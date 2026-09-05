use std::error::Error;
use std::fmt::{Display, Formatter};
use std::io;
use std::sync::Arc;

use getrandom::fill;
use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::CommandEvent;

use crate::NODE_SIDECAR_NAME;
use crate::bundle_contract::resolve_runtime_bundle;
use crate::navigation::{
    DashboardNavigationPolicy, PERSONAL_DASHBOARD_BOOTSTRAP_ENV, enforce_dashboard_navigation,
    ready_dashboard_origin,
};
use crate::sidecar_supervisor::{PackageProcessSupervisor, UnexpectedSidecarExitError};

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

fn enforce_webview_navigation(
    policy: &DashboardNavigationPolicy,
    app_handle: &AppHandle,
    candidate: &url::Url,
    new_window: bool,
) -> bool {
    // https://github.com/tauri-apps/tauri/blob/tauri-v2.11.5/crates/tauri/src/webview/webview_window.rs#L248-L319
    // https://github.com/tauri-apps/plugins-workspace/blob/shell-v2.3.6/plugins/shell/src/lib.rs#L69-L80
    #[allow(deprecated)]
    match enforce_dashboard_navigation(policy, candidate, new_window, |external| {
        app_handle.shell().open(external.as_str(), None)
    }) {
        Ok(allow) => allow,
        Err(error) => {
            print_error_chain(&error);
            app_handle.exit(1);
            false
        }
    }
}

fn stop_packaged_process(app_handle: &AppHandle) {
    let supervisor = app_handle.state::<Arc<PackageProcessSupervisor>>();
    match supervisor.stop_now() {
        Ok(true) => eprintln!("Floway desktop stopped and waited for its packaged runtime"),
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
            let supervisor = PackageProcessSupervisor::new();
            app.manage(Arc::clone(&supervisor));
            let setup = (|| -> Result<_, Box<dyn Error>> {
                let resource_dir = app.path().resource_dir()?;
                let runtime = resolve_runtime_bundle(&resource_dir)?;
                let bootstrap_token = ephemeral_bootstrap_token()?;
                let events = supervisor.spawn_registered(|| {
                    app.shell()
                        .sidecar(NODE_SIDECAR_NAME)?
                        .args(runtime.sidecar_arguments())
                        .current_dir(&runtime.root)
                        .env(PERSONAL_DASHBOARD_BOOTSTRAP_ENV, bootstrap_token.clone())
                        .env("FLOWAY_PROFILE", "personal")
                        .env("NODE_ENV", "production")
                        .spawn()
                })?;
                Ok((events, bootstrap_token))
            })();
            let (mut events, bootstrap_token) = setup.map_err(|error| {
                // Tauri turns setup-hook failures into display text. Report
                // the source chain before that boundary so OS causes survive.
                // https://github.com/tauri-apps/tauri/blob/tauri-v2.11.5/crates/tauri/src/app.rs#L1417-L1427
                print_error_chain(error.as_ref());
                error
            })?;

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
                                    match DashboardNavigationPolicy::new(origin, &token) {
                                        Ok(policy) => {
                                            let policy = Arc::new(policy);
                                            let url = policy.bootstrap_url().clone();
                                            let navigation_policy = Arc::clone(&policy);
                                            let navigation_app = app_handle.clone();
                                            let new_window_policy = Arc::clone(&policy);
                                            let new_window_app = app_handle.clone();
                                            if let Err(error) = WebviewWindowBuilder::new(
                                                &app_handle,
                                                "main",
                                                WebviewUrl::External(url),
                                            )
                                            .on_navigation(move |candidate| {
                                                enforce_webview_navigation(
                                                    &navigation_policy,
                                                    &navigation_app,
                                                    candidate,
                                                    false,
                                                )
                                            })
                                            .on_new_window(move |candidate, _features| {
                                                enforce_webview_navigation(
                                                    &new_window_policy,
                                                    &new_window_app,
                                                    &candidate,
                                                    true,
                                                );
                                                NewWindowResponse::Deny
                                            })
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
                            if supervisor.record_termination() {
                                let error = UnexpectedSidecarExitError {
                                    code: payload.code,
                                    signal: payload.signal,
                                    source: command_error.take(),
                                };
                                print_error_chain(&error);
                                // This is process-level failure propagation for
                                // a required packaged resource, not #17 window
                                // or tray lifetime policy.
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
                stop_packaged_process(app_handle);
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
