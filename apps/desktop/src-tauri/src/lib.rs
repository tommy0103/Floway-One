mod bundle_contract;
mod navigation;
#[cfg(feature = "desktop")]
mod runtime_status;
#[cfg(feature = "desktop")]
mod sidecar_log;

#[cfg(feature = "desktop")]
mod app;
#[cfg(feature = "desktop")]
mod runtime_controller;
#[cfg(feature = "desktop")]
mod sidecar_supervisor;

pub const NODE_SIDECAR_NAME: &str = "floway-node";

#[cfg(feature = "desktop")]
pub use app::run;
pub use bundle_contract::{BundleResourceError, RuntimeBundle, resolve_runtime_bundle};
pub use navigation::{
    DASHBOARD_ORIGIN, DESKTOP_STATUS_ROUTE, DashboardNavigationDecision, DashboardNavigationPolicy,
    DesktopAction, PERSONAL_DASHBOARD_BOOTSTRAP_ENV, PERSONAL_DASHBOARD_BOOTSTRAP_FRAGMENT_KEY,
    PERSONAL_RUNTIME_READY_PREFIX, dashboard_bootstrap_url, desktop_action,
    enforce_dashboard_navigation, is_desktop_status_navigation, ready_dashboard_origin,
};
