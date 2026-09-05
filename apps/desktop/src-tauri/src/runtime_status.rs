use std::error::Error;
use std::fmt::{Display, Formatter};
use std::io::{self, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

use serde_json::Value;
use url::Url;

use crate::bundle_contract::RuntimeCompatibility;

pub const DESKTOP_FAILURE_EVENT_PREFIX: &str = "FLOWAY_DESKTOP_FAILURE ";
const DESKTOP_HEALTH_PATH: &str = "/api/desktop/health";
const HEALTH_IO_TIMEOUT: Duration = Duration::from_secs(1);
const MAXIMUM_HEALTH_RESPONSE_BYTES: u64 = 64 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FailureKind {
    Asset,
    Compatibility,
    Migration,
    NativeDependency,
    Port,
    Storage,
    Timeout,
    UnexpectedExit,
    Unknown,
}

impl FailureKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Asset => "asset",
            Self::Compatibility => "compatibility",
            Self::Migration => "migration",
            Self::NativeDependency => "native-dependency",
            Self::Port => "port",
            Self::Storage => "storage",
            Self::Timeout => "timeout",
            Self::UnexpectedExit => "unexpected-exit",
            Self::Unknown => "unknown",
        }
    }

    fn from_wire(value: &str) -> Option<Self> {
        Some(match value {
            "asset" => Self::Asset,
            "compatibility" => Self::Compatibility,
            "migration" => Self::Migration,
            "native-dependency" => Self::NativeDependency,
            "port" => Self::Port,
            "storage" => Self::Storage,
            "unknown" => Self::Unknown,
            _ => return None,
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FailureReport {
    pub chain: Vec<String>,
    pub kind: FailureKind,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RuntimePhase {
    Failed,
    Ready,
    Starting,
}

#[derive(Debug)]
pub struct RuntimeAttemptState {
    generation: u64,
    phase: RuntimePhase,
}

impl RuntimeAttemptState {
    pub fn new() -> Self {
        Self {
            generation: 0,
            phase: RuntimePhase::Failed,
        }
    }

    pub fn begin(&mut self) -> Option<u64> {
        if self.phase == RuntimePhase::Starting {
            return None;
        }
        self.generation = self.generation.saturating_add(1);
        self.phase = RuntimePhase::Starting;
        Some(self.generation)
    }

    pub fn mark_ready(&mut self, generation: u64) -> bool {
        if self.generation != generation || self.phase != RuntimePhase::Starting {
            return false;
        }
        self.phase = RuntimePhase::Ready;
        true
    }

    pub fn mark_failed(&mut self, generation: u64) -> bool {
        if self.generation != generation || self.phase == RuntimePhase::Failed {
            return false;
        }
        self.phase = RuntimePhase::Failed;
        true
    }

    pub fn is_starting(&self, generation: u64) -> bool {
        self.generation == generation && self.phase == RuntimePhase::Starting
    }

    pub fn phase(&self) -> RuntimePhase {
        self.phase
    }
}

impl FailureReport {
    pub fn from_error(kind: FailureKind, error: &(dyn Error + 'static)) -> Self {
        let mut chain = vec![error.to_string()];
        let mut source = error.source();
        while let Some(cause) = source {
            chain.push(cause.to_string());
            source = cause.source();
        }
        Self { chain, kind }
    }
}

pub fn parse_sidecar_failure(line: &str) -> Option<FailureReport> {
    let payload = line.trim().strip_prefix(DESKTOP_FAILURE_EVENT_PREFIX)?;
    let value: Value = serde_json::from_str(payload).ok()?;
    let kind = FailureKind::from_wire(value.get("kind")?.as_str()?)?;
    let chain = value
        .get("chain")?
        .as_array()?
        .iter()
        .map(Value::as_str)
        .collect::<Option<Vec<_>>>()?
        .into_iter()
        .map(str::to_owned)
        .collect::<Vec<_>>();
    if chain.is_empty() {
        return None;
    }
    Some(FailureReport { chain, kind })
}

#[derive(Debug)]
pub enum RuntimeHealthError {
    Unavailable(io::Error),
    Incompatible(String),
}

impl Display for RuntimeHealthError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unavailable(source) => {
                write!(formatter, "Floway runtime health is unavailable: {source}")
            }
            Self::Incompatible(message) => write!(
                formatter,
                "Floway runtime compatibility check failed: {message}"
            ),
        }
    }
}

impl Error for RuntimeHealthError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Unavailable(source) => Some(source),
            Self::Incompatible(_) => None,
        }
    }
}

