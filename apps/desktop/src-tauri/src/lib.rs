use std::error::Error;
use std::ffi::OsString;
use std::fmt::{Display, Formatter};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

pub const DASHBOARD_ORIGIN: &str = "http://127.0.0.1:8788";
pub const NODE_SIDECAR_NAME: &str = "floway-node";

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
    use std::sync::Mutex;

    use getrandom::fill;
    use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
    use tauri_plugin_shell::ShellExt;
    use tauri_plugin_shell::process::CommandEvent;

    use super::{DASHBOARD_ORIGIN, NODE_SIDECAR_NAME, resolve_runtime_bundle};

    const PACKAGE_VERIFICATION_SCRIPT: &str = r#"
const watchdog = setTimeout(() => {
  console.error('Floway package verification sidecar timed out');
  process.exit(70);
}, 10_000);
const keyring = await import('@napi-rs/keyring');
if (typeof keyring.Entry !== 'function') throw new Error('Floway package verification could not load the Keyring native entry');
await import('@floway-dev/gateway');
await import('./entry.js');
clearTimeout(watchdog);
"#;
    // Keyring's loader exclusively tries this override when it is present.
    // https://github.com/Brooooooklyn/keyring-node/blob/f3449416a1b4bf11b0570f0a49395aacc84c8608/index.js#L63-L70
    const KEYRING_NATIVE_LIBRARY_OVERRIDE: &str = "NAPI_RS_NATIVE_LIBRARY_PATH";

    #[derive(Debug)]
    struct StartupAuthorityError {
        source: getrandom::Error,
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

    fn ephemeral_admin_key() -> Result<String, StartupAuthorityError> {
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

    fn start_package_verification(
        app: &mut tauri::App,
        runtime: super::RuntimeBundle,
        keyring_fault: bool,
    ) -> Result<(), Box<dyn Error>> {
        let platform_node = runtime.root.join("apps/platform-node");
        let mut command = app
            .shell()
            .sidecar(NODE_SIDECAR_NAME)?
            .args(["--input-type=module", "--eval", PACKAGE_VERIFICATION_SCRIPT])
            .current_dir(&platform_node);
        if keyring_fault {
            command = command.env(
                KEYRING_NATIVE_LIBRARY_OVERRIDE,
                platform_node.join("missing-keyring.node"),
            );
        }
        let (mut events, child) = command.spawn()?;
        println!("Floway package verification sidecar pid {}", child.pid());
        app.manage(Mutex::new(child));
        let handle = app.handle().clone();
        tauri::async_runtime::spawn(async move {
            let mut command_error = None;
            while let Some(event) = events.recv().await {
                match event {
                    CommandEvent::Stdout(bytes) => {
                        println!(
                            "[Floway package verification stdout] {}",
                            String::from_utf8_lossy(&bytes)
                        );
                    }
                    CommandEvent::Stderr(bytes) => {
                        eprintln!(
                            "[Floway package verification stderr] {}",
                            String::from_utf8_lossy(&bytes)
                        );
                    }
                    CommandEvent::Error(error) => command_error = Some(error),
                    CommandEvent::Terminated(payload) => {
                        if payload.code == Some(0) && command_error.is_none() {
                            println!("Floway package verification succeeded");
                            handle.exit(0);
                        } else {
                            if let Some(error) = command_error {
                                eprintln!("Floway package verification sidecar error: {error}");
                            }
                            eprintln!(
                                "Floway package verification sidecar exited with code {:?} signal {:?}",
                                payload.code, payload.signal
                            );
                            handle.exit(1);
                        }
                        return;
                    }
                    _ => {}
                }
            }
            eprintln!("Floway package verification sidecar event stream ended before exit");
            handle.exit(1);
        });
        Ok(())
    }

    fn try_run() -> Result<(), Box<dyn Error>> {
        let package_verification = std::env::args().any(|argument| argument == "--verify-package");
        let keyring_fault = package_verification
            && std::env::args().any(|argument| argument == "--verify-broken-keyring");
        tauri::Builder::default()
            .plugin(tauri_plugin_shell::init())
            .setup(move |app| {
                let resource_dir = app.path().resource_dir()?;
                let runtime = resolve_runtime_bundle(&resource_dir)?;
                if package_verification {
                    return start_package_verification(app, runtime, keyring_fault);
                }
                let admin_key = ephemeral_admin_key()?;
                let (mut events, child) = app
                    .shell()
                    .sidecar(NODE_SIDECAR_NAME)?
                    .args(runtime.sidecar_arguments())
                    .current_dir(&runtime.root)
                    .env("ADMIN_KEY", admin_key)
                    .env("FLOWAY_PROFILE", "personal")
                    .env("NODE_ENV", "production")
                    .spawn()?;

                let window = WebviewWindowBuilder::new(
                    app,
                    "main",
                    WebviewUrl::External(DASHBOARD_ORIGIN.parse()?),
                )
                .title("Floway One")
                .inner_size(1280.0, 800.0)
                .build();
                if let Err(error) = window {
                    let _ = child.kill();
                    return Err(error.into());
                }
                app.manage(Mutex::new(child));

                tauri::async_runtime::spawn(async move {
                    while let Some(event) = events.recv().await {
                        match event {
                            CommandEvent::Stdout(bytes) => {
                                eprintln!(
                                    "[Floway runtime stdout] {}",
                                    String::from_utf8_lossy(&bytes)
                                );
                            }
                            CommandEvent::Stderr(bytes) => {
                                eprintln!(
                                    "[Floway runtime stderr] {}",
                                    String::from_utf8_lossy(&bytes)
                                );
                            }
                            CommandEvent::Error(error) => {
                                eprintln!("[Floway runtime error] {error}");
                            }
                            CommandEvent::Terminated(payload) => {
                                eprintln!(
                                    "[Floway runtime exit] code={:?} signal={:?}",
                                    payload.code, payload.signal
                                );
                            }
                            _ => {}
                        }
                    }
                });
                Ok(())
            })
            .run(tauri::generate_context!())?;
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
