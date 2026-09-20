#[path = "../../src/desktop_i18n.rs"]
mod desktop_i18n;

use desktop_i18n::{DesktopLocale, locale_from_identifier, messages_for};

#[test]
fn selects_simplified_chinese_without_mislabeling_traditional_chinese() {
    for locale in [
        "zh",
        "zh-CN",
        "zh-Hans",
        "zh-Hans-CN",
        "zh_Hans_CN",
        "zh-SG",
    ] {
        assert_eq!(locale_from_identifier(Some(locale)), DesktopLocale::ZhHans);
    }
    for locale in [None, Some("en-US"), Some("zh-Hant"), Some("zh-TW")] {
        assert_eq!(locale_from_identifier(locale), DesktopLocale::En);
    }
}

#[test]
fn english_and_simplified_chinese_define_the_complete_tray_vocabulary() {
    let english = messages_for(DesktopLocale::En);
    let simplified_chinese = messages_for(DesktopLocale::ZhHans);

    for message in [
        english.copy_gateway_address,
        english.launch_at_login,
        english.open_floway,
        english.open_logs,
        english.quit_floway,
        english.restart_gateway,
        english.status_needs_attention,
        english.status_running,
        english.status_starting,
        english.tooltip_needs_attention,
        english.tooltip_running,
        english.tooltip_starting,
        english.update_install,
        english.update_install_version,
        simplified_chinese.copy_gateway_address,
        simplified_chinese.launch_at_login,
        simplified_chinese.open_floway,
        simplified_chinese.open_logs,
        simplified_chinese.quit_floway,
        simplified_chinese.restart_gateway,
        simplified_chinese.status_needs_attention,
        simplified_chinese.status_running,
        simplified_chinese.status_starting,
        simplified_chinese.tooltip_needs_attention,
        simplified_chinese.tooltip_running,
        simplified_chinese.tooltip_starting,
        simplified_chinese.update_install,
        simplified_chinese.update_install_version,
    ] {
        assert!(!message.trim().is_empty());
    }
    assert!(english.update_install_version.contains("{version}"));
    assert!(
        simplified_chinese
            .update_install_version
            .contains("{version}")
    );
    assert_eq!(simplified_chinese.copy_gateway_address, "复制 Gateway 地址");
    assert_eq!(simplified_chinese.launch_at_login, "开机启动");
    assert_eq!(simplified_chinese.open_floway, "打开 Floway");
    assert_eq!(simplified_chinese.open_logs, "打开日志目录");
    assert_eq!(simplified_chinese.quit_floway, "退出 Floway");
    assert_eq!(simplified_chinese.restart_gateway, "重启 Gateway");
    assert_eq!(
        simplified_chinese.status_needs_attention,
        "Gateway：需要处理"
    );
    assert_eq!(simplified_chinese.status_running, "Gateway：运行中");
    assert_eq!(simplified_chinese.status_starting, "Gateway：正在启动");
    assert_eq!(
        simplified_chinese.tooltip_needs_attention,
        "Floway：需要处理"
    );
    assert_eq!(simplified_chinese.tooltip_running, "Floway：运行中");
    assert_eq!(simplified_chinese.tooltip_starting, "Floway：正在启动");
}
