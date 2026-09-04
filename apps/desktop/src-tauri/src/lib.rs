use std::error::Error;
use std::ffi::OsString;
use std::fmt::{Display, Formatter};
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};

use sha2::{Digest, Sha256};

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

pub fn spawn_after_lifecycle_setup<T, E>(
    establish_lifecycle: impl FnOnce() -> Result<(), E>,
    spawn_and_register: impl FnOnce() -> Result<T, E>,
) -> Result<T, E> {
    establish_lifecycle()?;
    spawn_and_register()
}

#[derive(Debug, Eq, PartialEq)]
pub struct RuntimeBundle {
    pub contract: PathBuf,
    pub dashboard_assets: Vec<PathBuf>,
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

fn invalid_bundle_contract(path: &Path, message: impl Into<String>) -> BundleResourceError {
    BundleResourceError::new(
        path.to_path_buf(),
        io::Error::new(io::ErrorKind::InvalidData, message.into()),
    )
}

fn expected_node_contract() -> Option<(&'static str, &'static str)> {
    match std::env::consts::ARCH {
        "aarch64" => Some(("arm64", "aarch64-apple-darwin")),
        "x86_64" => Some(("x64", "x86_64-apple-darwin")),
        _ => None,
    }
}

fn validate_bundle_contract(
    contract_path: &Path,
    runtime_root: &Path,
) -> Result<Vec<PathBuf>, BundleResourceError> {
    let source = fs::read_to_string(contract_path)
        .map_err(|source| BundleResourceError::new(contract_path.to_path_buf(), source))?;
    let contract: serde_json::Value = serde_json::from_str(&source).map_err(|source| {
        BundleResourceError::new(
            contract_path.to_path_buf(),
            io::Error::new(io::ErrorKind::InvalidData, source),
        )
    })?;
    if contract
        .get("schemaVersion")
        .and_then(serde_json::Value::as_u64)
        != Some(1)
    {
        return Err(invalid_bundle_contract(
            contract_path,
            "the desktop bundle schema version is not supported",
        ));
    }
    let node = contract
        .get("node")
        .and_then(serde_json::Value::as_object)
        .ok_or_else(|| invalid_bundle_contract(contract_path, "the Node contract is missing"))?;
    let (expected_architecture, expected_target) = expected_node_contract().ok_or_else(|| {
        invalid_bundle_contract(
            contract_path,
            format!(
                "the desktop host architecture {} is unsupported",
                std::env::consts::ARCH
            ),
        )
    })?;
    let version = node.get("version").and_then(serde_json::Value::as_str);
    let version_is_exact = version.is_some_and(|value| {
        let segments = value.split('.').collect::<Vec<_>>();
        segments.len() == 3
            && segments.iter().all(|segment| {
                !segment.is_empty() && segment.bytes().all(|byte| byte.is_ascii_digit())
            })
    });
    if node.get("architecture").and_then(serde_json::Value::as_str) != Some(expected_architecture)
        || node.get("platform").and_then(serde_json::Value::as_str) != Some("darwin")
        || node.get("targetTriple").and_then(serde_json::Value::as_str) != Some(expected_target)
        || !version_is_exact
    {
        return Err(invalid_bundle_contract(
            contract_path,
            "the Node contract does not match this installed desktop artifact",
        ));
    }

    let assets = contract
        .get("dashboard")
        .and_then(|dashboard| dashboard.get("assets"))
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| {
            invalid_bundle_contract(contract_path, "the Dashboard asset contract is missing")
        })?;
    if assets.is_empty() {
        return Err(invalid_bundle_contract(
            contract_path,
            "the Dashboard asset contract is empty",
        ));
    }

