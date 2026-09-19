use std::error::Error;
use std::fmt::{Display, Formatter};
use std::io;
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

#[cfg(feature = "desktop")]
use tauri_plugin_shell::process::CommandChild;

const PROCESS_STOP_TIMEOUT: Duration = Duration::from_secs(10);
pub(crate) const GRACEFUL_STOP_SIGNAL_TIMEOUT: Duration = Duration::from_secs(5);

pub(crate) trait PackagedChild: Send {
    /// Asks the child to shut down on its own; the child may still be running
    /// when this returns.
    fn request_stop(&self) -> Result<(), Box<dyn Error + Send + Sync>>;
    /// Kills the child immediately.
    fn stop_now(self: Box<Self>) -> Result<(), Box<dyn Error + Send + Sync>>;
}

#[cfg(feature = "desktop")]
impl PackagedChild for CommandChild {
    fn request_stop(&self) -> Result<(), Box<dyn Error + Send + Sync>> {
        // XNU owns the POSIX signal identities; SIGTERM reaches only the exact
        // sidecar pid, which installs a graceful-stop handler when it runs as
        // the packaged desktop sidecar.
        // https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/sys/signal.h#L101-L104
        // https://github.com/tauri-apps/plugins-workspace/blob/shell-v2.3.6/plugins/shell/src/process/mod.rs#L84-L90
        let result = unsafe { libc::kill(self.pid() as libc::pid_t, libc::SIGTERM) };
        if result == 0 {
            Ok(())
        } else {
            Err(Box::new(io::Error::last_os_error()) as Box<dyn Error + Send + Sync>)
        }
    }

    fn stop_now(self: Box<Self>) -> Result<(), Box<dyn Error + Send + Sync>> {
        (*self)
            .kill()
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

/// Owns only packaged child registration, termination, and teardown settlement.
/// Window, tray, singleton, autostart, and user-driven lifetime policy stay
/// outside this process-ownership boundary.
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
        if !matches!(*state, ProcessState::Empty | ProcessState::Terminated) {
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
        let Some(child) = self.take_running_child() else {
            return Ok(false);
        };
        let mut failures = Vec::new();
        // Failure teardown kills immediately: the runtime may be wedged and a
        // graceful request cannot be trusted to settle it.
        // https://github.com/tauri-apps/plugins-workspace/blob/shell-v2.3.6/plugins/shell/src/process/mod.rs#L70-L86
        if let Err(source) = child.stop_now() {
            failures.push(source);
        }
        self.wait_for_termination(PROCESS_STOP_TIMEOUT, &mut failures);
        if failures.is_empty() {
            Ok(true)
        } else {
            Err(ProcessStopError { failures })
        }
    }

    /// Graceful explicit-quit stop: signal first, escalate to a kill only when
    /// the child does not settle within the grace window.
    pub(crate) fn stop_gracefully(&self, grace: Duration) -> Result<bool, ProcessStopError> {
        let Some(child) = self.take_running_child() else {
            return Ok(false);
        };
        let mut failures = Vec::new();
        if let Err(source) = child.request_stop() {
            failures.push(source);
        } else {
            let state = self
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let (state, _) = self
                .changed
                .wait_timeout_while(state, grace, |state| {
                    !matches!(*state, ProcessState::Terminated)
                })
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if matches!(*state, ProcessState::Terminated) {
                return Ok(true);
            }
        }
        if let Err(source) = child.stop_now() {
            failures.push(source);
        }
        self.wait_for_termination(PROCESS_STOP_TIMEOUT, &mut failures);
        if failures.is_empty() {
            Ok(true)
        } else {
            Err(ProcessStopError { failures })
        }
    }

    fn take_running_child(&self) -> Option<Box<dyn PackagedChild>> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let prior = std::mem::replace(&mut *state, ProcessState::StopRequested);
        match prior {
            ProcessState::Running(child) => Some(child),
            other => {
                *state = other;
                None
            }
        }
    }

    fn wait_for_termination(
        &self,
        timeout: Duration,
        failures: &mut Vec<Box<dyn Error + Send + Sync>>,
    ) {
        let state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let (state, elapsed) = self
            .changed
            .wait_timeout_while(state, timeout, |state| {
                !matches!(*state, ProcessState::Terminated)
            })
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if elapsed.timed_out() && !matches!(*state, ProcessState::Terminated) {
            failures.push(Box::new(io::Error::new(
                io::ErrorKind::TimedOut,
                format!(
                    "Floway packaged runtime did not report termination within {} seconds",
                    timeout.as_secs()
                ),
            )) as Box<dyn Error + Send + Sync>);
        }
    }
}
