//! macOS 划词捕获：CGEventTap（listen-only 鼠标监听）+ AX（选中文本查询）。
//! 双线程模型：tap 线程仅入队回调 → detect 线程做状态机/防抖/AX 查询（docs/03 §3.1–3.3）。
//! 安全边界：全程不读写剪贴板；AX 查询失败 = 静默失败。

use std::os::raw::{c_char, c_int, c_void};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use core_foundation::base::TCFType;
use core_foundation::boolean::CFBoolean;
use core_foundation::dictionary::CFDictionary;
use core_foundation::string::{CFString, CFStringRef};

use super::{debug_log, CaptureEvent};

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
    focused_app: CFStringRef,
    focused_element: CFStringRef,
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
        focused_app: ax_string("AXFocusedApplication"),
        focused_element: ax_string("AXFocusedUIElement"),
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
    // 输入监控（Input Monitoring）权限探测：缺失时事件 tap 只能收到本进程的事件
    fn CGPreflightListenEventAccess() -> u8;
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

/// 启动 AX 自检：在已授权上下文中立即实测 AX 服务是否放行，
/// 区分「AXIsProcessTrusted=true（TCC 信任）」与「AX 服务实际可用」——
/// 权限数据库缓存异常/未签名二进制代持授权时，两者可能割裂。
fn ax_self_test() {
    std::thread::sleep(Duration::from_secs(2));
    unsafe {
        let consts = ax_consts();
        let sys = AXUIElementCreateSystemWide();
        if sys.is_null() {
            debug_log("AX 自检：system-wide 元素创建失败");
            return;
        }
        let mut app: CFTypeRefC = std::ptr::null();
        let rc = AXUIElementCopyAttributeValue(sys, consts.focused_app, &mut app);
        if rc == 0 && !app.is_null() {
            let mut pid: c_int = 0;
            let _ = AXUIElementGetPid(app as AXUIElementRef, &mut pid);
            debug_log(format!("AX 自检：通过 ✓（聚焦应用查询 rc=0，pid={pid}），AX 服务可用"));
            CFRelease(app as *mut c_void);
        } else {
            debug_log(format!(
                "AX 自检：失败 ✗ rc={rc} —— TCC 已授权但 AX 服务拒绝。修复：系统设置取消勾选辅助功能里的终端 → 等 5 秒 → 重新勾选 → 重启应用"
            ));
        }

        let listen = CGPreflightListenEventAccess() != 0;
        if listen {
            debug_log("输入监控自检：通过 ✓（ListenEventAccess=true）");
        } else {
            debug_log(
                "输入监控自检：缺失 ✗ —— 事件 tap 将收不到其他应用的事件！修复：系统设置 → 隐私与安全性 → 输入监控 → 勾选运行 dev 的终端 → 重启应用",
            );
        }
        CFRelease(sys as *mut c_void);
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
                } else {
                    debug_log(format!(
                        "mouse-up：判定为选词（drag={drag_dist:.1}px double={is_double}），防抖 {debounce_ms}ms 后查询 AX"
                    ));
                    // 防抖：等应用完成选区更新
                    std::thread::sleep(Duration::from_millis(debounce_ms));
                    if let Some((text, pid)) = unsafe { ax_selected_text() } {
                        debug_log(format!("AX 捕获成功：pid={pid} len={}", text.len()));
                        // 重复抑制：同文本 + 坐标相近（< 4px）
                        let dup = last_emitted.as_ref().map_or(false, |(lt, lx, ly)| {
                            *lt == text
                                && ((lx - ev.x).powi(2) + (ly - ev.y).powi(2)).sqrt() < 4.0
                        });
                        if !dup {
                            let app = proc_path(pid).unwrap_or_default();
                            debug_log(format!("判定通过 → 交 worker：app={app}"));
                            let _ = tx.send(CaptureEvent::Selection {
                                text: text.clone(),
                                x: ev.x,
                                y: ev.y,
                                app,
                                pid,
                            });
                            last_emitted = Some((text, ev.x, ev.y));
                        } else {
                            debug_log("跳过：与上次捕获重复");
                        }
                    } else {
                        debug_log("AX 未取到选中文本（静默失败，无事件）");
                    }
                }
                last_up = Some((ev.t, ev.x, ev.y));
                down = None;
            }
            _ => {} // dragged 不单独处理，up 时按 down 起点统一计算
        }
    }
}

// ---------- AX 查询（docs/03 §3.3，不碰剪贴板） ----------

/// 查询聚焦应用的选中文本。返回 (文本, 应用 pid)；失败 = None（静默）。
unsafe fn ax_selected_text() -> Option<(String, i32)> {
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

        // 路径1（主）：聚焦元素级 SelectedText —— 多数应用的主路径
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
        CFRelease(app as *mut c_void);
    } else {
        debug_log(format!("AX: 获取聚焦应用失败 rc={rc_app}"));
    }
    CFRelease(sys as *mut c_void);
    out
}

/// 聚焦元素级 SelectedText
unsafe fn query_focused_element(app_el: AXUIElementRef, consts: &AxConsts) -> Option<String> {
    let mut focused: CFTypeRefC = std::ptr::null();
    let rc_focus = AXUIElementCopyAttributeValue(app_el, consts.focused_element, &mut focused);
    if rc_focus != 0 || focused.is_null() {
        debug_log(format!("AX: 聚焦元素不可达 rc_focus={rc_focus}"));
        return None;
    }
    let mut val: CFTypeRefC = std::ptr::null();
    let rc_sel = AXUIElementCopyAttributeValue(
        focused as AXUIElementRef,
        consts.selected_text,
        &mut val,
    );
    let text = if rc_sel == 0 {
        cf_type_to_string(val)
    } else {
        None
    };
    if text.is_none() {
        debug_log(format!("AX: 聚焦元素 SelectedText rc_sel={rc_sel}"));
    }
    CFRelease(focused as *mut c_void);
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
