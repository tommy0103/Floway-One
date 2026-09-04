use std::error::Error;
use std::fmt::{Display, Formatter};
use std::io;
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

#[cfg(feature = "desktop")]
use tauri_plugin_shell::process::CommandChild;

const PROCESS_STOP_TIMEOUT: Duration = Duration::from_secs(10);

pub(crate) trait PackagedChild: Send {
    fn stop_now(&self) -> Result<(), Box<dyn Error + Send + Sync>>;
}

#[cfg(feature = "desktop")]
impl PackagedChild for CommandChild {
    fn stop_now(&self) -> Result<(), Box<dyn Error + Send + Sync>> {
        self.kill()
            .map_err(|source| Box::new(source) as Box<dyn Error + Send + Sync>)
    }
}

#[derive(Debug)]
pub(crate) enum ProcessRegistrationError<E> {
    AlreadyOwned,
    Spawn(E),
}

impl<E: Display> Display for ProcessRegistrationError<E> {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::AlreadyOwned => {
                write!(formatter, "Floway desktop already owns a packaged runtime")
            }
            Self::Spawn(source) => write!(
                formatter,
                "Floway desktop could not start its packaged runtime: {source}"
            ),
        }
    }
}

impl<E: Error + 'static> Error for ProcessRegistrationError<E> {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::AlreadyOwned => None,
            Self::Spawn(source) => Some(source),
        }
    }
}

#[derive(Debug)]
pub(crate) struct ProcessStopError {
    failures: Vec<Box<dyn Error + Send + Sync>>,
}

impl Display for ProcessStopError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "Floway desktop could not stop and wait for its packaged runtime"
        )?;
        for failure in &self.failures {
            write!(formatter, "; {failure}")?;
        }
        Ok(())
    }
}

impl Error for ProcessStopError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        self.failures
            .first()
            .map(|failure| failure.as_ref() as &(dyn Error + 'static))
    }
}

#[derive(Debug)]
pub(crate) struct UnexpectedSidecarExitError {
    pub(crate) code: Option<i32>,
    pub(crate) signal: Option<i32>,
    pub(crate) source: Option<io::Error>,
}

impl Display for UnexpectedSidecarExitError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "Floway packaged runtime exited unexpectedly: code={:?} signal={:?}",
            self.code, self.signal
        )
    }
}

impl Error for UnexpectedSidecarExitError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        self.source
            .as_ref()
            .map(|source| source as &(dyn Error + 'static))
    }
}

enum ProcessState {
    Empty,
    Running(Box<dyn PackagedChild>),
    StopRequested,
    Terminated,
}

/// Owns only the packaged child process. Window, tray, singleton, restart,
/// autostart, and user-driven lifetime policy remain the responsibility of #17.
pub(crate) struct PackageProcessSupervisor {
    changed: Condvar,
    state: Mutex<ProcessState>,
}

impl PackageProcessSupervisor {
    pub(crate) fn new() -> Arc<Self> {
        Arc::new(Self {
            changed: Condvar::new(),
            state: Mutex::new(ProcessState::Empty),
        })
    }

    pub(crate) fn spawn_registered<T, C, E>(
        &self,
        spawn: impl FnOnce() -> Result<(T, C), E>,
    ) -> Result<T, ProcessRegistrationError<E>>
    where
        C: PackagedChild + 'static,
    {
        // Registration shares one lock with stop/termination bookkeeping, so
        // setup can never publish an unowned child between spawn and storage.
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if !matches!(*state, ProcessState::Empty) {
            return Err(ProcessRegistrationError::AlreadyOwned);
        }
        let (events, child) = spawn().map_err(ProcessRegistrationError::Spawn)?;
        *state = ProcessState::Running(Box::new(child));
        self.changed.notify_all();
        Ok(events)
    }

    pub(crate) fn record_termination(&self) -> bool {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let unexpected = matches!(*state, ProcessState::Running(_));
        *state = ProcessState::Terminated;
        self.changed.notify_all();
        unexpected
    }

    pub(crate) fn stop_now(&self) -> Result<bool, ProcessStopError> {
        let child = {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let prior = std::mem::replace(&mut *state, ProcessState::StopRequested);
            match prior {
                ProcessState::Running(child) => child,
                other => {
                    *state = other;
                    return Ok(false);
                }
            }
        };
        let mut failures = Vec::new();
        // This is an immediate package-resource cleanup operation, not #17's
        // future graceful explicit-quit policy.
        // https://github.com/tauri-apps/plugins-workspace/blob/shell-v2.3.6/plugins/shell/src/process/mod.rs#L70-L86
        if let Err(source) = child.stop_now() {
            failures.push(source);
        }

        let state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let (state, timeout) = self
            .changed
            .wait_timeout_while(state, PROCESS_STOP_TIMEOUT, |state| {
                !matches!(*state, ProcessState::Terminated)
            })
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if timeout.timed_out() && !matches!(*state, ProcessState::Terminated) {
            failures.push(Box::new(io::Error::new(
                io::ErrorKind::TimedOut,
                "Floway packaged runtime did not report termination within 10 seconds",
            )) as Box<dyn Error + Send + Sync>);
        }
        if failures.is_empty() {
            Ok(true)
        } else {
            Err(ProcessStopError { failures })
        }
    }
}
