use std::{error::Error, fs, io, sync::Arc};

use serde_json::Value;
use tauri::{AppHandle, Manager};

use super::{
    DesktopController, MAXIMUM_SURFACE_EVENT_BYTES, capture_rendered_snapshot, main_window,
    require_update_window,
};

// Fixed gestures only, unavailable in release builds. The verifier clicks the
// rendered controls; it never calls the update commands in place of the UI.
pub(super) fn drive(app: &AppHandle, step: &str) -> Result<(), Box<dyn Error>> {
    if !cfg!(debug_assertions) {
        return Err("update UI verification requires a debug build".into());
    }
    let window = main_window(app)?;
    require_update_window(app, &window).map_err(io::Error::other)?;
    if step == "open-settings" {
        window.eval("window.location.assign('/dashboard/settings')")?;
        return Ok(());
    }
    let labels = match step {
        "snapshot" => None,
        "check" => Some(["Check for updates", "检查更新"]),
        "notes" => Some(["View changes", "查看更新内容"]),
        "close" => Some(["Close", "关闭"]),
        "later" => Some(["Later", "稍后"]),
        "install" | "confirm" => Some(["Update and restart", "更新并重启"]),
        _ => return Err("unknown update UI verification step".into()),
    };
    let script = format!(
        r#"(async () => {{
        const step = {step};
        const labels = {labels};
        const buttons = () => [...document.querySelectorAll('button')];
        const matches = label => buttons().filter(button => label.includes(button.textContent.trim()));
        const wait = async predicate => {{
            for (let i = 0; i < 100; i++) {{
                if (predicate()) return;
                await new Promise(resolve => setTimeout(resolve, 100));
            }}
            throw new Error('Floway update UI did not reach ' + step);
        }};
        try {{
            await wait(() => matches(['Check for updates', '检查更新']).length > 0);
            if (labels) {{
                await wait(() => matches(labels).some(button => !button.disabled));
                const candidates = matches(labels);
                const button = step === 'confirm' ? candidates.at(-1) : candidates[0];
                if (button.disabled) throw new Error('Floway update UI control is disabled');
                button.click();
            }}
            if (step === 'confirm') return;
            await new Promise(resolve => setTimeout(resolve, 500));
            if (step === 'check') await wait(() => matches(['Check for updates', '检查更新']).some(button => !button.disabled));
            const state = await window.__TAURI_INTERNALS__.invoke('desktop_update_status');
            const surface = {{
                step, revision: state.revision, phase: state.phase, version: state.stagedVersion,
                readyButtons: matches(['Update and restart', '更新并重启']).filter(button => !button.disabled).length,
                laterButtons: matches(['Later', '稍后']).length,
                notesVisible: !!document.querySelector('[role="dialog"]') && document.body.textContent.includes('verification update'),
            }};
            await window.__TAURI_INTERNALS__.invoke('report_desktop_update_surface', {{ surface }});
        }} catch (cause) {{
            await window.__TAURI_INTERNALS__.invoke('report_desktop_update_surface', {{ surface: {{ step, error: String(cause) }} }});
        }}
    }})()"#,
        step = serde_json::to_string(step)?,
        labels = serde_json::to_string(&labels)?
    );
    window.eval(script)?;
    Ok(())
}

pub(super) fn report(
    app: AppHandle,
    window: tauri::WebviewWindow,
    surface: Value,
) -> Result<(), String> {
    if !cfg!(debug_assertions) {
        return Err("update UI verification requires a debug build".to_owned());
    }
    require_update_window(&app, &window)?;
    if surface.get("error").is_none() {
        let state = app
            .state::<Arc<DesktopController>>()
            .update
            .status_snapshot();
        if surface.get("revision") != state.get("revision")
            || surface.get("version") != state.get("stagedVersion")
        {
            return Err("Floway update UI evidence disagrees with the native state".to_owned());
        }
        let snapshot = capture_rendered_snapshot(&window).map_err(|error| error.to_string())?;
        let controller = app.state::<Arc<DesktopController>>();
        let root = controller
            .logs_dir
            .parent()
            .ok_or("Floway update UI has no evidence directory")?;
        fs::write(root.join("update-ui.png"), snapshot.png).map_err(|error| error.to_string())?;
    }
    let encoded = serde_json::to_string(&surface).map_err(|error| error.to_string())?;
    if encoded.len() > MAXIMUM_SURFACE_EVENT_BYTES {
        return Err("Floway update UI evidence exceeded its bound".to_owned());
    }
    eprintln!("FLOWAY_DESKTOP_UPDATE_UI {encoded}");
    Ok(())
}
