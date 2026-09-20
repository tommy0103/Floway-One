#[allow(dead_code)]
#[path = "../../src/update_channel.rs"]
mod update_channel;

use std::fs;
use std::sync::atomic::{AtomicU64, Ordering};

use update_channel::{
    UPDATE_CHANNEL_FILE_NAME, UpdateChannel, load_update_channel, parse_update_channel,
    parse_updater_endpoints, previous_release_page_url, resolve_updater_authority,
};

static NEXT_TEMPORARY_ROOT: AtomicU64 = AtomicU64::new(0);

fn temporary_root() -> std::path::PathBuf {
    let nonce = NEXT_TEMPORARY_ROOT.fetch_add(1, Ordering::Relaxed);
    let root = std::env::temp_dir().join(format!(
        "floway-update-channel-{}-{nonce}",
        std::process::id()
    ));
    fs::create_dir_all(&root).expect("fixture directory must be writable");
    root
}

#[test]
fn stable_is_the_default_channel_and_preview_requires_an_explicit_file() {
    let root = temporary_root();
    let channel_file = root.join(UPDATE_CHANNEL_FILE_NAME);

    let (channel, diagnostic) = load_update_channel(&channel_file);
    assert_eq!(channel, UpdateChannel::Stable);
    assert!(diagnostic.is_none());

    fs::write(&channel_file, "{\"channel\":\"preview\"}\n").expect("channel file must be writable");
    let (channel, diagnostic) = load_update_channel(&channel_file);
    assert_eq!(channel, UpdateChannel::Preview);
    assert!(diagnostic.is_none());

    fs::write(&channel_file, "{\"channel\":\"stable\"}\n").expect("channel file must be writable");
    let (channel, diagnostic) = load_update_channel(&channel_file);
    assert_eq!(channel, UpdateChannel::Stable);
    assert!(diagnostic.is_none());

    fs::remove_dir_all(&root).expect("fixture directory must be removable");
}

#[test]
fn an_invalid_channel_file_never_enables_preview_and_reports_a_diagnostic() {
    let root = temporary_root();
    let channel_file = root.join(UPDATE_CHANNEL_FILE_NAME);

    for source in [
        "{\"channel\":\"nightly\"}",
        "{\"channel\":\"preview\",\"extra\":true}",
        "[]",
        "not json",
        "{\"channel\":1}",
        "{}",
    ] {
        fs::write(&channel_file, source).expect("channel file must be writable");
        let (channel, diagnostic) = load_update_channel(&channel_file);
        assert_eq!(channel, UpdateChannel::Stable, "source: {source}");
        let diagnostic =
            diagnostic.unwrap_or_else(|| panic!("source {source} must produce a diagnostic"));
        assert!(
            diagnostic
                .to_string()
                .contains("update channel configuration is invalid"),
            "source: {source}"
        );
    }

    fs::remove_dir_all(&root).expect("fixture directory must be removable");
}

#[test]
fn channel_parsing_accepts_exactly_the_documented_shape() {
    assert_eq!(
        parse_update_channel("{\"channel\":\"stable\"}").expect("stable must parse"),
        UpdateChannel::Stable
    );
    assert_eq!(
        parse_update_channel("{\"channel\":\"preview\"}").expect("preview must parse"),
        UpdateChannel::Preview
    );
    assert_eq!(UpdateChannel::Stable.as_str(), "stable");
    assert_eq!(UpdateChannel::Preview.as_str(), "preview");
    assert_ne!(
        UpdateChannel::Stable.endpoint(),
        UpdateChannel::Preview.endpoint()
    );
    assert!(
        UpdateChannel::Stable
            .endpoint()
            .starts_with("https://github.com/")
    );
    assert!(
        UpdateChannel::Preview
            .endpoint()
            .starts_with("https://github.com/")
    );
}

#[test]
fn endpoint_override_parsing_accepts_only_plain_http_urls() {
    let endpoints = parse_updater_endpoints(
        "https://updates.example/floway.json, http://127.0.0.1:9000/manifest.json",
    )
    .expect("http and https endpoints must parse");
    assert_eq!(endpoints.len(), 2);
    assert_eq!(endpoints[0].as_str(), "https://updates.example/floway.json");
    assert_eq!(endpoints[1].as_str(), "http://127.0.0.1:9000/manifest.json");

    for value in [
        "",
        "https://updates.example/floway.json,",
        "not a url",
        "ftp://updates.example/floway.json",
        "https://user:secret@updates.example/floway.json",
    ] {
        assert!(
            parse_updater_endpoints(value).is_err(),
            "endpoints {value} must be rejected"
        );
    }
}

#[test]
fn updater_authority_requires_endpoint_and_pubkey_pairs() {
    let authority = resolve_updater_authority(
        UpdateChannel::Stable,
        Some("http://127.0.0.1:9000/manifest.json"),
        Some("verification-pubkey"),
        None,
    )
    .expect("a complete override must resolve");
    assert_eq!(authority.endpoints.len(), 1);
    assert_eq!(authority.endpoints[0].host_str(), Some("127.0.0.1"));
    assert_eq!(authority.pubkey, "verification-pubkey");

    let authority = resolve_updater_authority(
        UpdateChannel::Preview,
        None,
        None,
        Some("configured-pubkey"),
    )
    .expect("the configured production authority must resolve");
    assert_eq!(authority.endpoints.len(), 1);
    assert_eq!(
        authority.endpoints[0].as_str(),
        UpdateChannel::Preview.endpoint()
    );
    assert_eq!(authority.pubkey, "configured-pubkey");

    for (endpoints, pubkey, configured) in [
        (Some("http://127.0.0.1:9000/manifest.json"), None, None),
        (None, Some("verification-pubkey"), None),
        (
            Some("http://127.0.0.1:9000/manifest.json"),
            Some("  "),
            None,
        ),
        (None, None, None),
        (None, None, Some("")),
    ] {
        assert!(
            resolve_updater_authority(UpdateChannel::Stable, endpoints, pubkey, configured)
                .is_err(),
            "partial authority {endpoints:?}/{pubkey:?}/{configured:?} must be rejected"
        );
    }
}

#[test]
fn previous_release_page_urls_target_the_release_tag() {
    assert_eq!(
        previous_release_page_url("0.1.0"),
        "https://github.com/tommy0103/Floway-One/releases/tag/v0.1.0"
    );
}
