//! Owns the bounded packaged-runtime readiness and visible recovery state.

use std::error::Error;
use std::fmt::{Display, Formatter};
use std::fs;
use std::io;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, RwLock};
use std::thread;
use std::time::{Duration, Instant};

use getrandom::fill;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::webview::{NewWindowResponse, PageLoadEvent, PageLoadPayload};
use tauri::{AppHandle, Emitter, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::{CommandEvent, TerminatedPayload};
use url::Url;

use crate::NODE_SIDECAR_NAME;
use crate::bundle_contract::{
    BundleResourceError, BundleResourceKind, RuntimeBundle, resolve_runtime_bundle,
};
use crate::desktop_i18n::{DesktopMessages, system_messages};
use crate::desktop_paths::DesktopPaths;
use crate::navigation::{
    DESKTOP_STATUS_ROUTE, DashboardNavigationPolicy, DesktopAction,
    PERSONAL_DASHBOARD_BOOTSTRAP_ENV, desktop_action, enforce_dashboard_navigation,
    is_desktop_status_navigation, ready_dashboard_origin, recovery_surface_diagnostic,
    sanitized_page_load_diagnostic,
};
use crate::runtime_status::{
    DesktopRuntimeStatus, DesktopStartupError, FailureKind, FailureReport, InitialStatusLoadGate,
    RuntimeAttemptState, RuntimeHealthError, RuntimePhase, STARTUP_TIMEOUT, SidecarFailureDecoder,
    apply_recovery_surface, probe_compatible_runtime,
};
use crate::sidecar_log::{BoundedSidecarLog, SidecarStream};
use crate::sidecar_supervisor::{PackageProcessSupervisor, UnexpectedSidecarExitError};

const DESKTOP_RUNTIME_CONTRACT_ENV: &str = "FLOWAY_DESKTOP_CONTRACT";
const DESKTOP_PAGE_LOAD_EVENT_PREFIX: &str = "FLOWAY_DESKTOP_PAGE_LOAD ";
const DESKTOP_SURFACE_EVENT_PREFIX: &str = "FLOWAY_DESKTOP_SURFACE ";
const DESKTOP_RECOVERY_SURFACE_EVENT_PREFIX: &str = "FLOWAY_DESKTOP_RECOVERY_SURFACE ";
const DESKTOP_STATUS_EVENT: &str = "floway-desktop-status";
const MAXIMUM_CAPTURED_DIAGNOSTIC_BYTES: usize = 64 * 1024;
const MAXIMUM_SURFACE_EVENT_BYTES: usize = 2048;
const READINESS_POLL_INTERVAL: Duration = Duration::from_millis(200);
const TRAY_LOGS_ID: &str = "runtime-open-logs";
const TRAY_RESTART_ID: &str = "runtime-restart";

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

fn classify_bundle_failure(error: &BundleResourceError) -> FailureKind {
    match error.kind() {
        BundleResourceKind::Asset => FailureKind::Asset,
        BundleResourceKind::Compatibility => FailureKind::Compatibility,
        BundleResourceKind::Migration => FailureKind::Migration,
        BundleResourceKind::NativeDependency => FailureKind::NativeDependency,
    }
}

fn append_bounded(buffer: &mut String, value: &str) {
    buffer.push_str(value);
    if buffer.len() > MAXIMUM_CAPTURED_DIAGNOSTIC_BYTES {
        let mut boundary = buffer.len() - MAXIMUM_CAPTURED_DIAGNOSTIC_BYTES;
        while !buffer.is_char_boundary(boundary) {
            boundary += 1;
        }
        buffer.drain(..boundary);
    }
}

fn emit_page_load_diagnostic(payload: &PageLoadPayload<'_>) {
    let event = match payload.event() {
        PageLoadEvent::Started => "started",
        PageLoadEvent::Finished => "finished",
    };
    let diagnostic = sanitized_page_load_diagnostic(payload.url(), event);
    match serde_json::to_string(&diagnostic) {
        Ok(encoded) if encoded.len() <= MAXIMUM_SURFACE_EVENT_BYTES => {
            eprintln!("{DESKTOP_PAGE_LOAD_EVENT_PREFIX}{encoded}");
        }
        Ok(_) => print_error_chain(&io::Error::new(
            io::ErrorKind::InvalidData,
            "Floway desktop page-load diagnostic exceeded its byte bound",
        )),
        Err(error) => print_error_chain(&error),
    }
}

struct DesktopTray {
    _icon: TrayIcon<tauri::Wry>,
    logs: MenuItem<tauri::Wry>,
    messages: &'static DesktopMessages,
    restart: MenuItem<tauri::Wry>,
    status: MenuItem<tauri::Wry>,
}

impl DesktopTray {
    fn build(app: &AppHandle) -> Result<Self, Box<dyn Error>> {
        let messages = system_messages();
        let status = MenuItem::with_id(
            app,
            "runtime-status",
            messages.status_starting,
            false,
            None::<&str>,
        )?;
        let restart = MenuItem::with_id(
            app,
            TRAY_RESTART_ID,
            messages.restart_gateway,
            false,
            None::<&str>,
        )?;
        let logs = MenuItem::with_id(app, TRAY_LOGS_ID, messages.open_logs, true, None::<&str>)?;
        let menu = Menu::with_items(app, &[&status, &restart, &logs])?;
        // Tauri's tray builder owns native menu callbacks and supports runtime
        // tooltip updates on every desktop target.
        // https://github.com/tauri-apps/tauri/blob/tauri-v2.11.5/crates/tauri/src/tray/mod.rs#L203-L378
        let mut builder = TrayIconBuilder::with_id("floway-runtime")
            .menu(&menu)
            .tooltip(messages.tooltip_starting);
        if let Some(icon) = app.default_window_icon() {
            builder = builder.icon(icon.clone());
        }
        let icon = builder
            .on_menu_event(|app, event| match event.id().as_ref() {
                TRAY_RESTART_ID => restart_failed_runtime(app),
                TRAY_LOGS_ID => open_logs(app),
                _ => {}
            })
            .build(app)?;
        Ok(Self {
            _icon: icon,
            logs,
            messages,
            restart,
            status,
        })
    }

    fn set_phase(
        &self,
        phase: RuntimePhase,
        restart_enabled: bool,
        logs_enabled: bool,
    ) -> Result<(), Box<dyn Error>> {
        let (label, tooltip) = match phase {
            RuntimePhase::Starting => (
                self.messages.status_starting,
                self.messages.tooltip_starting,
            ),
            RuntimePhase::Ready => (self.messages.status_running, self.messages.tooltip_running),
            RuntimePhase::Failed => (
                self.messages.status_needs_attention,
                self.messages.tooltip_needs_attention,
            ),
        };
        self.status.set_text(label)?;
        self.restart.set_enabled(restart_enabled)?;
        self.logs.set_enabled(logs_enabled)?;
        self._icon.set_tooltip(Some(tooltip))?;
        Ok(())
    }

    fn diagnostic_snapshot(&self) -> Result<serde_json::Value, Box<dyn Error>> {
        // These getters read the same native menu items updated by set_phase.
        // https://github.com/tauri-apps/tauri/blob/tauri-v2.11.5/crates/tauri/src/menu/normal.rs#L87-L106
        Ok(serde_json::json!({
            "logs": {
                "enabled": self.logs.is_enabled()?,
                "text": self.logs.text()?,
            },
            "restart": {
                "enabled": self.restart.is_enabled()?,
                "text": self.restart.text()?,
            },
            "status": {
                "enabled": self.status.is_enabled()?,
                "text": self.status.text()?,
            },
        }))
    }
}

struct DesktopController {
    attempts: Mutex<RuntimeAttemptState>,
    dashboard_policy: RwLock<Option<DashboardNavigationPolicy>>,
    log: Mutex<Option<BoundedSidecarLog>>,
    logs_dir: PathBuf,
    pending_failure_surface: Mutex<Option<FailureKind>>,
    status_url: Url,
    supervisor: Arc<PackageProcessSupervisor>,
    tray: DesktopTray,
}

impl DesktopController {
    fn begin_attempt(&self) -> Option<u64> {
        let generation = self
            .attempts
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .begin()?;
        *self
            .dashboard_policy
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
        Some(generation)
    }

    fn is_starting(&self, generation: u64) -> bool {
        self.attempts
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .is_starting(generation)
    }

    fn commit_ready(
        &self,
        generation: u64,
        effects: impl FnOnce() -> Result<(), Box<dyn Error>>,
    ) -> Result<bool, Box<dyn Error>> {
        self.attempts
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .commit_ready(generation, |_attempt| effects())
    }

    fn mark_startup_failed(&self, generation: u64, kind: FailureKind) -> bool {
        self.attempts
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .mark_startup_failed(generation, kind)
    }

    fn mark_failed(&self, generation: u64, kind: FailureKind) -> bool {
        self.attempts
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .mark_failed(generation, kind)
    }

    fn phase(&self) -> RuntimePhase {
        self.attempts
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .phase()
    }

    fn complete_teardown(&self, generation: u64) -> bool {
        self.attempts
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .complete_teardown(generation)
    }

    fn restart_available(&self) -> bool {
        self.attempts
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .restart_available()
    }

    fn status(&self) -> DesktopRuntimeStatus {
        self.attempts
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .status()
    }

    fn set_logs_available(&self, available: bool) {
        self.attempts
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .set_logs_available(available);
    }

    fn append_log(&self, stream: SidecarStream, bytes: &[u8]) -> io::Result<()> {
        let mut log = self
            .log
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let result = (|| {
            if log.is_none() {
                *log = Some(BoundedSidecarLog::open(&self.logs_dir)?);
            }
            log.as_mut()
                .expect("sidecar log must be initialized")
                .append(stream, bytes)
        })();
        drop(log);
        self.set_logs_available(result.is_ok());
        result
    }
}

fn desktop_status_value(status: DesktopRuntimeStatus) -> serde_json::Value {
    status.to_wire_value()
}

fn emit_desktop_status(app: &AppHandle, status: DesktopRuntimeStatus) -> Result<(), tauri::Error> {
    app.emit(DESKTOP_STATUS_EVENT, desktop_status_value(status))
}

fn status_url(controller: &DesktopController, report: Option<&FailureReport>) -> Url {
    let mut url = controller.status_url.clone();
    url.set_query(None);
    url.set_fragment(None);
    let status = controller.status();
    {
        let mut query = url.query_pairs_mut();
        query.append_pair(
            "state",
            match status.phase {
                RuntimePhase::Failed => "failed",
                RuntimePhase::Ready => "ready",
                RuntimePhase::Starting => "starting",
            },
        );
        if let Some(report) = report {
            query.append_pair("kind", report.kind.as_str());
        }
    }
    url
}

fn show_status(app: &AppHandle, report: Option<&FailureReport>) -> Result<(), Box<dyn Error>> {
    let controller = app.state::<Arc<DesktopController>>();
    let window = app.get_webview_window("main").ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::NotFound,
            "Floway main recovery window is unavailable",
        )
    })?;
    let url = status_url(controller.inner(), report);
    apply_recovery_surface(
        || window.navigate(url),
        || window.show(),
        || window.set_focus(),
    )?;
    Ok(())
}