fn parse_http_body(response: &[u8]) -> Result<&[u8], RuntimeHealthError> {
    let separator = b"\r\n\r\n";
    let Some(header_end) = response
        .windows(separator.len())
        .position(|window| window == separator)
    else {
        return Err(RuntimeHealthError::Incompatible(
            "the health response has no HTTP header boundary".to_owned(),
        ));
    };
    let headers = std::str::from_utf8(&response[..header_end]).map_err(|source| {
        RuntimeHealthError::Incompatible(format!(
            "the health response headers are not UTF-8: {source}"
        ))
    })?;
    if !headers
        .lines()
        .next()
        .is_some_and(|line| line.contains(" 200 "))
    {
        return Err(RuntimeHealthError::Incompatible(format!(
            "the health endpoint returned {}",
            headers.lines().next().unwrap_or("an invalid status line")
        )));
    }
    Ok(&response[header_end + separator.len()..])
}

fn validate_health_body(
    body: &[u8],
    expected: &RuntimeCompatibility,
) -> Result<(), RuntimeHealthError> {
    let value: Value = serde_json::from_slice(body).map_err(|source| {
        RuntimeHealthError::Incompatible(format!("the health response is not valid JSON: {source}"))
    })?;
    let compatibility = value.get("compatibility");
    let actual_protocol = compatibility
        .and_then(|value| value.get("protocolVersion"))
        .and_then(Value::as_u64);
    let actual_release = compatibility
        .and_then(|value| value.get("releaseVersion"))
        .and_then(Value::as_str);
    let actual_digest = compatibility
        .and_then(|value| value.get("contractDigest"))
        .and_then(Value::as_str);
    if value.get("status").and_then(Value::as_str) != Some("ok")
        || value.get("service").and_then(Value::as_str) != Some("floway")
        || actual_protocol != Some(expected.protocol_version)
        || actual_release != Some(expected.release_version.as_str())
        || actual_digest != Some(expected.contract_digest.as_str())
    {
        return Err(RuntimeHealthError::Incompatible(format!(
            "expected protocol {} release {} contract {}; received protocol {} release {} contract {}",
            expected.protocol_version,
            expected.release_version,
            expected.contract_digest,
            actual_protocol.map_or_else(|| "missing".to_owned(), |value| value.to_string()),
            actual_release.unwrap_or("missing"),
            actual_digest.unwrap_or("missing"),
        )));
    }
    Ok(())
}

pub fn probe_compatible_runtime(
    origin: &str,
    expected: &RuntimeCompatibility,
) -> Result<(), RuntimeHealthError> {
    let origin = Url::parse(origin).map_err(|source| {
        RuntimeHealthError::Incompatible(format!("the runtime origin is invalid: {source}"))
    })?;
    if origin.scheme() != "http" || origin.host_str() != Some("127.0.0.1") {
        return Err(RuntimeHealthError::Incompatible(
            "the runtime health origin is not the packaged loopback authority".to_owned(),
        ));
    }
    let port = origin.port().ok_or_else(|| {
        RuntimeHealthError::Incompatible(
            "the runtime health origin has no explicit port".to_owned(),
        )
    })?;
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&address, HEALTH_IO_TIMEOUT)
        .map_err(RuntimeHealthError::Unavailable)?;
    stream
        .set_read_timeout(Some(HEALTH_IO_TIMEOUT))
        .and_then(|()| stream.set_write_timeout(Some(HEALTH_IO_TIMEOUT)))
        .map_err(RuntimeHealthError::Unavailable)?;
    write!(
        stream,
        "GET {DESKTOP_HEALTH_PATH} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAccept: application/json\r\nConnection: close\r\n\r\n"
    )
    .map_err(RuntimeHealthError::Unavailable)?;
    let mut response = Vec::new();
    stream
        .take(MAXIMUM_HEALTH_RESPONSE_BYTES)
        .read_to_end(&mut response)
        .map_err(RuntimeHealthError::Unavailable)?;
    validate_health_body(parse_http_body(&response)?, expected)
}

#[cfg(test)]
pub(crate) fn validate_health_response_for_test(
    response: &[u8],
    expected: &RuntimeCompatibility,
) -> Result<(), RuntimeHealthError> {
    validate_health_body(parse_http_body(response)?, expected)
}
