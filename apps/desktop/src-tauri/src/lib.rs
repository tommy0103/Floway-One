mod bundle_contract;
mod navigation;

#[cfg(feature = "desktop")]
mod app;
#[cfg(feature = "desktop")]
mod sidecar_supervisor;

pub const NODE_SIDECAR_NAME: &str = "floway-node";

pub use bundle_contract::{BundleResourceError, RuntimeBundle, resolve_runtime_bundle};
pub use navigation::{
    DASHBOARD_ORIGIN, DashboardNavigationDecision, DashboardNavigationPolicy,
    PERSONAL_DASHBOARD_BOOTSTRAP_ENV, PERSONAL_DASHBOARD_BOOTSTRAP_FRAGMENT_KEY,
    PERSONAL_RUNTIME_READY_PREFIX, dashboard_bootstrap_url, enforce_dashboard_navigation,
    ready_dashboard_origin,
};

#[cfg(feature = "desktop")]
pub use app::run;
