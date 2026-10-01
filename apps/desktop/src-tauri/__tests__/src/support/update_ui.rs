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
    let labels = match step {
        "open-settings" | "snapshot" => None,
        "check" => Some(["Check for updates", "检查更新"]),
        "notes" => Some(["View changes", "查看更新内容"]),
        "close" => Some(["Close", "关闭"]),
        "later" => Some(["Later", "稍后"]),
        "install" | "confirm" => Some(["Update and restart", "更新并重启"]),
        _ => return Err("unknown update UI verification step".into()),
    };
    let script = format!(
        r#"
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
            if (step === 'open-settings') {{
                const settings = () => document.querySelector('a[href="/dashboard/settings"]');
                await wait(() => settings());
                settings().click();
            }}
            await wait(() => matches(['Check for updates', '检查更新']).length > 0);
            if (labels) {{
                await wait(() => matches(labels).some(button => !button.disabled));
                const candidates = matches(labels);
                const button = step === 'confirm' ? candidates.at(-1) : candidates[0];
                if (button.disabled) throw new Error('Floway update UI control is disabled');
                button.click();
            }}
            if (step === 'confirm') return JSON.stringify({{ step, confirmed: true }});
            await new Promise(resolve => setTimeout(resolve, 500));
            if (step === 'check') await wait(() => matches(['Check for updates', '检查更新']).some(button => !button.disabled));
            const state = await Promise.race([
                window.__TAURI_INTERNALS__.invoke('desktop_update_status'),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Floway native update status command did not return')), 5000)),
            ]);
            const surface = {{
                step, revision: state.revision, phase: state.phase, version: state.stagedVersion,
                readyButtons: matches(['Update and restart', '更新并重启']).filter(button => !button.disabled).length,
                laterButtons: matches(['Later', '稍后']).length,
                notesVisible: !!document.querySelector('[role="dialog"]') && document.body.textContent.includes('verification update'),
            }};
            return JSON.stringify(surface);
        }} catch (cause) {{
            return JSON.stringify({{
                step, error: String(cause), isTauri: !!globalThis.isTauri,
                hasInvoke: typeof window.__TAURI_INTERNALS__?.invoke === 'function',
                hasIpc: typeof window.__TAURI_INTERNALS__?.ipc === 'function',
                bridgeKeys: Object.keys(window.__TAURI_INTERNALS__ ?? {{}}),
                buttonLabels: buttons().map(button => button.textContent.trim().slice(0, 120)),
            }});
        }}"#,
        step = serde_json::to_string(step)?,
        labels = serde_json::to_string(&labels)?
    );
    let app = app.clone();
    let step = step.to_owned();
    std::thread::spawn(move || {
        let result = observe_script(&window, script)
            .and_then(|encoded| serde_json::from_str::<Value>(&encoded).map_err(io::Error::other))
            .and_then(|surface| {
                if step == "confirm"
                    && surface.get("confirmed").and_then(Value::as_bool) == Some(true)
                {
                    return Ok(());
                }
                report(app, window, surface).map_err(io::Error::other)
            });
        if let Err(error) = result {
            crate::print_error_chain(&error);
            eprintln!(
                "FLOWAY_DESKTOP_UPDATE_UI {}",
                serde_json::json!({ "step": step, "error": crate::error_chain_text(&error) })
            );
        }
    });
    Ok(())
}

fn report(app: AppHandle, window: tauri::WebviewWindow, surface: Value) -> Result<(), String> {
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

// WebKit reports both promise completion and original script exceptions. A
// fire-and-forget eval can destroy the only channel that would report a failed
// bridge, so evidence comes back through this native observation boundary.
// https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/API/Cocoa/WKWebView.h
fn observe_script(window: &tauri::WebviewWindow, script: String) -> Result<String, io::Error> {
    use std::{ffi::CString, sync::mpsc, time::Duration};

    use block2::RcBlock;
    use objc2::{
        msg_send,
        runtime::{AnyClass, AnyObject},
    };

    fn object_text(object: *mut AnyObject) -> Result<String, String> {
        if object.is_null() {
            return Err("Floway update UI returned no script result".to_owned());
        }
        let utf8: *const std::ffi::c_char = unsafe { msg_send![object, UTF8String] };
        if utf8.is_null() {
            return Err("Floway update UI returned no UTF-8 result".to_owned());
        }
        Ok(unsafe { std::ffi::CStr::from_ptr(utf8) }
            .to_string_lossy()
            .into_owned())
    }

    let (sender, receiver) = mpsc::sync_channel(1);
    window
        .with_webview(move |view| {
            let result = (|| -> Result<(), String> {
                let source = CString::new(script).map_err(|error| error.to_string())?;
                let string_class = AnyClass::get(c"NSString").ok_or("NSString is unavailable")?;
                let world_class =
                    AnyClass::get(c"WKContentWorld").ok_or("WKContentWorld is unavailable")?;
                let source: *mut AnyObject =
                    unsafe { msg_send![string_class, stringWithUTF8String: source.as_ptr()] };
                let world: *mut AnyObject = unsafe { msg_send![world_class, pageWorld] };
                let completion_sender = sender.clone();
                let completion: RcBlock<dyn Fn(*mut AnyObject, *mut AnyObject)> =
                    RcBlock::new(move |result, error| {
                        let result = if error.is_null() {
                            object_text(result)
                        } else {
                            let description: *mut AnyObject =
                                unsafe { msg_send![error, description] };
                            Err(object_text(description).unwrap_or_else(|error| error))
                        };
                        let _ = completion_sender.send(result);
                    });
                let webview = view.inner().cast::<AnyObject>();
                let () = unsafe {
                    msg_send![webview,
                        callAsyncJavaScript: source
                        arguments: std::ptr::null::<AnyObject>()
                        inFrame: std::ptr::null::<AnyObject>()
                        inContentWorld: world
                        completionHandler: &*completion
                    ]
                };
                Ok(())
            })();
            if let Err(error) = result {
                let _ = sender.send(Err(error));
            }
        })
        .map_err(io::Error::other)?;
    receiver
        .recv_timeout(Duration::from_secs(25))
        .map_err(io::Error::other)?
        .map_err(io::Error::other)
}
