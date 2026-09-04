use std::error::Error;
use std::ffi::OsString;
use std::fmt::{Display, Formatter};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

pub const DASHBOARD_ORIGIN: &str = "http://127.0.0.1:8788";
pub const NODE_SIDECAR_NAME: &str = "floway-node";
// These identifiers are owned by the merged personal Dashboard bootstrap
// contract; desktop supplies one fresh value to both sides of that exchange.
// https://github.com/tommy0103/Floway-One/blob/246524d44fc8f69ca9440e2d3d2ca9f26eb89736/apps/platform-node/src/personal-dashboard-bootstrap.ts#L3-L11
// https://github.com/tommy0103/Floway-One/blob/246524d44fc8f69ca9440e2d3d2ca9f26eb89736/apps/web/src/auth/session.ts#L1-L4
pub const PERSONAL_DASHBOARD_BOOTSTRAP_ENV: &str = "FLOWAY_BOOTSTRAP_TOKEN";
pub const PERSONAL_DASHBOARD_BOOTSTRAP_FRAGMENT_KEY: &str = "floway-bootstrap";
pub const PERSONAL_RUNTIME_READY_PREFIX: &str = "Floway listening on ";

pub fn dashboard_bootstrap_url(origin: &str, token: &str) -> String {
    format!("{origin}/#{PERSONAL_DASHBOARD_BOOTSTRAP_FRAGMENT_KEY}={token}")
}

pub fn ready_dashboard_origin(output: &str) -> Option<&str> {
    output
        .lines()
        .find_map(|line| line.strip_prefix(PERSONAL_RUNTIME_READY_PREFIX))
}

#[derive(Debug, Eq, PartialEq)]
pub struct RuntimeBundle {
    pub dashboard_index: PathBuf,
    pub dashboard_routes: PathBuf,
    pub entry: PathBuf,
    pub migrations: PathBuf,
    pub root: PathBuf,
}

impl RuntimeBundle {
    pub fn sidecar_arguments(&self) -> Vec<OsString> {
        vec![
            self.entry.as_os_str().to_owned(),
            OsString::from("--profile=personal"),
        ]
    }
}

#[derive(Debug)]
pub struct BundleResourceError {
    path: PathBuf,
    source: io::Error,
}

impl BundleResourceError {
    fn new(path: PathBuf, source: io::Error) -> Self {
        Self { path, source }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Display for BundleResourceError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "Floway desktop runtime resource is unavailable at {}",
            self.path.display()
        )
    }
}

impl Error for BundleResourceError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        Some(&self.source)
    }
}

fn require_file(path: PathBuf) -> Result<PathBuf, BundleResourceError> {
    let metadata =
        fs::metadata(&path).map_err(|source| BundleResourceError::new(path.clone(), source))?;
    if !metadata.is_file() {
        return Err(BundleResourceError::new(
            path,
            io::Error::new(io::ErrorKind::InvalidData, "the path is not a file"),
        ));
    }
    Ok(path)
}

fn require_migrations(path: PathBuf) -> Result<PathBuf, BundleResourceError> {
    let entries =
        fs::read_dir(&path).map_err(|source| BundleResourceError::new(path.clone(), source))?;
    for entry in entries {
        let entry = entry.map_err(|source| BundleResourceError::new(path.clone(), source))?;
        if entry
            .path()
            .extension()
            .is_some_and(|extension| extension == "sql")
        {
            return Ok(path);
        }
    }
    Err(BundleResourceError::new(
        path,
        io::Error::new(
            io::ErrorKind::NotFound,
            "the directory contains no SQL migrations",
        ),
    ))
}

pub fn resolve_runtime_bundle(resource_dir: &Path) -> Result<RuntimeBundle, BundleResourceError> {
    let root = resource_dir.join("runtime");
    let platform_node = root.join("apps/platform-node");
    Ok(RuntimeBundle {
        dashboard_index: require_file(root.join("apps/web/dist/client/index.html"))?,
        dashboard_routes: require_file(root.join("apps/web/dist/client/dashboard-routes.json"))?,
        entry: require_file(platform_node.join("entry.js"))?,
        migrations: require_migrations(
            platform_node.join("node_modules/@floway-dev/gateway/migrations"),
        )?,
        root,
    })
}

#[cfg(feature = "desktop")]
mod desktop {
    use std::error::Error;
    use std::fmt::{Display, Formatter};
    use std::io;
    use std::sync::{Arc, Condvar, Mutex};
    use std::thread;
    use std::time::Duration;

    use getrandom::fill;
    use signal_hook::{consts::SIGTERM, iterator::Signals};
    use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
    use tauri_plugin_shell::ShellExt;
    use tauri_plugin_shell::process::{CommandChild, CommandEvent};