fn emit_failure_surface_snapshot(app: AppHandle, kind: FailureKind, loaded_url: Url) {
    let snapshot = (|| -> Result<serde_json::Value, Box<dyn Error>> {
        let controller = app.state::<Arc<DesktopController>>();
        let window = app.get_webview_window("main").ok_or_else(|| {
            io::Error::new(io::ErrorKind::NotFound, "Floway main window is unavailable")
        })?;
        // Combine the actual Tauri finished-load URL with the live window and
        // menu objects, but serialize only whitelisted fields so bootstrap
        // authority and unrestricted diagnostics never enter this event.
        // https://github.com/tauri-apps/tauri/blob/tauri-v2.11.5/crates/tauri/src/webview/mod.rs#L313-L336
        // https://github.com/tauri-apps/tauri/blob/tauri-v2.11.5/crates/tauri/src/webview/webview_window.rs#L2379-L2382
        let route = loaded_url.path();
        if route.trim_matches('/') != DESKTOP_STATUS_ROUTE
            || controller.phase() != RuntimePhase::Failed
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Floway finished failure route does not match its runtime state",
            )
            .into());
        }
        Ok(serde_json::json!({
            "failureKind": kind.as_str(),
            "phase": "failed",
            "tray": controller.tray.diagnostic_snapshot()?,
            "window": {
                "failureKind": kind.as_str(),
                "route": route,
                "state": "failed",
                "title": window.title()?,
                "visible": window.is_visible()?,
            },
        }))
    })();
    match snapshot.and_then(|value| serde_json::to_string(&value).map_err(Into::into)) {
        Ok(encoded) if encoded.len() <= MAXIMUM_SURFACE_EVENT_BYTES => {
            eprintln!("{DESKTOP_SURFACE_EVENT_PREFIX}{encoded}");
        }
        Ok(_) => print_error_chain(&io::Error::new(
            io::ErrorKind::InvalidData,
            "Floway desktop surface diagnostic exceeded its byte bound",
        )),
        Err(error) => print_error_chain(error.as_ref()),
    }
}

