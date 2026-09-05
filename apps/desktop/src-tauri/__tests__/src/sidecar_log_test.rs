#[allow(dead_code)]
#[path = "../../src/sidecar_log.rs"]
mod sidecar_log;

use std::fs::{read_to_string, remove_dir_all};
use std::time::{SystemTime, UNIX_EPOCH};

use sidecar_log::{BoundedSidecarLog, SidecarStream};

fn temporary_root() -> std::path::PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock must follow the Unix epoch")
        .as_nanos();
    let root = std::env::temp_dir().join(format!("floway-sidecar-log-{nonce}"));
    std::fs::create_dir_all(&root).expect("fixture directory must be writable");
    root
}

#[test]
fn captures_both_streams_and_rotates_with_a_fixed_file_bound() {
    let root = temporary_root();
    let mut log = BoundedSidecarLog::open_for_test(&root, 40, 2).expect("log must open");

    log.append(SidecarStream::Stdout, b"ready")
        .expect("stdout must append");
    log.append(SidecarStream::Stderr, b"first failure")
        .expect("stderr must append");
    log.append(SidecarStream::Stderr, b"second failure")
        .expect("rotation must succeed");
    log.append(SidecarStream::Stdout, b"recovered")
        .expect("new log must remain writable");

    assert_eq!(
        read_to_string(log.path()).expect("active log must be readable"),
        "[stdout] recovered\n"
    );
    assert_eq!(
        read_to_string(log.path().with_extension("log.1"))
            .expect("latest rotated log must be readable"),
        "[stderr] second failure\n",
    );
    assert_eq!(
        read_to_string(log.path().with_extension("log.2"))
            .expect("oldest retained log must be readable"),
        "[stdout] ready\n[stderr] first failure\n",
    );
    assert!(!log.path().with_extension("log.3").exists());

    remove_dir_all(root).expect("fixture cleanup must succeed");
}
