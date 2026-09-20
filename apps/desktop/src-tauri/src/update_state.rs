//! Owns the persisted staged-update state and its transition rules.

use std::error::Error;
use std::fmt::{Display, Formatter};
use std::fs;
use std::io;
use std::path::Path;

use serde_json::{Map, Value, json};

pub const UPDATE_STATE_FILE_NAME: &str = "update-state.json";
const UPDATE_STATE_SCHEMA_VERSION: u64 = 1;

// These bounds mirror runtime_status::bounded_failure_chain so the update
// surface and the runtime failure surface show the same clipped chain.
const FAILURE_CHAIN_MAXIMUM_ENTRIES: usize = 4;
const FAILURE_CHAIN_MAXIMUM_ENTRY_CHARS: usize = 400;
const UPDATE_NOTES_MAXIMUM_CHARS: usize = 2000;

fn is_exact_version(value: &str) -> bool {
    let segments = value.split('.').collect::<Vec<_>>();
    segments.len() == 3
        && segments
            .iter()
            .all(|segment| !segment.is_empty() && segment.bytes().all(|byte| byte.is_ascii_digit()))
}

fn bounded_chain(chain: &[String]) -> Vec<String> {
    chain
        .iter()
        .take(FAILURE_CHAIN_MAXIMUM_ENTRIES)
        .map(|entry| {
            entry
                .lines()
                .filter(|line| !line.trim_start().starts_with("at "))
                .flat_map(|line| line.chars().chain(std::iter::once('\n')))
                .filter(|character| !character.is_control() || *character == '\n')
                .take(FAILURE_CHAIN_MAXIMUM_ENTRY_CHARS)
                .collect::<String>()
                .trim_end()
                .to_owned()
        })
        .filter(|entry| !entry.is_empty())
        .collect()
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StagedUpdate {
    pub artifact_bytes: u64,
    pub artifact_file: String,
    pub download_url: String,
    pub notes: Option<String>,
    pub signature: String,
    pub staged_at: u64,
    pub version: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingUpdateHealth {
    pub installed_at: u64,
    pub previous_version: String,
    pub version: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum UpdateFailurePhase {
    Check,
    Download,
    Health,
    Install,
    RecoveryPoint,
    Signature,
}

impl UpdateFailurePhase {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Check => "check",
            Self::Download => "download",
            Self::Health => "health",
            Self::Install => "install",
            Self::RecoveryPoint => "recovery-point",
            Self::Signature => "signature",
        }
    }

    fn from_wire(value: &str) -> Option<Self> {
        Some(match value {
            "check" => Self::Check,
            "download" => Self::Download,
            "health" => Self::Health,
            "install" => Self::Install,
            "recovery-point" => Self::RecoveryPoint,
            "signature" => Self::Signature,
            _ => return None,
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UpdateFailure {
    pub at: u64,
    pub chain: Vec<String>,
    pub phase: UpdateFailurePhase,
    pub version: Option<String>,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct DesktopUpdateState {
    pub failure: Option<UpdateFailure>,
    pub last_healthy_version: Option<String>,
    pub pending: Option<PendingUpdateHealth>,
    pub staged: Option<StagedUpdate>,
}

#[derive(Debug)]
pub struct UpdateStateError {
    message: String,
    source: Option<io::Error>,
}

impl Display for UpdateStateError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "Floway update state is invalid: {}",
            self.message
        )
    }
}

impl Error for UpdateStateError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        self.source
            .as_ref()
            .map(|source| source as &(dyn Error + 'static))
    }
}

fn invalid_state(message: impl Into<String>) -> UpdateStateError {
    UpdateStateError {
        message: message.into(),
        source: None,
    }
}

fn invalid_state_with_source(message: impl Into<String>, source: io::Error) -> UpdateStateError {
    UpdateStateError {
        message: message.into(),
        source: Some(source),
    }
}

fn required_string<'a>(
    object: &'a Map<String, Value>,
    key: &str,
    label: &str,
) -> Result<&'a str, UpdateStateError> {
    object
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| invalid_state(format!("{label} is missing or not a string")))
}

fn optional_version(
    object: &Map<String, Value>,
    key: &str,
    label: &str,
) -> Result<Option<String>, UpdateStateError> {
    match object.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) if is_exact_version(value) => Ok(Some(value.clone())),
        _ => Err(invalid_state(format!(
            "{label} is not an exact release version"
        ))),
    }
}

fn required_version(
    object: &Map<String, Value>,
    key: &str,
    label: &str,
) -> Result<String, UpdateStateError> {
    let version = required_string(object, key, label)?;
    if !is_exact_version(version) {
        return Err(invalid_state(format!(
            "{label} is not an exact release version"
        )));
    }
    Ok(version.to_owned())
}