fn emit_pending_failure_surface(app: &AppHandle) {
    let controller = app.state::<Arc<DesktopController>>();
    if !controller.status().restart_available {
        return;
    }
    let kind = controller
        .pending_failure_surface
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .take();
    let Some(kind) = kind else {
        return;
    };
    let Some(window) = app.get_webview_window("main") else {
        print_error_chain(&io::Error::new(
            io::ErrorKind::NotFound,
            "Floway main recovery window is unavailable for support diagnostics",
        ));
        app.exit(1);
        return;
    };
    match window.url() {
        Ok(loaded_url) => {
            let snapshot_app = app.clone();
            thread::spawn(move || emit_failure_surface_snapshot(snapshot_app, kind, loaded_url));
        }
        Err(error) => {
            print_error_chain(&error);
            app.exit(1);
        }
    }
}

fn complete_failure_teardown(app: &AppHandle, generation: u64, kind: FailureKind) {
    let controller = app.state::<Arc<DesktopController>>().inner().clone();
    if !controller.complete_teardown(generation) {
        return;
    }
    let status = controller.status();
    if let Err(error) = controller.tray.set_phase(
        RuntimePhase::Failed,
        status.restart_available,
        status.logs_available,
    ) {
        print_error_chain(error.as_ref());
        app.exit(1);
        return;
    }
    debug_assert_eq!(status.failure_kind, Some(kind));
    if let Err(error) = emit_desktop_status(app, status) {
        print_error_chain(&error);
        app.exit(1);
        return;
    }
    emit_pending_failure_surface(app);
}

