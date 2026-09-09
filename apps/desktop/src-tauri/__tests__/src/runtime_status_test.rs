#[allow(dead_code)]
#[path = "../../src/bundle_contract.rs"]
mod bundle_contract;
#[allow(dead_code)]
#[path = "../../src/runtime_status.rs"]
mod runtime_status;

use bundle_contract::RuntimeCompatibility;
use runtime_status::{
    DesktopStartupError, FailureKind, InitialStatusLoadGate, RecoverySurfaceOperation,
    RuntimeAttemptState, RuntimeHealthError, RuntimePhase, STARTUP_TIMEOUT, SidecarFailureDecoder,
    apply_recovery_surface, parse_sidecar_failure, validate_health_response_for_test,
};
use std::error::Error;
use std::io;
use std::sync::{Arc, Mutex, mpsc};
use std::thread;
use std::time::{Duration, Instant};

fn expected() -> RuntimeCompatibility {
    RuntimeCompatibility {
        contract_digest: "a".repeat(64),
        protocol_version: 1,
        release_version: "0.1.0".to_owned(),
    }
}

fn response(body: &str) -> Vec<u8> {
    format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{body}")
        .into_bytes()
}

#[test]
fn accepts_only_the_exact_shell_sidecar_and_dashboard_contract() {
    let body = serde_json::json!({
        "status": "ok",
        "service": "floway",
        "compatibility": {
            "protocolVersion": 1,
            "releaseVersion": "0.1.0",
            "contractDigest": "a".repeat(64),
        },
    });
    validate_health_response_for_test(&response(&body.to_string()), &expected())
        .expect("matching runtime health must be accepted");

    for (field, value) in [
        ("protocolVersion", serde_json::json!(2)),
        ("releaseVersion", serde_json::json!("0.2.0")),
        ("contractDigest", serde_json::json!("b".repeat(64))),
    ] {
        let mut incompatible = body.clone();
        incompatible["compatibility"][field] = value;
        let error =
            validate_health_response_for_test(&response(&incompatible.to_string()), &expected())
                .expect_err("each compatibility mismatch must fail");
        assert!(matches!(error, RuntimeHealthError::Incompatible(_)));
        assert!(
            error
                .to_string()
                .contains("expected protocol 1 release 0.1.0")
        );
    }
}

#[test]
fn rejects_generic_or_malformed_health_responses() {
    for body in [r#"{"status":"ok","service":"floway"}"#, "not json"] {
        let error = validate_health_response_for_test(&response(body), &expected())
            .expect_err("a generic health response must not satisfy desktop readiness");
        assert!(matches!(error, RuntimeHealthError::Incompatible(_)));
    }
}

#[test]
fn parses_a_structured_sidecar_failure_without_flattening_its_chain() {
    let report = parse_sidecar_failure(
        r#"FLOWAY_DESKTOP_FAILURE {"kind":"migration","chain":["outer migration context","original sqlite cause"]}"#,
    )
    .expect("structured failure must parse");
    assert_eq!(report.kind, FailureKind::Migration);
    assert_eq!(
        report.chain,
        ["outer migration context", "original sqlite cause"]
    );
    assert!(parse_sidecar_failure("ordinary stderr").is_none());
}

#[test]
fn decodes_a_structured_failure_split_across_stderr_events() {
    let mut decoder = SidecarFailureDecoder::default();
    assert!(
        decoder
            .push(b"ordinary stderr\nFLOWAY_DESKTOP_FAILURE {\"kind\":\"native-")
            .is_none()
    );
    let report = decoder
        .push(b"dependency\",\"chain\":[\"outer context\",\"original cause\"]}\ntrailing stderr")
        .expect("the completed structured event must decode");
    assert_eq!(report.kind, FailureKind::NativeDependency);
    assert_eq!(report.chain, ["outer context", "original cause"]);
    assert!(decoder.finish().is_none());
}

