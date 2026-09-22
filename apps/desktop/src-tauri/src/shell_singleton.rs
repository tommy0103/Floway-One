//! Owns the single desktop shell instance and its loopback-free control
//! channel. The owning shell binds one Unix domain socket per data root;
//! repeated launches delegate their request to the owner and exit instead of
//! starting a second gateway. The socket lives in the per-user temporary
//! directory, which macOS creates with user-only access.
//! https://developer.apple.com/library/archive/documentation/FileManagement/Conceptual/FileSystemProgrammingGuide/FileSystemOverview/FileSystemOverview.html#//apple_ref/doc/uid/TP40010672-CH2-SW12

use std::ffi::OsString;
use std::fs;
use std::io::{self, Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::thread;
use std::time::Duration;

use serde_json::{Value, json};
use sha2::{Digest, Sha256};

pub const SHELL_CONTROL_ARGUMENT: &str = "--desktop-control";
// Unix `sun_path` holds at most 104 bytes on macOS; the hashed socket name
// keeps every derivable path far below that bound.
// https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/sys/un.h#L61-L67
const SOCKET_NAME_DIGEST_BYTES: usize = 12;
const MAXIMUM_CONTROL_MESSAGE_BYTES: u64 = 4096;
const CONTROL_IO_TIMEOUT: Duration = Duration::from_secs(5);
const OWNER_PROBE_ATTEMPTS: usize = 3;
const OWNER_PROBE_INTERVAL: Duration = Duration::from_millis(100);

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ShellCommand {
    Activate,
    CloseWindow,
    CopyGatewayAddress,
    Quit,
    ReportStatus,
    RestartGateway,
    SetAutostart(bool),
    // Verifier-only transport for the external-link gate (#45): the URL is
    // driven through the live shell's webview so `handle_navigation` — the
    // segment a Dashboard link click takes — decides what happens to it.
    VerifyExternalOpen(String),
}

impl ShellCommand {
    fn name(&self) -> &'static str {
        match self {
            Self::Activate => "activate",
            Self::CloseWindow => "close-window",
            Self::CopyGatewayAddress => "copy-gateway-address",
            Self::Quit => "quit",
            Self::ReportStatus => "report-status",
            Self::RestartGateway => "restart-gateway",
            Self::SetAutostart(_) => "set-autostart",
            Self::VerifyExternalOpen(_) => "verify-external-open",
        }
    }

    fn from_name(name: &str, url: Option<&str>, enabled: Option<bool>) -> Option<Self> {
        match (name, url, enabled) {
            ("activate", None, None) => Some(Self::Activate),
            ("close-window", None, None) => Some(Self::CloseWindow),
            ("copy-gateway-address", None, None) => Some(Self::CopyGatewayAddress),
            ("quit", None, None) => Some(Self::Quit),
            ("report-status", None, None) => Some(Self::ReportStatus),
            ("restart-gateway", None, None) => Some(Self::RestartGateway),
            ("set-autostart", None, Some(enabled)) => Some(Self::SetAutostart(enabled)),
            ("verify-external-open", Some(url), None) => {
                Some(Self::VerifyExternalOpen(url.to_owned()))
            }
            _ => None,
        }
    }

    fn from_control_name(name: &str) -> Option<Self> {
        if let Some(url) = name.strip_prefix("verify-external-open?url=") {
            return Some(Self::VerifyExternalOpen(url.to_owned()));
        }
        match name {
            "activate" => Some(Self::Activate),
            "close-window" => Some(Self::CloseWindow),
            "copy-gateway-address" => Some(Self::CopyGatewayAddress),
            "quit" => Some(Self::Quit),
            "report-status" => Some(Self::ReportStatus),
            "restart-gateway" => Some(Self::RestartGateway),
            "autostart-on" => Some(Self::SetAutostart(true)),
            "autostart-off" => Some(Self::SetAutostart(false)),
            _ => None,
        }
    }
}

fn encode_command(command: ShellCommand) -> Vec<u8> {
    let mut value = json!({ "command": command.name() });
    {
        let fields = value
            .as_object_mut()
            .expect("shell command wire value must remain an object");
        match &command {
            ShellCommand::SetAutostart(enabled) => {
                fields.insert("enabled".to_owned(), json!(enabled));
            }
            ShellCommand::VerifyExternalOpen(url) => {
                fields.insert("url".to_owned(), json!(url));
            }
            _ => {}
        }
    }
    let mut encoded = serde_json::to_vec(&value).expect("shell command wire value must encode");
    encoded.push(b'\n');
    encoded
}

fn decode_command(line: &str) -> Option<ShellCommand> {
    let value: Value = serde_json::from_str(line).ok()?;
    let fields = value.as_object()?;
    let name = fields.get("command")?.as_str()?;
    let url = fields.get("url").and_then(Value::as_str);
    let enabled = fields.get("enabled").and_then(Value::as_bool);
    ShellCommand::from_name(name, url, enabled)
}

pub fn control_socket_path(data_root: &Path) -> PathBuf {
    let canonical = fs::canonicalize(data_root).unwrap_or_else(|_| data_root.to_path_buf());
    let digest = Sha256::digest(canonical.as_os_str().as_encoded_bytes());
    let mut name = String::from("floway-one-");
    for byte in &digest[..SOCKET_NAME_DIGEST_BYTES] {
        name.push_str(&format!("{byte:02x}"));
    }
    name.push_str(".sock");
    std::env::temp_dir().join(name)
}

