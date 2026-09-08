#[allow(dead_code)]
#[path = "../../src/sidecar_log.rs"]
mod sidecar_log;

use std::fs::{metadata, read, read_to_string, remove_dir_all};
use std::sync::atomic::{AtomicU64, Ordering};

use sidecar_log::{BoundedSidecarLog, SidecarStream};

static NEXT_TEMPORARY_ROOT: AtomicU64 = AtomicU64::new(0);

fn temporary_root() -> std::path::PathBuf {
    let nonce = NEXT_TEMPORARY_ROOT.fetch_add(1, Ordering::Relaxed);
    let root =
        std::env::temp_dir().join(format!("floway-sidecar-log-{}-{nonce}", std::process::id()));
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

#[test]
fn truncates_one_oversized_event_to_the_exact_byte_bound_without_splitting_utf8() {
    let root = temporary_root();
    let mut log = BoundedSidecarLog::open_for_test(&root, 24, 2).expect("log must open");

    log.append(SidecarStream::Stderr, "故障原因🙂故障原因🙂".as_bytes())
        .expect("oversized stderr must be bounded");

    let bytes = read(log.path()).expect("active log must be readable");
    assert!(bytes.len() <= 24);
    assert_eq!(
        metadata(log.path()).expect("log metadata must exist").len(),
        bytes.len() as u64
    );
    assert!(std::str::from_utf8(&bytes).is_ok());
    assert!(
        read_to_string(log.path())
            .expect("bounded log must be UTF-8")
            .starts_with("[stderr] ")
    );
    assert!(!log.path().with_extension("log.1").exists());

    remove_dir_all(root).expect("fixture cleanup must succeed");
}
