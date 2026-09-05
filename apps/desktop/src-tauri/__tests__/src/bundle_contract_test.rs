use std::error::Error;
use std::fs::{create_dir_all, read, remove_dir_all, remove_file, write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use floway_desktop::{NODE_SIDECAR_NAME, resolve_runtime_bundle};
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
        "schemaVersion": 2,
        "compatibility": {
            "protocolVersion": 1,
            "releaseVersion": "0.1.0",
        },
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
    assert_eq!(runtime.root, root.join("runtime"));
    assert_eq!(runtime.compatibility.protocol_version, 1);
    assert_eq!(runtime.compatibility.release_version, "0.1.0");
    assert_eq!(runtime.compatibility.contract_digest.len(), 64);
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
fn incompatible_release_contract_fails_before_runtime_startup() {
    let root = temporary_root();
    write_fixture(&root);
    let contract_path = root.join("desktop-bundle-contract.json");
    let mut contract: serde_json::Value = serde_json::from_slice(
        &read(&contract_path).expect("fixture bundle contract must be readable"),
    )
    .expect("fixture bundle contract must be JSON");
    contract["compatibility"]["releaseVersion"] = json!("0.2.0");
    write(&contract_path, format!("{contract}\n")).expect("incompatible contract must be writable");

    let error = resolve_runtime_bundle(&root).expect_err("incompatible release must fail");
    assert_eq!(error.path(), contract_path);
    assert!(
        error
            .source()
            .expect("compatibility cause must be retained")
            .to_string()
            .contains("this shell requires protocol 1 release 0.1.0")
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
