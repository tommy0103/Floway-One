//! Owns the bounded packaged-runtime readiness and visible recovery state.

use std::error::Error;
use std::fmt::{Display, Formatter};
use std::fs;
use std::io::{self, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex, RwLock};
use std::thread;
use std::time::{Duration, Instant};

use getrandom::fill;
use serde_json::{Value, json};
use tauri::menu::{CheckMenuItem, Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::webview::{NewWindowResponse, PageLoadEvent, PageLoadPayload};
use tauri::{AppHandle, Emitter, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::{CommandEvent, TerminatedPayload};
use url::Url;

use crate::DESKTOP_RUNTIME_CONTRACT_ENV;
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
use crate::print_error_chain;
use crate::rendered_snapshot::capture_rendered_snapshot;
use crate::runtime_status::{
    DesktopRuntimeStatus, DesktopStartupError, FailureKind, FailureReport, InitialStatusLoadGate,
    RuntimeAttemptState, RuntimeHealthError, RuntimePhase, STARTUP_TIMEOUT, SidecarFailureDecoder,
    apply_recovery_surface, probe_compatible_runtime,
};
use crate::shell_autostart::{
    ShellAutostart, launch_agents_dir, launchctl_domain, login_item_program_arguments,
};
use crate::shell_singleton::{
    ShellCommand, ShellOwnership, claim_shell_ownership, control_socket_path,
    parse_control_command, read_shell_command, send_shell_command, write_shell_reply,
};
use crate::sidecar_log::{BoundedSidecarLog, SidecarStream};
use crate::sidecar_supervisor::{
    GRACEFUL_STOP_SIGNAL_TIMEOUT, PackageProcessSupervisor, UnexpectedSidecarExitError,
};
use crate::update_controller::{
    DesktopUpdateController, INSTALL_STAGED_UPDATE_ARGUMENT, resolve_install_bundle,
};

const DESKTOP_PAGE_LOAD_EVENT_PREFIX: &str = "FLOWAY_DESKTOP_PAGE_LOAD ";
const DESKTOP_SURFACE_EVENT_PREFIX: &str = "FLOWAY_DESKTOP_SURFACE ";
const DESKTOP_RECOVERY_SURFACE_EVENT_PREFIX: &str = "FLOWAY_DESKTOP_RECOVERY_SURFACE ";
const DESKTOP_UPDATE_SURFACE_EVENT_PREFIX: &str = "FLOWAY_DESKTOP_UPDATE_SURFACE ";
const DESKTOP_STATUS_EVENT: &str = "floway-desktop-status";
const MAXIMUM_CAPTURED_DIAGNOSTIC_BYTES: usize = 64 * 1024;
const MAXIMUM_SURFACE_EVENT_BYTES: usize = 2048;
const RECOVERY_SNAPSHOT_FILE_NAME: &str = "recovery-surface.png";
const READINESS_POLL_INTERVAL: Duration = Duration::from_millis(200);
const RESTART_SETTLE_TIMEOUT: Duration = Duration::from_secs(20);
const TRAY_AUTOSTART_ID: &str = "tray-autostart";
const TRAY_COPY_ADDRESS_ID: &str = "tray-copy-address";
const TRAY_LOGS_ID: &str = "runtime-open-logs";
const TRAY_OPEN_ID: &str = "tray-open";
const TRAY_QUIT_ID: &str = "tray-quit";
const TRAY_RESTART_ID: &str = "runtime-restart";
const TRAY_UPDATE_ID: &str = "runtime-update";

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

struct TrayPhaseUpdate<'a> {
    copy_enabled: bool,
    logs_enabled: bool,
    origin: Option<&'a str>,
    restart_enabled: bool,
}

impl TrayPhaseUpdate<'_> {
    fn failed(status: &DesktopRuntimeStatus) -> Self {
        Self {
            copy_enabled: false,
            logs_enabled: status.logs_available,
            origin: None,
            restart_enabled: status.restart_available,
        }
    }
}

struct DesktopTray {
    _icon: TrayIcon<tauri::Wry>,
    autostart: CheckMenuItem<tauri::Wry>,
    copy_address: MenuItem<tauri::Wry>,
    logs: MenuItem<tauri::Wry>,
    messages: &'static DesktopMessages,
    open: MenuItem<tauri::Wry>,
    quit: MenuItem<tauri::Wry>,
    restart: MenuItem<tauri::Wry>,
    status: MenuItem<tauri::Wry>,
    update: MenuItem<tauri::Wry>,
}

