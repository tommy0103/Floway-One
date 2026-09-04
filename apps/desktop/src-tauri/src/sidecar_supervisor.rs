use std::error::Error;
use std::fmt::{Display, Formatter};
use std::io;
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use tauri_plugin_shell::process::CommandChild;

const PROCESS_STOP_TIMEOUT: Duration = Duration::from_secs(10);

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

struct ProcessState {
    child: Option<CommandChild>,
    stop_requested: bool,
    terminated: bool,
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
            state: Mutex::new(ProcessState {
                child: None,
                stop_requested: false,
                terminated: false,
            }),
        })
    }

    pub(crate) fn spawn_registered<T, E>(
        &self,
        spawn: impl FnOnce() -> Result<(T, CommandChild), E>,
    ) -> Result<T, E> {
        // Registration shares one lock with stop/termination bookkeeping, so
        // setup can never publish an unowned child between spawn and storage.
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let (events, child) = spawn()?;
        state.child = Some(child);
        self.changed.notify_all();
        Ok(events)
    }

    pub(crate) fn record_termination(&self) -> bool {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.terminated = true;
        state.child.take();
        let unexpected = !state.stop_requested;
        self.changed.notify_all();
        unexpected
    }

    pub(crate) fn stop_now(&self) -> Result<bool, ProcessStopError> {
        let child = {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            state.stop_requested = true;
            if state.terminated {
                return Ok(false);
            }
            state.child.take()
        };
        let mut failures: Vec<Box<dyn Error + Send + Sync>> = Vec::new();
        match child {
            Some(child) => {
                // This is an immediate package-resource cleanup operation, not
                // #17's future graceful explicit-quit policy.
                // https://github.com/tauri-apps/plugins-workspace/blob/shell-v2.3.6/plugins/shell/src/process/mod.rs#L70-L86
                if let Err(source) = child.kill() {
                    failures.push(Box::new(source));
                }
            }
            None => return Ok(false),
        }

        let state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let (state, timeout) = self
            .changed
            .wait_timeout_while(state, PROCESS_STOP_TIMEOUT, |state| !state.terminated)
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if timeout.timed_out() && !state.terminated {
            failures.push(Box::new(io::Error::new(
                io::ErrorKind::TimedOut,
                "Floway packaged runtime did not report termination within 10 seconds",
            )));
        }
        if failures.is_empty() {
            Ok(true)
        } else {
            Err(ProcessStopError { failures })
        }
    }
}
