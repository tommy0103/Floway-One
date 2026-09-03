use std::error::Error;
use std::fs::{create_dir_all, remove_dir_all, remove_file, write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use floway_desktop::{DASHBOARD_ORIGIN, NODE_SIDECAR_NAME, resolve_runtime_bundle};

fn temporary_root() -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock must follow the Unix epoch")
        .as_nanos();
    std::env::temp_dir().join(format!(
        "floway-desktop-rust-{}-{nonce}",
        std::process::id()
    ))
}

fn write_fixture(root: &Path) {
    let files = [
        "runtime/apps/platform-node/entry.js",
        "runtime/apps/platform-node/node_modules/@floway-dev/gateway/migrations/0001_initial.sql",
        "runtime/apps/web/dist/client/index.html",
    ];
    for relative in files {
        let path = root.join(relative);
        create_dir_all(path.parent().expect("fixture path must have a parent"))
            .expect("fixture directory must be writable");
        write(path, relative).expect("fixture file must be writable");
    }
}

#[test]
fn resolves_only_packaged_runtime_resources_for_the_personal_sidecar() {
    let root = temporary_root();
    write_fixture(&root);

    let runtime = resolve_runtime_bundle(&root).expect("complete packaged resources must resolve");
    assert_eq!(NODE_SIDECAR_NAME, "floway-node");
    assert_eq!(DASHBOARD_ORIGIN, "http://127.0.0.1:8788");
    assert_eq!(runtime.root, root.join("runtime"));
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
