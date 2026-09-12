#[path = "../../src/desktop_paths.rs"]
mod desktop_paths;

use std::ffi::OsString;
use std::path::PathBuf;

use desktop_paths::DesktopPaths;

#[test]
fn composes_default_paths_beneath_the_platform_data_directory() {
    let paths = DesktopPaths::from_args(
        PathBuf::from("/platform/data"),
        [OsString::from("floway-one")],
    )
    .expect("default data paths must resolve");

    assert_eq!(
        paths.logs(),
        PathBuf::from("/platform/data/Floway One/logs")
    );
}

#[test]
fn accepts_one_documented_absolute_data_directory_argument() {
    let paths = DesktopPaths::from_args(
        PathBuf::from("/platform/data"),
        [
            OsString::from("floway-one"),
            OsString::from("--data-dir"),
            OsString::from("/isolated/floway"),
        ],
    )
    .expect("explicit data root must resolve");

    assert_eq!(paths.logs(), PathBuf::from("/isolated/floway/logs"));
}

#[test]
fn rejects_relative_missing_or_duplicate_data_directory_arguments() {
    for args in [
        vec!["floway-one", "--data-dir", "relative"],
        vec!["floway-one", "--data-dir"],
        vec!["floway-one", "--data-dir", "/one", "--data-dir", "/two"],
    ] {
        let error = DesktopPaths::from_args(
            PathBuf::from("/platform/data"),
            args.into_iter().map(OsString::from),
        )
        .expect_err("invalid data-root arguments must fail");
        assert!(error.to_string().contains("--data-dir"));
    }
}