#[test]
fn ignores_stale_readiness_and_failure_results_across_explicit_restarts() {
    let mut state = RuntimeAttemptState::new();
    let first = state.begin().expect("first attempt must begin");
    assert!(state.mark_startup_failed(first, FailureKind::Port));
    assert!(state.complete_teardown(first));
    let second = state.begin().expect("failed runtime may restart");

    assert_ne!(first, second);
    assert!(
        !state
            .commit_ready(first, |_| Ok::<(), ()>(()))
            .expect("stale ready transition must not fail")
    );
    assert!(state.is_starting(second));
    assert!(
        state
            .commit_ready(second, |_| Ok::<(), ()>(()))
            .expect("ready transition must succeed")
    );
    assert_eq!(state.phase(), RuntimePhase::Ready);
    assert!(!state.mark_startup_failed(first, FailureKind::Timeout));
    assert!(state.mark_failed(second, FailureKind::UnexpectedExit));
    assert_eq!(state.phase(), RuntimePhase::Failed);
}

#[test]
fn a_ready_attempt_cannot_time_out_after_its_deadline() {
    let mut state = RuntimeAttemptState::new();
    let generation = state.begin().expect("attempt must begin");
    let deadline = Instant::now() + Duration::from_millis(1);
    assert!(
        state
            .commit_ready(generation, |_| Ok::<(), ()>(()))
            .expect("ready transition must succeed")
    );
    thread::sleep(deadline.saturating_duration_since(Instant::now()) + Duration::from_millis(1));

    assert!(!state.mark_startup_failed(generation, FailureKind::Timeout));
    assert_eq!(state.phase(), RuntimePhase::Ready);
}

#[test]
fn ready_effects_finish_before_the_attempt_can_become_ready() {
    let mut state = RuntimeAttemptState::new();
    let generation = state.begin().expect("attempt must begin");
    let mut effects_finished = false;

    assert!(
        state
            .commit_ready(generation, |observed| {
                assert_eq!(observed.phase(), RuntimePhase::Starting);
                effects_finished = true;
                Ok::<(), ()>(())
            })
            .expect("ready effects must succeed")
    );

    assert!(effects_finished);
    assert_eq!(state.phase(), RuntimePhase::Ready);
}

#[test]
fn a_failed_attempt_rejects_all_late_ready_effects() {
    let mut state = RuntimeAttemptState::new();
    let generation = state.begin().expect("attempt must begin");
    assert!(state.mark_startup_failed(generation, FailureKind::Migration));
    let mut effects_ran = false;

    assert!(
        !state
            .commit_ready(generation, |_observed| {
                effects_ran = true;
                Ok::<(), ()>(())
            })
            .expect("rejected ready effects must not fail")
    );

    assert!(!effects_ran);
    assert_eq!(state.phase(), RuntimePhase::Failed);
}

#[test]
fn termination_waiting_on_ready_effects_applies_failed_last() {
    let state = Arc::new(Mutex::new(RuntimeAttemptState::new()));
    let generation = state.lock().unwrap().begin().expect("attempt must begin");
    let (effects_started_tx, effects_started_rx) = mpsc::channel();
    let (finish_effects_tx, finish_effects_rx) = mpsc::channel();

    let ready_state = Arc::clone(&state);
    let ready = thread::spawn(move || {
        ready_state
            .lock()
            .unwrap()
            .commit_ready(generation, |_observed| {
                effects_started_tx.send(()).unwrap();
                finish_effects_rx.recv().unwrap();
                Ok::<(), ()>(())
            })
            .unwrap()
    });
    effects_started_rx.recv().unwrap();

    let failed_state = Arc::clone(&state);
    let failed = thread::spawn(move || {
        failed_state
            .lock()
            .unwrap()
            .mark_failed(generation, FailureKind::UnexpectedExit)
    });
    finish_effects_tx.send(()).unwrap();

    assert!(ready.join().unwrap());
    assert!(failed.join().unwrap());
    assert_eq!(state.lock().unwrap().phase(), RuntimePhase::Failed);
}

#[test]
fn only_the_matching_starting_attempt_can_time_out() {
    let mut state = RuntimeAttemptState::new();
    let first = state.begin().expect("attempt must begin");
    assert!(!state.mark_startup_failed(first.saturating_add(1), FailureKind::Timeout));
    assert!(state.is_starting(first));
    assert!(state.mark_startup_failed(first, FailureKind::Timeout));
    assert_eq!(state.phase(), RuntimePhase::Failed);
}

