//! macOS 划词捕获：CGEventTap（listen-only 鼠标监听）+ AX（选中文本查询）。
//! 双线程模型：tap 线程仅入队回调 → detect 线程做状态机/防抖/AX 查询（docs/03 §3.1–3.3）。
//! 安全边界：全程不读写剪贴板；AX 查询失败 = 静默失败。

use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_int, c_void};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use core_foundation::base::TCFType;
use core_foundation::boolean::CFBoolean;
use core_foundation::dictionary::CFDictionary;
use core_foundation::string::{CFString, CFStringRef};

use super::{capture_muted, debug_log, CaptureEvent};

// ---------- C FFI ----------

type AXUIElementRef = *mut c_void;
type CFTypeRefC = *const c_void;
type CFDictionaryRefC = *const c_void;
type CFMachPortRef = *mut c_void;
type CFRunLoopRef = *mut c_void;
type CFRunLoopSourceRef = *mut c_void;
type CGEventRef = *mut c_void;
type CGEventTapProxy = *mut c_void;
type CGEventMask = u64;
type CFTypeID = usize;

#[repr(C)]
#[derive(Clone, Copy)]
struct CGPoint {
    x: f64,
    y: f64,
}

type CGEventTapCallBack =
    extern "C" fn(CGEventTapProxy, u32, CGEventRef, *mut c_void) -> CGEventRef;

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    // 无障碍 API 函数（经 ApplicationServices 伞框架解析）。
    // 注意：kAX* 属性常量不在 SDK tbd 导出表中，须运行时 dlsym（见 ax_consts）。
    fn AXUIElementCreateSystemWide() -> AXUIElementRef;
    fn AXUIElementCopyAttributeValue(
        el: AXUIElementRef,
        attr: CFStringRef,
        value: *mut CFTypeRefC,
    ) -> c_int;
    fn AXUIElementCopyParameterizedAttributeValue(
        el: AXUIElementRef,
        attr: CFStringRef,
        param: CFTypeRefC,
        value: *mut CFTypeRefC,
    ) -> c_int;
    // 坐标定位：Apple 文档明确为 top-left 原点屏幕坐标（与 CGEvent 同系，免转换）
    fn AXUIElementCopyElementAtPosition(
        el: AXUIElementRef,
        x: f32,
        y: f32,
        value: *mut CFTypeRefC,
    ) -> c_int;
    fn AXValueCreate(value_type: usize, value: *const c_void) -> *mut c_void;
    fn AXValueGetValue(value: CFTypeRefC, value_type: usize, into: *mut c_void) -> u8;
    fn AXUIElementSetAttributeValue(
        el: AXUIElementRef,
        attr: CFStringRef,
        value: CFTypeRefC,
    ) -> c_int;
    fn AXUIElementGetPid(el: AXUIElementRef, pid: *mut c_int) -> c_int;
    fn AXIsProcessTrustedWithOptions(options: CFDictionaryRefC) -> u8;
}

struct AxConsts {
    selected_text: CFStringRef,
    selected_text_range: CFStringRef,
    string_for_range: CFStringRef,
    focused_app: CFStringRef,
    focused_element: CFStringRef,
    focused_window: CFStringRef,
    children: CFStringRef,
    parent: CFStringRef,
    trusted_prompt: CFStringRef,
    // Chromium/Electron 系应用默认不构建 AX 树，需置 true 才暴露接口
    enhanced_ui: CFStringRef,
    manual_accessibility: CFStringRef,
}

// SAFETY: 不可变字符串常量，跨线程共享安全
unsafe impl Send for AxConsts {}
unsafe impl Sync for AxConsts {}

/// AX 属性名即公开字符串契约（"AXSelectedText" 等，跨 macOS 版本稳定）。
/// 不经链接器/dlsym 取 kAX* 数据符号——实测部分 macOS 版本（如 26）这些数据符号
/// 不参与导出，dlsym 返回 NULL，导致 CopyAttributeValue 报 -25201 IllegalArgument。
fn ax_consts() -> &'static AxConsts {
    static CACHE: std::sync::OnceLock<AxConsts> = std::sync::OnceLock::new();
    CACHE.get_or_init(|| AxConsts {
        selected_text: ax_string("AXSelectedText"),
        selected_text_range: ax_string("AXSelectedTextRange"),
        string_for_range: ax_string("AXStringForRange"),
        focused_app: ax_string("AXFocusedApplication"),
        focused_element: ax_string("AXFocusedUIElement"),
        focused_window: ax_string("AXFocusedWindow"),
        children: ax_string("AXChildren"),
        parent: ax_string("AXParent"),
        trusted_prompt: ax_string("AXTrustedCheckOptionPrompt"),
        enhanced_ui: ax_string("AXEnhancedUserInterface"),
        manual_accessibility: ax_string("AXManualAccessibility"),
    })
}

