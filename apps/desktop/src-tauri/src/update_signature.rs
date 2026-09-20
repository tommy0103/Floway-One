//! Owns staged-artifact signature re-authentication before installation.

use std::error::Error;
use std::fmt::{Display, Formatter};

use base64::Engine;
use minisign_verify::{PublicKey, Signature};

#[derive(Debug)]
pub struct StagedArtifactSignatureError {
    message: String,
}

impl Display for StagedArtifactSignatureError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "Floway staged update artifact failed signature verification: {}",
            self.message
        )
    }
}

impl Error for StagedArtifactSignatureError {}

fn invalid_signature(message: impl Into<String>) -> StagedArtifactSignatureError {
    StagedArtifactSignatureError {
        message: message.into(),
    }
}

fn base64_to_string(value: &str, label: &str) -> Result<String, StagedArtifactSignatureError> {
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(value)
        .map_err(|error| invalid_signature(format!("the {label} is not valid base64: {error}")))?;
    String::from_utf8(decoded)
        .map_err(|error| invalid_signature(format!("the {label} is not valid UTF-8: {error}")))
}

// The Tauri updater authenticates artifact bytes inside Update::download, but
// Update::install performs no signature check, so staged bytes read back from
// the application data directory must be re-authenticated the same way before
// the bundle swap.
// https://github.com/tauri-apps/plugins-workspace/blob/updater-v2.12.0/plugins/updater/src/updater.rs#L680
// https://github.com/tauri-apps/plugins-workspace/blob/updater-v2.12.0/plugins/updater/src/updater.rs#L757
pub fn verify_staged_artifact(
    bytes: &[u8],
    release_signature: &str,
    pubkey: &str,
) -> Result<(), StagedArtifactSignatureError> {
    let decoded_pubkey = base64_to_string(pubkey, "updater pubkey")?;
    let public_key = PublicKey::decode(&decoded_pubkey)
        .map_err(|error| invalid_signature(format!("the updater pubkey is invalid: {error}")))?;
    let decoded_signature = base64_to_string(release_signature, "staged artifact signature")?;
    let signature = Signature::decode(&decoded_signature).map_err(|error| {
        invalid_signature(format!("the staged artifact signature is invalid: {error}"))
    })?;
    public_key.verify(bytes, &signature, true).map_err(|error| {
        invalid_signature(format!(
            "the staged artifact does not match its signature: {error}"
        ))
    })
}
