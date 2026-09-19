use std::cell::RefCell;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::rc::Rc;

#[allow(dead_code)]
#[path = "../../src/shell_autostart.rs"]
mod shell_autostart;

use shell_autostart::{
    LaunchctlFailure, ShellAutostart, launch_agents_dir, launchctl_domain,
    login_item_program_arguments,
};

fn test_dir(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "floway-shell-autostart-test-{label}-{}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("test directory must be created");
    dir
}

fn autostart(dir: &Path) -> ShellAutostart {
    ShellAutostart::new(
        "dev.floway.one".to_owned(),
        dir.join("LaunchAgents"),
        launchctl_domain(501),
        login_item_program_arguments(
            Path::new("/Applications/Floway.app/Contents/MacOS/floway-one"),
            Path::new("/Users/test/Library/Application Support/dev.floway.one/data"),
        ),
    )
}

fn recorded_launchctl(
    failures: &'static [(&'static str, &'static str)],
) -> (
    impl Fn(&[OsString]) -> Result<(), LaunchctlFailure>,
    impl Fn() -> Vec<Vec<String>>,
) {
    let calls = Rc::new(RefCell::new(Vec::<Vec<String>>::new()));
    let run_calls = Rc::clone(&calls);
    let run = move |args: &[OsString]| {
        let rendered = args
            .iter()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        run_calls.borrow_mut().push(rendered.clone());
        for (verb, stderr) in failures {
            if rendered.first().map(String::as_str) == Some(verb) {
                return Err(LaunchctlFailure::for_test(args, "exit status: 1", stderr));
            }
        }
        Ok(())
    };
    let dump = move || calls.borrow().clone();
    (run, dump)
}

#[test]
fn login_item_plist_escapes_and_lists_every_program_argument() {
    let dir = test_dir("plist");
    let autostart = autostart(&dir);
    let (run, calls) = recorded_launchctl(&[]);
    autostart.enable_with(run).expect("enable must succeed");
    let plist = fs::read_to_string(autostart.plist_path()).expect("plist must exist");
    assert!(plist.contains("<key>Label</key>\n  <string>dev.floway.one</string>"));
    assert!(plist.contains("<string>/Applications/Floway.app/Contents/MacOS/floway-one</string>"));
    assert!(plist.contains("<string>--data-dir</string>"));
    assert!(plist.contains("Application Support/dev.floway.one/data"));
    assert!(plist.contains("<key>RunAtLoad</key>\n  <true/>"));
    let recorded = calls();
    assert_eq!(recorded.len(), 2);
    assert_eq!(recorded[0][..2], ["bootout", "gui/501/dev.floway.one"]);
    assert_eq!(recorded[1][..2], ["bootstrap", "gui/501"]);
    assert_eq!(recorded[1][2], autostart.plist_path().to_string_lossy());
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn enable_is_idempotent_against_a_stale_loaded_registration() {
    let dir = test_dir("stale");
    let autostart = autostart(&dir);
    let (run, _calls) = recorded_launchctl(&[]);
    autostart
        .enable_with(&run)
        .expect("first enable must succeed");
    autostart
        .enable_with(&run)
        .expect("a second enable must replace the registration");
    assert!(autostart.is_enabled());
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn enable_tolerates_a_not_loaded_bootout() {
    let dir = test_dir("not-loaded");
    let autostart = autostart(&dir);
    let (run, calls) = recorded_launchctl(&[("bootout", "Boot-out failed: 3: No such process")]);
    autostart
        .enable_with(run)
        .expect("a missing prior registration must not block enable");
    assert!(autostart.is_enabled());
    assert_eq!(calls().len(), 2);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn enable_rolls_back_its_plist_when_bootstrap_is_rejected() {
    let dir = test_dir("bootstrap-failure");
    let autostart = autostart(&dir);
    let (run, _calls) = recorded_launchctl(&[
        ("bootstrap", "Bootstrap failed: 5: Input/output error"),
        (
            "print",
            "Could not find service \"dev.floway.one\" in domain",
        ),
    ]);
    let failure = autostart
        .enable_with(run)
        .expect_err("a rejected bootstrap must fail");
    assert_eq!(
        failure.to_string(),
        "Floway could not register its login item"
    );
    let mut chain = String::new();
    let mut source = std::error::Error::source(&failure);
    while let Some(cause) = source {
        chain.push_str(&cause.to_string());
        source = cause.source();
    }
    assert!(chain.contains("Bootstrap failed: 5: Input/output error"));
    assert!(!autostart.is_enabled());
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn enable_accepts_a_registration_background_management_already_loaded() {
    let dir = test_dir("already-loaded");
    let autostart = autostart(&dir);
    // BTM loads a new LaunchAgent as soon as its plist lands; the follow-up
    // bootstrap then reports the job as already present.
    let (run, calls) =
        recorded_launchctl(&[("bootstrap", "Bootstrap failed: 5: Input/output error")]);
    autostart
        .enable_with(run)
        .expect("an already-loaded registration must count as enabled");
    assert!(autostart.is_enabled());
    assert_eq!(
        calls().last().expect("print must run")[..2],
        ["print", "gui/501/dev.floway.one"]
    );
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn enable_rolls_back_its_plist_when_the_prior_unload_fails() {
    let dir = test_dir("bootout-failure");
    let autostart = autostart(&dir);
    let (run, calls) =
        recorded_launchctl(&[("bootout", "Boot-out failed: 1: Operation not permitted")]);
    let failure = autostart
        .enable_with(run)
        .expect_err("a failed prior unload must fail");
    assert_eq!(
        failure.to_string(),
        "Floway could not unload its previous login item"
    );
    assert!(!autostart.is_enabled());
    // No bootstrap may be attempted after a failed unload.
    assert_eq!(calls().len(), 1);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn disable_unloads_and_removes_the_registration() {
    let dir = test_dir("disable");
    let autostart = autostart(&dir);
    let (run, calls) = recorded_launchctl(&[]);
    autostart.enable_with(&run).expect("enable must succeed");
    autostart.disable_with(&run).expect("disable must succeed");
    assert!(!autostart.is_enabled());
    assert_eq!(
        calls().last().expect("bootout must run")[..2],
        ["bootout", "gui/501/dev.floway.one"]
    );
    // Disabling twice stays a clean no-op.
    autostart
        .disable_with(&run)
        .expect("repeated disable must succeed");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn disable_removes_the_registration_file_even_when_unload_fails() {
    let dir = test_dir("disable-failure");
    let autostart = autostart(&dir);
    let (run, _calls) = recorded_launchctl(&[]);
    autostart.enable_with(&run).expect("enable must succeed");
    let (failing_run, _failing_calls) =
        recorded_launchctl(&[("bootout", "Boot-out failed: 1: Operation not permitted")]);
    let failure = autostart
        .disable_with(failing_run)
        .expect_err("a failed unload must surface");
    assert_eq!(
        failure.to_string(),
        "Floway could not unload its previous login item"
    );
    assert!(!autostart.is_enabled());
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn paths_derive_from_the_home_directory_and_uid() {
    assert_eq!(
        launch_agents_dir(Path::new("/Users/test")),
        Path::new("/Users/test/Library/LaunchAgents")
    );
    assert_eq!(launchctl_domain(501), "gui/501");
}