/// 构造进程生命周期的 CFString 常量（故意不释放）
fn ax_string(s: &str) -> CFStringRef {
    let cf = CFString::new(s);
    let raw = cf.as_concrete_TypeRef();
    std::mem::forget(cf);
    raw
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFMachPortCreateRunLoopSource(
        alloc: *const c_void,
        port: CFMachPortRef,
        order: i64,
    ) -> CFRunLoopSourceRef;
    fn CFRunLoopAddSource(rl: CFRunLoopRef, src: CFRunLoopSourceRef, mode: CFStringRef);
    fn CFRunLoopRunInMode(mode: CFStringRef, seconds: f64, return_after_source_handled: u8) -> i32;
    fn CFRunLoopGetCurrent() -> CFRunLoopRef;
    fn CFMachPortIsValid(port: CFMachPortRef) -> u8;
    fn CFMachPortInvalidate(port: CFMachPortRef);

    fn CFRelease(cf: *mut c_void);
    fn CFGetTypeID(cf: CFTypeRefC) -> CFTypeID;
    static kCFRunLoopDefaultMode: CFStringRef;

    // CFArray（AXChildren 遍历用）
    fn CFArrayGetCount(arr: CFTypeRefC) -> isize;
    fn CFArrayGetValueAtIndex(arr: CFTypeRefC, idx: isize) -> CFTypeRefC;
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    // 事件监听
    fn CGEventTapCreate(
        tap: u32,
        place: u32,
        options: u32,
        mask: CGEventMask,
        cb: CGEventTapCallBack,
        user: *mut c_void,
    ) -> CFMachPortRef;
    fn CGEventGetLocation(ev: CGEventRef) -> CGPoint;
    // 键盘事件合成（兼容模式模拟 ⌘C）
    fn CGEventCreateKeyboardEvent(source: *mut c_void, keycode: u16, keydown: u8) -> CGEventRef;
    fn CGEventSetFlags(ev: CGEventRef, flags: u64);
    fn CGEventPost(tap: u32, ev: CGEventRef);
    // 输入监控（Input Monitoring）权限探测：缺失时事件 tap 只能收到本进程的事件
    fn CGPreflightListenEventAccess() -> u8;
    // 发起输入监控授权请求：系统把当前运行的二进制自动注册进「输入监控」列表
    fn CGRequestListenEventAccess() -> u8;
    // 屏幕录制权限：OCR 截图取词需要
    fn CGPreflightScreenCaptureAccess() -> u8;
    fn CGRequestScreenCaptureAccess() -> u8;
}

extern "C" {
    // libproc —— pid → 进程路径（黑名单匹配），随 libSystem 链接
    fn proc_pidpath(pid: c_int, buf: *mut c_char, size: u32) -> c_int;
}

// CGEventType：LeftMouseDown=1, LeftMouseUp=2, LeftMouseDragged=6；掩码 = 1 << 类型
const EV_LEFT_DOWN: u32 = 1;
const EV_LEFT_UP: u32 = 2;
const EV_LEFT_DRAGGED: u32 = 6;
// CGEventTapLocation：kCGHIDEventTap=0, kCGSessionEventTap=1（勿混淆！）
const K_CG_HID_EVENT_TAP: u32 = 0;
const K_CG_SESSION_EVENT_TAP: u32 = 1;
const K_CG_HEAD_INSERT_EVENT_TAP: u32 = 0;
const K_CG_EVENT_TAP_OPTION_LISTEN_ONLY: u32 = 1;

// 诊断计数器
static EVENT_COUNT: AtomicU64 = AtomicU64::new(0);
static EVENT_TOTAL: AtomicU64 = AtomicU64::new(0);
static FIRST_EVENT: AtomicBool = AtomicBool::new(false);
static LAST_EVENT_MS: AtomicU64 = AtomicU64::new(0); // UNIX 毫秒

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ---------- 原始鼠标事件通道 ----------

#[derive(Clone, Copy)]
struct MouseEvent {
    kind: u32,
    x: f64,
    y: f64,
    t: Instant,
}

static EVENT_TX: Mutex<Option<Sender<MouseEvent>>> = Mutex::new(None);

extern "C" fn tap_callback(
    _proxy: CGEventTapProxy,
    kind: u32,
    ev: CGEventRef,
    _user: *mut c_void,
) -> CGEventRef {
    // 截图取词等系统交互期间静音：screencapture 的框选拖选会被误判为划词
    if capture_muted() {
        return ev;
    }
    // 回调内只做计数 + 入队（绝不查询 AX）
    EVENT_COUNT.fetch_add(1, Ordering::Relaxed);
    EVENT_TOTAL.fetch_add(1, Ordering::Relaxed);
    LAST_EVENT_MS.store(now_ms(), Ordering::Relaxed);
    if !FIRST_EVENT.swap(true, Ordering::Relaxed) {
        debug_log("✓ 收到首个鼠标事件，tap 工作正常");
    }
    if let Some(tx) = EVENT_TX.lock().ok().and_then(|g| g.clone()) {
        let p = unsafe { CGEventGetLocation(ev) };
        let _ = tx.send(MouseEvent { kind, x: p.x, y: p.y, t: Instant::now() });
    }
    ev
}

// ---------- 对外接口 ----------

pub fn start(tx: Sender<CaptureEvent>, debounce_ms: u64) {
    let (raw_tx, raw_rx) = channel::<MouseEvent>();
    if let Ok(mut g) = EVENT_TX.lock() {
        *g = Some(raw_tx);
    }
    std::thread::Builder::new()
        .name("capture-tap".into())
        .spawn(tap_thread)
        .expect("spawn capture-tap thread");
    std::thread::Builder::new()
        .name("capture-detect".into())
        .spawn(move || detect_loop(raw_rx, tx, debounce_ms))
        .expect("spawn capture-detect thread");
    std::thread::Builder::new()
        .name("capture-heartbeat".into())
        .spawn(tap_heartbeat)
        .expect("spawn capture-heartbeat thread");
    std::thread::Builder::new()
        .name("capture-axtest".into())
        .spawn(ax_self_test)
        .expect("spawn capture-axtest thread");
}

pub fn is_accessibility_granted() -> bool {
    unsafe { AXIsProcessTrustedWithOptions(std::ptr::null()) != 0 }
}

/// 发起辅助功能授权请求（kAXTrustedCheckOptionPrompt=true）：
/// 系统会把**当前运行的二进制**自动注册进辅助功能列表（指纹必然匹配），
/// 并打开系统设置对应面板——避免手动添加时的副本/指纹错位
pub fn prompt_accessibility() -> bool {
    unsafe {
        let key: CFString = CFString::wrap_under_get_rule(ax_consts().trusted_prompt);
        let dict = CFDictionary::from_CFType_pairs(&[(key, CFBoolean::true_value())]);
        AXIsProcessTrustedWithOptions(dict.as_concrete_TypeRef() as CFDictionaryRefC) != 0
    }
}