fn publish_failure(app: &AppHandle, generation: u64, report: FailureReport, stop: bool) {
    let controller = app.state::<Arc<DesktopController>>().inner().clone();
    let status = controller.status();
    if let Err(error) = controller.tray.set_phase(
        RuntimePhase::Failed,
        status.restart_available,
        status.logs_available,
    ) {
        print_error_chain(error.as_ref());
        app.exit(1);
    }
    let detail = report.chain.join("\n\ncaused by: ");
    eprintln!("Floway desktop runtime failure: {detail}");
    if let Err(error) = controller.append_log(SidecarStream::Stderr, detail.as_bytes()) {
        eprintln!("Floway desktop could not persist its runtime failure report: {error}");
    }
    eprintln!(
        "Floway desktop runtime state: failed kind={}",
        report.kind.as_str()
    );
    if let Err(error) = emit_desktop_status(app, controller.status()) {
        print_error_chain(&error);
        app.exit(1);
    }
    *controller
        .pending_failure_surface
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(report.kind);
    if let Err(error) = show_status(app, Some(&report)) {
        print_error_chain(error.as_ref());
        app.exit(1);
    }
    if stop {
        let supervisor = Arc::clone(&controller.supervisor);
        let teardown_app = app.clone();
        let kind = report.kind;
        thread::spawn(move || {
            if let Err(error) = supervisor.stop_now() {
                print_error_chain(&error);
                teardown_app.exit(1);
                return;
            }
            complete_failure_teardown(&teardown_app, generation, kind);
        });
    } else {
        complete_failure_teardown(app, generation, report.kind);
    }
}

fn fail_startup_attempt(app: &AppHandle, generation: u64, report: FailureReport, stop: bool) {
    let controller = app.state::<Arc<DesktopController>>();
    if controller.mark_startup_failed(generation, report.kind) {
        publish_failure(app, generation, report, stop);
    }
}

fn fail_current_attempt(app: &AppHandle, generation: u64, report: FailureReport, stop: bool) {
    let controller = app.state::<Arc<DesktopController>>();
    if controller.mark_failed(generation, report.kind) {
        publish_failure(app, generation, report, stop);
    }
}

