//! AX/CGEvent/CF 底层 FFI：extern 绑定、AX 属性名常量、事件类型常量。
//! 常量必须对照 SDK 头文件（AGENTS.md 警告案例：kAXValueCFRangeType、NSTextCheckingTypeDate）。
use core_foundation::base::TCFType;
use core_foundation::string::{CFString, CFStringRef};
use std::os::raw::{c_char, c_int, c_void};

// ---------- C FFI ----------

pub(super) type AXUIElementRef = *mut c_void;
pub(super) type CFTypeRefC = *const c_void;
pub(super) type CFDictionaryRefC = *const c_void;
pub(super) type CFMachPortRef = *mut c_void;
pub(super) type CFRunLoopRef = *mut c_void;
pub(super) type CFRunLoopSourceRef = *mut c_void;
pub(super) type CGEventRef = *mut c_void;
pub(super) type CGEventTapProxy = *mut c_void;
pub(super) type CGEventMask = u64;
pub(super) type CFTypeID = usize;

#[repr(C)]
#[derive(Clone, Copy)]
pub(super) struct CGPoint {
    pub(super) x: f64,
    pub(super) y: f64,
}

pub(super) type CGEventTapCallBack =
    extern "C" fn(CGEventTapProxy, u32, CGEventRef, *mut c_void) -> CGEventRef;

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    // 无障碍 API 函数（经 ApplicationServices 伞框架解析）。
    // 注意：kAX* 属性常量不在 SDK tbd 导出表中，须运行时 dlsym（见 ax_consts）。
    pub(super) fn AXUIElementCreateSystemWide() -> AXUIElementRef;
    pub(super) fn AXUIElementCreateApplication(pid: c_int) -> AXUIElementRef;
    pub(super) fn AXUIElementCopyAttributeValue(
        el: AXUIElementRef,
        attr: CFStringRef,
        value: *mut CFTypeRefC,
    ) -> c_int;
    pub(super) fn AXUIElementCopyParameterizedAttributeValue(
        el: AXUIElementRef,
        attr: CFStringRef,
        param: CFTypeRefC,
        value: *mut CFTypeRefC,
    ) -> c_int;
    // 坐标定位：Apple 文档明确为 top-left 原点屏幕坐标（与 CGEvent 同系，免转换）
    pub(super) fn AXUIElementCopyElementAtPosition(
        el: AXUIElementRef,
        x: f32,
        y: f32,
        value: *mut CFTypeRefC,
    ) -> c_int;
    pub(super) fn AXValueCreate(value_type: usize, value: *const c_void) -> *mut c_void;
    pub(super) fn AXValueGetValue(value: CFTypeRefC, value_type: usize, into: *mut c_void) -> u8;
    pub(super) fn AXUIElementSetAttributeValue(
        el: AXUIElementRef,
        attr: CFStringRef,
        value: CFTypeRefC,
    ) -> c_int;
    pub(super) fn AXUIElementGetPid(el: AXUIElementRef, pid: *mut c_int) -> c_int;
    pub(super) fn AXIsProcessTrustedWithOptions(options: CFDictionaryRefC) -> u8;
}

pub(super) struct AxConsts {
    pub(super) selected_text: CFStringRef,
    pub(super) selected_text_range: CFStringRef,
    pub(super) string_for_range: CFStringRef,
    pub(super) role: CFStringRef,
    pub(super) focused_app: CFStringRef,
    pub(super) focused_element: CFStringRef,
    pub(super) focused_window: CFStringRef,
    pub(super) children: CFStringRef,
    pub(super) parent: CFStringRef,
    /// 元素屏幕几何（应答锚定校验用，见 anchored_to_gesture）
    pub(super) position: CFStringRef,
    pub(super) size: CFStringRef,
    pub(super) trusted_prompt: CFStringRef,
    // Chromium/Electron 系应用默认不构建 AX 树，需置 true 才暴露接口
    pub(super) enhanced_ui: CFStringRef,
    pub(super) manual_accessibility: CFStringRef,
}

// SAFETY: 不可变字符串常量，跨线程共享安全
unsafe impl Send for AxConsts {}
unsafe impl Sync for AxConsts {}

/// AX 属性名即公开字符串契约（"AXSelectedText" 等，跨 macOS 版本稳定）。
/// 不经链接器/dlsym 取 kAX* 数据符号——实测部分 macOS 版本（如 26）这些数据符号
/// 不参与导出，dlsym 返回 NULL，导致 CopyAttributeValue 报 -25201 IllegalArgument。
pub(super) fn ax_consts() -> &'static AxConsts {
    static CACHE: std::sync::OnceLock<AxConsts> = std::sync::OnceLock::new();
    CACHE.get_or_init(|| AxConsts {
        selected_text: ax_string("AXSelectedText"),
        selected_text_range: ax_string("AXSelectedTextRange"),
        string_for_range: ax_string("AXStringForRange"),
        role: ax_string("AXRole"),
        focused_app: ax_string("AXFocusedApplication"),
        focused_element: ax_string("AXFocusedUIElement"),
        focused_window: ax_string("AXFocusedWindow"),
        children: ax_string("AXChildren"),
        parent: ax_string("AXParent"),
        position: ax_string("AXPosition"),
        size: ax_string("AXSize"),
        trusted_prompt: ax_string("AXTrustedCheckOptionPrompt"),
        enhanced_ui: ax_string("AXEnhancedUserInterface"),
        manual_accessibility: ax_string("AXManualAccessibility"),
    })
}