    let dashboard_root = runtime_root.join("apps/web/dist/client");
    let mut previous = None;
    let mut resolved = Vec::with_capacity(assets.len());
    for asset in assets {
        let relative = asset
            .get("path")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| {
                invalid_bundle_contract(contract_path, "a Dashboard asset path is missing")
            })?;
        if relative.is_empty()
            || Path::new(relative)
                .components()
                .any(|component| !matches!(component, Component::Normal(_)))
            || previous.is_some_and(|prior: &str| prior >= relative)
        {
            return Err(invalid_bundle_contract(
                contract_path,
                format!("the Dashboard asset path is unsafe, duplicated, or unsorted: {relative}"),
            ));
        }
        previous = Some(relative);
        let expected_hash = asset
            .get("sha256")
            .and_then(serde_json::Value::as_str)
            .filter(|hash| hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit()))
            .ok_or_else(|| {
                invalid_bundle_contract(
                    contract_path,
                    format!("the Dashboard asset digest is invalid for {relative}"),
                )
            })?;
        let path = require_file(dashboard_root.join(relative))?;
        let contents =
            fs::read(&path).map_err(|source| BundleResourceError::new(path.clone(), source))?;
        let actual_hash = format!("{:x}", Sha256::digest(contents));
        if actual_hash != expected_hash.to_ascii_lowercase() {
            return Err(invalid_bundle_contract(
                contract_path,
                format!("the Dashboard asset digest is stale for {relative}"),
            ));
        }
        resolved.push(path);
    }
    for required in ["index.html", "dashboard-routes.json"] {
        if !resolved
            .iter()
            .any(|path| path == &dashboard_root.join(required))
        {
            return Err(invalid_bundle_contract(
                contract_path,
                format!("the Dashboard asset contract omits {required}"),
            ));
        }
    }
    Ok(resolved)
}