fn mark_runtime_ready(app: &AppHandle, generation: u64, origin: &str, bootstrap_token: &str) {
    let controller = app.state::<Arc<DesktopController>>().inner().clone();
    let policy = match DashboardNavigationPolicy::new(origin, bootstrap_token) {
        Ok(policy) => policy,
        Err(error) => {
            fail_startup_attempt(
                app,
                generation,
                FailureReport::from_error(FailureKind::Compatibility, error.as_ref()),
                true,
            );
            return;
        }
    };
    let dashboard_url = policy.bootstrap_url().clone();
    let ready = controller.commit_ready(generation, || {
        let effects = (|| -> Result<(), Box<dyn Error>> {
            *controller
                .dashboard_policy
                .write()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(policy);
            controller
                .tray
                .set_phase(RuntimePhase::Ready, false, true)?;
            if let Some(window) = app.get_webview_window("main") {
                window
                    .navigate(dashboard_url)
                    .and_then(|()| window.set_title("Floway"))
                    .and_then(|()| window.show())
                    .and_then(|()| window.set_focus())?;
            }
            Ok(())
        })();
        if effects.is_err() {
            *controller
                .dashboard_policy
                .write()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
        }
        effects
    });
    if let Err(error) = ready {
        fail_startup_attempt(
            app,
            generation,
            FailureReport::from_error(FailureKind::Asset, error.as_ref()),
            true,
        );
    }
}

fn begin_health_probe(
    app: AppHandle,
    generation: u64,
    origin: String,
    runtime: RuntimeBundle,
    bootstrap_token: String,
    deadline: Instant,
) {
    thread::spawn(move || {
        loop {
            let controller = app.state::<Arc<DesktopController>>();
            if !controller.is_starting(generation) {
                return;
            }
            match probe_compatible_runtime(&origin, &runtime.compatibility) {
                Ok(()) => {
                    mark_runtime_ready(&app, generation, &origin, &bootstrap_token);
                    return;
                }
                Err(RuntimeHealthError::Incompatible(message)) => {
                    let error = io::Error::new(io::ErrorKind::InvalidData, message);
                    fail_startup_attempt(
                        &app,
                        generation,
                        FailureReport::from_error(FailureKind::Compatibility, &error),
                        true,
                    );
                    return;
                }
                Err(RuntimeHealthError::Unavailable(_)) if Instant::now() < deadline => {
                    thread::sleep(READINESS_POLL_INTERVAL);
                }
                Err(error) => {
                    fail_startup_attempt(
                        &app,
                        generation,
                        FailureReport::from_error(FailureKind::Timeout, &error),
                        true,
                    );
                    return;
                }
            }
        }
    });
}

fn unexpected_exit_report(
    payload: TerminatedPayload,
    command_error: Option<io::Error>,
) -> FailureReport {
    let error = UnexpectedSidecarExitError {
        code: payload.code,
        signal: payload.signal,
        source: command_error,
    };
    FailureReport::from_error(FailureKind::UnexpectedExit, &error)
}