pub fn open_accessibility_settings() {
    let _ = std::process::Command::new("open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
        .spawn();
}

/// AX 服务实测：system-wide 聚焦应用查询是否放行。
/// 区分「AXIsProcessTrusted=true（TCC 信任）」与「AX 服务实际可用」——
/// 权限数据库缓存异常/未签名二进制代持授权时，两者可能割裂。
pub fn ax_service_probe() -> bool {
    unsafe {
        let sys = AXUIElementCreateSystemWide();
        if sys.is_null() {
            return false;
        }
        let mut app: CFTypeRefC = std::ptr::null();
        let rc = AXUIElementCopyAttributeValue(sys, ax_consts().focused_app, &mut app);
        let ok = rc == 0 && !app.is_null();
        if ok {
            CFRelease(app as *mut c_void);
        }
        CFRelease(sys as *mut c_void);
        ok
    }
}

/// 输入监控权限预检：false 时事件 tap 收不到其他应用的事件（划词死路）
pub fn listen_event_access() -> bool {
    unsafe { CGPreflightListenEventAccess() != 0 }
}

/// 发起输入监控授权请求（系统自动把当前二进制注册进「输入监控」列表）；
/// 仍未通过时打开输入监控设置面板。返回当前是否已授权。
pub fn request_listen_access() -> bool {
    let granted = unsafe { CGRequestListenEventAccess() != 0 };
    if !granted {
        let _ = std::process::Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent")
            .spawn();
    }
    granted
}

// ---------- tap / detect 线程 ----------

fn tap_location() -> u32 {
    // 默认 HID 级：实测 macOS 26（Intel）上 Session 级 tap 收不到拖选事件，
    // HID 级正常（docs/03 §3.1）。SHICI_TAP=session 可切回对照。
    match std::env::var("SHICI_TAP").as_deref() {
        Ok("session") => K_CG_SESSION_EVENT_TAP,
        _ => K_CG_HID_EVENT_TAP,
    }
}

fn tap_thread() {
    let loc = tap_location();
    let trusted = unsafe { AXIsProcessTrustedWithOptions(std::ptr::null()) != 0 };
    debug_log(format!(
        "capture 启动：AXIsProcessTrusted={trusted}，tap location={}",
        if loc == K_CG_HID_EVENT_TAP { "HID" } else { "Session" }
    ));

    unsafe {
        loop {
            let mut port = create_tap();
            let mut retries: u32 = 0;
            while port.is_null() {
                // 未授权辅助功能：tap 创建失败，每 3s 重试（授权后自愈）
                if retries == 0 {
                    debug_log("CGEventTapCreate 失败：辅助功能未授权？3 秒后重试");
                }
                retries += 1;
                std::thread::sleep(Duration::from_secs(3));
                port = create_tap();
            }
            debug_log(if retries == 0 {
                "event tap 已创建".to_string()
            } else {
                format!("event tap 已创建（重试 {retries} 次后，权限已生效）")
            });
            let src = CFMachPortCreateRunLoopSource(std::ptr::null(), port, 0);
            let rl = CFRunLoopGetCurrent();
            CFRunLoopAddSource(rl, src, kCFRunLoopDefaultMode);

            // 每 10s 醒来体检（CFRunLoopRunInMode 带超时返回）：
            // 授权开关变更等会让系统直接杀死现存 tap 且不会复活，必须检测并重建。
            loop {
                CFRunLoopRunInMode(kCFRunLoopDefaultMode, 10.0, 0);
                if CFMachPortIsValid(port) == 0 {
                    debug_log("tap 已失效（授权变更/系统回收），正在重建…");
                    break;
                }
                let last = LAST_EVENT_MS.load(Ordering::Relaxed);
                if last != 0 && now_ms().saturating_sub(last) > 180_000 {
                    debug_log("tap 超 3 分钟无事件（端口仍有效），预防性重建");
                    break;
                }
            }

            CFMachPortInvalidate(port);
            CFRelease(port as *mut c_void);
            CFRelease(src as *mut c_void);
            std::thread::sleep(Duration::from_millis(200)); // 重建间隔，避免抖动
        }
    }
}

/// 心跳：无条件报告事件数（调试期静默 = 异常信号）
fn tap_heartbeat() {
    loop {
        std::thread::sleep(Duration::from_secs(15));
        let n = EVENT_COUNT.swap(0, Ordering::Relaxed);
        let total = EVENT_TOTAL.load(Ordering::Relaxed);
        debug_log(format!("心跳：近 15s 事件 {n} / 累计 {total}"));
    }
}

/// 启动 AX 自检：立即实测 AX 服务与输入监控是否放行（结果同时供自检页展示）
fn ax_self_test() {
    std::thread::sleep(Duration::from_secs(2));
    if ax_service_probe() {
        debug_log("AX 自检：通过 ✓（聚焦应用查询 rc=0），AX 服务可用");
    } else {
        debug_log(
            "AX 自检：失败 ✗ —— TCC 已授权但 AX 服务拒绝。修复：系统设置取消勾选辅助功能里的应用 → 等 5 秒 → 重新勾选 → 重启应用",
        );
    }

    if listen_event_access() {
        debug_log("输入监控自检：通过 ✓（ListenEventAccess=true）");
    } else {
        debug_log(
            "输入监控自检：缺失 ✗ —— 事件 tap 将收不到其他应用的事件！修复：系统设置 → 隐私与安全性 → 输入监控 → 勾选本应用 → 重启应用",
        );
    }
}

unsafe fn create_tap() -> CFMachPortRef {
    CGEventTapCreate(
        tap_location(),
        K_CG_HEAD_INSERT_EVENT_TAP,
        K_CG_EVENT_TAP_OPTION_LISTEN_ONLY,
        tap_mask(),
        tap_callback,
        std::ptr::null_mut(),
    )
}

/// SHICI_ALL_EVENTS=1 时把 MouseMoved 也纳入（诊断用：移动事件量大，心跳立辨死活）
fn tap_mask() -> u64 {
    let mut m = (1u64 << EV_LEFT_DOWN) | (1u64 << EV_LEFT_UP) | (1u64 << EV_LEFT_DRAGGED);
    if std::env::var("SHICI_ALL_EVENTS").as_deref() == Ok("1") {
        m |= 1u64 << 5; // kCGEventMouseMoved
    }
    m
}

/// 选词判定状态机（docs/03 §3.2）：拖选 > 6px 或双击 → 防抖 → AX 查询；普通单击 → PlainClick
fn detect_loop(rx: Receiver<MouseEvent>, tx: Sender<CaptureEvent>, debounce_ms: u64) {
    let mut down: Option<(f64, f64)> = None;
    let mut last_up: Option<(Instant, f64, f64)> = None;
    let mut last_emitted: Option<(String, f64, f64)> = None;

    while let Ok(ev) = rx.recv() {
        match ev.kind {
            EV_LEFT_DOWN => {
                debug_log(format!("mouse-down ({:.0},{:.0})", ev.x, ev.y));
                down = Some((ev.x, ev.y));
            }
            EV_LEFT_DRAGGED => {
                // 拖动浮动条中：坐标转发给 worker 驱动窗口移动
                if crate::floating::is_dragging() {
                    let _ = tx.send(CaptureEvent::DragMove { x: ev.x, y: ev.y });
                }
            }
            EV_LEFT_UP => {
                if crate::floating::is_dragging() {
                    // 拖动结束：不参与选词/单击判定
                    let _ = tx.send(CaptureEvent::DragEnd);
                    last_up = Some((ev.t, ev.x, ev.y));
                    down = None;
                    continue;
                }
                let drag_dist = down
                    .map_or(0.0, |(dx, dy)| {
                        ((dx - ev.x).powi(2) + (dy - ev.y).powi(2)).sqrt()
                    });
                let is_double = last_up.map_or(false, |(lt, lx, ly)| {
                    ev.t.duration_since(lt) < Duration::from_millis(400)
                        && ((lx - ev.x).powi(2) + (ly - ev.y).powi(2)).sqrt() < 10.0
                });

                if drag_dist <= 6.0 && !is_double {
                    debug_log(format!("mouse-up：普通点击 ({:.0},{:.0})", ev.x, ev.y));
                    // 注意：不带 pid——worker 只用浮动条矩形判定，若填自身 pid 会被过滤导致 dismiss 永不触发
                    let _ = tx.send(CaptureEvent::PlainClick { x: ev.x, y: ev.y });
                } else if capture_muted() {
                    // 截图取词等系统交互期间的拖选：跳过判定与 AX 查询（防止在
                    // 截图模态会话里触发 AX 异常导致进程 abort）
                    debug_log("mouse-up：静音期间忽略拖选");
                } else {
                    debug_log(format!(
                        "mouse-up：判定为选词（drag={drag_dist:.1}px double={is_double}），防抖 {debounce_ms}ms 后查询 AX"
                    ));
                    // 防抖：等应用完成选区更新
                    std::thread::sleep(Duration::from_millis(debounce_ms));
                    if let Some((text, pid)) = unsafe { ax_selected_text(ev.x, ev.y) } {
                        forward_selection(
                            &tx,
                            &mut last_emitted,
                            text,
                            pid,
                            ev.x,
                            ev.y,
                            "AX 捕获成功",
                        );
                    } else if focused_is_safari() {
                        debug_log("AX 未取到 → Safari AppleScript 取词");
                        let text = safari_selected_text();
                        if let Some(text) = text {
                            forward_selection(
                                &tx,
                                &mut last_emitted,
                                text,
                                focused_pid().unwrap_or(0),
                                ev.x,
                                ev.y,
                                "Safari 取词成功",
                            );
                        } else if let Some((text, pid)) = force_fetch_via_copy() {
                            forward_selection(
                                &tx,
                                &mut last_emitted,
                                text,
                                pid,
                                ev.x,
                                ev.y,
                                "兼容模式取词成功",
                            );
                        } else {
                            debug_log("Safari + 兼容模式均未取到（静默，无事件）");
                        }
                    } else if let Some((text, pid)) = force_fetch_via_copy() {
                        forward_selection(
                            &tx,
                            &mut last_emitted,
                            text,
                            pid,
                            ev.x,
                            ev.y,
                            "兼容模式取词成功",
                        );
                    } else {
                        debug_log("AX + 兼容模式均未取到选中文本（静默失败，无事件）");
                    }
                }
                last_up = Some((ev.t, ev.x, ev.y));
                down = None;
            }
            _ => {} // dragged 不单独处理，up 时按 down 起点统一计算
        }
    }
}

// ---------- AX 查询（docs/03 §3.3，默认不碰剪贴板） ----------

/// 重复抑制 + 转发（AX / 兼容模式共用）
fn forward_selection(
    tx: &Sender<CaptureEvent>,
    last_emitted: &mut Option<(String, f64, f64)>,
    text: String,
    pid: i32,
    x: f64,
    y: f64,
    source: &str,
) {
    debug_log(format!("{source}：pid={pid} len={}", text.len()));
    // 重复抑制：同文本 + 坐标相近（< 4px）
    let dup = last_emitted.as_ref().map_or(false, |(lt, lx, ly)| {
        *lt == text && ((lx - x).powi(2) + (ly - y).powi(2)).sqrt() < 4.0
    });
    if dup {
        debug_log("跳过：与上次捕获重复");
        return;
    }
    // AX 链路拿不到 pid（权限状态异常等）时，用 NSWorkspace 前台应用兜底，
    // 保证黑名单过滤与归属判断不失效
    let pid = if pid > 0 { pid } else { frontmost_pid().unwrap_or(0) };
    let app = proc_path(pid).unwrap_or_default();
    let bid = running_bundle_id(pid).unwrap_or_default();
    debug_log(format!("判定通过 → 交 worker：app={app} bid={bid}"));
    let _ = tx.send(CaptureEvent::Selection {
        text: text.clone(),
        x,
        y,
        app,
        bid,
        pid,
    });
    *last_emitted = Some((text, x, y));
}

/// AX 错误码可读名（日志用）
fn ax_error_name(rc: i32) -> &'static str {
    match rc {
        0 => "Success",
        -25200 => "Failure",
        -25201 => "BadAttribute",
        -25202 => "InvalidElement",
        -25203 => "InvalidParameter",
        -25204 => "InvalidFocusedUIElement",
        -25205 => "IllegalArgument",
        -25206 => "NoValue",
        -25207 => "DoingAction",
        -25208 => "AttributeUnsupported",
        -25209 => "ActionUnsupported",
        -25210 => "NotificationUnsupported",
        -25211 => "NotImplemented",
        -25212 => "NotificationAlreadyRegistered",
        -25213 => "CannotComplete(消息失败/目标繁忙)",
        -25214 => "NotEnoughPrecision",
        _ => "Unknown",
    }
}

