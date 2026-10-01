use floway_desktop::UpdateActivity;

#[test]
fn concurrent_checks_and_install_cannot_overlap() {
    let mut work = UpdateActivity::default();
    assert!(work.begin_check(10));
    assert!(!work.begin_check(11));
    assert!(!work.begin_install(true));
    work.finish("ready");
    assert!(work.begin_install(true));
    assert!(!work.begin_install(true));
    assert!(!work.begin_check(12));
    work.finish("error");
    assert!(!work.begin_install(false));
    assert!(work.begin_install(true));
}

#[test]
fn transfer_completion_does_not_release_the_verification_lock() {
    let mut work = UpdateActivity::default();
    assert!(work.begin_check(10));
    work.phase = "downloading";
    work.download(30, Some(100));
    work.download(70, Some(100));
    assert_eq!(work.received, 100);
    assert!(!work.begin_install(true));
    work.phase = "verifying";
    assert!(!work.begin_install(true));
    work.finish("ready");
    assert!(work.begin_install(true));
}

#[test]
fn unknown_size_and_failed_checks_do_not_claim_completion() {
    let mut work = UpdateActivity::default();
    assert!(work.begin_check(10));
    work.download(42, None);
    assert_eq!(work.total, None);
    work.download(10, Some(0));
    assert_eq!(work.total, None);
    work.finish("error");
    assert_eq!(work.phase, "error");
    assert_eq!(work.poll_delay_seconds(), 3600);
    assert!(work.begin_check(20));
    assert_eq!(work.received, 0);
    work.finish("error");
    assert_eq!(work.poll_delay_seconds(), 7200);
    assert!(work.begin_check(30));
    work.finish("upToDate");
    assert_eq!(work.poll_delay_seconds(), 1800);
}