fn monitor_runtime(
    app: AppHandle,
    generation: u64,
    runtime: RuntimeBundle,
    bootstrap_token: String,
    deadline: Instant,
    mut events: tauri::async_runtime::Receiver<CommandEvent>,
) {
    tauri::async_runtime::spawn(async move {
        let mut readiness_probe_started = false;
        let mut runtime_stdout = String::new();
        let mut structured_failure = None;
        let mut structured_failure_decoder = SidecarFailureDecoder::default();
        let mut command_error = None;
        while let Some(event) = events.recv().await {
            let controller = app.state::<Arc<DesktopController>>().inner().clone();
            match event {
                CommandEvent::Stdout(bytes) => {
                    let output = String::from_utf8_lossy(&bytes);
                    eprintln!("[Floway runtime stdout] {output}");
                    if let Err(error) = controller.append_log(SidecarStream::Stdout, &bytes) {
                        fail_current_attempt(
                            &app,
                            generation,
                            FailureReport::from_error(FailureKind::Storage, &error),
                            true,
                        );
                        continue;
                    }
                    if !readiness_probe_started && controller.is_starting(generation) {
                        append_bounded(&mut runtime_stdout, &output);
                        if let Some(origin) = ready_dashboard_origin(&runtime_stdout) {
                            readiness_probe_started = true;
                            begin_health_probe(
                                app.clone(),
                                generation,
                                origin.to_owned(),
                                runtime.clone(),
                                bootstrap_token.clone(),
                                deadline,
                            );
                        }
                    }
                }
                CommandEvent::Stderr(bytes) => {
                    let output = String::from_utf8_lossy(&bytes);
                    eprintln!("[Floway runtime stderr] {output}");
                    if let Err(error) = controller.append_log(SidecarStream::Stderr, &bytes) {
                        fail_current_attempt(
                            &app,
                            generation,
                            FailureReport::from_error(FailureKind::Storage, &error),
                            true,
                        );
                        continue;
                    }
                    structured_failure = structured_failure_decoder
                        .push(&bytes)
                        .or(structured_failure);
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
                    if controller.supervisor.record_termination() {
                        structured_failure =
                            structured_failure_decoder.finish().or(structured_failure);
                        let report = if controller.phase() == RuntimePhase::Starting {
                            structured_failure
                                .unwrap_or_else(|| unexpected_exit_report(payload, command_error))
                        } else {
                            unexpected_exit_report(payload, command_error)
                        };
                        fail_current_attempt(&app, generation, report, false);
                    }
                    return;
                }
                _ => {}
            }
        }
    });
}

fn start_runtime(app: &AppHandle) {
    let controller = app.state::<Arc<DesktopController>>().inner().clone();
    let Some(generation) = controller.begin_attempt() else {
        return;
    };
    if let Err(error) = controller.tray.set_phase(
        RuntimePhase::Starting,
        false,
        controller.status().logs_available,
    ) {
        print_error_chain(error.as_ref());
        app.exit(1);
        return;
    }
    if let Err(error) = emit_desktop_status(app, controller.status()) {
        print_error_chain(&error);
    }
    if let Err(error) = show_status(app, None) {
        print_error_chain(error.as_ref());
        app.exit(1);
        return;
    }

    let setup = (|| -> Result<_, DesktopStartupError> {
        {
            let mut log = controller
                .log
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if log.is_none() {
                *log = Some(
                    BoundedSidecarLog::open(&controller.logs_dir).map_err(|source| {
                        DesktopStartupError::new(
                            FailureKind::Storage,
                            "Floway could not initialize its desktop logs",
                            source,
                        )
                    })?,
                );
            }
        }
        controller.set_logs_available(true);
        let resource_dir = app.path().resource_dir().map_err(|source| {
            DesktopStartupError::new(
                FailureKind::Compatibility,
                "Floway could not locate its packaged resources",
                source,
            )
        })?;
        let runtime = resolve_runtime_bundle(&resource_dir).map_err(|source| {
            DesktopStartupError::new(
                classify_bundle_failure(&source),
                "Floway could not validate its packaged runtime",
                source,
            )
        })?;
        let bootstrap_token = ephemeral_bootstrap_token().map_err(|source| {
            DesktopStartupError::new(
                FailureKind::Compatibility,
                "Floway could not create startup authority",
                source,
            )
        })?;
        let events = controller
            .supervisor
            .spawn_registered(|| {
                app.shell()
                    .sidecar(NODE_SIDECAR_NAME)?
                    .args(runtime.sidecar_arguments())
                    .current_dir(&runtime.root)
                    .env(PERSONAL_DASHBOARD_BOOTSTRAP_ENV, bootstrap_token.clone())
                    .env(DESKTOP_RUNTIME_CONTRACT_ENV, runtime.contract.clone())
                    .env("FLOWAY_PROFILE", "personal")
                    .env("NODE_ENV", "production")
                    .spawn()
            })
            .map_err(|source| {
                DesktopStartupError::new(
                    FailureKind::NativeDependency,
                    "Floway could not start its packaged runtime",
                    source,
                )
            })?;
        Ok((events, runtime, bootstrap_token))
    })();

    match setup {
        Ok((events, runtime, bootstrap_token)) => {
            let deadline = Instant::now() + STARTUP_TIMEOUT;
            let timeout_app = app.clone();
            thread::spawn(move || {
                thread::sleep(STARTUP_TIMEOUT);
                let error = io::Error::new(
                    io::ErrorKind::TimedOut,
                    "Floway runtime did not become healthy within 30 seconds",
                );
                fail_startup_attempt(
                    &timeout_app,
                    generation,
                    FailureReport::from_error(FailureKind::Timeout, &error),
                    true,
                );
            });
            monitor_runtime(
                app.clone(),
                generation,
                runtime,
                bootstrap_token,
                deadline,
                events,
            );
        }
        Err(error) => {
            let kind = error.kind();
            print_error_chain(&error);
            fail_startup_attempt(
                app,
                generation,
                FailureReport::from_error(kind, &error),
                false,
            );
        }
    }
}