/// 构造进程生命周期的 CFString 常量（故意不释放）
pub(super) fn ax_string(s: &str) -> CFStringRef {
    let cf = CFString::new(s);
    let raw = cf.as_concrete_TypeRef();
    std::mem::forget(cf);
    raw
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    pub(super) fn CFMachPortCreateRunLoopSource(
        alloc: *const c_void,
        port: CFMachPortRef,
        order: i64,
    ) -> CFRunLoopSourceRef;
    pub(super) fn CFRunLoopAddSource(rl: CFRunLoopRef, src: CFRunLoopSourceRef, mode: CFStringRef);
    pub(super) fn CFRunLoopRunInMode(mode: CFStringRef, seconds: f64, return_after_source_handled: u8) -> i32;
    pub(super) fn CFRunLoopGetCurrent() -> CFRunLoopRef;
    pub(super) fn CFMachPortIsValid(port: CFMachPortRef) -> u8;
    pub(super) fn CFMachPortInvalidate(port: CFMachPortRef);

    pub(super) fn CFRelease(cf: *mut c_void);
    pub(super) fn CFGetTypeID(cf: CFTypeRefC) -> CFTypeID;
    pub(super) static kCFRunLoopDefaultMode: CFStringRef;

    // CFArray（AXChildren 遍历用）
    pub(super) fn CFArrayGetCount(arr: CFTypeRefC) -> isize;
    pub(super) fn CFArrayGetValueAtIndex(arr: CFTypeRefC, idx: isize) -> CFTypeRefC;
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    // 事件监听
    pub(super) fn CGEventTapCreate(
        tap: u32,
        place: u32,
        options: u32,
        mask: CGEventMask,
        cb: CGEventTapCallBack,
        user: *mut c_void,
    ) -> CFMachPortRef;
    pub(super) fn CGEventGetLocation(ev: CGEventRef) -> CGPoint;
    /// 读取事件字段：kCGKeyboardEventKeycode=9（物理键码）、kCGKeyboardEventAutorepeat=8
    pub(super) fn CGEventGetIntegerValueField(ev: CGEventRef, field: u64) -> i64;
    // 键盘事件合成（兼容模式模拟 ⌘C）
    pub(super) fn CGEventCreateKeyboardEvent(source: *mut c_void, keycode: u16, keydown: u8) -> CGEventRef;
    pub(super) fn CGEventSetFlags(ev: CGEventRef, flags: u64);
    pub(super) fn CGEventPost(tap: u32, ev: CGEventRef);
    // 输入监控（Input Monitoring）权限探测：缺失时事件 tap 只能收到本进程的事件
    pub(super) fn CGPreflightListenEventAccess() -> u8;
    // 发起输入监控授权请求：系统把当前运行的二进制自动注册进「输入监控」列表
    pub(super) fn CGRequestListenEventAccess() -> u8;
    // 屏幕录制权限：OCR 截图取词需要
    pub(super) fn CGPreflightScreenCaptureAccess() -> u8;
    pub(super) fn CGRequestScreenCaptureAccess() -> u8;
}

extern "C" {
    // libproc —— pid → 进程路径（黑名单匹配），随 libSystem 链接
    pub(super) fn proc_pidpath(pid: c_int, buf: *mut c_char, size: u32) -> c_int;
}

// CGEventType：LeftMouseDown=1, LeftMouseUp=2, LeftMouseDragged=6；掩码 = 1 << 类型
pub(super) const EV_MOUSE_MOVED: u32 = 5;
pub(super) const EV_LEFT_DOWN: u32 = 1;
pub(super) const EV_LEFT_UP: u32 = 2;
pub(super) const EV_LEFT_DRAGGED: u32 = 6;
// kCGEventKeyDown=10：只为「浮动条可见时按 Esc 收起」而监听，且回调内即刻过滤
// （只放行 Esc 的 keycode，其余按键不入队、不落盘、不读取内容）
pub(super) const EV_KEY_DOWN: u32 = 10;
pub(super) const KEY_ESC: u16 = 53;
// CGEventTapLocation：kCGHIDEventTap=0, kCGSessionEventTap=1（勿混淆！）
pub(super) const K_CG_HID_EVENT_TAP: u32 = 0;
pub(super) const K_CG_SESSION_EVENT_TAP: u32 = 1;
pub(super) const K_CG_HEAD_INSERT_EVENT_TAP: u32 = 0;
pub(super) const K_CG_EVENT_TAP_OPTION_LISTEN_ONLY: u32 = 1;