/// AX 查询选中文本（默认路径），失败时按开关走兼容模式
unsafe fn ax_selected_text(x: f64, y: f64) -> Option<(String, i32)> {
    let consts = ax_consts();
    let sys = AXUIElementCreateSystemWide();
    if sys.is_null() {
        debug_log("AX: AXUIElementCreateSystemWide 返回 null");
        return None;
    }
    let mut out = None;

    let mut app: CFTypeRefC = std::ptr::null();
    let rc_app = AXUIElementCopyAttributeValue(sys, consts.focused_app, &mut app);
    if rc_app == 0 && !app.is_null() {
        let app_el = app as AXUIElementRef;
        let mut pid: c_int = 0;
        let _ = AXUIElementGetPid(app_el, &mut pid);

        // 路径1（主）：聚焦元素级 SelectedText；失败则范围回退（AXSelectedTextRange + StringForRange）
        // —— 微信 4.x 等 Qt 自绘文本视图不暴露 SelectedText，但支持范围取值
        let mut text = query_focused_element(app_el, consts);

        // 路径2：应用级 SelectedText（部分应用只在此暴露）
        if text.is_none() {
            let (rc, t) = query_app_level(app_el, consts);
            debug_log(format!("AX: 应用级 SelectedText rc={rc} → {}", t.is_some()));
            text = t;
        }

        // 路径3：Chromium/Electron 系（Chrome/Edge/VSCode 等）默认不构建 AX 树，
        // 置 AXEnhancedUserInterface / AXManualAccessibility 后才暴露接口。轻推 + 重试一次。
        if text.is_none() {
            debug_log("AX: 常规路径无文本，尝试轻推 Chromium/Electron 辅助支持");
            set_bool_attr(app_el, consts.enhanced_ui);
            set_bool_attr(app_el, consts.manual_accessibility);
            std::thread::sleep(Duration::from_millis(150));
            text = query_focused_element(app_el, consts);
            if text.is_none() {
                let (rc, t) = query_app_level(app_el, consts);
                debug_log(format!("AX: 轻推后应用级 rc={rc} → {}", t.is_some()));
                text = t;
            }
        }

        if let Some(t) = text {
            out = Some((t, pid));
        }
    } else {
        debug_log(format!(
            "AX: 获取聚焦应用失败 rc={rc_app}（{}）——转坐标定位",
            ax_error_name(rc_app)
        ));
    }

    // 路径⑥：坐标定位 + 父链上溯（绕开聚焦链路，鼠标位置即选区位置）
    if out.is_none() {
        if let Some(t) = query_at_position(sys, consts, x, y) {
            let pid = focused_pid().unwrap_or(0);
            out = Some((t, pid));
        }
    }

    // 路径⑦：兼容模式（常开兜底）——模拟 ⌘C 读剪贴板，微信/Office 等自绘文本应用的行业通行解
    if out.is_none() {
        debug_log("AX 未取到 → 兼容模式：模拟 ⌘C 取词");
        if let Some((text, pid)) = force_fetch_via_copy() {
            out = Some((text, pid));
        }
    }

    // 路径⑤（最后兜底）：有界子树扫描——仅当以上全部失败，避免拖慢主路径
    if out.is_none() && !app.is_null() {
        if let Some(t) = scan_focused_subtrees(app as AXUIElementRef, consts) {
            let pid = focused_pid().unwrap_or(0);
            out = Some((t, pid));
        }
    }

    if !app.is_null() {
        CFRelease(app as *mut c_void);
    }
    CFRelease(sys as *mut c_void);
    out
}

