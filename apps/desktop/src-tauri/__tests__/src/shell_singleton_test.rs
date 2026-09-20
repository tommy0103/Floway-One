use std::ffi::OsString;
use std::fs;
use std::io::Write;
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

#[allow(dead_code)]
#[path = "../../src/shell_singleton.rs"]
mod shell_singleton;

use shell_singleton::{
    ShellCommand, ShellOwnership, claim_shell_ownership, control_socket_path,
    finish_command_write_side, parse_control_command, read_shell_command, send_shell_command,
    write_shell_reply,
};

fn test_dir(label: &str) -> PathBuf {
    // Unix `sun_path` holds at most 104 bytes on macOS; keep fixture paths short.
    // https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/sys/un.h#L61-L67
    let dir = std::env::temp_dir().join(format!("floway-sst-{label}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("test directory must be created");
    dir
}

fn socket_in(dir: &std::path::Path) -> PathBuf {
    dir.join("t.sock")
}

#[test]
fn shell_commands_round_trip_through_their_wire_encoding() {
    let commands = [
        ShellCommand::Activate,
        ShellCommand::CloseWindow,
        ShellCommand::CopyGatewayAddress,
        ShellCommand::Quit,
        ShellCommand::ReportStatus,
        ShellCommand::RestartGateway,
        ShellCommand::SetAutostart(true),
        ShellCommand::SetAutostart(false),
    ];
    let dir = test_dir("round-trip");
    let socket = socket_in(&dir);
    let ShellOwnership::Owner(listener) = claim_shell_ownership(&socket).expect("first claim")
    else {
        panic!("first claim must own the channel");
    };
    let (reported, commands_rx) = mpsc::channel();
    let server = thread::spawn(move || {
        for _ in &commands {
            let (mut stream, _) = listener.accept().expect("accept must succeed");
            let command = read_shell_command(&stream).expect("command must decode");
            reported.send(command).expect("command must report");
            write_shell_reply(&mut stream, &serde_json::json!({ "ok": true }))
                .expect("reply must be written");
        }
    });
    for command in commands {
        send_shell_command(&socket, command).expect("command must be acknowledged");
        assert_eq!(
            commands_rx
                .recv_timeout(Duration::from_secs(5))
                .expect("command must arrive"),
            Some(command),
        );
    }
    server.join().expect("server thread must finish");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn report_status_carries_its_status_payload_back_to_the_caller() {
    let dir = test_dir("report-status");
    let socket = socket_in(&dir);
    let ShellOwnership::Owner(listener) = claim_shell_ownership(&socket).expect("claim") else {
        panic!("claim must own the channel");
    };
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("accept must succeed");
        let command = read_shell_command(&stream).expect("command must decode");
        assert_eq!(command, Some(ShellCommand::ReportStatus));
        write_shell_reply(
            &mut stream,
            &serde_json::json!({
                "ok": true,
                "status": { "phase": "ready", "gatewayOrigin": "http://127.0.0.1:8788" },
            }),
        )
        .expect("reply must be written");
    });
    let reply = send_shell_command(&socket, ShellCommand::ReportStatus).expect("reply must arrive");
    assert_eq!(
        reply
            .pointer("/status/gatewayOrigin")
            .and_then(serde_json::Value::as_str),
        Some("http://127.0.0.1:8788"),
    );
    server.join().expect("server thread must finish");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn control_argument_parses_each_operator_command_exactly_once() {
    let cases: [(&str, ShellCommand); 8] = [
        ("activate", ShellCommand::Activate),
        ("close-window", ShellCommand::CloseWindow),
        ("copy-gateway-address", ShellCommand::CopyGatewayAddress),
        ("quit", ShellCommand::Quit),
        ("report-status", ShellCommand::ReportStatus),
        ("restart-gateway", ShellCommand::RestartGateway),
        ("autostart-on", ShellCommand::SetAutostart(true)),
        ("autostart-off", ShellCommand::SetAutostart(false)),
    ];
    for (name, expected) in cases {
        let args = [
            OsString::from("floway-one"),
            OsString::from("--desktop-control"),
            OsString::from(name),
        ];
        assert_eq!(
            parse_control_command(args).expect("control argument must parse"),
            Some(expected),
        );
    }
    let passthrough = [
        OsString::from("floway-one"),
        OsString::from("--data-dir"),
        OsString::from("/tmp/floway"),
    ];
    assert_eq!(
        parse_control_command(passthrough).expect("other arguments must pass through"),
        None,
    );
}

#[test]
fn control_argument_rejects_unknown_missing_and_repeated_commands() {
    let unknown = [
        OsString::from("floway-one"),
        OsString::from("--desktop-control"),
        OsString::from("detonate"),
    ];
    assert!(parse_control_command(unknown).is_err());
    let missing = [
        OsString::from("floway-one"),
        OsString::from("--desktop-control"),
    ];
    assert!(parse_control_command(missing).is_err());
    let repeated = [
        OsString::from("floway-one"),
        OsString::from("--desktop-control"),
        OsString::from("quit"),
        OsString::from("--desktop-control"),
        OsString::from("activate"),
    ];
    assert!(parse_control_command(repeated).is_err());
}

#[test]
fn control_socket_path_stays_short_stable_and_distinct_per_data_root() {
    let first = control_socket_path(std::path::Path::new("/tmp/floway-one-first"));
    let second = control_socket_path(std::path::Path::new("/tmp/floway-one-second"));
    assert_ne!(first, second);
    assert_eq!(
        first,
        control_socket_path(std::path::Path::new("/tmp/floway-one-first"))
    );
    // https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/sys/un.h#L61-L67
    assert!(first.as_os_str().as_encoded_bytes().len() < 104);
}

#[test]
fn ownership_rejects_a_second_claim_and_recovers_from_a_dead_owner() {
    let dir = test_dir("ownership");
    let socket = socket_in(&dir);
    let owner = claim_shell_ownership(&socket).expect("first claim must succeed");
    assert!(matches!(owner, ShellOwnership::Owner(_)));
    assert!(matches!(
        claim_shell_ownership(&socket).expect("second claim must resolve"),
        ShellOwnership::AlreadyRunning,
    ));
    drop(owner);
    // A dropped owner leaves the socket file behind with nobody listening;
    // the next claim must reclaim it instead of delegating to a dead shell.
    let deadline = Instant::now() + Duration::from_secs(5);
    let reclaimed = loop {
        match claim_shell_ownership(&socket) {
            Ok(ownership) => break ownership,
            Err(error) if Instant::now() < deadline => {
                let _ = error;
                thread::sleep(Duration::from_millis(20));
            }
            Err(error) => panic!("dead-owner recovery must succeed: {error}"),
        }
    };
    assert!(matches!(reclaimed, ShellOwnership::Owner(_)));
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn ownership_reclaims_a_stale_socket_file_left_without_a_listener() {
    let dir = test_dir("stale-socket-file");
    let socket = socket_in(&dir);
    fs::write(&socket, b"stale").expect("stale socket file must exist");
    // With no listener the probe fails; recovery removes the file and binds.
    let reclaimed = claim_shell_ownership(&socket).expect("stale claim must recover");
    assert!(matches!(reclaimed, ShellOwnership::Owner(_)));
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn ownership_probe_without_a_command_reads_as_no_command() {
    let dir = test_dir("probe");
    let socket = socket_in(&dir);
    let ShellOwnership::Owner(listener) = claim_shell_ownership(&socket).expect("claim") else {
        panic!("claim must own the channel");
    };
    let probe = UnixStream::connect(&socket).expect("probe must connect");
    drop(probe);
    let (stream, _) = listener.accept().expect("accept must succeed");
    assert_eq!(
        read_shell_command(&stream).expect("empty probe must not fail"),
        None,
    );
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn malformed_and_unknown_commands_are_rejected() {
    let dir = test_dir("malformed");
    let socket = socket_in(&dir);
    let ShellOwnership::Owner(listener) = claim_shell_ownership(&socket).expect("claim") else {
        panic!("claim must own the channel");
    };
    for payload in [
        b"not json\n".as_slice(),
        b"{\"command\":\"detonate\"}\n".as_slice(),
    ] {
        let mut client = UnixStream::connect(&socket).expect("client must connect");
        client.write_all(payload).expect("payload must be written");
        drop(client);
        let (stream, _) = listener.accept().expect("accept must succeed");
        assert!(read_shell_command(&stream).is_err());
    }
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn command_half_close_tolerates_an_owner_that_finished_first() {
    let (client, server) = UnixStream::pair().expect("socket pair must exist");
    drop(server);
    // Establish the platform premise: with the peer fully closed, XNU reports
    // the write-half shutdown as not-connected instead of a harmless no-op.
    // https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/kern/uipc_socket.c#L1771-L1778
    assert_eq!(
        client
            .shutdown(std::net::Shutdown::Write)
            .expect_err("a closed peer must surface as not-connected")
            .kind(),
        std::io::ErrorKind::NotConnected,
    );
    finish_command_write_side(&client)
        .expect("an owner that already finished must not fail the exchange");
}

#[test]
fn send_to_a_missing_owner_fails_closed() {
    let dir = test_dir("missing-owner");
    let socket = socket_in(&dir);
    assert!(send_shell_command(&socket, ShellCommand::Activate).is_err());
    let _ = fs::remove_dir_all(&dir);
}
