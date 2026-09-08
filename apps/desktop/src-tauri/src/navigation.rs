use std::error::Error;
use std::io;

use percent_encoding::percent_decode_str;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use url::Url;

pub const DASHBOARD_ORIGIN: &str = "http://127.0.0.1:8788";
pub const PERSONAL_DASHBOARD_BOOTSTRAP_ENV: &str = "FLOWAY_BOOTSTRAP_TOKEN";
pub const PERSONAL_DASHBOARD_BOOTSTRAP_FRAGMENT_KEY: &str = "floway-bootstrap";
pub const PERSONAL_RUNTIME_READY_PREFIX: &str = "Floway listening on ";
pub const DESKTOP_STATUS_ROUTE: &str = "desktop-status";
const MAXIMUM_AUTHORITY_DECODE_PASSES: usize = 8;
const MAXIMUM_RENDERED_SURFACE_VALUE_BYTES: usize = 512;
const RENDERED_SURFACE_ACTION: &str = "report-rendered-surface";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DesktopAction {
    OpenLogs,
    Restart,
}

pub fn desktop_action(candidate: &Url) -> Option<DesktopAction> {
    if candidate.scheme() != "floway-action" {
        return None;
    }
    match candidate.host_str()? {
        "open-logs" => Some(DesktopAction::OpenLogs),
        "restart" => Some(DesktopAction::Restart),
        _ => None,
    }
}

pub fn rendered_surface_diagnostic(candidate: &Url) -> Option<Result<Value, io::Error>> {
    if candidate.scheme() != "floway-action"
        || candidate.host_str() != Some(RENDERED_SURFACE_ACTION)
    {
        return None;
    }
    Some((|| {
        let pairs = candidate.query_pairs().collect::<Vec<_>>();
        let required = [
            "failureKind",
            "locale",
            "title",
            "message",
            "restartLabel",
            "restartHref",
            "logsLabel",
            "logsHref",
        ];
        if pairs.len() != required.len() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Floway rendered failure diagnostic has an invalid field count",
            ));
        }
        let value = |key: &str| -> Result<String, io::Error> {
            let matches = pairs
                .iter()
                .filter(|(candidate, _value)| candidate == key)
                .collect::<Vec<_>>();
            if matches.len() != 1 {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("Floway rendered failure diagnostic has an invalid {key} field"),
                ));
            }
            let value = matches[0].1.as_ref();
            if value.is_empty()
                || value.len() > MAXIMUM_RENDERED_SURFACE_VALUE_BYTES
                || value.chars().any(char::is_control)
            {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("Floway rendered failure diagnostic has an unsafe {key} field"),
                ));
            }
            Ok(value.to_owned())
        };
        let failure_kind = value("failureKind")?;
        if !matches!(
            failure_kind.as_str(),
            "asset"
                | "compatibility"
                | "migration"
                | "native-dependency"
                | "port"
                | "storage"
                | "timeout"
                | "unexpected-exit"
                | "unknown"
        ) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Floway rendered failure diagnostic has an unknown failure kind",
            ));
        }
        let locale = value("locale")?;
        if !matches!(locale.as_str(), "en" | "zh-Hans") {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Floway rendered failure diagnostic has an unknown locale",
            ));
        }
        let copy = [
            value("title")?,
            value("message")?,
            value("restartLabel")?,
            value("restartHref")?,
            value("logsLabel")?,
            value("logsHref")?,
        ];
        if copy[3] != "floway-action://restart" || copy[5] != "floway-action://open-logs" {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Floway rendered failure diagnostic has an unknown recovery action",
            ));
        }
        let encoded = serde_json::to_vec(&copy).map_err(io::Error::other)?;
        Ok(json!({
            "actions": ["restart", "open-logs"],
            "copyDigest": format!("{:x}", Sha256::digest(encoded)),
            "failureKind": failure_kind,
            "locale": locale,
        }))
    })())
}

pub fn is_desktop_status_navigation(candidate: &Url, new_window: bool) -> bool {
    if new_window || candidate.path().trim_matches('/') != DESKTOP_STATUS_ROUTE {
        return false;
    }
    (candidate.scheme() == "tauri" && candidate.host_str() == Some("localhost"))
        || (candidate.scheme() == "http" && candidate.host_str() == Some("tauri.localhost"))
}

pub fn sanitized_page_load_diagnostic(url: &Url, event: &str) -> Value {
    let bootstrap_authority = url.fragment().is_some_and(|fragment| {
        url::form_urlencoded::parse(fragment.as_bytes())
            .any(|(key, _value)| key == PERSONAL_DASHBOARD_BOOTSTRAP_FRAGMENT_KEY)
    });
    let surface = if is_desktop_status_navigation(url, false) {
        "desktop-status"
    } else if url.scheme() == "http" && url.host_str() == Some("127.0.0.1") {
        "dashboard"
    } else {
        "other"
    };
    json!({
        "bootstrapAuthority": bootstrap_authority,
        "event": event,
        "route": url.path(),
        "surface": surface,
    })
}

