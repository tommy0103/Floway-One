#[allow(dead_code)]
#[path = "../../src/failure_chain.rs"]
mod failure_chain;
#[path = "../../src/update_state.rs"]
mod update_state;

use std::fs;
use std::sync::atomic::{AtomicU64, Ordering};

use update_state::{
    BeginInstallError, DesktopUpdateState, MarkHealthyOutcome, PendingUpdateHealth, StagedUpdate,
    UPDATE_STATE_FILE_NAME, UpdateFailure, UpdateFailurePhase,
};

static NEXT_TEMPORARY_ROOT: AtomicU64 = AtomicU64::new(0);

fn temporary_root() -> std::path::PathBuf {
    let nonce = NEXT_TEMPORARY_ROOT.fetch_add(1, Ordering::Relaxed);
    let root = std::env::temp_dir().join(format!(
        "floway-update-state-{}-{nonce}",
        std::process::id()
    ));
    fs::create_dir_all(&root).expect("fixture directory must be writable");
    root
}

fn staged(version: &str) -> StagedUpdate {
    StagedUpdate {
        artifact_bytes: 42_000,
        artifact_file: format!("staged-{version}.bin"),
        download_url: format!("https://releases.example/Floway-{version}.app.tar.gz"),
        notes: Some("release notes".to_owned()),
        signature: "minisign-signature".to_owned(),
        staged_at: 1_760_000_000,
        version: version.to_owned(),
    }
}

fn failure(phase: UpdateFailurePhase) -> UpdateFailure {
    UpdateFailure {
        at: 1_760_000_100,
        chain: vec!["the update phase failed".to_owned()],
        phase,
        version: Some("0.2.0".to_owned()),
    }
}

#[test]
fn update_state_round_trips_through_its_persisted_form() {
    let root = temporary_root();
    let state_file = root.join(UPDATE_STATE_FILE_NAME);

    let mut state = DesktopUpdateState::default();
    state.record_staged(staged("0.2.0"));
    let (pending, consumed) = state
        .begin_install("0.1.0", 1_760_000_200)
        .expect("a staged update must begin installing");
    assert_eq!(consumed.version, "0.2.0");
    assert_eq!(
        pending,
        PendingUpdateHealth {
            installed_at: 1_760_000_200,
            previous_version: "0.1.0".to_owned(),
            version: "0.2.0".to_owned(),
        }
    );

    state.save(&state_file).expect("state must persist");
    let reloaded = DesktopUpdateState::load(&state_file).expect("state must load");
    assert_eq!(reloaded, state);
    assert_eq!(
        DesktopUpdateState::from_value(&reloaded.to_value()).expect("state must reparse"),
        state
    );

    fs::remove_dir_all(&root).expect("fixture directory must be removable");
}

#[test]
fn a_missing_state_file_loads_as_the_empty_state() {
    let root = temporary_root();
    let state = DesktopUpdateState::load(&root.join(UPDATE_STATE_FILE_NAME))
        .expect("a missing state file must load empty");
    assert_eq!(state, DesktopUpdateState::default());
    fs::remove_dir_all(&root).expect("fixture directory must be removable");
}

#[test]
fn begin_install_requires_a_staged_update() {
    let mut state = DesktopUpdateState::default();
    assert_eq!(
        state
            .begin_install("0.1.0", 1)
            .expect_err("install must fail"),
        BeginInstallError::NothingStaged
    );
}

#[test]
fn failures_preserve_the_staged_update_pending_install_and_recovery_information() {
    let mut state = DesktopUpdateState::default();
    state.record_staged(staged("0.2.0"));
    state.record_failure(failure(UpdateFailurePhase::Signature));
    assert!(
        state.staged.is_some(),
        "a signature failure must not consume the staged update"
    );

    state
        .begin_install("0.1.0", 1_760_000_200)
        .expect("install must begin");
    assert!(state.staged.is_none());
    assert!(state.pending.is_some());
    assert!(
        state.failure.is_none(),
        "begin_install clears the prior phase failure"
    );

    state.record_failure(failure(UpdateFailurePhase::Health));
    assert!(
        state.pending.is_some(),
        "a health failure must preserve the pending update"
    );
    assert_eq!(
        state.failure.as_ref().map(|failure| failure.phase),
        Some(UpdateFailurePhase::Health)
    );
    assert_eq!(
        state.last_healthy_version, None,
        "a failure must not mark a version healthy"
    );
}