fn open_logs(app: &AppHandle) {
    let controller = app.state::<Arc<DesktopController>>();
    if !controller.status().logs_available {
        return;
    }
    #[allow(deprecated)]
    let result = fs::create_dir_all(&controller.logs_dir).and_then(|()| {
        app.shell()
            .open(controller.logs_dir.to_string_lossy(), None)
            .map_err(io::Error::other)
    });
    if let Err(error) = result {
        print_error_chain(&error);
    }
}

fn restart_failed_runtime(app: &AppHandle) {
    let controller = app.state::<Arc<DesktopController>>();
    if controller.phase() == RuntimePhase::Failed && controller.restart_available() {
        start_runtime(app);
    }
}

fn handle_navigation(app: &AppHandle, candidate: &Url, new_window: bool) -> bool {
    if let Some(action) = desktop_action(candidate) {
        match action {
            DesktopAction::OpenLogs => open_logs(app),
            DesktopAction::Restart => restart_failed_runtime(app),
        }
        return false;
    }
    if is_desktop_status_navigation(candidate, new_window) {
        return true;
    }
    let controller = app.state::<Arc<DesktopController>>();
    let policy = controller
        .dashboard_policy
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let Some(policy) = policy.as_ref() else {
        return false;
    };
    #[allow(deprecated)]
    match enforce_dashboard_navigation(policy, candidate, new_window, |external| {
        app.shell().open(external.as_str(), None)
    }) {
        Ok(allow) => allow,
        Err(error) => {
            print_error_chain(&error);
            app.exit(1);
            false
        }
    }
}

#[tauri::command]
fn report_desktop_recovery_surface(
    app: AppHandle,
    surface: serde_json::Value,
) -> Result<(), String> {
    let diagnostic = recovery_surface_diagnostic(&surface).map_err(|error| {
        print_error_chain(&error);
        error.to_string()
    })?;
    let encoded = serde_json::to_string(&diagnostic).map_err(|error| {
        print_error_chain(&error);
        error.to_string()
    })?;
    if encoded.len() > MAXIMUM_SURFACE_EVENT_BYTES {
        let error = io::Error::new(
            io::ErrorKind::InvalidData,
            "Floway recovery support diagnostic exceeded its byte bound",
        );
        print_error_chain(&error);
        return Err(error.to_string());
    }
    let controller = app.state::<Arc<DesktopController>>();
    let status = controller.status();
    if status.phase != RuntimePhase::Failed
        || status.failure_kind.map(FailureKind::as_str)
            != diagnostic
                .get("failureKind")
                .and_then(serde_json::Value::as_str)
        || status.restart_available
            != diagnostic
                .get("restartEnabled")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false)
        || status.logs_available
            != diagnostic
                .get("logsAvailable")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false)
        || Some(status.revision)
            != diagnostic
                .get("revision")
                .and_then(serde_json::Value::as_u64)
    {
        let error = io::Error::new(
            io::ErrorKind::InvalidData,
            "Floway recovery support state does not match the owning runtime state",
        );
        print_error_chain(&error);
        return Err(error.to_string());
    }
    eprintln!("{DESKTOP_RECOVERY_SURFACE_EVENT_PREFIX}{encoded}");
    controller
        .append_log(
            SidecarStream::Stderr,
            format!("{DESKTOP_RECOVERY_SURFACE_EVENT_PREFIX}{encoded}").as_bytes(),
        )
        .map_err(|error| {
            print_error_chain(&error);
            error.to_string()
        })?;
    Ok(())
}

#[tauri::command]
fn desktop_runtime_status(app: AppHandle) -> serde_json::Value {
    let controller = app.state::<Arc<DesktopController>>();
    desktop_status_value(controller.status())
}

