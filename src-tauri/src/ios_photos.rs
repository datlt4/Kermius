//! iOS: received photos and videos also go to the Photos library; the original stays in Files › Kermius.
use objc2::{class, msg_send, rc::autoreleasepool, runtime::AnyObject};
use std::ffi::{c_void, CString};
use std::path::Path;
use std::ptr::{null, null_mut};

#[link(name = "UIKit", kind = "framework")]
extern "C" {
    fn UIImageWriteToSavedPhotosAlbum(image: *mut AnyObject, target: *mut AnyObject, selector: *const c_void, context: *mut c_void);
    fn UIVideoAtPathIsCompatibleWithSavedPhotosAlbum(path: *mut AnyObject) -> bool;
    fn UISaveVideoAtPathToSavedPhotosAlbum(path: *mut AnyObject, target: *mut AnyObject, selector: *const c_void, context: *mut c_void);
}

const IMAGES: &[&str] = &["jpg", "jpeg", "png", "heic", "heif", "gif", "webp", "tif", "tiff", "bmp"];
const VIDEOS: &[&str] = &["mov", "mp4", "m4v", "3gp"];

/// Adds the file to Photos when it is an image or a video (needs NSPhotoLibraryAddUsageDescription). Main thread.
pub fn save(path: &Path) {
    let ext = path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).unwrap_or_default();
    let (image, video) = (IMAGES.contains(&ext.as_str()), VIDEOS.contains(&ext.as_str()));
    if !image && !video {
        return;
    }
    let Ok(c) = CString::new(path.to_string_lossy().as_bytes()) else { return };
    autoreleasepool(|_| unsafe {
        let s: *mut AnyObject = msg_send![class!(NSString), stringWithUTF8String: c.as_ptr()];
        if s.is_null() {
            return;
        }
        if image {
            let img: *mut AnyObject = msg_send![class!(UIImage), imageWithContentsOfFile: s];
            if !img.is_null() {
                UIImageWriteToSavedPhotosAlbum(img, null_mut(), null(), null_mut());
            }
        } else if UIVideoAtPathIsCompatibleWithSavedPhotosAlbum(s) {
            UISaveVideoAtPathToSavedPhotosAlbum(s, null_mut(), null(), null_mut());
        }
    });
}