impl DesktopTray {
    fn build(app: &AppHandle) -> Result<Self, Box<dyn Error>> {
        let messages = system_messages();
        let open = MenuItem::with_id(app, TRAY_OPEN_ID, messages.open_floway, true, None::<&str>)?;
        let status = MenuItem::with_id(
            app,
            "runtime-status",
            messages.status_starting,
            false,
            None::<&str>,
        )?;
        let copy_address = MenuItem::with_id(
            app,
            TRAY_COPY_ADDRESS_ID,
            messages.copy_gateway_address,
            false,
            None::<&str>,
        )?;
        let update = MenuItem::with_id(
            app,
            TRAY_UPDATE_ID,
            messages.update_install,
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
        let autostart = CheckMenuItem::with_id(
            app,
            TRAY_AUTOSTART_ID,
            messages.launch_at_login,
            true,
            false,
            None::<&str>,
        )?;
        let logs = MenuItem::with_id(app, TRAY_LOGS_ID, messages.open_logs, true, None::<&str>)?;
        let quit = MenuItem::with_id(app, TRAY_QUIT_ID, messages.quit_floway, true, None::<&str>)?;
        let menu = Menu::with_items(
            app,
            &[
                &open,
                &status,
                &update,
                &copy_address,
                &restart,
                &autostart,
                &logs,
                &quit,
            ],
        )?;
        // Tauri's tray builder owns native menu callbacks and supports runtime
        // tooltip updates on every desktop target.
        // https://github.com/tauri-apps/tauri/blob/tauri-v2.11.5/crates/tauri/src/tray/mod.rs#L203-L378
        let mut builder = TrayIconBuilder::with_id("floway-runtime")
            .menu(&menu)
            // The spec binds window restore to the tray icon click, so the menu
            // moves to the secondary click and the primary click reopens the
            // main window.
            .show_menu_on_left_click(false)
            .tooltip(messages.tooltip_starting);
        if let Some(icon) = app.default_window_icon() {
            builder = builder.icon(icon.clone());
        }
        let icon = builder
            .on_menu_event(|app, event| match event.id().as_ref() {
                TRAY_OPEN_ID => activate_main_window(app),
                TRAY_COPY_ADDRESS_ID => {
                    if let Err(error) = copy_gateway_address(app) {
                        print_error_chain(error.as_ref());
                    }
                }
                TRAY_UPDATE_ID => {
                    let controller = app.state::<Arc<DesktopController>>();
                    if controller.update.staged_version().is_some() {
                        install_update_from_tray(app);
                    } else {
                        open_previous_version_download(app);
                    }
                }
                TRAY_RESTART_ID => {
                    if let Err(error) = restart_gateway(app) {
                        print_error_chain(error.as_ref());
                    }
                }
                TRAY_AUTOSTART_ID => toggle_autostart_from_menu(app),
                TRAY_LOGS_ID => open_logs(app),
                TRAY_QUIT_ID => quit_floway(app),
                _ => {}
            })
            .on_tray_icon_event(|tray, event| {
                if let TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } = event
                {
                    activate_main_window(tray.app_handle());
                }
            })
            .build(app)?;
        Ok(Self {
            _icon: icon,
            autostart,
            copy_address,
            logs,
            messages,
            open,
            quit,
            restart,
            status,
            update,
        })
    }

    fn set_update(
        &self,
        staged_version: Option<&str>,
        update_failed: bool,
    ) -> Result<(), Box<dyn Error>> {
        if let Some(version) = staged_version {
            self.update.set_text(
                self.messages
                    .update_install_version
                    .replace("{version}", version),
            )?;
            self.update.set_enabled(true)?;
        } else if update_failed {
            self.update.set_text(self.messages.update_failed)?;
            self.update.set_enabled(true)?;
        } else {
            self.update.set_text(self.messages.update_install)?;
            self.update.set_enabled(false)?;
        }
        Ok(())
    }

    fn set_phase(
        &self,
        phase: RuntimePhase,
        update: TrayPhaseUpdate<'_>,
    ) -> Result<(), Box<dyn Error>> {
        let (label, tooltip) = match phase {
            RuntimePhase::Starting => (
                self.messages.status_starting.to_owned(),
                self.messages.tooltip_starting,
            ),
            RuntimePhase::Ready => (
                match update.origin {
                    Some(origin) => format!("{} — {origin}", self.messages.status_running),
                    None => self.messages.status_running.to_owned(),
                },
                self.messages.tooltip_running,
            ),
            RuntimePhase::Failed => (
                self.messages.status_needs_attention.to_owned(),
                self.messages.tooltip_needs_attention,
            ),
        };
        self.status.set_text(label)?;
        self.copy_address.set_enabled(update.copy_enabled)?;
        self.restart.set_enabled(update.restart_enabled)?;
        self.logs.set_enabled(update.logs_enabled)?;
        self._icon.set_tooltip(Some(tooltip))?;
        Ok(())
    }

    fn autostart_checked(&self) -> bool {
        self.autostart.is_checked().unwrap_or(false)
    }

    fn set_autostart_checked(&self, checked: bool) -> Result<(), Box<dyn Error>> {
        self.autostart.set_checked(checked)?;
        Ok(())
    }

    fn diagnostic_snapshot(&self) -> Result<serde_json::Value, Box<dyn Error>> {
        // These getters read the same native menu items updated by set_phase.
        // https://github.com/tauri-apps/tauri/blob/tauri-v2.11.5/crates/tauri/src/menu/normal.rs#L87-L106
        Ok(serde_json::json!({
            "autostart": {
                "checked": self.autostart_checked(),
                "enabled": self.autostart.is_enabled()?,
                "text": self.autostart.text()?,
            },
            "copyAddress": {
                "enabled": self.copy_address.is_enabled()?,
                "text": self.copy_address.text()?,
            },
            "logs": {
                "enabled": self.logs.is_enabled()?,
                "text": self.logs.text()?,
            },
            "open": {
                "enabled": self.open.is_enabled()?,
                "text": self.open.text()?,
            },
            "quit": {
                "enabled": self.quit.is_enabled()?,
                "text": self.quit.text()?,
            },
            "restart": {
                "enabled": self.restart.is_enabled()?,
                "text": self.restart.text()?,
            },
            "status": {
                "enabled": self.status.is_enabled()?,
                "text": self.status.text()?,
            },
            "update": {
                "enabled": self.update.is_enabled()?,
                "text": self.update.text()?,
            },
        }))
    }
}

