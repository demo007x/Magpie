//! 系统应用选择面板：供禁用应用列表选择 .app。
//! 使用 rfd（tauri-plugin-dialog 同款底层库）——AppKit 的线程/异常细节由其处理，
//! 不要手写 NSOpenPanel（ObjC 异常会穿透 Rust FFI 直接 abort，见 wry#1752 一族）。
//!
//! 返回黑名单匹配键：优先 bundle identifier（如 com.apple.Safari，唯一稳定），
//! 解析失败回退 bundle 名称（如 WeChat.app，走进程路径 contains 兜底）。用户取消 = None。
//! 必须在主线程调用（Tauri 同步命令默认在主线程执行）。

use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_void};
use std::path::Path;

// 显式链接 AppKit（NSBundle/NSRunningApplication）与 UniformTypeIdentifiers
#[link(name = "AppKit", kind = "framework")]
extern "C" {}

#[allow(clashing_extern_declarations)]
extern "C" {
    fn objc_getClass(name: *const c_char) -> *mut c_void;
    fn sel_registerName(name: *const c_char) -> *mut c_void;
    #[link_name = "objc_msgSend"]
    fn msg_send_id_char(cls: *mut c_void, sel: *mut c_void, arg: *const c_char) -> *mut c_void;
    #[link_name = "objc_msgSend"]
    fn msg_send_id_cls_obj(cls: *mut c_void, sel: *mut c_void, arg: *mut c_void) -> *mut c_void;
    #[link_name = "objc_msgSend"]
    fn msg_send_id_inst(receiver: *mut c_void, sel: *mut c_void) -> *mut c_void;
    #[link_name = "objc_msgSend"]
    fn msg_send_utf8(receiver: *mut c_void, sel: *mut c_void) -> *const c_char;
}

fn class(name: &str) -> *mut c_void {
    let c = CString::new(name).unwrap();
    unsafe { objc_getClass(c.as_ptr()) }
}

fn sel(name: &str) -> *mut c_void {
    let c = CString::new(name).unwrap();
    unsafe { sel_registerName(c.as_ptr()) }
}

fn ns_string(s: &str) -> *mut c_void {
    unsafe {
        msg_send_id_char(
            class("NSString"),
            sel("stringWithUTF8String:"),
            s.as_ptr() as *const c_char,
        ) as *mut c_void
    }
}

fn ns_to_string(obj: *mut c_void) -> String {
    if obj.is_null() {
        return String::new();
    }
    unsafe {
        let ptr = msg_send_utf8(obj, sel("UTF8String"));
        if ptr.is_null() {
            return String::new();
        }
        CStr::from_ptr(ptr).to_string_lossy().into_owned()
    }
}

#[tauri::command]
pub fn pick_app_bundle() -> Option<String> {
    #[cfg(target_os = "macos")]
    return pick_impl();
    #[cfg(not(target_os = "macos"))]
    None
}

#[cfg(target_os = "macos")]
fn pick_impl() -> Option<String> {
    // add_filter 指定 "app" 扩展：面板中只有 .app 可选（包按扩展名匹配，不会灰）
    let path = rfd::FileDialog::new()
        .set_directory("/Applications")
        .add_filter("Application", &["app"])
        .pick_file()?;

    let name = Path::new(&path)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())?;
    if !name.ends_with(".app") {
        return None;
    }

    // 优先解析 bundle identifier（唯一稳定；Safari 等系统应用的进程路径不含 .app）
    unsafe {
        let bundle = msg_send_id_cls_obj(
            class("NSBundle"),
            sel("bundleWithPath:"),
            ns_string(path.to_string_lossy().as_ref()),
        );
        if !bundle.is_null() {
            let bid = msg_send_id_inst(bundle, sel("bundleIdentifier"));
            let bid = ns_to_string(bid);
            if !bid.is_empty() {
                return Some(bid);
            }
        }
    }

    Some(name)
}