pub fn resolve_runtime_bundle(resource_dir: &Path) -> Result<RuntimeBundle, BundleResourceError> {
    let root = resource_dir.join("runtime");
    let platform_node = root.join("apps/platform-node");
    let contract = require_file(resource_dir.join("desktop-bundle-contract.json"))?;
    let dashboard_assets = validate_bundle_contract(&contract, &root)?;
    Ok(RuntimeBundle {
        contract,
        dashboard_assets,
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
        ready_dashboard_origin, resolve_runtime_bundle, spawn_after_lifecycle_setup,
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

    #[derive(Debug, Eq, PartialEq)]
    enum SidecarShutdownOutcome {
        AlreadyStopped,
        Graceful,
        HardKillFallback,
    }

    const GRACEFUL_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(3);
    const HARD_KILL_TIMEOUT: Duration = Duration::from_secs(3);
    const HARD_KILL_SIGNAL_NAME: &str = "SIGKILL";

    struct SidecarOwner {
        changed: Condvar,
        state: Mutex<SidecarState>,
    }

    impl SidecarOwner {
        fn new() -> Arc<Self> {
            Arc::new(Self {
                changed: Condvar::new(),
                state: Mutex::new(SidecarState {
                    child: None,
                    shutdown_requested: false,
                    terminated: false,
                }),
            })
        }

        fn request_shutdown(&self) {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            state.shutdown_requested = true;
            self.changed.notify_all();
        }

        fn spawn_registered<T, E>(
            &self,
            spawn: impl FnOnce() -> Result<(T, CommandChild), E>,
        ) -> Result<Option<T>, E> {
            // Holding the ownership lock across spawn and registration makes
            // an immediate termination request choose exactly one state: it
            // either prevents spawning or observes a registered child.
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if state.shutdown_requested {
                return Ok(None);
            }
            let (events, child) = spawn()?;
            state.child = Some(child);
            self.changed.notify_all();
            Ok(Some(events))
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

        fn shutdown(&self) -> Result<SidecarShutdownOutcome, SidecarShutdownError> {
            let mut failures: Vec<Box<dyn Error + Send + Sync>> = Vec::new();
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            state.shutdown_requested = true;
            if state.terminated || state.child.is_none() {
                return Ok(SidecarShutdownOutcome::AlreadyStopped);
            }
            let pid = state
                .child
                .as_ref()
                .expect("registered child must exist")
                .pid();

            // XNU defines SIGTERM as the catchable graceful termination signal
            // and SIGKILL as the uncatchable hard-stop fallback.
            // https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/sys/signal.h#L101-L104
            let graceful_result = unsafe { libc::kill(pid as libc::pid_t, libc::SIGTERM) };
            if graceful_result != 0 {
                let source = io::Error::last_os_error();
                if source.raw_os_error() != Some(libc::ESRCH) {
                    failures.push(Box::new(source));
                }
            }

            let (next_state, graceful_timeout) = self
                .changed
                .wait_timeout_while(state, GRACEFUL_SHUTDOWN_TIMEOUT, |state| !state.terminated)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            state = next_state;
            if state.terminated {
                return if failures.is_empty() {
                    Ok(SidecarShutdownOutcome::Graceful)
                } else {
                    Err(SidecarShutdownError { failures })
                };
            }

            if !graceful_timeout.timed_out() {
                failures.push(Box::new(io::Error::other(
                    "Floway personal runtime remained live after its graceful shutdown state changed",
                )));
            }
            let child = state.child.take();
            drop(state);
            match child {
                Some(child) => {
                    // Tauri's sidecar handle delegates to shared_child, whose
                    // Unix hard-kill contract is explicitly SIGKILL.
                    // https://github.com/tauri-apps/plugins-workspace/blob/shell-v2.3.6/plugins/shell/src/process/mod.rs#L70-L86
                    // https://github.com/oconnor663/shared_child.rs/blob/v1.1.1/src/lib.rs#L305-L322
                    if let Err(source) = child.kill() {
                        failures.push(Box::new(source));
                    }
                }
                None => failures.push(Box::new(io::Error::new(
                    io::ErrorKind::NotFound,
                    "Floway personal runtime handle disappeared before the hard-kill fallback",
                ))),
            }

            let state = self
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let (state, hard_timeout) = self
                .changed
                .wait_timeout_while(state, HARD_KILL_TIMEOUT, |state| !state.terminated)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if hard_timeout.timed_out() && !state.terminated {
                failures.push(Box::new(io::Error::new(
                    io::ErrorKind::TimedOut,
                    format!(
                        "Floway personal runtime did not report termination after {HARD_KILL_SIGNAL_NAME}"
                    ),
                )));
            }

            if failures.is_empty() {
                Ok(SidecarShutdownOutcome::HardKillFallback)
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

    fn install_termination_signal(
        app_handle: AppHandle,
        owner: Arc<SidecarOwner>,
    ) -> Result<(), io::Error> {
        // XNU owns SIGTERM's process-termination semantics. Turning it into a
        // Tauri exit request lets the shipping shell run its sidecar teardown.
        // https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/sys/signal.h#L101-L104
        let mut signals = Signals::new([SIGTERM])?;
        thread::Builder::new()
            .name("floway-desktop-signals".to_owned())
            .spawn(move || {
                if signals.forever().next().is_some() {
                    owner.request_shutdown();
                    app_handle.exit(0);
                }
            })?;
        Ok(())
    }

    fn shutdown_sidecar(app_handle: &AppHandle) {
        let owner = app_handle.state::<Arc<SidecarOwner>>();
        match owner.shutdown() {
            Ok(SidecarShutdownOutcome::Graceful) => {
                eprintln!(
                    "Floway desktop gracefully terminated and waited for its personal runtime"
                );
            }
            Ok(SidecarShutdownOutcome::HardKillFallback) => {
                eprintln!(
                    "Floway desktop used {HARD_KILL_SIGNAL_NAME} after its personal runtime exceeded the graceful shutdown deadline"
                );
            }
            Ok(SidecarShutdownOutcome::AlreadyStopped) => {}
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
                let owner = SidecarOwner::new();
                app.manage(Arc::clone(&owner));
                let app_handle = app.handle().clone();
                let owner_for_signal = Arc::clone(&owner);
                let Some((mut events, bootstrap_token)) = spawn_after_lifecycle_setup(
                    || -> Result<(), Box<dyn Error>> {
                        install_termination_signal(app_handle, owner_for_signal)?;
                        Ok(())
                    },
                    || -> Result<_, Box<dyn Error>> {
                        let resource_dir = app.path().resource_dir()?;
                        let runtime = resolve_runtime_bundle(&resource_dir)?;
                        let bootstrap_token = ephemeral_bootstrap_token()?;
                        let events = owner.spawn_registered(|| {
                            app.shell()
                                .sidecar(NODE_SIDECAR_NAME)?
                                .args(runtime.sidecar_arguments())
                                .current_dir(&runtime.root)
                                .env(PERSONAL_DASHBOARD_BOOTSTRAP_ENV, bootstrap_token.clone())
                                .env("FLOWAY_PROFILE", "personal")
                                .env("NODE_ENV", "production")
                                .spawn()
                        })?;
                        Ok(events.map(|events| (events, bootstrap_token)))
                    },
                )?
                else {
                    return Ok(());
                };
                let app_handle = app.handle().clone();
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