fn has_valid_percent_encoding(value: &str) -> bool {
    let bytes = value.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len()
                || !bytes[index + 1].is_ascii_hexdigit()
                || !bytes[index + 2].is_ascii_hexdigit()
            {
                return false;
            }
            index += 3;
        } else {
            index += 1;
        }
    }
    true
}

fn canonicalize_for_authority_check(value: &str) -> Option<String> {
    let mut current = value.to_owned();
    for _ in 0..MAXIMUM_AUTHORITY_DECODE_PASSES {
        if !has_valid_percent_encoding(&current) {
            return None;
        }
        let decoded = percent_decode_str(&current)
            .decode_utf8()
            .ok()?
            .into_owned();
        if decoded == current {
            return Some(decoded);
        }
        current = decoded;
    }
    None
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DashboardNavigationDecision {
    AllowInWebview,
    OpenInSystemBrowser(Url),
    Reject,
}

#[derive(Clone, Debug)]
pub struct DashboardNavigationPolicy {
    bootstrap_url: Url,
    bootstrap_token: String,
    trusted_origin: Url,
}

impl DashboardNavigationPolicy {
    pub fn new(origin: &str, bootstrap_token: &str) -> Result<Self, Box<dyn Error>> {
        let trusted_origin = Url::parse(origin)?;
        if trusted_origin.scheme() != "http"
            || trusted_origin.host_str() != Some("127.0.0.1")
            || trusted_origin.port().is_none()
            || trusted_origin.path() != "/"
            || trusted_origin.query().is_some()
            || trusted_origin.fragment().is_some()
            || !trusted_origin.username().is_empty()
            || trusted_origin.password().is_some()
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("Floway personal runtime reported an invalid Dashboard origin: {origin}"),
            )
            .into());
        }
        let bootstrap_url = Url::parse(&dashboard_bootstrap_url(origin, bootstrap_token))?;
        Ok(Self {
            bootstrap_url,
            bootstrap_token: bootstrap_token.to_owned(),
            trusted_origin,
        })
    }

    pub fn bootstrap_url(&self) -> &Url {
        &self.bootstrap_url
    }

    pub fn decide(&self, candidate: &Url, new_window: bool) -> DashboardNavigationDecision {
        let Some(decoded_candidate) = canonicalize_for_authority_check(candidate.as_str()) else {
            return DashboardNavigationDecision::Reject;
        };
        let query_carries_bootstrap_authority = candidate.query_pairs().any(|(key, value)| {
            key == PERSONAL_DASHBOARD_BOOTSTRAP_FRAGMENT_KEY
                || value.contains(&self.bootstrap_token)
        });
        let carries_bootstrap_key = query_carries_bootstrap_authority
            || decoded_candidate.contains(PERSONAL_DASHBOARD_BOOTSTRAP_FRAGMENT_KEY);
        let carries_bootstrap_token = decoded_candidate.contains(&self.bootstrap_token);
        if (carries_bootstrap_key || carries_bootstrap_token) && candidate != &self.bootstrap_url {
            return DashboardNavigationDecision::Reject;
        }

        let same_origin = candidate.scheme() == self.trusted_origin.scheme()
            && candidate.host_str() == self.trusted_origin.host_str()
            && candidate.port_or_known_default() == self.trusted_origin.port_or_known_default()
            && candidate.username().is_empty()
            && candidate.password().is_none();
        if same_origin {
            return if new_window {
                DashboardNavigationDecision::Reject
            } else {
                DashboardNavigationDecision::AllowInWebview
            };
        }
        if candidate.scheme() == "https"
            && candidate.host_str().is_some()
            && candidate.username().is_empty()
            && candidate.password().is_none()
            && !carries_bootstrap_key
            && !carries_bootstrap_token
        {
            let mut external = candidate.clone();
            external.set_fragment(None);
            return DashboardNavigationDecision::OpenInSystemBrowser(external);
        }
        DashboardNavigationDecision::Reject
    }
}

pub fn enforce_dashboard_navigation<E>(
    policy: &DashboardNavigationPolicy,
    candidate: &Url,
    new_window: bool,
    open_external: impl FnOnce(&Url) -> Result<(), E>,
) -> Result<bool, E> {
    match policy.decide(candidate, new_window) {
        DashboardNavigationDecision::AllowInWebview => Ok(true),
        DashboardNavigationDecision::OpenInSystemBrowser(external) => {
            open_external(&external)?;
            Ok(false)
        }
        DashboardNavigationDecision::Reject => Ok(false),
    }
}

pub fn dashboard_bootstrap_url(origin: &str, token: &str) -> String {
    format!("{origin}/#{PERSONAL_DASHBOARD_BOOTSTRAP_FRAGMENT_KEY}={token}")
}

pub fn ready_dashboard_origin(output: &str) -> Option<&str> {
    output
        .lines()
        .find_map(|line| line.strip_prefix(PERSONAL_RUNTIME_READY_PREFIX))
}