/// 最后兜底：聚焦元素子树 → 聚焦窗口子树（有界 DFS）。
/// 微信 4.x 的 Qt 桥常把 AXFocusedUIElement 停在输入框（rc=0 但选区为空），
/// 真正的选区在兄弟/子孙节点上，需下探扫描。
unsafe fn scan_focused_subtrees(app_el: AXUIElementRef, consts: &AxConsts) -> Option<String> {
    const SCAN_BUDGET: usize = 64;
    const SCAN_DEPTH: usize = 6;

    let mut focused: CFTypeRefC = std::ptr::null();
    let rc = AXUIElementCopyAttributeValue(app_el, consts.focused_element, &mut focused);
    if rc == 0 && !focused.is_null() {
        debug_log("AX: 扫描聚焦元素子树…");
        let mut budget = SCAN_BUDGET;
        let hit = scan_subtree_for_text(focused as AXUIElementRef, consts, SCAN_DEPTH, &mut budget);
        CFRelease(focused as *mut c_void);
        if hit.is_some() {
            return hit;
        }
    }

    let mut win: CFTypeRefC = std::ptr::null();
    let rc_win = AXUIElementCopyAttributeValue(app_el, consts.focused_window, &mut win);
    if rc_win == 0 && !win.is_null() {
        debug_log("AX: 扫描聚焦窗口子树…");
        let mut budget = SCAN_BUDGET;
        let hit = scan_subtree_for_text(win as AXUIElementRef, consts, SCAN_DEPTH, &mut budget);
        CFRelease(win as *mut c_void);
        if hit.is_some() {
            return hit;
        }
    }
    None
}

/// 聚焦应用 pid（兼容模式取词后归属过滤用；查不到为 0，worker 侧黑名单跳过）
fn focused_pid() -> Option<i32> {
    unsafe {
        let sys = AXUIElementCreateSystemWide();
        if sys.is_null() {
            return None;
        }
        let mut app: CFTypeRefC = std::ptr::null();
        let rc = AXUIElementCopyAttributeValue(sys, ax_consts().focused_app, &mut app);
        let mut pid: c_int = 0;
        if rc == 0 && !app.is_null() {
            let _ = AXUIElementGetPid(app as AXUIElementRef, &mut pid);
            CFRelease(app as *mut c_void);
        }
        CFRelease(sys as *mut c_void);
        (pid != 0).then_some(pid)
    }
}