#[test]
fn mark_healthy_requires_the_pending_version_to_be_running() {
    let mut state = DesktopUpdateState::default();
    assert_eq!(
        state.mark_healthy("0.1.0"),
        MarkHealthyOutcome::NoPendingUpdate
    );
    assert_eq!(state.last_healthy_version.as_deref(), Some("0.1.0"));

    state.record_staged(staged("0.2.0"));
    state
        .begin_install("0.1.0", 1_760_000_200)
        .expect("install must begin");
    assert_eq!(
        state.mark_healthy("0.3.0"),
        MarkHealthyOutcome::PendingVersionMismatch
    );
    assert!(
        state.pending.is_some(),
        "a mismatched version must stay pending"
    );

    state.record_failure(failure(UpdateFailurePhase::Health));
    assert_eq!(
        state.mark_healthy("0.2.0"),
        MarkHealthyOutcome::MarkedHealthy
    );
    assert!(state.pending.is_none());
    assert!(state.failure.is_none());
    assert_eq!(state.last_healthy_version.as_deref(), Some("0.2.0"));
}

#[test]
fn failure_chains_are_bounded_like_the_runtime_failure_surface() {
    let mut state = DesktopUpdateState::default();
    let long_entry = "x".repeat(500);
    state.record_failure(UpdateFailure {
        at: 1,
        chain: vec![
            "first\n\tat frame one\n\tat frame two".to_owned(),
            long_entry,
            "cont\u{0007}rol".to_owned(),
            "fourth".to_owned(),
            "fifth".to_owned(),
        ],
        phase: UpdateFailurePhase::Download,
        version: None,
    });
    let chain = state.failure.expect("failure must be recorded").chain;
    assert_eq!(chain.len(), 4, "the chain keeps at most four entries");
    assert_eq!(chain[0], "first");
    assert_eq!(chain[1].chars().count(), 400);
    assert_eq!(chain[2], "control");
    assert_eq!(chain[3], "fourth");
}

#[test]
fn corrupt_or_unsafe_state_files_are_rejected() {
    let root = temporary_root();
    let state_file = root.join(UPDATE_STATE_FILE_NAME);

    let valid = DesktopUpdateState::default().to_value();
    let mut wrong_schema = valid.clone();
    wrong_schema["schemaVersion"] = serde_json::json!(2);
    let mut unsafe_artifact = DesktopUpdateState {
        staged: Some(StagedUpdate {
            artifact_file: "../escape.bin".to_owned(),
            ..staged("0.2.0")
        }),
        ..DesktopUpdateState::default()
    }
    .to_value();
    unsafe_artifact["staged"]["artifactFile"] = serde_json::json!("../escape.bin");
    let mut missing_field = valid.clone();
    missing_field
        .as_object_mut()
        .expect("state is an object")
        .remove("pending");

    for (label, value) in [
        ("wrong schema", wrong_schema),
        ("unsafe artifact file", unsafe_artifact),
        ("missing field", missing_field),
    ] {
        assert!(
            DesktopUpdateState::from_value(&value).is_err(),
            "{label} must be rejected"
        );
    }

    fs::write(&state_file, "not json").expect("state file must be writable");
    assert!(DesktopUpdateState::load(&state_file).is_err());
    fs::write(&state_file, "{}").expect("state file must be writable");
    assert!(DesktopUpdateState::load(&state_file).is_err());

    fs::remove_dir_all(&root).expect("fixture directory must be removable");
}

#[test]
fn state_files_persist_with_owner_only_permissions() {
    let root = temporary_root();
    let state_file = root.join(UPDATE_STATE_FILE_NAME);
    DesktopUpdateState::default()
        .save(&state_file)
        .expect("state must persist");

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&state_file)
                .expect("state file must exist")
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
    #[cfg(not(unix))]
    assert!(state_file.exists());

    fs::remove_dir_all(&root).expect("fixture directory must be removable");
}
