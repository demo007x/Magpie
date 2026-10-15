//! 系统应用选择面板：供禁用应用列表选择 .app。
//! 使用 rfd（tauri-plugin-dialog 同款底层库）——AppKit 的线程/异常细节由其处理，
//! 不要手写 NSOpenPanel（ObjC 异常会穿透 Rust FFI 直接 abort，见 wry#1752 一族）。
//!
//! 返回黑名单匹配键：优先 bundle identifier（如 com.apple.Safari，唯一稳定），
//! 解析失败回退 bundle 名称（如 WeChat.app，走进程路径 contains 兜底）。用户取消 = None。
//! 必须在主线程调用（Tauri 同步命令默认在主线程执行）。

#[cfg(target_os = "macos")]
use std::ffi::{CStr, CString};
#[cfg(target_os = "macos")]
use std::os::raw::{c_char, c_void};
#[cfg(target_os = "macos")]
use std::path::Path;

// 显式链接 AppKit（NSBundle/NSRunningApplication）与 UniformTypeIdentifiers。
// 以下 ObjC FFI 辅助仅 macOS 使用（Windows 走 rfd 文件对话框 + exe 名）
#[cfg(target_os = "macos")]
#[link(name = "AppKit", kind = "framework")]
extern "C" {}

#[cfg(target_os = "macos")]
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

#[cfg(target_os = "macos")]
fn class(name: &str) -> *mut c_void {
    let c = CString::new(name).unwrap();
    unsafe { objc_getClass(c.as_ptr()) }
}

#[cfg(target_os = "macos")]
fn sel(name: &str) -> *mut c_void {
    let c = CString::new(name).unwrap();
    unsafe { sel_registerName(c.as_ptr()) }
}

#[cfg(target_os = "macos")]
fn ns_string(s: &str) -> *mut c_void {
    unsafe {
        msg_send_id_char(
            class("NSString"),
            sel("stringWithUTF8String:"),
            s.as_ptr() as *const c_char,
        ) as *mut c_void
    }
}

#[cfg(target_os = "macos")]
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
    // Windows：应用标识 = 可执行文件名（如 notepad.exe）。is_blacklisted 按
    // 进程路径小写子串匹配，文件名在应用移动/重装后仍命中，等价 macOS 端
    // bundle id 的稳定性；UIA 侧拿不到 bundle id，exe 名即最稳标识
    #[cfg(target_os = "windows")]
    return rfd::FileDialog::new()
        .set_title("选择要加入黑名单的应用")
        .add_filter("应用程序", &["exe", "lnk"])
        .pick_file()
        .and_then(|path| path.file_name().map(|s| s.to_string_lossy().into_owned()));
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
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

/// 系统目录选择面板：供 Obsidian vault 路径选择。用户取消 = None。
/// rfd pick_folder 三平台一致；必须在主线程调用（Tauri 同步命令默认在主线程执行）。
#[tauri::command]
pub fn pick_vault_dir() -> Option<String> {
    let path = rfd::FileDialog::new()
        .set_title("选择 Obsidian Vault 目录")
        .pick_folder()?;
    Some(path.to_string_lossy().into_owned())
}

/// 系统文件选择面板：选一张图片供「访达选图取字」识别。用户取消 = None。
/// 必须在主线程调用（rfd 对 AppKit 的线程约束同下方两个选择器）；
/// 且不能在托盘菜单事件回调内直接调用——先交由独立线程承载，
/// 见 main.rs::start_file_ocr_flow 的线程模型说明。
pub fn pick_image_file() -> Option<std::path::PathBuf> {
    rfd::FileDialog::new()
        .set_title("选择要识别的图片")
        .add_filter(
            "图片",
            &["png", "jpg", "jpeg", "heic", "webp", "bmp", "tif", "tiff", "gif"],
        )
        .pick_file()
}
