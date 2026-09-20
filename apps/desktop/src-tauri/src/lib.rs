mod bundle_contract;
#[cfg(feature = "desktop")]
mod desktop_i18n;
#[cfg(feature = "desktop")]
mod desktop_paths;
mod navigation;
#[cfg(feature = "desktop")]
mod runtime_status;
#[cfg(feature = "desktop")]
mod sidecar_log;
mod update_channel;
mod update_state;

#[cfg(feature = "desktop")]
mod app;
#[cfg(feature = "desktop")]
mod rendered_snapshot;
#[cfg(feature = "desktop")]
mod runtime_controller;
#[cfg(feature = "desktop")]
mod shell_autostart;
#[cfg(feature = "desktop")]
mod shell_singleton;
#[cfg(feature = "desktop")]
mod sidecar_supervisor;
#[cfg(feature = "desktop")]
mod update_controller;

pub const NODE_SIDECAR_NAME: &str = "floway-node";

#[cfg(feature = "desktop")]
pub use app::run;
pub use bundle_contract::{
    BundleResourceError, BundleResourceKind, RuntimeBundle, resolve_runtime_bundle,
};
pub use navigation::{
    DASHBOARD_ORIGIN, DESKTOP_STATUS_ROUTE, DashboardNavigationDecision, DashboardNavigationPolicy,
    DesktopAction, PERSONAL_DASHBOARD_BOOTSTRAP_ENV, PERSONAL_DASHBOARD_BOOTSTRAP_FRAGMENT_KEY,
    PERSONAL_RUNTIME_READY_PREFIX, dashboard_bootstrap_url, desktop_action,
    enforce_dashboard_navigation, is_desktop_status_navigation, ready_dashboard_origin,
    recovery_surface_diagnostic, sanitized_page_load_diagnostic,
};
#[cfg(feature = "desktop")]
pub use runtime_status::InitialStatusLoadGate;
pub use update_channel::{
    UPDATE_CHANNEL_FILE_NAME, UPDATE_DIRECTORY_NAME, UPDATE_RECOVERY_POINT_FILE_NAME,
    UpdateChannel, UpdaterAuthority, load_update_channel, parse_update_channel,
    parse_updater_endpoints, previous_release_page_url, resolve_updater_authority,
};
pub use update_state::{
    BeginInstallError, DesktopUpdateState, MarkHealthyOutcome, PendingUpdateHealth, StagedUpdate,
    UPDATE_STATE_FILE_NAME, UpdateFailure, UpdateFailurePhase,
};
