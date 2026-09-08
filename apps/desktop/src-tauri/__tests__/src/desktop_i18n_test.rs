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
        english.open_logs,
        english.restart_gateway,
        english.status_needs_attention,
        english.status_running,
        english.status_starting,
        english.tooltip_needs_attention,
        english.tooltip_running,
        english.tooltip_starting,
        simplified_chinese.open_logs,
        simplified_chinese.restart_gateway,
        simplified_chinese.status_needs_attention,
        simplified_chinese.status_running,
        simplified_chinese.status_starting,
        simplified_chinese.tooltip_needs_attention,
        simplified_chinese.tooltip_running,
        simplified_chinese.tooltip_starting,
    ] {
        assert!(!message.trim().is_empty());
    }
}