fn stop_packaged_process(app_handle: &AppHandle) {
    let Some(controller) = app_handle.try_state::<Arc<DesktopController>>() else {
        return;
    };
    match controller.supervisor.stop_now() {
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
        .invoke_handler(tauri::generate_handler![
            desktop_runtime_status,
            report_desktop_recovery_surface,
        ])
        .setup(|app| {
            let app_handle = app.handle().clone();
            // The local status route is bundled with the Dashboard build but
            // remains shell-owned. Only a compatible loopback runtime replaces it.
            // https://github.com/tauri-apps/tauri/blob/tauri-v2.11.5/crates/tauri/src/webview/webview_window.rs#L57-L111
            let navigation_app = app_handle.clone();
            let new_window_app = app_handle.clone();
            let initial_status_load_gate = Arc::new(InitialStatusLoadGate::default());
            let page_load_gate = Arc::clone(&initial_status_load_gate);
            let page_load_app = app_handle.clone();
            let window = WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::App(DESKTOP_STATUS_ROUTE.into()),
            )
            .on_navigation(move |candidate| handle_navigation(&navigation_app, candidate, false))
            .on_new_window(move |candidate, _features| {
                handle_navigation(&new_window_app, &candidate, true);
                NewWindowResponse::Deny
            })
            .on_page_load(move |_window, payload| {
                emit_page_load_diagnostic(&payload);
                if payload.event() == PageLoadEvent::Finished
                    && is_desktop_status_navigation(payload.url(), false)
                {
                    if let Some(controller) = page_load_app.try_state::<Arc<DesktopController>>() {
                        if controller.status().restart_available {
                            emit_pending_failure_surface(&page_load_app);
                        }
                    }
                    if page_load_gate.mark_loaded() {
                        start_runtime(&page_load_app);
                    }
                }
            })
            .title("Floway")
            .inner_size(720.0, 560.0)
            .min_inner_size(520.0, 420.0)
            .build()?;
            let status_url = window.url()?;
            let logs_dir: Result<PathBuf, Box<dyn Error>> = app
                .path()
                .data_dir()
                .map_err(|error| Box::new(error) as Box<dyn Error>)
                .and_then(|platform_data_dir| {
                    DesktopPaths::from_args(platform_data_dir, std::env::args_os())
                        .map(|paths| paths.logs())
                        .map_err(|error| Box::new(error) as Box<dyn Error>)
                });
            let (logs_dir, logs_dir_error) = match logs_dir {
                Ok(logs_dir) => (logs_dir, None),
                Err(error) => (PathBuf::new(), Some(error)),
            };
            let tray = DesktopTray::build(&app_handle)?;
            let controller = Arc::new(DesktopController {
                attempts: Mutex::new(RuntimeAttemptState::new()),
                dashboard_policy: RwLock::new(None),
                log: Mutex::new(None),
                logs_dir,
                pending_failure_surface: Mutex::new(None),
                status_url,
                supervisor: PackageProcessSupervisor::new(),
                tray,
            });
            app.manage(controller);
            if let Some(error) = logs_dir_error {
                let controller = app_handle.state::<Arc<DesktopController>>();
                let generation = controller
                    .begin_attempt()
                    .expect("the initial desktop runtime attempt must begin");
                fail_startup_attempt(
                    &app_handle,
                    generation,
                    FailureReport::from_error(FailureKind::Storage, error.as_ref()),
                    false,
                );
            } else if initial_status_load_gate.arm() {
                start_runtime(&app_handle);
            } else {
                let timeout_gate = Arc::clone(&initial_status_load_gate);
                let timeout_app = app_handle.clone();
                thread::spawn(move || {
                    thread::sleep(STARTUP_TIMEOUT);
                    if !timeout_gate.time_out() {
                        return;
                    }
                    let controller = timeout_app.state::<Arc<DesktopController>>();
                    let generation = controller
                        .begin_attempt()
                        .expect("the initial desktop status timeout must begin an attempt");
                    let error = io::Error::new(
                        io::ErrorKind::TimedOut,
                        "Floway initial status document did not finish loading within 30 seconds",
                    );
                    fail_startup_attempt(
                        &timeout_app,
                        generation,
                        FailureReport::from_error(FailureKind::Asset, &error),
                        false,
                    );
                });
            }
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
