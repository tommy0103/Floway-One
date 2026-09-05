use floway_desktop::{
    DASHBOARD_ORIGIN, DESKTOP_STATUS_ROUTE, DashboardNavigationPolicy, DesktopAction,
    PERSONAL_DASHBOARD_BOOTSTRAP_ENV, PERSONAL_DASHBOARD_BOOTSTRAP_FRAGMENT_KEY,
    PERSONAL_RUNTIME_READY_PREFIX, dashboard_bootstrap_url, desktop_action,
    enforce_dashboard_navigation, is_desktop_status_navigation, ready_dashboard_origin,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct ForcedNavigationOpenFailure;

#[test]
fn owns_bootstrap_and_ready_protocol_constants() {
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
}

#[test]
fn limits_shell_status_navigation_and_actions_to_the_owned_surface() {
    assert_eq!(DESKTOP_STATUS_ROUTE, "desktop-status");
    assert!(is_desktop_status_navigation(
        &url::Url::parse("tauri://localhost/desktop-status?state=failed").unwrap(),
        false,
    ));
    assert!(is_desktop_status_navigation(
        &url::Url::parse("http://tauri.localhost/desktop-status").unwrap(),
        false,
    ));
    assert!(!is_desktop_status_navigation(
        &url::Url::parse("https://tauri.localhost/desktop-status").unwrap(),
        false,
    ));
    assert!(!is_desktop_status_navigation(
        &url::Url::parse("tauri://localhost/desktop-status").unwrap(),
        true,
    ));
    assert_eq!(
        desktop_action(&url::Url::parse("floway-action://open-logs").unwrap()),
        Some(DesktopAction::OpenLogs),
    );
    assert_eq!(
        desktop_action(&url::Url::parse("floway-action://restart").unwrap()),
        Some(DesktopAction::Restart),
    );
    assert_eq!(
        desktop_action(&url::Url::parse("floway-action://quit").unwrap()),
        None,
    );
}

#[test]
fn keeps_custom_loopback_routes_inside_one_webview() {
    let token = "ab".repeat(32);
    let policy = DashboardNavigationPolicy::new("http://127.0.0.1:49200", &token).unwrap();
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
            .unwrap()
        );
    }
    assert!(opened.is_empty());
}

#[test]
fn routes_safe_https_without_webview_or_bootstrap_authority() {
    let policy =
        DashboardNavigationPolicy::new("http://127.0.0.1:49201", &"cd".repeat(32)).unwrap();
    let external =
        url::Url::parse("https://docs.example.test/guide?topic=desktop#section").unwrap();
    let mut opened = None;
    assert!(
        !enforce_dashboard_navigation(&policy, &external, false, |url| {
            opened = Some(url.clone());
            Ok::<_, ForcedNavigationOpenFailure>(())
        })
        .unwrap()
    );
    assert_eq!(
        opened.unwrap().as_str(),
        "https://docs.example.test/guide?topic=desktop"
    );

    let mut popup_opened = None;
    assert!(
        !enforce_dashboard_navigation(&policy, &external, true, |url| {
            popup_opened = Some(url.clone());
            Ok::<_, ForcedNavigationOpenFailure>(())
        })
        .unwrap()
    );
    assert_eq!(popup_opened.unwrap().fragment(), None);
}

#[test]
fn rejects_cross_origin_schemes_popups_and_encoded_token_leaks() {
    let token = "ef".repeat(32);
    let policy = DashboardNavigationPolicy::new("http://127.0.0.1:49202", &token).unwrap();
    let percent_encode = |value: &str| {
        value
            .bytes()
            .map(|byte| format!("%{byte:02X}"))
            .collect::<String>()
    };
    let encoded_once = percent_encode(&token);
    let encoded_twice = percent_encode(&encoded_once);
    let encoded_thrice = percent_encode(&encoded_twice);
    let encoded_key_twice =
        percent_encode(&percent_encode(PERSONAL_DASHBOARD_BOOTSTRAP_FRAGMENT_KEY));
    let candidates = [
        "http://127.0.0.1:49203/dashboard".to_owned(),
        "http://example.test/dashboard".to_owned(),
        "file:///tmp/floway.html".to_owned(),
        "javascript:alert(1)".to_owned(),
        format!("https://example.test/?floway-bootstrap={token}"),
        format!("https://example.test/#{token}"),
        format!("https://example.test/?secret={encoded_once}"),
        format!("https://example.test/redirect/{encoded_twice}"),
        format!("https://example.test/?redirect={encoded_thrice}"),
        format!("https://example.test/?redirect={encoded_key_twice}"),
        format!("https://example.test/#{encoded_twice}"),
        format!("https://{encoded_thrice}@example.test/"),
        "https://example.test/path%ZZ".to_owned(),
        "https://example.test/?redirect=%".to_owned(),
        "https://example.test/#%GG".to_owned(),
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
        assert!(!opened);
    }

    let popup = url::Url::parse("http://127.0.0.1:49202/dashboard").unwrap();
    assert!(
        !enforce_dashboard_navigation(
            &policy,
            &popup,
            true,
            |_external| -> Result<(), ForcedNavigationOpenFailure> {
                panic!("same-origin popup must not reach the system browser")
            },
        )
        .unwrap()
    );
}

#[test]
fn preserves_system_browser_errors_without_allowing_navigation() {
    let policy =
        DashboardNavigationPolicy::new("http://127.0.0.1:49204", &"12".repeat(32)).unwrap();
    let external = url::Url::parse("https://docs.example.test/").unwrap();
    let result = enforce_dashboard_navigation(&policy, &external, false, |_external| {
        Err(ForcedNavigationOpenFailure)
    });
    assert_eq!(result, Err(ForcedNavigationOpenFailure));
}