/// 坐标定位回退：AXUIElementCopyElementAtPosition（top-left 原点，与 CGEvent 同系）
/// 取光标下元素，沿 AXParent 向上找带选区文本的节点。绕开聚焦链路。
unsafe fn query_at_position(
    sys: AXUIElementRef,
    consts: &AxConsts,
    x: f64,
    y: f64,
) -> Option<String> {
    let mut el: CFTypeRefC = std::ptr::null();
    let rc = AXUIElementCopyElementAtPosition(sys, x as f32, y as f32, &mut el);
    if rc != 0 || el.is_null() {
        debug_log(format!(
            "AX: 坐标定位不可用 rc={rc}（{}）",
            ax_error_name(rc)
        ));
        return None;
    }
    let mut cur = el as AXUIElementRef;
    let mut text = None;
    for depth in 0..=5 {
        text = copy_selected_text(cur, consts, true)
            .or_else(|| query_text_via_range(cur, consts, true));
        if text.is_some() {
            debug_log(format!("AX: 坐标定位命中（向上 {depth} 层）"));
            break;
        }
        let mut parent: CFTypeRefC = std::ptr::null();
        let rc_p = AXUIElementCopyAttributeValue(cur, consts.parent, &mut parent);
        if rc_p != 0 || parent.is_null() {
            break;
        }
        CFRelease(cur as *mut c_void);
        cur = parent as AXUIElementRef;
    }
    CFRelease(cur as *mut c_void);
    text
}

// ---------- Safari：AppleScript 取词（Safari 不暴露 AX SelectedText；剪贴板-free，参考 Easydict GUIDE） ----------

fn focused_is_safari() -> bool {
    focused_pid()
        .and_then(proc_path)
        .map(|p| p.to_lowercase().contains("safari"))
        .unwrap_or(false)
}

/// Safari 取词：do JavaScript 读 window.getSelection()，并暂存选区 Range。
/// 需 Safari 开发菜单开启「允许来自 Apple 事件的 JavaScript」；未开启/超时/空选区 = None。
/// 副作用处理：浮动条出现/失焦可能清掉页面选区，读取时把 Range 存到 window.__magpieSel，
/// 350ms 后检测到选区被清空则重新套用（还原高亮）。
fn safari_selected_text() -> Option<String> {
    use std::io::Read;
    use std::process::{Command, Stdio};

    // 读取 + 暂存 Range（选区收起/无选区时返回空串）
    let script = r#"tell application "Safari" to do JavaScript "(function(){var s=getSelection();if(!s.rangeCount||s.isCollapsed)return '';window.__magpieSel=s.getRangeAt(0).cloneRange();return s.toString()})()" in current tab of front window"#;
    // 还原：仅当选区被清空/收起时重新套用，避免重复叠加
    let restore = r#"tell application "Safari" to do JavaScript "(function(){var r=window.__magpieSel;if(!r)return;var s=getSelection();if(s.rangeCount===0||s.isCollapsed){s.removeAllRanges();s.addRange(r);}delete window.__magpieSel})()" in current tab of front window"#;

    let mut child = Command::new("osascript")
        .arg("-e")
        .arg(script)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;

    // 有界等待：Safari 响应通常 <100ms，超时视为失败
    let deadline = Instant::now() + Duration::from_millis(800);
    let mut done = false;
    while Instant::now() < deadline {
        match child.try_wait() {
            Ok(Some(_)) => {
                done = true;
                break;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(_) => return None,
        }
    }
    if !done {
        let _ = child.kill();
        let _ = child.wait();
        debug_log("Safari AppleScript 超时");
        return None;
    }

    let mut stdout = String::new();
    if let Some(mut pipe) = child.stdout.take() {
        let _ = pipe.read_to_string(&mut stdout);
    }
    let text = stdout.trim().to_string();
    if text.is_empty() {
        debug_log("Safari AppleScript：未取到文本（检查 开发菜单 → 允许来自 Apple 事件的 JavaScript）");
        return None;
    }
    debug_log(format!("Safari AppleScript 取词成功 len={}", text.len()));

    // 延时还原选区高亮：等浮动条出现、可能的清选区动作发生后执行
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(350));
        let _ = Command::new("osascript")
            .arg("-e")
            .arg(restore)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    });

    Some(text)
}

// ---------- 兼容模式：模拟 ⌘C 读剪贴板（常开兜底；行业通行解，参考 Easydict #84） ----------

const K_VK_ANSI_C: u16 = 8;
const K_CG_EVENT_FLAG_COMMAND: u64 = 1 << 20;

unsafe fn post_cmd_c() {
    let down = CGEventCreateKeyboardEvent(std::ptr::null_mut(), K_VK_ANSI_C, 1);
    let up = CGEventCreateKeyboardEvent(std::ptr::null_mut(), K_VK_ANSI_C, 0);
    if down.is_null() || up.is_null() {
        if !down.is_null() {
            CFRelease(down);
        }
        if !up.is_null() {
            CFRelease(up);
        }
        return;
    }
    CGEventSetFlags(down, K_CG_EVENT_FLAG_COMMAND);
    CGEventSetFlags(up, K_CG_EVENT_FLAG_COMMAND);
    CGEventPost(K_CG_HID_EVENT_TAP, down);
    CGEventPost(K_CG_HID_EVENT_TAP, up);
    CFRelease(down);
    CFRelease(up);
}

