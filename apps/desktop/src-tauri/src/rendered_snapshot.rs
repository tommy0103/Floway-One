//! Produces bounded support evidence from the live packaged browser rendering.
//!
//! The browser content accessibility tree stays behind the system
//! accessibility server, which refuses reads from processes without an
//! Accessibility approval, so it cannot evidence anything on a clean machine.
//! The packaged browser's own rendered pixels are readable without any grant.
//! https://developer.apple.com/documentation/applicationservices/axisprocesstrusted
//! https://developer.apple.com/documentation/webkit/wkwebview/3650058-takesnapshot

use std::io;

use tauri::WebviewWindow;

pub struct RenderedSnapshot {
    pub png: Vec<u8>,
    pub sha256: String,
}

#[cfg(target_os = "macos")]
mod platform {
    use std::ffi::c_void;
    use std::sync::mpsc;
    use std::time::Duration;

    use block2::RcBlock;
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject};
    use objc2_core_foundation::CGRect;
    use sha2::{Digest, Sha256};
    use tauri::WebviewWindow;

    use super::RenderedSnapshot;

    const MAXIMUM_SNAPSHOT_BYTES: usize = 4 * 1024 * 1024;
    const OBSERVATION_TIMEOUT: Duration = Duration::from_secs(5);
    const SNAPSHOT_SCALE: f64 = 2.0;

    fn describe_failure(error: *mut AnyObject) -> String {
        let description: *mut AnyObject = unsafe { msg_send![error, localizedDescription] };
        let utf8: *const std::ffi::c_char = if description.is_null() {
            std::ptr::null()
        } else {
            unsafe { msg_send![description, UTF8String] }
        };
        if utf8.is_null() {
            return "Floway packaged browser snapshot failed without a description".to_owned();
        }
        format!(
            "Floway packaged browser snapshot failed: {}",
            unsafe { std::ffi::CStr::from_ptr(utf8) }.to_string_lossy(),
        )
    }

    fn encode_png(image: *mut AnyObject, error: *mut AnyObject) -> Result<Vec<u8>, String> {
        if !error.is_null() {
            return Err(describe_failure(error));
        }
        if image.is_null() {
            return Err("Floway packaged browser snapshot produced no image".to_owned());
        }
        let tiff: *mut AnyObject = unsafe { msg_send![image, TIFFRepresentation] };
        if tiff.is_null() {
            return Err(
                "Floway packaged browser snapshot produced no TIFF representation".to_owned(),
            );
        }
        let Some(representation_class) = AnyClass::get(c"NSBitmapImageRep") else {
            return Err(
                "Floway packaged browser snapshot found no NSBitmapImageRep class".to_owned(),
            );
        };
        let allocated: *mut AnyObject = unsafe { msg_send![representation_class, alloc] };
        let representation: *mut AnyObject = if allocated.is_null() {
            std::ptr::null_mut()
        } else {
            unsafe { msg_send![allocated, initWithData: tiff] }
        };
        if representation.is_null() {
            return Err(
                "Floway packaged browser snapshot produced no bitmap representation".to_owned(),
            );
        }
        // NSBitmapImageFileTypePNG
        // https://developer.apple.com/documentation/appkit/nsbitmapimagefiletype/nsbitmapimagefiletypepng
        const PNG_FILE_TYPE: usize = 4;
        let png: *mut AnyObject = unsafe {
            msg_send![representation, representationUsingType: PNG_FILE_TYPE, properties: std::ptr::null::<AnyObject>()]
        };
        let () = unsafe { msg_send![representation, release] };
        if png.is_null() {
            return Err("Floway packaged browser snapshot produced no PNG encoding".to_owned());
        }
        let length: usize = unsafe { msg_send![png, length] };
        let bytes: *const c_void = unsafe { msg_send![png, bytes] };
        if bytes.is_null() && length != 0 {
            return Err("Floway packaged browser snapshot produced no PNG bytes".to_owned());
        }
        Ok(unsafe { std::slice::from_raw_parts(bytes.cast::<u8>(), length) }.to_vec())
    }

    fn start_snapshot(webview: *mut c_void, sender: mpsc::SyncSender<Result<Vec<u8>, String>>) {
        let fail = |message: &str| {
            let _ = sender.send(Err(message.to_owned()));
        };
        if webview.is_null() {
            return fail("Floway packaged browser handle is unavailable");
        }
        let webview = webview.cast::<AnyObject>();
        let Some(configuration_class) = AnyClass::get(c"WKSnapshotConfiguration") else {
            return fail("Floway packaged browser snapshot configuration class is unavailable");
        };
        let configuration: *mut AnyObject = unsafe { msg_send![configuration_class, new] };
        if configuration.is_null() {
            return fail("Floway packaged browser snapshot configuration is unavailable");
        }
        let bounds: CGRect = unsafe { msg_send![webview, bounds] };
        let width = (bounds.size.width * SNAPSHOT_SCALE).round();
        if !width.is_finite() || width <= 0.0 {
            let () = unsafe { msg_send![configuration, release] };
            return fail("Floway packaged browser snapshot found an empty rendering extent");
        }
        let Some(number_class) = AnyClass::get(c"NSNumber") else {
            let () = unsafe { msg_send![configuration, release] };
            return fail("Floway packaged browser snapshot found no NSNumber class");
        };
        let snapshot_width: *mut AnyObject =
            unsafe { msg_send![number_class, numberWithUnsignedInteger: width as usize] };
        if snapshot_width.is_null() {
            let () = unsafe { msg_send![configuration, release] };
            return fail("Floway packaged browser snapshot width is unavailable");
        }
        let () = unsafe { msg_send![configuration, setRect: bounds] };
        let () = unsafe { msg_send![configuration, setSnapshotWidth: snapshot_width] };
        let completion: RcBlock<dyn Fn(*mut AnyObject, *mut AnyObject)> =
            RcBlock::new(move |image, error| {
                let _ = sender.send(encode_png(image, error));
            });
        let () = unsafe {
            msg_send![webview, takeSnapshotWithConfiguration: configuration, completionHandler: &*completion]
        };
        let () = unsafe { msg_send![configuration, release] };
    }

    pub(super) fn capture(window: &WebviewWindow) -> Result<RenderedSnapshot, std::io::Error> {
        let (sender, receiver) = mpsc::sync_channel(1);
        window
            .with_webview(move |webview| start_snapshot(webview.inner(), sender))
            .map_err(std::io::Error::other)?;
        let png = receiver
            .recv_timeout(OBSERVATION_TIMEOUT)
            .map_err(|error| {
                std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    format!("Floway packaged browser snapshot observation timed out: {error}"),
                )
            })?
            .map_err(std::io::Error::other)?;
        if png.len() > MAXIMUM_SNAPSHOT_BYTES {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "Floway packaged browser snapshot exceeded its byte bound",
            ));
        }
        let sha256 = Sha256::digest(&png)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        Ok(RenderedSnapshot { png, sha256 })
    }
}

pub fn capture_rendered_snapshot(window: &WebviewWindow) -> io::Result<RenderedSnapshot> {
    #[cfg(target_os = "macos")]
    {
        platform::capture(window)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window;
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "Floway rendered snapshot evidence requires macOS",
        ))
    }
}
