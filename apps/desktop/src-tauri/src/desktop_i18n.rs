#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DesktopLocale {
    En,
    ZhHans,
}

#[derive(Debug, Eq, PartialEq)]
pub struct DesktopMessages {
    pub open_logs: &'static str,
    pub restart_gateway: &'static str,
    pub status_needs_attention: &'static str,
    pub status_running: &'static str,
    pub status_starting: &'static str,
    pub tooltip_needs_attention: &'static str,
    pub tooltip_running: &'static str,
    pub tooltip_starting: &'static str,
}

const EN: DesktopMessages = DesktopMessages {
    open_logs: "Open Logs",
    restart_gateway: "Restart Gateway",
    status_needs_attention: "Gateway: Needs attention",
    status_running: "Gateway: Running",
    status_starting: "Gateway: Starting",
    tooltip_needs_attention: "Floway: Needs attention",
    tooltip_running: "Floway: Running",
    tooltip_starting: "Floway: Starting",
};

const ZH_HANS: DesktopMessages = DesktopMessages {
    open_logs: "打开日志",
    restart_gateway: "重启 Gateway",
    status_needs_attention: "Gateway：需要处理",
    status_running: "Gateway：运行中",
    status_starting: "Gateway：正在启动",
    tooltip_needs_attention: "Floway：需要处理",
    tooltip_running: "Floway：运行中",
    tooltip_starting: "Floway：正在启动",
};

pub fn locale_from_identifier(identifier: Option<&str>) -> DesktopLocale {
    let normalized = identifier
        .unwrap_or_default()
        .replace('_', "-")
        .to_ascii_lowercase();
    if normalized == "zh"
        || normalized.starts_with("zh-hans-")
        || normalized.starts_with("zh-cn")
        || normalized.starts_with("zh-sg")
    {
        DesktopLocale::ZhHans
    } else {
        DesktopLocale::En
    }
}

pub fn messages_for(locale: DesktopLocale) -> &'static DesktopMessages {
    match locale {
        DesktopLocale::En => &EN,
        DesktopLocale::ZhHans => &ZH_HANS,
    }
}

#[cfg(feature = "desktop")]
pub fn system_messages() -> &'static DesktopMessages {
    messages_for(locale_from_identifier(sys_locale::get_locale().as_deref()))
}
