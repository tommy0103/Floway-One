use std::error::Error;
use std::fs::{create_dir_all, read, remove_dir_all, remove_file, write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use floway_desktop::{
    DASHBOARD_ORIGIN, DashboardNavigationPolicy, NODE_SIDECAR_NAME,
    PERSONAL_DASHBOARD_BOOTSTRAP_ENV, PERSONAL_DASHBOARD_BOOTSTRAP_FRAGMENT_KEY,
    PERSONAL_RUNTIME_READY_PREFIX, dashboard_bootstrap_url, enforce_dashboard_navigation,
    ready_dashboard_origin, resolve_runtime_bundle, spawn_after_lifecycle_setup,
};
use serde_json::json;
use sha2::{Digest, Sha256};

fn temporary_root() -> PathBuf {
    static NONCE: AtomicU64 = AtomicU64::new(0);
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock must follow the Unix epoch")
        .as_nanos();
    std::env::temp_dir().join(format!(
        "floway-desktop-rust-{}-{nonce}-{}",
        std::process::id(),
        NONCE.fetch_add(1, Ordering::Relaxed),
    ))
}

fn write_fixture(root: &Path) {
    let files = [
        "runtime/apps/platform-node/entry.js",
        "runtime/apps/platform-node/node_modules/@floway-dev/gateway/migrations/0001_initial.sql",
        "runtime/apps/platform-node/node_modules/@floway-dev/gateway/migrations/0002_independent.sql",
        "runtime/apps/web/dist/client/index.html",
        "runtime/apps/web/dist/client/dashboard-routes.json",
        "runtime/apps/web/dist/client/assets/lazy-dashboard.js",
    ];
    for relative in files {
        let path = root.join(relative);
        create_dir_all(path.parent().expect("fixture path must have a parent"))
            .expect("fixture directory must be writable");
        write(path, relative).expect("fixture file must be writable");
    }
    let (architecture, target_triple) = match std::env::consts::ARCH {
        "aarch64" => ("arm64", "aarch64-apple-darwin"),
        "x86_64" => ("x64", "x86_64-apple-darwin"),
        architecture => panic!("unsupported test architecture {architecture}"),
    };
    let dashboard_assets = [
        "assets/lazy-dashboard.js",
        "dashboard-routes.json",
        "index.html",
    ]
    .map(|relative| {
        let contents = read(root.join("runtime/apps/web/dist/client").join(relative))
            .expect("fixture asset must be readable");
        json!({
            "path": relative,
            "sha256": format!("{:x}", Sha256::digest(contents)),
        })
    });
    let migration_files = ["0001_initial.sql", "0002_independent.sql"].map(|relative| {
        let contents = read(
            root.join("runtime/apps/platform-node/node_modules/@floway-dev/gateway/migrations")
                .join(relative),
        )
        .expect("fixture migration must be readable");
        json!({
            "path": relative,
            "sha256": format!("{:x}", Sha256::digest(contents)),
        })
    });
    let contract = json!({
        "schemaVersion": 1,
        "dashboard": { "assets": dashboard_assets },
        "migrations": { "files": migration_files },
        "node": {
            "architecture": architecture,
            "platform": "darwin",
            "targetTriple": target_triple,
            "version": "24.19.0",
        },
    });
    write(
        root.join("desktop-bundle-contract.json"),
        format!("{contract}\n"),
    )
    .expect("fixture bundle contract must be writable");
}

#[test]
fn resolves_only_packaged_runtime_resources_for_the_personal_sidecar() {
    let root = temporary_root();
    write_fixture(&root);

    let runtime = resolve_runtime_bundle(&root).expect("complete packaged resources must resolve");
    assert_eq!(NODE_SIDECAR_NAME, "floway-node");
    assert_eq!(DASHBOARD_ORIGIN, "http://127.0.0.1:8788");
    assert_eq!(PERSONAL_DASHBOARD_BOOTSTRAP_ENV, "FLOWAY_BOOTSTRAP_TOKEN");
    assert_eq!(
        PERSONAL_DASHBOARD_BOOTSTRAP_FRAGMENT_KEY,
        "floway-bootstrap"
    );
    let token = "12".repeat(32);
    assert_eq!(
        dashboard_bootstrap_url(DASHBOARD_ORIGIN, &token),
        format!("http://127.0.0.1:8788/#floway-bootstrap={token}")
    );
    assert_eq!(PERSONAL_RUNTIME_READY_PREFIX, "Floway listening on ");
    assert_eq!(
        ready_dashboard_origin("migration complete\nFloway listening on http://127.0.0.1:9217\n"),
        Some("http://127.0.0.1:9217")
    );
    assert_eq!(runtime.root, root.join("runtime"));
    assert_eq!(runtime.contract, root.join("desktop-bundle-contract.json"));
    assert_eq!(runtime.dashboard_assets.len(), 3);
    assert_eq!(runtime.migration_files.len(), 2);
    assert_eq!(
        runtime.sidecar_arguments(),
        vec![
            root.join("runtime/apps/platform-node/entry.js")
                .into_os_string(),
            "--profile=personal".into(),
        ]
    );

    remove_dir_all(root).expect("fixture cleanup must succeed");
}

#[test]
fn missing_dashboard_assets_fail_with_the_original_filesystem_error() {
    let root = temporary_root();
    write_fixture(&root);
    let missing = root.join("runtime/apps/web/dist/client/index.html");
    remove_file(&missing).expect("fixture Dashboard index must exist before removal");

    let error = resolve_runtime_bundle(&root).expect_err("missing Dashboard assets must fail");
    assert_eq!(error.path(), missing);
    let source = error.source().expect("filesystem cause must be retained");
    assert!(source.to_string().contains("No such file") || source.to_string().contains("not find"));

    remove_dir_all(root).expect("fixture cleanup must succeed");
}

#[test]
fn missing_lazy_dashboard_chunk_fails_with_the_original_filesystem_error() {
    let root = temporary_root();
    write_fixture(&root);
    let missing = root.join("runtime/apps/web/dist/client/assets/lazy-dashboard.js");
    remove_file(&missing).expect("fixture lazy Dashboard chunk must exist before removal");

    let error = resolve_runtime_bundle(&root).expect_err("missing lazy Dashboard chunk must fail");
    assert_eq!(error.path(), missing);
    let source = error.source().expect("filesystem cause must be retained");
    assert!(source.to_string().contains("No such file") || source.to_string().contains("not find"));

    remove_dir_all(root).expect("fixture cleanup must succeed");
}

#[test]
fn stale_dashboard_contract_fails_before_runtime_startup() {
    let root = temporary_root();
    write_fixture(&root);
    let contract_path = root.join("desktop-bundle-contract.json");
    let mut contract: serde_json::Value = serde_json::from_slice(
        &read(&contract_path).expect("fixture bundle contract must be readable"),
    )
    .expect("fixture bundle contract must be JSON");
    contract["dashboard"]["assets"][0]["sha256"] = json!("0".repeat(64));
    write(&contract_path, format!("{contract}\n")).expect("stale contract must be writable");

    let error = resolve_runtime_bundle(&root).expect_err("stale Dashboard contract must fail");
    assert_eq!(error.path(), contract_path);
    assert!(
        error
            .source()
            .expect("stale contract cause must be retained")
            .to_string()
            .contains("digest is stale")
    );

    remove_dir_all(root).expect("fixture cleanup must succeed");
}

#[test]
fn missing_independent_migration_fails_with_the_original_filesystem_error() {
    let root = temporary_root();
    write_fixture(&root);
    let missing = root.join(
        "runtime/apps/platform-node/node_modules/@floway-dev/gateway/migrations/0002_independent.sql",
    );
    remove_file(&missing).expect("fixture independent migration must exist before removal");

    let error = resolve_runtime_bundle(&root).expect_err("missing independent migration must fail");
    assert_eq!(error.path(), missing);
    let source = error.source().expect("filesystem cause must be retained");
    assert!(source.to_string().contains("No such file") || source.to_string().contains("not find"));

    remove_dir_all(root).expect("fixture cleanup must succeed");
}

#[test]
fn modified_independent_migration_fails_with_the_contract_cause() {
    let root = temporary_root();
    write_fixture(&root);
    let migration = root.join(
        "runtime/apps/platform-node/node_modules/@floway-dev/gateway/migrations/0001_initial.sql",
    );
    write(&migration, "tampered independent migration")
        .expect("fixture migration must be writable");

    let error = resolve_runtime_bundle(&root).expect_err("modified migration must fail");
    assert_eq!(error.path(), root.join("desktop-bundle-contract.json"));
    assert!(
        error
            .source()
            .expect("stale migration contract cause must be retained")
            .to_string()
            .contains("migration file digest is stale")
    );

    remove_dir_all(root).expect("fixture cleanup must succeed");
}

#[test]
fn extra_migration_fails_the_exact_contract_inventory() {
    let root = temporary_root();
    write_fixture(&root);
    let extra = root.join(
        "runtime/apps/platform-node/node_modules/@floway-dev/gateway/migrations/0003_unowned.sql",
    );
    write(&extra, "unowned migration").expect("extra migration must be writable");

    let error = resolve_runtime_bundle(&root).expect_err("extra migration must fail");
    assert_eq!(error.path(), root.join("desktop-bundle-contract.json"));
    assert!(
        error
            .source()
            .expect("exact migration inventory cause must be retained")
            .to_string()
            .contains("inventory differs")
    );

    remove_dir_all(root).expect("fixture cleanup must succeed");
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct ForcedHandlerSetupFailure;

#[test]
fn handler_setup_failure_preserves_its_cause_and_never_spawns() {
    let mut spawn_called = false;
    let result = spawn_after_lifecycle_setup(
        || Err(ForcedHandlerSetupFailure),
        || {
            spawn_called = true;
            Ok::<_, ForcedHandlerSetupFailure>(())
        },
    );

    assert_eq!(result, Err(ForcedHandlerSetupFailure));
    assert!(
        !spawn_called,
        "handler failure must make spawning unreachable"
    );
}

#[test]
fn navigation_policy_keeps_custom_loopback_routes_inside_one_webview() {
    let token = "ab".repeat(32);
    let policy = DashboardNavigationPolicy::new("http://127.0.0.1:49200", &token)
        .expect("custom loopback origin must be valid");
    let mut opened = Vec::new();
    for candidate in [
        policy.bootstrap_url().clone(),
        url::Url::parse("http://127.0.0.1:49200/dashboard/providers").unwrap(),
        url::Url::parse("http://127.0.0.1:49200/assets/dashboard.js?version=1").unwrap(),
    ] {
        assert!(
            enforce_dashboard_navigation(&policy, &candidate, false, |external| {
                opened.push(external.clone());
                Ok::<_, ForcedNavigationOpenFailure>(())
            })
            .expect("same-origin navigation must not invoke the browser")
        );
    }
    assert!(opened.is_empty());
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct ForcedNavigationOpenFailure;

#[test]
fn navigation_policy_routes_safe_https_without_webview_or_bootstrap_authority() {
    let token = "cd".repeat(32);
    let policy = DashboardNavigationPolicy::new("http://127.0.0.1:49201", &token).unwrap();
    let external =
        url::Url::parse("https://docs.example.test/guide?topic=desktop#section").unwrap();
    let mut opened = None;
    let allowed = enforce_dashboard_navigation(&policy, &external, false, |url| {
        opened = Some(url.clone());
        Ok::<_, ForcedNavigationOpenFailure>(())
    })
    .unwrap();
    assert!(
        !allowed,
        "external HTTPS must never enter the privileged WebView"
    );
    assert_eq!(
        opened.unwrap().as_str(),
        "https://docs.example.test/guide?topic=desktop"
    );

    let mut popup_opened = None;
    let popup_allowed = enforce_dashboard_navigation(&policy, &external, true, |url| {
        popup_opened = Some(url.clone());
        Ok::<_, ForcedNavigationOpenFailure>(())
    })
    .unwrap();
    assert!(!popup_allowed, "new-window requests must always be denied");
    assert_eq!(popup_opened.unwrap().fragment(), None);
}

#[test]
fn navigation_policy_rejects_cross_origin_schemes_popups_and_token_leaks() {
    let token = "ef".repeat(32);
    let policy = DashboardNavigationPolicy::new("http://127.0.0.1:49202", &token).unwrap();
    let candidates = [
        "http://127.0.0.1:49203/dashboard".to_owned(),
        "http://example.test/dashboard".to_owned(),
        "file:///tmp/floway.html".to_owned(),
        "javascript:alert(1)".to_owned(),
        format!("https://example.test/?floway-bootstrap={token}"),
        format!("https://example.test/#{token}"),
        format!(
            "https://example.test/?secret={}",
            token
                .bytes()
                .map(|byte| format!("%{byte:02X}"))
                .collect::<String>()
        ),
    ];
    for candidate in candidates {
        let candidate = url::Url::parse(&candidate).unwrap();
        let mut opened = false;
        assert!(
            !enforce_dashboard_navigation(&policy, &candidate, false, |_external| {
                opened = true;
                Ok::<_, ForcedNavigationOpenFailure>(())
            })
            .unwrap()
        );
        assert!(
            !opened,
            "rejected navigation must not reach the system browser"
        );
    }

    let same_origin_popup = url::Url::parse("http://127.0.0.1:49202/dashboard").unwrap();
    assert!(
        !enforce_dashboard_navigation(
            &policy,
            &same_origin_popup,
            true,
            |_external| -> Result<(), ForcedNavigationOpenFailure> {
                panic!("same-origin popup must not reach the system browser")
            }
        )
        .unwrap()
    );
}

#[test]
fn navigation_policy_preserves_system_browser_errors_without_allowing_navigation() {
    let policy =
        DashboardNavigationPolicy::new("http://127.0.0.1:49204", &"12".repeat(32)).unwrap();
    let external = url::Url::parse("https://docs.example.test/").unwrap();
    let result = enforce_dashboard_navigation(&policy, &external, false, |_external| {
        Err(ForcedNavigationOpenFailure)
    });
    assert_eq!(result, Err(ForcedNavigationOpenFailure));
}