/// 兼容模式取词：快照剪贴板 → 模拟 ⌘C → 轮询变化 → 取词 → 还原快照。
/// 返回 (文本, 聚焦应用 pid（查不到为 0）)；失败 = None（静默）。
pub fn force_fetch_via_copy() -> Option<(String, i32)> {
    const POLL_TIMES: usize = 60; // 60 × 10ms = 600ms 上限；应用响应后首个周期即命中
    const POLL_INTERVAL: Duration = Duration::from_millis(10);

    let mut board = arboard::Clipboard::new().ok()?;
    let snapshot = board.get_text().ok();

    unsafe { post_cmd_c() };

    let mut fetched: Option<String> = None;
    for _ in 0..POLL_TIMES {
        std::thread::sleep(POLL_INTERVAL);
        if let Ok(now) = board.get_text() {
            let changed = snapshot.as_ref().map_or(true, |s| *s != now);
            if changed && !now.trim().is_empty() {
                fetched = Some(now);
                break;
            }
        }
    }

    // 尽力还原快照（原剪贴板无文本则清空）
    let _ = match &snapshot {
        Some(s) => board.set_text(s.clone()),
        None => board.clear(),
    };

    let text = fetched?;
    let pid = focused_pid().unwrap_or(0);
    debug_log(format!("兼容模式：⌘C 取到文本 len={}", text.len()));
    Some((text, pid))
}

/// 聚焦元素级取文本：SelectedText → 范围回退（轻量路径；子树扫描见 scan_focused_subtrees）
unsafe fn query_focused_element(app_el: AXUIElementRef, consts: &AxConsts) -> Option<String> {
    let mut focused: CFTypeRefC = std::ptr::null();
    let rc_focus = AXUIElementCopyAttributeValue(app_el, consts.focused_element, &mut focused);
    if rc_focus != 0 || focused.is_null() {
        debug_log(format!("AX: 聚焦元素不可达 rc_focus={rc_focus}"));
        return None;
    }
    let el = focused as AXUIElementRef;
    let mut text = copy_selected_text(el, consts, false);
    if text.is_none() {
        text = query_text_via_range(el, consts, false);
    }
    CFRelease(focused as *mut c_void);
    text
}

/// 有界 DFS：在子树每个节点上尝试 SelectedText / 范围回退（静默，避免日志刷屏）。
/// budget 跨递归共享，防止大 UI 树拖垮查询耗时。
unsafe fn scan_subtree_for_text(
    el: AXUIElementRef,
    consts: &AxConsts,
    depth: usize,
    budget: &mut usize,
) -> Option<String> {
    if *budget == 0 {
        return None;
    }
    *budget -= 1;

    let mut text = copy_selected_text(el, consts, true);
    if text.is_none() {
        text = query_text_via_range(el, consts, true);
    }
    if text.is_some() {
        debug_log(format!("AX: 子树扫描命中（剩余预算 {budget}）"));
        return text;
    }
    if depth == 0 {
        return None;
    }

    let mut kids: CFTypeRefC = std::ptr::null();
    let rc = AXUIElementCopyAttributeValue(el, consts.children, &mut kids);
    if rc != 0 || kids.is_null() {
        return None;
    }
    let n = CFArrayGetCount(kids);
    for i in 0..n {
        let child = CFArrayGetValueAtIndex(kids, i);
        if child.is_null() {
            continue;
        }
        // 数组持有引用，元素无需释放；找到即提前返回（kids 由 CFRelease 释放）
        if let Some(t) = scan_subtree_for_text(child as AXUIElementRef, consts, depth - 1, budget) {
            CFRelease(kids as *mut c_void);
            return Some(t);
        }
        if *budget == 0 {
            break;
        }
    }
    CFRelease(kids as *mut c_void);
    None
}

/// 直接取 AXSelectedText；rc=0 时区分 空值/非字符串/空串 三种情况（verbose=false 时静默）
unsafe fn copy_selected_text(el: AXUIElementRef, consts: &AxConsts, quiet: bool) -> Option<String> {
    let mut val: CFTypeRefC = std::ptr::null();
    let rc_sel = AXUIElementCopyAttributeValue(el, consts.selected_text, &mut val);
    if rc_sel != 0 {
        if !quiet {
            debug_log(format!("AX: SelectedText rc_sel={rc_sel}"));
        }
        return None;
    }
    match describe_value(val) {
        Ok(t) => Some(t),
        Err(why) => {
            if !quiet {
                debug_log(format!("AX: SelectedText rc_sel=0 但{why}"));
            }
            None
        }
    }
}

/// 与 C CFRange 二进制布局一致（CFIndex = long = isize）
#[repr(C)]
struct CfRange {
    location: isize,
    length: isize,
}

/// 范围回退：AXSelectedTextRange → AXStringForRange（参数化查询）。
/// 部分自绘文本视图（如微信 4.x 的 Qt 控件）不暴露 SelectedText 但支持范围取值。
unsafe fn query_text_via_range(
    el: AXUIElementRef,
    consts: &AxConsts,
    quiet: bool,
) -> Option<String> {
    // kAXValueCFRangeType = 3
    const K_AX_VALUE_CF_RANGE: usize = 3;

    let mut range_val: CFTypeRefC = std::ptr::null();
    let rc_range = AXUIElementCopyAttributeValue(el, consts.selected_text_range, &mut range_val);
    if rc_range != 0 || range_val.is_null() {
        if !quiet {
            debug_log(format!("AX: 范围回退不可用 rc_range={rc_range}"));
        }
        return None;
    }
    let mut range = CfRange { location: 0, length: 0 };
    let ok = AXValueGetValue(range_val, K_AX_VALUE_CF_RANGE, &mut range as *mut _ as *mut c_void);
    CFRelease(range_val as *mut c_void);
    if ok == 0 || range.length <= 0 {
        if !quiet {
            debug_log(format!(
                "AX: 范围取值失败 ok={ok} len={}（选区为空或值类型非 Range）",
                range.length
            ));
        }
        return None;
    }

    let param = AXValueCreate(K_AX_VALUE_CF_RANGE, &range as *const _ as *const c_void);
    if param.is_null() {
        return None;
    }
    let mut out: CFTypeRefC = std::ptr::null();
    let rc_str = AXUIElementCopyParameterizedAttributeValue(
        el,
        consts.string_for_range,
        param,
        &mut out,
    );
    CFRelease(param);
    let text = if rc_str == 0 {
        cf_type_to_string(out)
    } else {
        None
    };
    if text.is_none() && !quiet {
        debug_log(format!("AX: StringForRange rc_str={rc_str}"));
    }
    text
}