pub fn parse_control_command(
    args: impl IntoIterator<Item = OsString>,
) -> io::Result<Option<ShellCommand>> {
    let mut args = args.into_iter().skip(1);
    let mut command = None;
    while let Some(argument) = args.next() {
        if argument != *SHELL_CONTROL_ARGUMENT {
            continue;
        }
        if command.is_some() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("Floway desktop accepts {SHELL_CONTROL_ARGUMENT} only once"),
            ));
        }
        let name = args.next().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("Floway desktop {SHELL_CONTROL_ARGUMENT} requires a command name"),
            )
        })?;
        let Some(parsed) = ShellCommand::from_control_name(&name.to_string_lossy()) else {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!(
                    "Floway desktop {SHELL_CONTROL_ARGUMENT} does not recognize {}",
                    name.to_string_lossy()
                ),
            ));
        };
        command = Some(parsed);
    }
    Ok(command)
}

fn owner_accepts_connections(socket_path: &Path) -> bool {
    for _ in 0..OWNER_PROBE_ATTEMPTS {
        match UnixStream::connect(socket_path) {
            Ok(_) => return true,
            Err(error) if error.kind() == io::ErrorKind::ConnectionRefused => {
                thread::sleep(OWNER_PROBE_INTERVAL);
            }
            Err(_) => return false,
        }
    }
    false
}

pub enum ShellOwnership {
    Owner(UnixListener),
    AlreadyRunning,
}

pub fn claim_shell_ownership(socket_path: &Path) -> io::Result<ShellOwnership> {
    match UnixListener::bind(socket_path) {
        Ok(listener) => Ok(ShellOwnership::Owner(listener)),
        Err(error) if error.kind() == io::ErrorKind::AddrInUse => {
            if owner_accepts_connections(socket_path) {
                return Ok(ShellOwnership::AlreadyRunning);
            }
            // A forced shell termination leaves its socket file behind; only a
            // refused probe proves the owner is gone before reclaiming it. The
            // file can also vanish between the failed bind and this cleanup
            // when the prior owner exits gracefully, so a missing file is a
            // successful reclaim too.
            match fs::remove_file(socket_path) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
            UnixListener::bind(socket_path).map(ShellOwnership::Owner)
        }
        Err(error) => Err(error),
    }
}

pub fn read_shell_command(stream: &UnixStream) -> io::Result<Option<ShellCommand>> {
    // XNU rejects every sockopt with EINVAL once a socket has been shut down
    // in both directions — exactly the state of an accepted channel whose
    // probe peer already fully disconnected. Our command clients half-close
    // but stay connected for the reply, so an EINVAL peer is a dead probe
    // whose reads drain to EOF without blocking.
    // https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/kern/uipc_socket.c#L4750-L4757
    if let Err(error) = stream.set_read_timeout(Some(CONTROL_IO_TIMEOUT)) {
        if error.kind() != io::ErrorKind::InvalidInput {
            return Err(error);
        }
    }
    // Commands are single bounded lines.
    let mut bytes = Vec::new();
    let mut byte = [0_u8; 1];
    loop {
        match (&*stream).read(&mut byte) {
            Ok(0) => break,
            Ok(_) => {
                if byte[0] == b'\n' {
                    break;
                }
                bytes.push(byte[0]);
                if bytes.len() as u64 > MAXIMUM_CONTROL_MESSAGE_BYTES {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "Floway desktop control message exceeded its byte bound",
                    ));
                }
            }
            Err(error) => return Err(error),
        }
    }
    if bytes.is_empty() {
        // An ownership probe opens and closes the channel without a command.
        return Ok(None);
    }
    let line = std::str::from_utf8(&bytes).map_err(|source| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("Floway desktop control message is not UTF-8: {source}"),
        )
    })?;
    decode_command(line)
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                "Floway desktop control message is not a known command",
            )
        })
        .map(Some)
}

pub fn write_shell_reply(stream: &mut UnixStream, reply: &Value) -> io::Result<()> {
    stream.write_all(&serde_json::to_vec(reply).expect("shell reply must encode"))?;
    stream.write_all(b"\n")?;
    stream.shutdown(std::net::Shutdown::Write)
}

// The write-half shutdown only signals the end of the command; XNU clears
// SS_ISCONNECTED on a Unix stream pair as soon as either side fully closes,
// so an owner that already read the command, replied, and closed turns this
// final courtesy into ENOTCONN even though the exchange succeeded. The reply
// read that follows decides the real outcome.
// https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/kern/uipc_socket.c#L1771-L1778
pub fn finish_command_write_side(stream: &UnixStream) -> io::Result<()> {
    match stream.shutdown(std::net::Shutdown::Write) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotConnected => Ok(()),
        Err(error) => Err(error),
    }
}

pub fn send_shell_command(socket_path: &Path, command: ShellCommand) -> io::Result<Value> {
    let mut stream = UnixStream::connect(socket_path).map_err(|source| {
        io::Error::new(
            source.kind(),
            format!("Floway desktop could not reach its running instance: {source}"),
        )
    })?;
    stream.set_read_timeout(Some(CONTROL_IO_TIMEOUT))?;
    stream.write_all(&encode_command(command))?;
    finish_command_write_side(&stream)?;
    let mut response = Vec::new();
    stream
        .take(MAXIMUM_CONTROL_MESSAGE_BYTES + 1)
        .read_to_end(&mut response)?;
    let value: Value = serde_json::from_slice(&response).map_err(|source| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("Floway desktop running instance returned an invalid reply: {source}"),
        )
    })?;
    if value.get("ok").and_then(Value::as_bool) == Some(true) {
        return Ok(value);
    }
    let reason = value
        .get("error")
        .and_then(Value::as_str)
        .unwrap_or("the running instance rejected the command without a reason");
    Err(io::Error::new(
        io::ErrorKind::ConnectionRefused,
        format!("Floway desktop running instance rejected the command: {reason}"),
    ))
}