fn required_u64(
    object: &Map<String, Value>,
    key: &str,
    label: &str,
) -> Result<u64, UpdateStateError> {
    object
        .get(key)
        .and_then(Value::as_u64)
        .ok_or_else(|| invalid_state(format!("{label} is missing or not an unsigned integer")))
}

fn expect_object<'a>(
    value: &'a Value,
    keys: &[&str],
    label: &str,
) -> Result<&'a Map<String, Value>, UpdateStateError> {
    let object = value
        .as_object()
        .ok_or_else(|| invalid_state(format!("{label} must be an object")))?;
    let mut expected: Vec<&str> = keys.to_vec();
    expected.sort_unstable();
    let mut actual: Vec<&str> = object.keys().map(String::as_str).collect();
    actual.sort_unstable();
    if actual != expected {
        return Err(invalid_state(format!(
            "{label} has unexpected or missing fields"
        )));
    }
    Ok(object)
}

fn parse_staged(value: &Value) -> Result<StagedUpdate, UpdateStateError> {
    let object = expect_object(
        value,
        &[
            "artifactBytes",
            "artifactFile",
            "downloadUrl",
            "notes",
            "signature",
            "stagedAt",
            "version",
        ],
        "the staged update",
    )?;
    let artifact_file = required_string(object, "artifactFile", "the staged artifact file")?;
    if artifact_file.is_empty()
        || artifact_file.contains('/')
        || artifact_file.contains('\\')
        || artifact_file.starts_with('.')
    {
        return Err(invalid_state(
            "the staged artifact file is not a plain file name",
        ));
    }
    let signature = required_string(object, "signature", "the staged signature")?;
    if signature.is_empty() {
        return Err(invalid_state("the staged signature is empty"));
    }
    let download_url = required_string(object, "downloadUrl", "the staged download URL")?;
    if download_url.is_empty() {
        return Err(invalid_state("the staged download URL is empty"));
    }
    let notes = match object.get("notes") {
        None | Some(Value::Null) => None,
        Some(Value::String(notes)) => {
            Some(notes.chars().take(UPDATE_NOTES_MAXIMUM_CHARS).collect())
        }
        _ => return Err(invalid_state("the staged notes are not a string")),
    };
    Ok(StagedUpdate {
        artifact_bytes: required_u64(object, "artifactBytes", "the staged artifact byte count")?,
        artifact_file: artifact_file.to_owned(),
        download_url: download_url.to_owned(),
        notes,
        signature: signature.to_owned(),
        staged_at: required_u64(object, "stagedAt", "the staged timestamp")?,
        version: required_version(object, "version", "the staged version")?,
    })
}

fn parse_pending(value: &Value) -> Result<PendingUpdateHealth, UpdateStateError> {
    let object = expect_object(
        value,
        &["installedAt", "previousVersion", "version"],
        "the pending update health",
    )?;
    Ok(PendingUpdateHealth {
        installed_at: required_u64(object, "installedAt", "the update install timestamp")?,
        previous_version: required_version(
            object,
            "previousVersion",
            "the previous release version",
        )?,
        version: required_version(object, "version", "the pending release version")?,
    })
}

fn parse_failure(value: &Value) -> Result<UpdateFailure, UpdateStateError> {
    let object = expect_object(
        value,
        &["at", "chain", "phase", "version"],
        "the update failure",
    )?;
    let phase = required_string(object, "phase", "the update failure phase")?;
    let phase = UpdateFailurePhase::from_wire(phase)
        .ok_or_else(|| invalid_state("the update failure phase is unknown"))?;
    let chain = object
        .get("chain")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid_state("the update failure chain is missing"))?
        .iter()
        .map(|entry| {
            entry
                .as_str()
                .map(str::to_owned)
                .ok_or_else(|| invalid_state("the update failure chain has a non-string entry"))
        })
        .collect::<Result<Vec<String>, _>>()?;
    if chain.is_empty() {
        return Err(invalid_state("the update failure chain is empty"));
    }
    Ok(UpdateFailure {
        at: required_u64(object, "at", "the update failure timestamp")?,
        chain,
        phase,
        version: optional_version(object, "version", "the update failure version")?,
    })
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BeginInstallError {
    NothingStaged,
}

impl Display for BeginInstallError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NothingStaged => {
                write!(formatter, "Floway has no staged update to install")
            }
        }
    }
}

impl Error for BeginInstallError {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MarkHealthyOutcome {
    NoPendingUpdate,
    PendingVersionMismatch,
    MarkedHealthy,
}

impl DesktopUpdateState {
    pub fn record_staged(&mut self, staged: StagedUpdate) {
        self.staged = Some(staged);
    }

