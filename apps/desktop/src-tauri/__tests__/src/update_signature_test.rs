#[path = "../../src/update_signature.rs"]
mod update_signature;

use update_signature::verify_staged_artifact;

// A throwaway minisign keypair generated for this test only; the private key
// signs nothing outside this file.
const TEST_PUBKEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IENEODlGNzU1NTRGODZERDcKUldUWGJmaFVWZmVKemZMT2JOcWNCbE5aWHYweklJOHlVb2l4dUQ0VkF0N2t1blhGN3owUGJKSnYK";
const TEST_PAYLOAD: &[u8] = b"Floway staged artifact verification fixture payload\n";
const TEST_SIGNATURE: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVUWGJmaFVWZmVKelFxb1ZKZi96dnNRd282ZEQ2aU93WEFvT3dDRUlWZEpXSFYvZ2hzMjZoaW9XRWtlU042NGlPUzl3dHA0VTFVZDl0TVRIZ2Jsa2JnTjUwMTA3N1ExZVFFPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzg5OTE0NTYzCWZpbGU6cGF5bG9hZC5iaW4KbEdDNksvQkNqcERkOU02NjBLK3B6VGdqaVJHU1VHTXpwTDNNWGp5a0V5K3kwc2ZqYXB3Q0VZRkh0NE5xWHZta2VsTzhjM3lWRnZqbDJRM0RCZ2djQXc9PQo=";

#[test]
fn authentic_staged_artifacts_pass_verification() {
    verify_staged_artifact(TEST_PAYLOAD, TEST_SIGNATURE, TEST_PUBKEY)
        .expect("the authentic staged artifact must verify");
}

#[test]
fn tampered_staged_artifacts_fail_with_the_signature_error() {
    let mut tampered = TEST_PAYLOAD.to_vec();
    let midpoint = tampered.len() / 2;
    tampered[midpoint] ^= 0xFF;

    let error = verify_staged_artifact(&tampered, TEST_SIGNATURE, TEST_PUBKEY)
        .expect_err("a tampered staged artifact must be rejected");
    assert!(error.to_string().contains("failed signature verification"));
    assert!(error.to_string().contains("does not match its signature"));
}

#[test]
fn mismatched_signatures_and_malformed_authority_fail() {
    let wrong_payload = b"another payload entirely";
    assert!(
        verify_staged_artifact(wrong_payload, TEST_SIGNATURE, TEST_PUBKEY).is_err(),
        "a signature over different bytes must be rejected"
    );
    for (signature, pubkey) in [
        ("not base64 at all", TEST_PUBKEY),
        (TEST_SIGNATURE, "not base64 at all"),
        ("", TEST_PUBKEY),
        (TEST_SIGNATURE, ""),
    ] {
        assert!(
            verify_staged_artifact(TEST_PAYLOAD, signature, pubkey).is_err(),
            "malformed authority {signature:?}/{pubkey:?} must be rejected"
        );
    }
}
