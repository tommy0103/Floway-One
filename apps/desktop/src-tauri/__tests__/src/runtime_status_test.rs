#[allow(dead_code)]
#[path = "../../src/bundle_contract.rs"]
mod bundle_contract;
#[allow(dead_code)]
#[path = "../../src/runtime_status.rs"]
mod runtime_status;

use bundle_contract::RuntimeCompatibility;
use runtime_status::{
    FailureKind, RuntimeAttemptState, RuntimeHealthError, RuntimePhase, parse_sidecar_failure,
    validate_health_response_for_test,
};

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
fn ignores_stale_readiness_and_failure_results_across_explicit_restarts() {
    let mut state = RuntimeAttemptState::new();
    let first = state.begin().expect("first attempt must begin");
    assert!(state.mark_failed(first));
    let second = state.begin().expect("failed runtime may restart");

    assert_ne!(first, second);
    assert!(!state.mark_ready(first));
    assert!(state.is_starting(second));
    assert!(state.mark_ready(second));
    assert_eq!(state.phase(), RuntimePhase::Ready);
    assert!(!state.mark_failed(first));
    assert!(state.mark_failed(second));
    assert_eq!(state.phase(), RuntimePhase::Failed);
}