#[test]
fn startup_deadline_is_finite_and_user_visible() {
    assert_eq!(STARTUP_TIMEOUT.as_secs(), 30);
}

#[test]
fn delayed_initial_status_load_releases_runtime_start_exactly_once() {
    let gate = InitialStatusLoadGate::default();

    assert!(!gate.arm());
    assert!(gate.mark_loaded());
    assert!(!gate.mark_loaded());
    assert!(!gate.arm());
}

#[test]
fn early_initial_status_load_waits_for_runtime_setup_before_starting() {
    let gate = InitialStatusLoadGate::default();

    assert!(!gate.mark_loaded());
    assert!(gate.arm());
    assert!(!gate.arm());
    assert!(!gate.mark_loaded());
}

#[test]
fn an_initial_status_timeout_prevents_a_late_runtime_start() {
    let gate = InitialStatusLoadGate::default();

    assert!(!gate.arm());
    assert!(gate.time_out());
    assert!(!gate.mark_loaded());
    assert!(!gate.time_out());
}

#[test]
fn restart_stays_unavailable_until_the_failed_attempt_finishes_teardown() {
    let mut state = RuntimeAttemptState::new();
    let generation = state.begin().expect("attempt must begin");
    assert!(state.mark_failed(generation, FailureKind::Storage));

    assert!(!state.restart_available());
    assert!(state.begin().is_none());
    assert!(state.complete_teardown(generation));
    assert!(state.restart_available());

    let restarted = state
        .begin()
        .expect("settled failure may restart exactly once");
    assert!(!state.restart_available());
    assert!(state.begin().is_none());
    assert_ne!(restarted, generation);
}

#[test]
fn status_snapshots_are_atomic_and_monotonically_revisioned() {
    let mut state = RuntimeAttemptState::new();
    let initial = state.status();
    let generation = state.begin().expect("attempt must begin");
    state.set_logs_available(true);
    let starting = state.status();
    assert!(starting.revision > initial.revision);
    assert_eq!(starting.phase, RuntimePhase::Starting);
    assert_eq!(starting.failure_kind, None);
    assert!(!starting.restart_available);
    assert!(starting.logs_available);

    assert!(state.mark_startup_failed(generation, FailureKind::Storage));
    let failed = state.status();
    assert!(failed.revision > starting.revision);
    assert_eq!(failed.phase, RuntimePhase::Failed);
    assert_eq!(failed.failure_kind, Some(FailureKind::Storage));
    assert!(!failed.restart_available);
    assert!(failed.logs_available);

    assert!(state.complete_teardown(generation));
    let settled = state.status();
    assert!(settled.revision > failed.revision);
    assert_eq!(settled.failure_kind, Some(FailureKind::Storage));
    assert!(settled.restart_available);
    assert_eq!(
        settled.to_wire_value(),
        serde_json::json!({
            "kind": "storage",
            "logsAvailable": true,
            "restartEnabled": true,
            "revision": settled.revision,
            "state": "failed",
        })
    );
}

#[test]
fn recovery_surface_operation_failure_preserves_its_owned_operation_and_source() {
    let original = io::Error::other("forced window show failure");
    let error = apply_recovery_surface(
        || Ok::<(), io::Error>(()),
        || Err(original),
        || Ok::<(), io::Error>(()),
    )
    .expect_err("a hidden recovery surface must fail publication");

    assert_eq!(error.operation(), RecoverySurfaceOperation::Show);
    assert_eq!(
        error.to_string(),
        "Floway could not show its recovery surface"
    );
    assert_eq!(
        error.source().map(ToString::to_string).as_deref(),
        Some("forced window show failure")
    );
}

#[test]
fn startup_failure_category_is_owned_without_message_or_path_inference() {
    let error = DesktopStartupError::new(
        FailureKind::NativeDependency,
        "Floway could not start its packaged runtime",
        io::Error::other("opaque loader failure"),
    );

    assert_eq!(error.kind(), FailureKind::NativeDependency);
    assert_eq!(
        error.to_string(),
        "Floway could not start its packaged runtime"
    );
    assert_eq!(
        error.source().map(ToString::to_string).as_deref(),
        Some("opaque loader failure")
    );
}