/// 应用级 SelectedText，返回 (错误码, 文本)
unsafe fn query_app_level(app_el: AXUIElementRef, consts: &AxConsts) -> (c_int, Option<String>) {
    let mut val: CFTypeRefC = std::ptr::null();
    let rc = AXUIElementCopyAttributeValue(app_el, consts.selected_text, &mut val);
    let text = if rc == 0 {
        cf_type_to_string(val)
    } else {
        None
    };
    (rc, text)
}

/// 布尔属性设置（不支持该属性的应用返回错误码，无害忽略）
unsafe fn set_bool_attr(el: AXUIElementRef, attr: CFStringRef) {
    let v = CFBoolean::true_value();
    let rc = AXUIElementSetAttributeValue(el, attr, v.as_concrete_TypeRef() as CFTypeRefC);
    if rc != 0 {
        debug_log(format!("AX: SetAttributeValue rc={rc}（不支持则忽略）"));
    }
}

/// CFTypeRef → String（接管 +1 所有权并负责释放）；空串/非字符串 → None
unsafe fn cf_type_to_string(v: CFTypeRefC) -> Option<String> {
    if v.is_null() {
        return None;
    }
    if CFGetTypeID(v) != CFString::type_id() {
        CFRelease(v as *mut c_void);
        return None;
    }
    let s = CFString::wrap_under_create_rule(v as CFStringRef);
    let out = s.to_string();
    if out.trim().is_empty() {
        None
    } else {
        Some(out)
    }
}

/// rc=0 但仍可能无文本：区分 空值 / 非字符串 / 空串（接管值的所有权）
unsafe fn describe_value(v: CFTypeRefC) -> Result<String, &'static str> {
    if v.is_null() {
        return Err("值为空");
    }
    if CFGetTypeID(v) != CFString::type_id() {
        CFRelease(v as *mut c_void);
        return Err("值类型非字符串");
    }
    let s = CFString::wrap_under_create_rule(v as CFStringRef);
    let out = s.to_string();
    if out.trim().is_empty() {
        Err("选区为空串")
    } else {
        Ok(out)
    }
}

fn proc_path(pid: c_int) -> Option<String> {
    let mut buf = [0 as c_char; 4096];
    let n = unsafe { proc_pidpath(pid, buf.as_mut_ptr(), buf.len() as u32) };
    if n <= 0 {
        return None;
    }
    let bytes: Vec<u8> = buf[..n as usize]
        .iter()
        .map(|&b| b as u8)
        .take_while(|&b| b != 0)
        .collect();
    String::from_utf8(bytes).ok()
}

/// 屏幕录制权限预检（OCR 截图取词需要）
pub fn screen_capture_access() -> bool {
    unsafe { CGPreflightScreenCaptureAccess() != 0 }
}

/// 发起屏幕录制授权请求（系统弹窗）
pub fn request_screen_capture_access() -> bool {
    unsafe { CGRequestScreenCaptureAccess() != 0 }
}

// ---------- NSRunningApplication / NSWorkspace：运行中应用身份（黑名单精确匹配用） ----------

#[link(name = "AppKit", kind = "framework")]
extern "C" {}

// objc_msgSend 按调用签名分别声明（与 objc crate 内部做法一致）
#[allow(clashing_extern_declarations)]
extern "C" {
    fn objc_getClass(name: *const c_char) -> *mut c_void;
    fn sel_registerName(name: *const c_char) -> *mut c_void;
    #[link_name = "objc_msgSend"]
    fn msg_send_id_with_i32(receiver: *mut c_void, sel: *mut c_void, arg: i32) -> *mut c_void;
    #[link_name = "objc_msgSend"]
    fn msg_send_id_inst(receiver: *mut c_void, sel: *mut c_void) -> *mut c_void;
    #[link_name = "objc_msgSend"]
    fn msg_send_i64(receiver: *mut c_void, sel: *mut c_void) -> i64;
    #[link_name = "objc_msgSend"]
    fn msg_send_utf8(receiver: *mut c_void, sel: *mut c_void) -> *const c_char;
}

fn objc_class(name: &str) -> *mut c_void {
    let c = CString::new(name).unwrap();
    unsafe { objc_getClass(c.as_ptr()) }
}

fn objc_sel(name: &str) -> *mut c_void {
    let c = CString::new(name).unwrap();
    unsafe { sel_registerName(c.as_ptr()) }
}

/// 运行中应用的 bundle identifier（如 com.apple.Safari）；解析失败 = None。
/// 黑名单精确匹配用——Safari 等系统应用的进程路径不含 .app 包名，contains 会漏。
pub(crate) fn running_bundle_id(pid: c_int) -> Option<String> {
    unsafe {
        let app = msg_send_id_with_i32(
            objc_class("NSRunningApplication"),
            objc_sel("runningApplicationWithProcessIdentifier:"),
            pid,
        );
        if app.is_null() {
            return None;
        }
        let bid = msg_send_id_inst(app, objc_sel("bundleIdentifier"));
        if bid.is_null() {
            return None;
        }
        let ptr = msg_send_utf8(bid, objc_sel("UTF8String"));
        if ptr.is_null() {
            return None;
        }
        Some(CStr::from_ptr(ptr).to_string_lossy().into_owned())
    }
}

/// 前台应用 pid（NSWorkspace，**不依赖 AX**）。AX 权限状态异常（如 -25212）时的兜底，
/// 保证黑名单过滤与归属归属判断不失效。
fn frontmost_pid() -> Option<i32> {
    unsafe {
        let ws = msg_send_id_inst(objc_class("NSWorkspace"), objc_sel("sharedWorkspace"));
        if ws.is_null() {
            return None;
        }
        let app = msg_send_id_inst(ws, objc_sel("frontmostApplication"));
        if app.is_null() {
            return None;
        }
        let pid = msg_send_i64(app, objc_sel("processIdentifier"));
        (pid > 0).then_some(pid as i32)
    }
}