    use super::{
        NODE_SIDECAR_NAME, PERSONAL_DASHBOARD_BOOTSTRAP_ENV, dashboard_bootstrap_url,
        ready_dashboard_origin, resolve_runtime_bundle,
    };

    #[derive(Debug)]
    struct StartupAuthorityError {
        source: getrandom::Error,
    }

    #[derive(Debug)]
    struct SidecarShutdownError {
        failures: Vec<Box<dyn Error + Send + Sync>>,
    }

    impl Display for SidecarShutdownError {
        fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
            write!(
                formatter,
                "Floway desktop could not terminate and wait for its personal runtime"
            )?;
            for failure in &self.failures {
                write!(formatter, "; {failure}")?;
            }
            Ok(())
        }
    }

    impl Error for SidecarShutdownError {
        fn source(&self) -> Option<&(dyn Error + 'static)> {
            self.failures
                .first()
                .map(|failure| failure.as_ref() as &(dyn Error + 'static))
        }
    }

    #[derive(Debug)]
    struct UnexpectedSidecarExitError {
        code: Option<i32>,
        signal: Option<i32>,
        source: Option<io::Error>,
    }

    impl Display for UnexpectedSidecarExitError {
        fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
            write!(
                formatter,
                "Floway personal runtime exited unexpectedly: code={:?} signal={:?}",
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

    struct SidecarState {
        child: Option<CommandChild>,
        shutdown_requested: bool,
        terminated: bool,
    }

    struct SidecarOwner {
        changed: Condvar,
        state: Mutex<SidecarState>,
    }

    impl SidecarOwner {
        fn new(child: CommandChild) -> Arc<Self> {
            Arc::new(Self {
                changed: Condvar::new(),
                state: Mutex::new(SidecarState {
                    child: Some(child),
                    shutdown_requested: false,
                    terminated: false,
                }),
            })
        }

        fn record_termination(&self) -> bool {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            state.terminated = true;
            state.child.take();
            let unexpected = !state.shutdown_requested;
            self.changed.notify_all();
            unexpected
        }

        fn shutdown(&self) -> Result<bool, SidecarShutdownError> {
            let child = {
                let mut state = self
                    .state
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                state.shutdown_requested = true;
                if state.terminated {
                    return Ok(false);
                }
                state.child.take()
            };

            let mut failures: Vec<Box<dyn Error + Send + Sync>> = Vec::new();
            match child {
                Some(child) => {
                    if let Err(source) = child.kill() {
                        failures.push(Box::new(source));
                    }
                }
                None => failures.push(Box::new(io::Error::new(
                    io::ErrorKind::NotFound,
                    "Floway personal runtime handle disappeared before termination",
                ))),
            }

            let state = self
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let (state, timeout) = self
                .changed
                .wait_timeout_while(state, Duration::from_secs(10), |state| !state.terminated)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if timeout.timed_out() && !state.terminated {
                failures.push(Box::new(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "Floway personal runtime did not report termination within 10 seconds",
                )));
            }

            if failures.is_empty() {
                Ok(true)
            } else {
                Err(SidecarShutdownError { failures })
            }
        }
    }

    impl Display for StartupAuthorityError {
        fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
            write!(
                formatter,
                "Floway could not create ephemeral startup authority"
            )
        }
    }

    impl Error for StartupAuthorityError {
        fn source(&self) -> Option<&(dyn Error + 'static)> {
            Some(&self.source)
        }
    }

    fn ephemeral_bootstrap_token() -> Result<String, StartupAuthorityError> {
        let mut bytes = [0_u8; 32];
        fill(&mut bytes).map_err(|source| StartupAuthorityError { source })?;
        Ok(bytes
            .into_iter()
            .map(|byte| format!("{byte:02x}"))
            .collect())
    }

    fn print_error_chain(error: &(dyn Error + 'static)) {
        eprintln!("Floway desktop application failed: {error}");
        let mut source = error.source();
        while let Some(cause) = source {
            eprintln!("caused by: {cause}");
            source = cause.source();
        }
    }

    fn dashboard_url_for_runtime(
        origin: &str,
        bootstrap_token: &str,
    ) -> Result<tauri::Url, Box<dyn Error>> {
        let parsed: tauri::Url = origin.parse()?;
        if parsed.scheme() != "http"
            || parsed.host_str() != Some("127.0.0.1")
            || parsed.port().is_none()
            || parsed.path() != "/"
            || parsed.query().is_some()
            || parsed.fragment().is_some()
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("Floway personal runtime reported an invalid Dashboard origin: {origin}"),
            )
            .into());
        }
        Ok(dashboard_bootstrap_url(origin, bootstrap_token).parse()?)
    }

    fn install_termination_signal(app_handle: AppHandle) -> Result<(), io::Error> {
        // XNU owns SIGTERM's process-termination semantics. Turning it into a
        // Tauri exit request lets the shipping shell run its sidecar teardown.
        // https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/sys/signal.h#L101-L104
        let mut signals = Signals::new([SIGTERM])?;
        thread::Builder::new()
            .name("floway-desktop-signals".to_owned())
            .spawn(move || {
                if signals.forever().next().is_some() {
                    app_handle.exit(0);
                }
            })?;
        Ok(())
    }

    fn shutdown_sidecar(app_handle: &AppHandle) {
        let owner = app_handle.state::<Arc<SidecarOwner>>();
        match owner.shutdown() {
            Ok(true) => eprintln!("Floway desktop terminated and waited for its personal runtime"),
            Ok(false) => {}
            Err(error) => {
                print_error_chain(&error);
                std::process::exit(1);
            }
        }
    }

    fn try_run() -> Result<(), Box<dyn Error>> {
        tauri::Builder::default()
            .plugin(tauri_plugin_shell::init())
            .setup(|app| {
                let resource_dir = app.path().resource_dir()?;
                let runtime = resolve_runtime_bundle(&resource_dir)?;
                let bootstrap_token = ephemeral_bootstrap_token()?;
                let (mut events, child) = app
                    .shell()
                    .sidecar(NODE_SIDECAR_NAME)?
                    .args(runtime.sidecar_arguments())
                    .current_dir(&runtime.root)
                    .env(PERSONAL_DASHBOARD_BOOTSTRAP_ENV, bootstrap_token.clone())
                    .env("FLOWAY_PROFILE", "personal")
                    .env("NODE_ENV", "production")
                    .spawn()?;
                let owner = SidecarOwner::new(child);
                app.manage(Arc::clone(&owner));

                let app_handle = app.handle().clone();
                install_termination_signal(app_handle.clone())?;
                tauri::async_runtime::spawn(async move {
                    let mut pending_bootstrap_token = Some(bootstrap_token);
                    let mut runtime_stdout = String::new();
                    let mut command_error = None;
                    while let Some(event) = events.recv().await {
                        match event {
                            CommandEvent::Stdout(bytes) => {
                                let output = String::from_utf8_lossy(&bytes);
                                eprintln!("[Floway runtime stdout] {}", output);
                                if pending_bootstrap_token.is_some() {
                                    runtime_stdout.push_str(&output);
                                    if let Some(origin) = ready_dashboard_origin(&runtime_stdout)
                                        && let Some(token) = pending_bootstrap_token.take()
                                    {
                                        match dashboard_url_for_runtime(origin, &token) {
                                            Ok(url) => {
                                                if let Err(error) = WebviewWindowBuilder::new(
                                                    &app_handle,
                                                    "main",
                                                    WebviewUrl::External(url),
                                                )
                                                .title("Floway")
                                                .inner_size(1280.0, 800.0)
                                                .build()
                                                {
                                                    print_error_chain(&error);
                                                    app_handle.exit(1);
                                                    return;
                                                }
                                            }
                                            Err(error) => {
                                                print_error_chain(error.as_ref());
                                                app_handle.exit(1);
                                                return;
                                            }
                                        }
                                        runtime_stdout.clear();
                                    }
                                }
                            }
                            CommandEvent::Stderr(bytes) => {
                                eprintln!(
                                    "[Floway runtime stderr] {}",
                                    String::from_utf8_lossy(&bytes)
                                );
                            }
                            CommandEvent::Error(error) => {
                                eprintln!("[Floway runtime error] {error}");
                                command_error = Some(io::Error::other(error));
                            }
                            CommandEvent::Terminated(payload) => {
                                eprintln!(
                                    "[Floway runtime exit] code={:?} signal={:?}",
                                    payload.code, payload.signal
                                );
                                if owner.record_termination() {
                                    let error = UnexpectedSidecarExitError {
                                        code: payload.code,
                                        signal: payload.signal,
                                        source: command_error.take(),
                                    };
                                    print_error_chain(&error);
                                    std::process::exit(1);
                                }
                                return;
                            }
                            _ => {}
                        }
                    }
                });
                Ok(())
            })
            .build(tauri::generate_context!())?
            .run(|app_handle, event| {
                if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
                    shutdown_sidecar(app_handle);
                }
            });
        Ok(())
    }

    pub fn run() {
        if let Err(error) = try_run() {
            print_error_chain(error.as_ref());
            std::process::exit(1);
        }
    }
}

#[cfg(feature = "desktop")]
pub use desktop::run;