    // A failed update phase never touches the staged artifact, the pending
    // install, or the recovery point: recovery information survives failures.
    pub fn record_failure(&mut self, failure: UpdateFailure) {
        self.failure = Some(UpdateFailure {
            chain: bounded_chain(&failure.chain),
            ..failure
        });
    }

    pub fn begin_install(
        &mut self,
        running_version: &str,
        installed_at: u64,
    ) -> Result<(PendingUpdateHealth, StagedUpdate), BeginInstallError> {
        let Some(staged) = self.staged.take() else {
            return Err(BeginInstallError::NothingStaged);
        };
        let pending = PendingUpdateHealth {
            installed_at,
            previous_version: running_version.to_owned(),
            version: staged.version.clone(),
        };
        self.pending = Some(pending.clone());
        self.failure = None;
        Ok((pending, staged))
    }

    pub fn mark_healthy(&mut self, running_version: &str) -> MarkHealthyOutcome {
        self.last_healthy_version = Some(running_version.to_owned());
        let Some(pending) = &self.pending else {
            return MarkHealthyOutcome::NoPendingUpdate;
        };
        if pending.version != running_version {
            return MarkHealthyOutcome::PendingVersionMismatch;
        }
        self.pending = None;
        self.failure = None;
        MarkHealthyOutcome::MarkedHealthy
    }

    pub fn to_value(&self) -> Value {
        let staged = self.staged.as_ref().map_or(Value::Null, |staged| {
            json!({
                "artifactBytes": staged.artifact_bytes,
                "artifactFile": staged.artifact_file,
                "downloadUrl": staged.download_url,
                "notes": staged.notes,
                "signature": staged.signature,
                "stagedAt": staged.staged_at,
                "version": staged.version,
            })
        });
        let pending = self.pending.as_ref().map_or(Value::Null, |pending| {
            json!({
                "installedAt": pending.installed_at,
                "previousVersion": pending.previous_version,
                "version": pending.version,
            })
        });
        let failure = self.failure.as_ref().map_or(Value::Null, |failure| {
            json!({
                "at": failure.at,
                "chain": failure.chain,
                "phase": failure.phase.as_str(),
                "version": failure.version,
            })
        });
        json!({
            "schemaVersion": UPDATE_STATE_SCHEMA_VERSION,
            "failure": failure,
            "lastHealthyVersion": self.last_healthy_version,
            "pending": pending,
            "staged": staged,
        })
    }

    pub fn from_value(value: &Value) -> Result<Self, UpdateStateError> {
        let object = expect_object(
            value,
            &[
                "schemaVersion",
                "failure",
                "lastHealthyVersion",
                "pending",
                "staged",
            ],
            "the update state",
        )?;
        if object.get("schemaVersion").and_then(Value::as_u64) != Some(UPDATE_STATE_SCHEMA_VERSION)
        {
            return Err(invalid_state(
                "the update state schema version is unsupported",
            ));
        }
        let staged = match object.get("staged") {
            None | Some(Value::Null) => None,
            Some(value) => Some(parse_staged(value)?),
        };
        let pending = match object.get("pending") {
            None | Some(Value::Null) => None,
            Some(value) => Some(parse_pending(value)?),
        };
        let failure = match object.get("failure") {
            None | Some(Value::Null) => None,
            Some(value) => Some(parse_failure(value)?),
        };
        Ok(Self {
            failure,
            last_healthy_version: optional_version(
                object,
                "lastHealthyVersion",
                "the last healthy release version",
            )?,
            pending,
            staged,
        })
    }

    pub fn load(state_file: &Path) -> Result<Self, UpdateStateError> {
        let source = match fs::read_to_string(state_file) {
            Ok(source) => source,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Self::default()),
            Err(error) => {
                return Err(invalid_state_with_source(
                    "the update state could not be read",
                    error,
                ));
            }
        };
        let value: Value = serde_json::from_str(&source).map_err(|source| {
            invalid_state_with_source(
                "the update state is not valid JSON",
                io::Error::new(io::ErrorKind::InvalidData, source),
            )
        })?;
        Self::from_value(&value)
    }

    pub fn save(&self, state_file: &Path) -> Result<(), UpdateStateError> {
        let encoded = serde_json::to_string_pretty(&self.to_value()).map_err(|source| {
            invalid_state_with_source(
                "the update state could not be encoded",
                io::Error::new(io::ErrorKind::InvalidData, source),
            )
        })?;
        let temporary = state_file.with_extension(format!("{}.tmp", std::process::id()));
        let persist = (|| -> Result<(), io::Error> {
            fs::write(&temporary, format!("{encoded}\n"))?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600))?;
            }
            fs::rename(&temporary, state_file)?;
            Ok(())
        })();
        persist.map_err(|source| {
            let _ = fs::remove_file(&temporary);
            invalid_state_with_source("the update state could not be persisted", source)
        })
    }
}
