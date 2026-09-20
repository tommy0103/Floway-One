//! Owns update channel selection and updater endpoint authority resolution.

use std::error::Error;
use std::fmt::{Display, Formatter};
use std::fs;
use std::io;
use std::path::Path;

use serde_json::Value;
use url::Url;

pub const UPDATE_CHANNEL_FILE_NAME: &str = "update-channel.json";
pub const UPDATE_DIRECTORY_NAME: &str = "update";
pub const UPDATE_RECOVERY_POINT_FILE_NAME: &str = "recovery-point.json";

// Floway publishes one signed updater manifest per GitHub Release; the stable
// channel tracks the latest full release while the preview channel tracks a
// moving pre-release tag and requires explicit operator opt-in.
// docs/floway-one-spec.zh-CN.md §14.3 (应用升级)
pub const STABLE_UPDATE_ENDPOINT: &str =
    "https://github.com/tommy0103/Floway-One/releases/latest/download/floway-update.json";
pub const PREVIEW_UPDATE_ENDPOINT: &str =
    "https://github.com/tommy0103/Floway-One/releases/download/floway-preview/floway-update.json";

// The recovery surface sends the operator to the release page of the version
// that preceded a failed update; MVP does not promise automatic binary
// rollback. docs/floway-one-spec.zh-CN.md §14.3 (应用升级)
const RELEASE_PAGE_URL_PREFIX: &str = "https://github.com/tommy0103/Floway-One/releases/tag/v";

pub const UPDATE_ENDPOINTS_ENV: &str = "FLOWAY_DESKTOP_UPDATE_ENDPOINTS";
pub const UPDATE_PUBKEY_ENV: &str = "FLOWAY_DESKTOP_UPDATE_PUBKEY";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum UpdateChannel {
    Stable,
    Preview,
}

impl UpdateChannel {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Stable => "stable",
            Self::Preview => "preview",
        }
    }

    pub fn endpoint(self) -> &'static str {
        match self {
            Self::Stable => STABLE_UPDATE_ENDPOINT,
            Self::Preview => PREVIEW_UPDATE_ENDPOINT,
        }
    }
}

#[derive(Debug)]
pub struct UpdateChannelError {
    message: String,
    source: Option<io::Error>,
}

impl Display for UpdateChannelError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "Floway update channel configuration is invalid: {}",
            self.message
        )
    }
}

impl Error for UpdateChannelError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        self.source
            .as_ref()
            .map(|source| source as &(dyn Error + 'static))
    }
}

fn invalid_channel(message: impl Into<String>, source: Option<io::Error>) -> UpdateChannelError {
    UpdateChannelError {
        message: message.into(),
        source,
    }
}

pub fn parse_update_channel(source: &str) -> Result<UpdateChannel, UpdateChannelError> {
    let value: Value = serde_json::from_str(source).map_err(|source| {
        invalid_channel(
            "the channel file is not valid JSON",
            Some(io::Error::new(io::ErrorKind::InvalidData, source)),
        )
    })?;
    let object = value
        .as_object()
        .ok_or_else(|| invalid_channel("the channel file must be an object", None))?;
    if object.len() != 1 {
        return Err(invalid_channel(
            "the channel file must contain exactly the channel field",
            None,
        ));
    }
    match object.get("channel").and_then(Value::as_str) {
        Some("stable") => Ok(UpdateChannel::Stable),
        Some("preview") => Ok(UpdateChannel::Preview),
        _ => Err(invalid_channel(
            "the channel field must be \"stable\" or \"preview\"",
            None,
        )),
    }
}

// A missing or unreadable channel file selects the stable default; a present
// but invalid file also resolves stable because preview must never be enabled
// by accident. The caller surfaces the diagnostic without failing the runtime.
pub fn load_update_channel(channel_file: &Path) -> (UpdateChannel, Option<UpdateChannelError>) {
    let source = match fs::read_to_string(channel_file) {
        Ok(source) => source,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return (UpdateChannel::Stable, None);
        }
        Err(error) => {
            return (
                UpdateChannel::Stable,
                Some(invalid_channel(
                    "the channel file could not be read",
                    Some(error),
                )),
            );
        }
    };
    match parse_update_channel(&source) {
        Ok(channel) => (channel, None),
        Err(error) => (UpdateChannel::Stable, Some(error)),
    }
}

#[derive(Debug)]
pub struct UpdateEndpointsError {
    message: String,
}

impl Display for UpdateEndpointsError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "Floway updater endpoints are invalid: {}",
            self.message
        )
    }
}

impl Error for UpdateEndpointsError {}

// The environment authority is an operator/verification contract: both the
// endpoint list and the matching signature pubkey must be supplied together,
// so a partial override can never weaken production signature verification.
pub fn parse_updater_endpoints(value: &str) -> Result<Vec<Url>, UpdateEndpointsError> {
    let mut endpoints = Vec::new();
    for candidate in value.split(',') {
        let candidate = candidate.trim();
        if candidate.is_empty() {
            return Err(UpdateEndpointsError {
                message: "an endpoint is empty".to_owned(),
            });
        }
        let url = Url::parse(candidate).map_err(|error| UpdateEndpointsError {
            message: format!("endpoint {candidate} is not a URL: {error}"),
        })?;
        if url.scheme() != "https" && url.scheme() != "http" {
            return Err(UpdateEndpointsError {
                message: format!("endpoint {candidate} is not an HTTP(S) URL"),
            });
        }
        if !url.username().is_empty() || url.password().is_some() {
            return Err(UpdateEndpointsError {
                message: format!("endpoint {candidate} must not carry credentials"),
            });
        }
        endpoints.push(url);
    }
    Ok(endpoints)
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UpdaterAuthority {
    pub endpoints: Vec<Url>,
    pub pubkey: String,
}

pub fn resolve_updater_authority(
    channel: UpdateChannel,
    endpoints_override: Option<&str>,
    pubkey_override: Option<&str>,
    configured_pubkey: Option<&str>,
) -> Result<UpdaterAuthority, UpdateEndpointsError> {
    match (endpoints_override, pubkey_override) {
        (Some(endpoints), Some(pubkey)) => {
            if pubkey.trim().is_empty() {
                return Err(UpdateEndpointsError {
                    message: format!("{UPDATE_PUBKEY_ENV} must not be empty"),
                });
            }
            Ok(UpdaterAuthority {
                endpoints: parse_updater_endpoints(endpoints)?,
                pubkey: pubkey.to_owned(),
            })
        }
        (None, None) => {
            let Some(pubkey) = configured_pubkey.filter(|pubkey| !pubkey.trim().is_empty()) else {
                return Err(UpdateEndpointsError {
                    message: "the configured updater pubkey is empty".to_owned(),
                });
            };
            Ok(UpdaterAuthority {
                endpoints: parse_updater_endpoints(channel.endpoint())?,
                pubkey: pubkey.to_owned(),
            })
        }
        _ => Err(UpdateEndpointsError {
            message: format!("{UPDATE_ENDPOINTS_ENV} and {UPDATE_PUBKEY_ENV} must be set together"),
        }),
    }
}

pub fn previous_release_page_url(previous_version: &str) -> String {
    format!("{RELEASE_PAGE_URL_PREFIX}{previous_version}")
}
