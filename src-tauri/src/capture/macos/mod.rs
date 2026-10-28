//! macOS 划词捕获：CGEventTap（listen-only 鼠标监听）+ AX（选中文本查询）。
//! 双线程模型：tap 线程仅入队回调 → detect 线程做状态机/防抖/AX 查询（docs/03 §3.1–3.3）。
//! 安全边界：全程不读写剪贴板（兼容模式兜底路径见 compat.rs，快照自动还原）。
//! 子模块：ffi = FFI 绑定与常量；query = AX 查询链与证据闸；compat = ⌘C 兜底。
use std::os::raw::c_void;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::AppHandle;

use core_foundation::base::TCFType;
use core_foundation::boolean::CFBoolean;
use core_foundation::dictionary::CFDictionary;
use core_foundation::string::CFString;

use super::{capture_muted, debug_log, CaptureEvent};

mod compat;
mod ffi;
mod query;

pub use compat::force_fetch_via_copy;
pub use query::{request_screen_capture_access, screen_capture_access};
use ffi::*;
use query::{
    ax_selected_text, control_drag_gained_selection, drag_starts_on_control,
    focused_is_safari, focused_pid, frontmost_pid, in_finder_file_context, proc_path,
    running_bundle_id,
    safari_selected_text, selection_baseline,
};

// ---------- 诊断计数器 ----------
/// 最近一次拖选手势的矩形（全局坐标，左上原点，逻辑点）——截屏识别的「未识别
/// 到文字」自愈重截用：交互式 screencapture 在快速手势下可能截到遮罩淡出/
/// 页面动画未稳的过渡帧（整图发虚、Vision 返回空），此时按此矩形用
/// `screencapture -R`（无遮罩）延迟重截。任何 >6px 的左键拖选都记录，
/// 静音期间（截图模态会话）也记录——那正是它的主要服务对象
static LAST_SNIP_RECT: Mutex<Option<(Instant, (f64, f64, f64, f64))>> = Mutex::new(None);

/// 取最近拖选矩形（max_age 内有效）。x/y/w/h 全局逻辑点，左上原点
pub fn last_snip_rect(max_age: Duration) -> Option<(f64, f64, f64, f64)> {
    let guard = LAST_SNIP_RECT.lock().unwrap_or_else(|e| e.into_inner());
    let (t, r) = guard.as_ref()?;
    (t.elapsed() <= max_age).then_some(*r)
}

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
    /// 键盘事件的物理键码（鼠标事件恒为 0）
    keycode: u16,
    t: Instant,
}

static EVENT_TX: Mutex<Option<Sender<MouseEvent>>> = Mutex::new(None);

/// 回调层的按下点（回调在 tap 线程串行执行，Mutex 仅防编译器抱怨跨线程）：
/// 静音期间 mouse 事件在回调入口即被丢弃，detect 线程收不到——截图识别的
/// 自愈重截需要框选矩形，故在静音早退之前于此处成对记录按下/抬起
static SNIP_DOWN: Mutex<Option<(f64, f64)>> = Mutex::new(None);

extern "C" fn tap_callback(
    _proxy: CGEventTapProxy,
    kind: u32,
    ev: CGEventRef,
    _user: *mut c_void,
) -> CGEventRef {
    // 回调内只做计数 + 入队（绝不查询 AX）
    let is_key = kind == EV_KEY_DOWN;
    // 拖选矩形记录（须在静音早退之前——静音期间 mouse 事件到此为止）：
    // LeftDown 记起点，LeftUp 与起点距离 >6px 时成矩形写入 LAST_SNIP_RECT。
    // 这正是截图框选（capture_muted）的形态，也是自愈重截的数据来源
    if kind == EV_LEFT_DOWN || kind == EV_LEFT_UP {
        let p = unsafe { CGEventGetLocation(ev) };
        let mut down = SNIP_DOWN.lock().unwrap_or_else(|e| e.into_inner());
        if kind == EV_LEFT_DOWN {
            *down = Some((p.x, p.y));
        } else if let Some((dx, dy)) = down.take() {
            let (w, h) = ((p.x - dx).abs(), (p.y - dy).abs());
            if w * w + h * h > 36.0 {
                let rect = (dx.min(p.x), dy.min(p.y), w, h);
                *LAST_SNIP_RECT.lock().unwrap_or_else(|e| e.into_inner()) =
                    Some((Instant::now(), rect));
            }
        }
    }
    // 截图取词等系统交互期间静音：screencapture 的框选拖选会被误判为划词。
    // 只静音鼠标事件——Esc 收起浮动条不该被截图模态吞掉
    if !is_key && capture_muted() {
        return ev;
    }
    // 键盘通道只放行 Esc 按下（且排除长按自动重复）：其余按键即刻丢弃，
    // 不读内容、不入队、不落盘——监听范围与隐私边界都止于这一个键码
    let keycode = if is_key {
        let code = unsafe { CGEventGetIntegerValueField(ev, 9) } as u16;
        if code != KEY_ESC || unsafe { CGEventGetIntegerValueField(ev, 8) } != 0 {
            return ev;
        }
        code
    } else {
        0
    };
    // MouseMoved 高频（~125Hz），仅在悬浮胶囊可见（hover 合成需要）时入队，
    // 其余时刻直接丢弃——避免淹没事件通道
    if kind == EV_MOUSE_MOVED && !crate::floating::hover_feed_active() {
        return ev;
    }
    if !is_key {
        LAST_EVENT_MS.store(now_ms(), Ordering::Relaxed);
        if !FIRST_EVENT.swap(true, Ordering::Relaxed) {
            debug_log("✓ 收到首个鼠标事件，tap 工作正常");
        }
    }
    if let Some(tx) = EVENT_TX.lock().ok().and_then(|g| g.clone()) {
        let (x, y) = if is_key {
            (0.0, 0.0)
        } else {
            let p = unsafe { CGEventGetLocation(ev) };
            (p.x, p.y)
        };
        let _ = tx.send(MouseEvent { kind, x, y, keycode, t: Instant::now() });
    }
    ev
}