struct DesktopController {
    attempts: Mutex<RuntimeAttemptState>,
    autostart: Mutex<Option<ShellAutostart>>,
    dashboard_policy: RwLock<Option<DashboardNavigationPolicy>>,
    data_root: PathBuf,
    gateway_origin: RwLock<Option<String>>,
    log: Mutex<Option<BoundedSidecarLog>>,
    logs_dir: PathBuf,
    pending_failure_surface: Mutex<Option<FailureKind>>,
    status_url: Url,
    supervisor: Arc<PackageProcessSupervisor>,
    tray: DesktopTray,
    update: Arc<DesktopUpdateController>,
    update_tray_signature: Mutex<Option<(bool, bool)>>,
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
        *self
            .gateway_origin
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

    fn mark_startup_failed(&self, generation: u64, report: &FailureReport) -> bool {
        self.attempts
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .mark_startup_failed(generation, report)
    }

    fn mark_failed(&self, generation: u64, report: &FailureReport) -> bool {
        self.attempts
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .mark_failed(generation, report)
    }

    fn phase(&self) -> RuntimePhase {
        self.attempts
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .phase()
    }

    fn gateway_origin(&self) -> Option<String> {
        self.gateway_origin
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    fn current_generation(&self) -> u64 {
        self.attempts
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .current_generation()
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

    fn status_snapshot(&self) -> (DesktopRuntimeStatus, Vec<String>) {
        let attempts = self
            .attempts
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        (attempts.status(), attempts.failure_chain())
    }

    fn persist_lifecycle(&self, line: &str) {
        if let Err(error) = self.append_log(SidecarStream::Stderr, format!("{line}\n").as_bytes()) {
            eprintln!("Floway desktop could not persist its lifecycle log: {error}");
        }
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

fn desktop_status_value(
    status: DesktopRuntimeStatus,
    failure_chain: Vec<String>,
    update: &DesktopUpdateController,
) -> serde_json::Value {
    let mut value = status.to_wire_value();
    let object = value
        .as_object_mut()
        .expect("desktop status wire value must remain an object");
    object.insert("chain".to_owned(), serde_json::json!(failure_chain));
    object.insert("update".to_owned(), update.status_snapshot());
    value
}

fn emit_desktop_status(
    app: &AppHandle,
    controller: &DesktopController,
) -> Result<(), tauri::Error> {
    let (status, failure_chain) = controller.status_snapshot();
    app.emit(
        DESKTOP_STATUS_EVENT,
        desktop_status_value(status, failure_chain, &controller.update),
    )
}

fn status_url(controller: &DesktopController, report: Option<&FailureReport>) -> Url {
    let mut url = controller.status_url.clone();
    url.set_query(None);
    url.set_fragment(None);
    let status = controller.status();
    {
        let mut query = url.query_pairs_mut();
        query.append_pair("state", status.phase.as_str());
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
    if let Err(error) = controller
        .tray
        .set_phase(RuntimePhase::Failed, TrayPhaseUpdate::failed(&status))
    {
        print_error_chain(error.as_ref());
        app.exit(1);
        return;
    }
    debug_assert_eq!(status.failure_kind, Some(kind));
    if let Err(error) = emit_desktop_status(app, &controller) {
        print_error_chain(&error);
        app.exit(1);
        return;
    }
    emit_pending_failure_surface(app);
}

fn publish_failure(app: &AppHandle, generation: u64, report: FailureReport, stop: bool) {
    let controller = app.state::<Arc<DesktopController>>().inner().clone();
    controller.update.after_runtime_failure(&report);
    refresh_update_tray(app);
    let status = controller.status();
    if let Err(error) = controller
        .tray
        .set_phase(RuntimePhase::Failed, TrayPhaseUpdate::failed(&status))
    {
        print_error_chain(error.as_ref());
        app.exit(1);
    }
    let detail = report.chain.join("\n\ncaused by: ");
    eprintln!("Floway desktop runtime failure: {detail}");
    if let Err(error) = controller.append_log(SidecarStream::Stderr, detail.as_bytes()) {
        eprintln!("Floway desktop could not persist its runtime failure report: {error}");
    }
    let state_line = format!(
        "Floway desktop runtime state: failed kind={}",
        report.kind.as_str()
    );
    eprintln!("{state_line}");
    controller.persist_lifecycle(&state_line);
    if let Err(error) = emit_desktop_status(app, &controller) {
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
    if controller.mark_startup_failed(generation, &report) {
        publish_failure(app, generation, report, stop);
    }
}

fn fail_current_attempt(app: &AppHandle, generation: u64, report: FailureReport, stop: bool) {
    let controller = app.state::<Arc<DesktopController>>();
    if controller.mark_failed(generation, &report) {
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
    let owned_origin = origin.to_owned();
    let ready = controller.commit_ready(generation, || {
        let effects = (|| -> Result<(), Box<dyn Error>> {
            *controller
                .dashboard_policy
                .write()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(policy);
            *controller
                .gateway_origin
                .write()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(owned_origin.clone());
            controller.tray.set_phase(
                RuntimePhase::Ready,
                TrayPhaseUpdate {
                    copy_enabled: true,
                    logs_enabled: true,
                    origin: Some(owned_origin.as_str()),
                    restart_enabled: true,
                },
            )?;
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
            *controller
                .gateway_origin
                .write()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
        }
        effects
    });
    match ready {
        Err(error) => {
            fail_startup_attempt(
                app,
                generation,
                FailureReport::from_error(FailureKind::Asset, error.as_ref()),
                true,
            );
        }
        Ok(true) => {
            controller.persist_lifecycle("Floway desktop runtime state: ready");
            let update_app = app.clone();
            controller
                .update
                .after_runtime_ready(app, move || refresh_update_tray(&update_app));
            refresh_update_tray(app);
        }
        Ok(false) => {}
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
    controller.persist_lifecycle("Floway desktop runtime state: starting");
    if let Err(error) = controller.tray.set_phase(
        RuntimePhase::Starting,
        TrayPhaseUpdate {
            copy_enabled: false,
            logs_enabled: controller.status().logs_available,
            origin: None,
            restart_enabled: false,
        },
    ) {
        print_error_chain(error.as_ref());
        app.exit(1);
        return;
    }
    if let Err(error) = emit_desktop_status(app, &controller) {
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
                    format!(
                        "Floway runtime did not become healthy within {} seconds",
                        STARTUP_TIMEOUT.as_secs()
                    ),
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
    controller.persist_lifecycle("Floway desktop operator opened its logs directory");
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

fn main_window(app: &AppHandle) -> Result<tauri::WebviewWindow, Box<dyn Error>> {
    app.get_webview_window("main").ok_or_else(|| {
        Box::new(io::Error::new(
            io::ErrorKind::NotFound,
            "Floway main window is unavailable",
        )) as Box<dyn Error>
    })
}

fn activate_main_window(app: &AppHandle) {
    let result = (|| -> Result<(), Box<dyn Error>> {
        let window = main_window(app)?;
        window.show()?;
        window.unminimize()?;
        window.set_focus()?;
        Ok(())
    })();
    match result {
        Ok(()) => {
            app.state::<Arc<DesktopController>>()
                .persist_lifecycle("Floway desktop restored its main window");
        }
        Err(error) => print_error_chain(error.as_ref()),
    }
}

fn hide_main_window(app: &AppHandle) -> Result<(), Box<dyn Error>> {
    let window = main_window(app)?;
    window.hide()?;
    app.state::<Arc<DesktopController>>()
        .persist_lifecycle("Floway desktop hid its main window; the Gateway keeps running");
    Ok(())
}

/// Drives the production close gesture: `WebviewWindow::close` emits
/// `WindowEvent::CloseRequested`, and the shell's window-event handler
/// prevents the close and hides the window — the exact chain the native
/// close button takes.
/// https://github.com/tauri-apps/tauri/blob/tauri-v2.11.5/crates/tauri/src/window/mod.rs#L1791-L1795
fn close_main_window(app: &AppHandle) -> Result<(), Box<dyn Error>> {
    main_window(app)?.close()?;
    Ok(())
}

fn emit_update_surface_snapshot(controller: &DesktopController) {
    let snapshot = (|| -> Result<serde_json::Value, Box<dyn Error>> {
        let update = controller.update.status_snapshot();
        Ok(serde_json::json!({
            "tray": controller.tray.diagnostic_snapshot()?,
            "update": {
                "failurePhase": update
                    .get("failure")
                    .and_then(|failure| failure.get("phase"))
                    .cloned()
                    .unwrap_or(serde_json::Value::Null),
                "previousVersionDownload": update
                    .get("previousDownloadUrl")
                    .is_some_and(|url| url.as_str().is_some()),
                "recoveryPointAvailable": update
                    .get("recoveryPointAvailable")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false),
                "stagedVersion": update.get("stagedVersion").cloned(),
                "version": update
                    .get("pendingVersion")
                    .cloned()
                    .filter(|version| !version.is_null())
                    .or_else(|| {
                        update
                            .get("failure")
                            .and_then(|failure| failure.get("version"))
                            .cloned()
                    }),
            },
        }))
    })();
    match snapshot.and_then(|value| serde_json::to_string(&value).map_err(Into::into)) {
        Ok(encoded) if encoded.len() <= MAXIMUM_SURFACE_EVENT_BYTES => {
            eprintln!("{DESKTOP_UPDATE_SURFACE_EVENT_PREFIX}{encoded}");
        }
        Ok(_) => print_error_chain(&io::Error::new(
            io::ErrorKind::InvalidData,
            "Floway desktop update surface diagnostic exceeded its byte bound",
        )),
        Err(error) => print_error_chain(error.as_ref()),
    }
}

fn refresh_update_tray(app: &AppHandle) {
    let controller = app.state::<Arc<DesktopController>>().inner().clone();
    let (staged, update_failed) = controller.update.tray_state();
    if let Err(error) = controller.tray.set_update(staged.as_deref(), update_failed) {
        print_error_chain(error.as_ref());
        return;
    }
    let signature = (staged.is_some(), update_failed);
    let mut last = controller
        .update_tray_signature
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if *last == Some(signature) {
        return;
    }
    *last = Some(signature);
    drop(last);
    emit_update_surface_snapshot(&controller);
}

fn open_previous_version_download(app: &AppHandle) {
    let controller = app.state::<Arc<DesktopController>>();
    let snapshot = controller.update.status_snapshot();
    let Some(url) = snapshot
        .get("previousDownloadUrl")
        .and_then(serde_json::Value::as_str)
    else {
        return;
    };
    controller
        .persist_lifecycle("Floway desktop operator opened the previous-version download entry");
    #[allow(deprecated)]
    if let Err(error) = app.shell().open(url, None) {
        print_error_chain(&error);
    }
}

fn install_staged_update_requested() -> bool {
    std::env::args_os().any(|argument| argument == INSTALL_STAGED_UPDATE_ARGUMENT)
}

// The install runs only after the packaged runtime has stopped, so no LLM
// request can be served while the application bundle is being replaced.
fn run_install_sequence(app: &AppHandle) {
    let controller = app.state::<Arc<DesktopController>>().inner().clone();
    let runtime_active = matches!(
        controller.phase(),
        RuntimePhase::Ready | RuntimePhase::Starting
    );
    if runtime_active && controller.supervisor.stop_now().is_err() {
        let error = io::Error::other(
            "Floway could not stop its packaged runtime before installing an update",
        );
        print_error_chain(&error);
        fail_current_attempt(
            app,
            controller.current_generation(),
            FailureReport::from_error(FailureKind::Unknown, &error),
            false,
        );
        return;
    }
    let bundle = match resolve_install_bundle(app) {
        Ok(bundle) => bundle,
        Err(error) => {
            print_error_chain(error.as_ref());
            return;
        }
    };
    match controller.update.install_staged_update(app, &bundle) {
        Ok(()) => app.restart(),
        Err(error) => {
            let (_phase, chain, _version) = error.report();
            let chained = io::Error::other(chain.join("\n\ncaused by: "));
            let report = FailureReport::from_error(FailureKind::Unknown, &chained);
            if runtime_active {
                fail_current_attempt(app, controller.current_generation(), report, false);
            } else if controller.phase() == RuntimePhase::Failed && !controller.restart_available()
            {
                // A startup-time install failure still owes the operator its
                // recovery surface: begin an attempt only to fail it.
                match controller.begin_attempt() {
                    Some(generation) => fail_startup_attempt(app, generation, report, false),
                    None => print_error_chain(&error),
                }
            } else {
                print_error_chain(&error);
            }
        }
    }
}

fn install_update_from_tray(app: &AppHandle) {
    let controller = app.state::<Arc<DesktopController>>();
    if controller.update.staged_version().is_none() {
        return;
    }
    controller.persist_lifecycle("Floway desktop operator started its staged update installation");
    let app = app.clone();
    thread::spawn(move || run_install_sequence(&app));
}

fn copy_gateway_address(app: &AppHandle) -> Result<(), Box<dyn Error>> {
    let controller = app.state::<Arc<DesktopController>>();
    let origin = controller.gateway_origin().ok_or_else(|| {
        Box::new(io::Error::new(
            io::ErrorKind::NotFound,
            "Floway desktop Gateway address is unavailable before the runtime is ready",
        )) as Box<dyn Error>
    })?;
    // The general pasteboard belongs to the login session; pbcopy is the
    // system clipboard writer and needs no accessibility grant.
    // https://keith.github.io/xcode-man-pages/pbcopy.1.html
    let mut pbcopy = Command::new("/usr/bin/pbcopy")
        .stdin(std::process::Stdio::piped())
        .spawn()
        .map_err(|source| {
            Box::new(io::Error::new(
                source.kind(),
                format!("Floway desktop could not start pbcopy: {source}"),
            )) as Box<dyn Error>
        })?;
    pbcopy
        .stdin
        .as_mut()
        .expect("pbcopy stdin must be piped")
        .write_all(origin.as_bytes())
        .map_err(|source| {
            Box::new(io::Error::new(
                source.kind(),
                format!("Floway desktop could not write the Gateway address to pbcopy: {source}"),
            )) as Box<dyn Error>
        })?;
    let status = pbcopy.wait().map_err(|source| {
        Box::new(io::Error::new(
            source.kind(),
            format!("Floway desktop could not wait for pbcopy: {source}"),
        )) as Box<dyn Error>
    })?;
    if !status.success() {
        return Err(Box::new(io::Error::new(
            io::ErrorKind::Other,
            format!("Floway desktop pbcopy exited with {status}"),
        )));
    }
    controller.persist_lifecycle("Floway desktop copied its Gateway address");
    Ok(())
}

fn resolve_shell_autostart(app: &AppHandle) -> Result<ShellAutostart, Box<dyn Error>> {
    // getuid cannot fail.
    // https://keith.github.io/xcode-man-pages/getuid.2.html
    let uid = unsafe { libc::getuid() };
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .filter(|home| home.is_absolute())
        .ok_or_else(|| {
            Box::new(io::Error::new(
                io::ErrorKind::NotFound,
                "Floway desktop could not resolve its home directory for login item registration",
            )) as Box<dyn Error>
        })?;
    let executable = std::env::current_exe().map_err(|source| {
        Box::new(io::Error::new(
            source.kind(),
            format!("Floway desktop could not resolve its own executable path: {source}"),
        )) as Box<dyn Error>
    })?;
    let controller = app.state::<Arc<DesktopController>>();
    if controller.data_root.as_os_str().is_empty() {
        return Err(Box::new(io::Error::new(
            io::ErrorKind::NotFound,
            "Floway desktop has no usable data root for login item registration",
        )));
    }
    Ok(ShellAutostart::new(
        app.config().identifier.clone(),
        launch_agents_dir(&home),
        launchctl_domain(uid),
        login_item_program_arguments(&executable, &controller.data_root),
    ))
}

fn set_autostart(app: &AppHandle, enabled: bool) -> Result<(), Box<dyn Error>> {
    let controller = app.state::<Arc<DesktopController>>().inner().clone();
    {
        let mut autostart = controller
            .autostart
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if autostart.is_none() {
            *autostart = Some(resolve_shell_autostart(app)?);
        }
        let registration = autostart
            .as_ref()
            .expect("login item registration must resolve");
        if enabled {
            registration.enable()?;
        } else {
            registration.disable()?;
        }
    }
    controller.tray.set_autostart_checked(enabled)?;
    controller.persist_lifecycle(if enabled {
        "Floway desktop enabled launch at login"
    } else {
        "Floway desktop disabled launch at login"
    });
    Ok(())
}

fn toggle_autostart_from_menu(app: &AppHandle) {
    let controller = app.state::<Arc<DesktopController>>();
    // muda flips the native check state before delivering the menu event.
    // https://github.com/tauri-apps/muda/blob/v0.19.3/src/platform_impl/macos/mod.rs#L1125-L1130
    let target = controller.tray.autostart_checked();
    if let Err(error) = set_autostart(app, target) {
        print_error_chain(error.as_ref());
        if let Err(revert) = controller.tray.set_autostart_checked(!target) {
            print_error_chain(revert.as_ref());
        }
    }
}

fn restart_gateway(app: &AppHandle) -> Result<(), Box<dyn Error>> {
    let controller = app.state::<Arc<DesktopController>>().inner().clone();
    match controller.phase() {
        RuntimePhase::Ready => {
            controller.persist_lifecycle("Floway desktop operator restarted its runtime");
            let restart_app = app.clone();
            thread::spawn(move || {
                let supervisor = &restart_app.state::<Arc<DesktopController>>().supervisor;
                let settled = match supervisor.stop_gracefully(GRACEFUL_STOP_SIGNAL_TIMEOUT) {
                    Ok(settled) => settled,
                    Err(error) => {
                        print_error_chain(&error);
                        restart_app.exit(1);
                        return;
                    }
                };
                // A simultaneous restart or quit may already be settling the
                // runtime; wait for that teardown before respawning so the
                // re-registration cannot race the previous child.
                if !settled && !supervisor.wait_terminated(RESTART_SETTLE_TIMEOUT) {
                    return;
                }
                start_runtime(&restart_app);
            });
            Ok(())
        }
        RuntimePhase::Failed if controller.restart_available() => {
            controller.persist_lifecycle("Floway desktop operator restarted its runtime");
            start_runtime(app);
            Ok(())
        }
        _ => Err(Box::new(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Floway desktop Gateway cannot restart while it is starting",
        ))),
    }
}

fn quit_floway(app: &AppHandle) {
    app.state::<Arc<DesktopController>>()
        .persist_lifecycle("Floway desktop operator quit; stopping its runtime");
    let quit_app = app.clone();
    thread::spawn(move || {
        stop_packaged_process(&quit_app);
        quit_app.exit(0);
    });
}

fn shell_status_snapshot(app: &AppHandle) -> Result<Value, Box<dyn Error>> {
    let controller = app.state::<Arc<DesktopController>>();
    let window = main_window(app)?;
    Ok(json!({
        "autostartEnabled": controller.tray.autostart_checked(),
        "gatewayOrigin": controller.gateway_origin(),
        "phase": controller.phase().as_str(),
        "tray": controller.tray.diagnostic_snapshot()?,
        "window": {
            "title": window.title()?,
            "visible": window.is_visible()?,
        },
    }))
}

fn dispatch_shell_command(app: &AppHandle, command: ShellCommand) -> Result<Value, Box<dyn Error>> {
    match command {
        ShellCommand::Activate => {
            activate_main_window(app);
            Ok(json!({ "ok": true }))
        }
        ShellCommand::CloseWindow => close_main_window(app).map(|()| json!({ "ok": true })),
        ShellCommand::CopyGatewayAddress => {
            copy_gateway_address(app).map(|()| json!({ "ok": true }))
        }
        ShellCommand::Quit => Ok(json!({ "ok": true })),
        ShellCommand::ReportStatus => {
            shell_status_snapshot(app).map(|status| json!({ "ok": true, "status": status }))
        }
        ShellCommand::RestartGateway => restart_gateway(app).map(|()| json!({ "ok": true })),
        ShellCommand::SetAutostart(enabled) => {
            set_autostart(app, enabled).map(|()| json!({ "ok": true }))
        }
    }
}

fn handle_shell_command(app: AppHandle, mut stream: UnixStream) {
    let command = match read_shell_command(&stream) {
        Ok(Some(command)) => command,
        // An ownership probe opens and closes the channel without a command.
        Ok(None) => return,
        Err(error) => {
            print_error_chain(&error);
            let _ = write_shell_reply(&mut stream, &json!({ "ok": false }));
            return;
        }
    };
    let reply = dispatch_shell_command(&app, command).unwrap_or_else(|error| {
        let chain = error_chain_text(error.as_ref());
        eprintln!("Floway desktop control command failed: {chain}");
        json!({ "error": chain, "ok": false })
    });
    let accepted = reply.get("ok").and_then(Value::as_bool) == Some(true);
    if let Err(error) = write_shell_reply(&mut stream, &reply) {
        print_error_chain(&error);
        return;
    }
    // The quit reply must reach the caller before the shell begins stopping.
    if accepted && command == ShellCommand::Quit {
        quit_floway(&app);
    }
}

fn serve_shell_commands(app: &AppHandle, listener: UnixListener) {
    let server_app = app.clone();
    thread::spawn(move || {
        for connection in listener.incoming() {
            match connection {
                Ok(stream) => {
                    let connection_app = server_app.clone();
                    thread::spawn(move || handle_shell_command(connection_app, stream));
                }
                Err(error) => {
                    eprintln!(
                        "Floway desktop control channel could not accept a connection: {error}"
                    )
                }
            }
        }
    });
}

fn hide_main_window_from_event(app: &AppHandle) {
    if let Err(error) = hide_main_window(app) {
        print_error_chain(error.as_ref());
    }
}

#[derive(Debug)]
struct ShellOwnershipError {
    source: io::Error,
}

impl Display for ShellOwnershipError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "Floway desktop could not claim single-instance ownership of its data root"
        )
    }
}

impl Error for ShellOwnershipError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        Some(&self.source)
    }
}

/// Resolves the control-channel role of this process. A `--desktop-control`
/// invocation forwards its command to the running owner and exits; a plain
/// launch that finds a live owner activates that owner's window and exits;
/// otherwise this process becomes the owner and receives the bound listener.
fn establish_shell_role(data_root: &Path) -> UnixListener {
    let socket_path = control_socket_path(data_root);
    match parse_control_command(std::env::args_os()) {
        Err(error) => {
            print_error_chain(&error);
            std::process::exit(1);
        }
        Ok(Some(command)) => match send_shell_command(&socket_path, command) {
            Ok(reply) => {
                println!(
                    "{}",
                    serde_json::to_string(&reply).expect("control reply must encode")
                );
                std::process::exit(0);
            }
            Err(error) => {
                print_error_chain(&error);
                std::process::exit(1);
            }
        },
        Ok(None) => {}
    }
    match claim_shell_ownership(&socket_path) {
        Ok(ShellOwnership::Owner(listener)) => listener,
        Ok(ShellOwnership::AlreadyRunning) => {
            match send_shell_command(&socket_path, ShellCommand::Activate) {
                Ok(_) => {
                    eprintln!("Floway desktop is already running; activated the existing instance");
                    std::process::exit(0);
                }
                Err(error) => {
                    print_error_chain(&error);
                    std::process::exit(1);
                }
            }
        }
        Err(source) => {
            print_error_chain(&ShellOwnershipError { source });
            std::process::exit(1);
        }
    }
}

fn handle_navigation(app: &AppHandle, candidate: &Url, new_window: bool) -> bool {
    if let Some(action) = desktop_action(candidate) {
        match action {
            DesktopAction::DownloadPreviousVersion => open_previous_version_download(app),
            DesktopAction::OpenLogs => open_logs(app),
            DesktopAction::Restart => {
                if let Err(error) = restart_gateway(app) {
                    print_error_chain(error.as_ref());
                }
            }
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

// The snapshot round trip parks this command on a channel while the browser
// completes it on the main run loop, so it must run off the main thread.
#[tauri::command(async)]
fn report_desktop_recovery_surface(
    app: AppHandle,
    surface: serde_json::Value,
) -> Result<(), String> {
    let diagnostic = recovery_surface_diagnostic(&surface).map_err(|error| {
        print_error_chain(&error);
        error.to_string()
    })?;
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
    let update_snapshot = controller.update.status_snapshot();
    let expected_update = serde_json::json!({
        "previousVersionDownload": update_snapshot
            .get("previousDownloadUrl")
            .is_some_and(|url| url.as_str().is_some()),
        "recoveryPointAvailable": update_snapshot
            .get("recoveryPointAvailable")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false),
        "version": update_snapshot
            .get("pendingVersion")
            .cloned()
            .filter(|version| !version.is_null())
            .or_else(|| {
                update_snapshot
                    .get("failure")
                    .and_then(|failure| failure.get("version"))
                    .cloned()
            }),
    });
    let expected_update_empty = expected_update["version"].is_null()
        && !expected_update["previousVersionDownload"]
            .as_bool()
            .unwrap_or(false)
        && !expected_update["recoveryPointAvailable"]
            .as_bool()
            .unwrap_or(false);
    let update_matches = match diagnostic.get("update") {
        Some(page_update) => !expected_update_empty && page_update == &expected_update,
        None => expected_update_empty,
    };
    if !update_matches {
        let error = io::Error::new(
            io::ErrorKind::InvalidData,
            "Floway recovery support update state does not match the owning update state",
        );
        print_error_chain(&error);
        return Err(error.to_string());
    }
    let window = app.get_webview_window("main").ok_or_else(|| {
        let error = io::Error::new(
            io::ErrorKind::NotFound,
            "Floway main recovery window is unavailable for rendered snapshot evidence",
        );
        print_error_chain(&error);
        error.to_string()
    })?;
    let snapshot = capture_rendered_snapshot(&window).map_err(|error| {
        print_error_chain(&error);
        error.to_string()
    })?;
    let data_root = controller
        .logs_dir
        .parent()
        .map(PathBuf::from)
        .ok_or_else(|| {
            let error = io::Error::new(
                io::ErrorKind::NotFound,
                "Floway desktop data root is unavailable for rendered snapshot evidence",
            );
            print_error_chain(&error);
            error.to_string()
        })?;
    let snapshot_staging = data_root.join(".recovery-surface.png.tmp");
    fs::write(&snapshot_staging, &snapshot.png).map_err(|error| {
        print_error_chain(&error);
        error.to_string()
    })?;
    fs::rename(
        &snapshot_staging,
        data_root.join(RECOVERY_SNAPSHOT_FILE_NAME),
    )
    .map_err(|error| {
        print_error_chain(&error);
        error.to_string()
    })?;
    let mut diagnostic = diagnostic;
    diagnostic
        .as_object_mut()
        .expect("validated recovery diagnostic must remain an object")
        .insert(
            "renderedSnapshot".to_owned(),
            serde_json::json!({
                "algorithm": "sha256-png-v1",
                "byteLength": snapshot.png.len(),
                "sha256": snapshot.sha256,
            }),
        );
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
    let (status, failure_chain) = controller.status_snapshot();
    desktop_status_value(status, failure_chain, &controller.update)
}

fn stop_packaged_process(app_handle: &AppHandle) {
    let Some(controller) = app_handle.try_state::<Arc<DesktopController>>() else {
        return;
    };
    match controller
        .supervisor
        .stop_gracefully(GRACEFUL_STOP_SIGNAL_TIMEOUT)
    {
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
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            desktop_runtime_status,
            report_desktop_recovery_surface,
        ])
        .setup(|app| {
            let app_handle = app.handle().clone();
            let desktop_paths: Result<DesktopPaths, Box<dyn Error>> = app
                .path()
                .data_dir()
                .map_err(|error| Box::new(error) as Box<dyn Error>)
                .and_then(|platform_data_dir| {
                    DesktopPaths::from_args(platform_data_dir, std::env::args_os())
                        .map_err(|error| Box::new(error) as Box<dyn Error>)
                });
            let (paths, paths_error) = match desktop_paths {
                Ok(paths) => (Some(paths), None),
                Err(error) => (None, Some(error)),
            };
            // The single-instance claim happens before any window exists: a
            // repeated launch delegates to the live owner and exits, and a
            // control invocation forwards its command and exits.
            let listener = paths
                .as_ref()
                .map(|paths| establish_shell_role(paths.root()));
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
                    if let Some(controller) = page_load_app.try_state::<Arc<DesktopController>>()
                        && controller.status().restart_available
                    {
                        emit_pending_failure_surface(&page_load_app);
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
            // Closing the window only hides it; the shell, tray, and Gateway
            // keep running until an explicit quit.
            // https://github.com/tauri-apps/tauri/blob/tauri-v2.11.5/crates/tauri/src/app.rs#L111-L120
            let close_app = app_handle.clone();
            window.on_window_event(move |event| {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    hide_main_window_from_event(&close_app);
                }
            });
            let (logs_dir, data_root) = paths
                .as_ref()
                .map(|paths| (paths.logs(), paths.root().to_path_buf()))
                .unwrap_or_default();
            let update = DesktopUpdateController::new(Some(data_root.clone()));
            let tray = DesktopTray::build(&app_handle)?;
            let controller = Arc::new(DesktopController {
                attempts: Mutex::new(RuntimeAttemptState::new()),
                autostart: Mutex::new(None),
                dashboard_policy: RwLock::new(None),
                data_root,
                gateway_origin: RwLock::new(None),
                log: Mutex::new(None),
                logs_dir,
                pending_failure_surface: Mutex::new(None),
                status_url,
                supervisor: PackageProcessSupervisor::new(),
                tray,
                update,
                update_tray_signature: Mutex::new(None),
            });
            app.manage(controller);
            if let Some(listener) = listener {
                serve_shell_commands(&app_handle, listener);
            }
            if paths_error.is_none() {
                match resolve_shell_autostart(&app_handle) {
                    Ok(registration) => {
                        let controller = app_handle.state::<Arc<DesktopController>>();
                        let enabled = registration.is_enabled();
                        *controller
                            .autostart
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner()) =
                            Some(registration);
                        if let Err(error) = controller.tray.set_autostart_checked(enabled) {
                            print_error_chain(error.as_ref());
                        }
                    }
                    Err(error) => print_error_chain(error.as_ref()),
                }
            }
            if let Some(error) = paths_error {
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
            } else if install_staged_update_requested()
                && app_handle
                    .state::<Arc<DesktopController>>()
                    .update
                    .staged_version()
                    .is_some()
            {
                // An explicit operator request installs the staged update
                // before any runtime starts, so no LLM request can be in
                // flight while the application bundle is replaced.
                let install_app = app_handle.clone();
                thread::spawn(move || run_install_sequence(&install_app));
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
                        format!(
                            "Floway initial status document did not finish loading within {} seconds",
                            STARTUP_TIMEOUT.as_secs()
                        ),
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
            match event {
                RunEvent::ExitRequested { .. } | RunEvent::Exit => {
                    stop_packaged_process(app_handle);
                }
                // macOS routes Dock-icon clicks and `open` relaunches of a
                // running application here instead of starting a new process.
                // https://github.com/tauri-apps/tauri/blob/tauri-v2.11.5/crates/tauri/src/app.rs#L275-L283
                #[cfg(target_os = "macos")]
                RunEvent::Reopen {
                    has_visible_windows,
                    ..
                } => {
                    if !has_visible_windows {
                        activate_main_window(app_handle);
                    }
                }
                _ => {}
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