// ---------- 对外接口 ----------

pub fn start(app: &AppHandle, tx: Sender<CaptureEvent>, debounce_ms: u64) {
    let (raw_tx, raw_rx) = channel::<MouseEvent>();
    if let Ok(mut g) = EVENT_TX.lock() {
        *g = Some(raw_tx);
    }
    std::thread::Builder::new()
        .name("capture-tap".into())
        .spawn(tap_thread)
        .expect("spawn capture-tap thread");
    let detect_app = app.clone();
    std::thread::Builder::new()
        .name("capture-detect".into())
        .spawn(move || detect_loop(&detect_app, raw_rx, tx, debounce_ms))
        .expect("spawn capture-detect thread");
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

/// 能力位：macOS 捕获后端真实可用
pub fn capture_available() -> bool {
    true
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

/// tap 死活观测：靠 tap_thread 内的「3 分钟无事件预防性重建」兜底，
/// 早期的心跳打印线程（每 15s 一条）已移除——诊断价值低且刷屏

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

/// MouseMoved 常驻纳入：悬浮胶囊可见时，全局鼠标位置经此喂给前端合成 hover
/// （非 key 窗口收不到 mouseMoved，WebKit 又只给"活动"页面渲染 :hover——
/// 本 tap 是唯一可靠的全局鼠标源）。诊断开关 SHICI_ALL_EVENTS 保留兼容
fn tap_mask() -> u64 {
    let mut m =
        (1u64 << EV_LEFT_DOWN) | (1u64 << EV_LEFT_UP) | (1u64 << EV_LEFT_DRAGGED) | (1u64 << EV_KEY_DOWN);
    if std::env::var("SHICI_ALL_EVENTS").as_deref() == Ok("1") {
        m |= 1u64 << 5; // kCGEventMouseMoved
    }
    m | (1u64 << EV_MOUSE_MOVED)
}

/// 选词判定状态机（docs/03 §3.2）：拖选 > 6px 或双击 → 非文本表面闸 → 防抖 →
/// AX 查询（应答证据闸见各查询函数）；普通单击 → PlainClick；
/// Finder 文件交互（拖动/双击，聚焦元素非文本框）在一切 AX 查询前排除
fn detect_loop(app: &AppHandle, rx: Receiver<MouseEvent>, tx: Sender<CaptureEvent>, debounce_ms: u64) {
    let mut down: Option<(f64, f64)> = None;
    // 按下时刻的选区基线（容器级应答的差分证据，见 query_focused_element）；
    // 每次 down 覆盖，up 消费，天然按单次手势隔离
    let mut down_baseline: Option<(i32, String)> = None;
    let mut last_up: Option<(Instant, f64, f64)> = None;
    let mut last_emitted: Option<(String, f64, f64)> = None;
    let mut last_hover: Option<Instant> = None;

    while let Ok(ev) = rx.recv() {
        match ev.kind {
            EV_MOUSE_MOVED => {
                // 悬浮胶囊可见时，把全局鼠标位置喂给前端合成 hover：
                // 非 key 窗口收不到 mouseMoved，WebKit 又只给"活动"页面渲染 :hover，
                // 本 tap 是唯一可靠的全局鼠标源。节流 ~60Hz，丢弃陈旧事件
                if crate::floating::hover_feed_active() {
                    let now = Instant::now();
                    if last_hover
                        .map_or(true, |t: Instant| now.duration_since(t) >= Duration::from_millis(16))
                        && ev.t.elapsed() <= Duration::from_millis(50)
                    {
                        last_hover = Some(now);
                        let _ = tx.send(CaptureEvent::HoverMove { x: ev.x, y: ev.y });
                    }
                }
            }
            EV_KEY_DOWN => {
                // 回调已过滤：能到这里必然是 Esc 按下。是否真的收起由 worker 的
                // 可见性判定 + 前端 dismiss 守卫（钉住/流式中忽略）决定
                if ev.keycode == KEY_ESC {
                    debug_log("key-down：Esc");
                    let _ = tx.send(CaptureEvent::Escape);
                }
            }
            EV_LEFT_DOWN => {
                down = Some((ev.x, ev.y));
                // 容器差分基线：静音期间不读（截图框选等模态交互期间不做任何 AX 查询）
                down_baseline = if capture_muted() { None } else { selection_baseline() };
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
                    // 普通单击：走 dismiss 判定（无日志——高频操作，打印即刷屏）。
                    // 注意：不带 pid——worker 只用浮动条矩形判定，若填自身 pid 会被过滤导致 dismiss 永不触发
                    let _ = tx.send(CaptureEvent::PlainClick { x: ev.x, y: ev.y });
                } else if capture_muted() {
                    // 截图取词等系统交互期间的拖选：跳过判定与 AX 查询（防止在
                    // 截图模态会话里触发 AX 异常导致进程 abort）
                    debug_log("mouse-up：静音期间忽略拖选");
                } else if focused_pid() == Some(std::process::id() as i32) {
                    // 选区发生在自身窗口（主窗/结果窗等 webview）：必须先于一切 AX 查询排除。
                    // 聚焦应用是自己时，任何 AX 下探都会走进 WKWebView 的辅助功能树，
                    // 而该路径 WebKit 仅限主线程调用，后台线程一碰即被主动 abort
                    // （EXC_BREAKPOINT，crashDueToApplicationCallingMainThreadOnlyWebKitAPIFromBackgroundThread）。
                    // worker 层的「自身进程」过滤在查询之后，救不了已发出的查询
                    debug_log("mouse-up：选区在自身窗口内，跳过取词");
                } else if down.map_or(false, |(dx, dy)| drag_starts_on_control(dx, dy))
                    && !control_drag_gained_selection(&down_baseline)
                {
                    // 拖拽起点在非文本表面上（控件/可选中元素）：滚动、调参、拖放、
                    // 换位等手势，非选词——整链跳过，不再付轻推+查询的成本。
                    // 例外＝差分应答放行（control_drag_gained_selection）：起点在
                    // 控件上但手势真的拉出了新选区（网页表格内拖选/双击），
                    // 落入下方正常防抖+查询链路（AX 查询的应答证据闸再复核）
                    debug_log("mouse-up：拖拽起点是非文本表面（控件/可选中元素），跳过");
                } else if in_finder_file_context() {
                    // Finder 文件交互（拖动移动 / 双击打开）形态上与拖选/双击选词完全一致，
                    // 但放行会经兼容模式 ⌘C 把文件名误捕为划词（见该函数注释）
                    debug_log("mouse-up：Finder 文件交互，非选词，跳过");
                } else {
                    // 自适应防抖：拖选的选区随拖动实时更新，松手即最终态，短等即可；
                    // 双击/三击的选区是松手后应用计算的，需给足处理时间（沿用 debounce_ms 档，
                    // 用户可配）。拖选档 30ms 只吸收事件分发抖动，不覆盖应用的慢响应
                    let wait_ms = if is_double { debounce_ms } else { 30 };
                    debug_log(format!(
                        "mouse-up：判定为选词（drag={drag_dist:.1}px double={is_double}），防抖 {wait_ms}ms 后查询 AX"
                    ));
                    // ⏱ 计时基线：松手判定完成，后续各段耗时都相对此刻
                    let t_up = Instant::now();
                    // 防抖：等应用完成选区更新
                    std::thread::sleep(Duration::from_millis(wait_ms));
                    // 按下点供应答锚定（拖选必从选中文本内部开始；起点记录在 down）
                    let (down_x, down_y) = down.unwrap_or((ev.x, ev.y));
                    if let Some((text, pid)) = unsafe {
                        ax_selected_text(app, (down_x, down_y), (ev.x, ev.y), &down_baseline)
                    } {
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
                        } else if let Some((text, pid)) = force_fetch_via_copy(app) {
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
                    } else if let Some((text, pid)) = force_fetch_via_copy(app) {
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
                    debug_log(format!(
                        "⏱ 划词链路（松手→发事件）：{}ms（其中防抖 {wait_ms}ms；AX 内部分段见上方日志）",
                        t_up.elapsed().as_millis()
                    ));
                }
                last_up = Some((ev.t, ev.x, ev.y));
                down = None;
            }
            _ => {} // dragged 不单独处理，up 时按 down 起点统一计算
        }
    }
}

// ---------- AX 查询（docs/03 §3.3，默认不碰剪贴板） ----------

/// 重复抑制 + 转发（AX / 兼容模式 / Safari AppleScript 共用）
fn forward_selection(
    tx: &Sender<CaptureEvent>,
    last_emitted: &mut Option<(String, f64, f64)>,
    text: String,
    pid: i32,
    x: f64,
    y: f64,
    source: &str,
) {
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
    // 临时诊断（2026-10-24，验证码误触发排查）：换行显式化（⏎）+ 前 80 字符——
    // 定位后移除
    let vis = |c: char| if c == '\n' { '⏎' } else { c };
    let preview: String = text.chars().take(80).map(vis).collect();
    debug_log(format!(
        "{source}：pid={pid} len={} app={app} bid={bid} text=「{preview}」",
        text.len()
    ));
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
