//! Windows 划词捕获后端（docs/03 §A.7 预设的落地）：
//! `SetWindowsHookEx(WH_MOUSE_LL/WH_KEYBOARD_LL)` 低级钩子（系统提供的能力，
//! 与 macOS CGEventTap 对位）+ UI Automation 选区查询（uiautomation-rs，
//! 成熟开源封装）→ 高层 CaptureEvent，与 macOS 后端同一 `start` 签名接入。
//!
//! 线程模型（低级钩子回调卡顿会拖慢全系统鼠标，因此回调绝不做重活）：
//!   钩子线程：安装钩子 + 消息泵；回调只把原始事件投进 channel
//!   detect 线程：手势识别（拖选阈值/双击）+ UIA 查询 + 闸门 → tx → spawn_worker
//!   （所有事件都经 worker 统一过滤转发，平台后端不做 worker 层的事）
//!
//! 闸门（docs/03 A.3.3 的 Windows 对位，v1）：
//!   - 静音闸门：CaptureMuteGuard 期间全量丢弃（截屏等模态操作）
//!   - 自身闸门：目标进程 = 本进程，或点位根 HWND 属本进程（WebView2 内容
//!     挂在 msedgewebview2.exe 名下，pid 闸会漏掉自家面板文字的自捕获）→ 跳过
//!   - 起点分类（第一道防线，看按下点而非抬起点）：滚动条/按钮/标签页/
//!     文件树行/菜单等手势同形表面按下的拖动是成型的其他手势，直接拒绝——
//!     这些表面的文本祖先可能带着遗留选区，放行即替从未发生的手势背书。
//!     按下点之外的父亲/容器（如网页外壳的 Tab）不连坐，否则正常划选被误拒。
//!     名单刻意不含 DataItem/ListItem：网页表格行/聊天消息叶子的拖选起点
//!     常是这两类（Chromium UIA 映射），收进去会大面积误杀正文划选——
//!     macOS 侧因此连坐过网页表格（AXRow 在名单里，2026-10-21 已用差分
//!     例外修复，见 macos.rs::control_drag_gained_selection 与 docs/03 A.3.2）
//!   - 应答证据（唯一放行条件）：沿抬起点父链（≤40 层，Chromium 系树很深）
//!     找 TextPattern 非空选区——聊天消息/网页正文的选区常挂在起点上层的
//!     文档节点，起点本身往往是 ListItem/Group 叶子；选区为空 = 手势未发生
//!     → 按普通点击处理。父链无证据时再查焦点元素父链兜底（仅当焦点与
//!     终点同进程，避免跨进程的陈旧选区背书）。ControlView 断链处用 RawView
//!     续走：跨 provider 边界（自绘容器/宿主窗格）ControlView 常在此报错，
//!     断链即弃会把本可命中的选区误判成「没有」
//!   （锚定/差分证据为 v2；遇到新误报场景优先扩展表面分类。若某场景必须
//!     把行项角色收进名单又不能误杀其内文本，macOS 的差分例外是现成模板）
//!
//! 兼容模式（ADR-05 的 Windows 对位，`compat_fetch`）：**按应用授权，默认绝不发按键**。
//! macOS 侧兼容模式常开，这里刻意不同——Windows 上无法探测目标应用当前处于什么
//! 状态，而 Ctrl+C 在终端类界面里是「中断正在运行的进程」的杀伤性信号。三条闸缺一不可：
//!   1. 两条父链都报「TextPattern 层数 = 0」——只有根本不暴露文本接口的应用才借用
//!      复制；暴露了接口却取到空选区 = 手势没发生，不发按键（否则就是把误报换成
//!      对他人剪贴板和焦点应用的干扰）
//!   2. 该应用命中 `settings.compat_apps` 允许清单（划词页逐应用添加）
//!   3. 剪贴板当前是文件/图片时整段跳过——还原只写得回文本，会把用户刚复制的
//!      文件或截图换成一段字
//! 键序：主键 Ctrl+Insert（终端里不是中断信号，闸 1+2 都过了也别去碰用户正在跑的
//! 进程），不认该键的应用才用 Ctrl+C 兜底。残余风险因此收窄到「主键无绑定 + 此刻
//! 终端里有前台进程」这一种叠加情形。
//! 还原竞态规则与 macOS 同一套（拿完重读现状，只在「现状仍是我取到的文本」时物归
//! 原主，否则保留现状不动）。
//!
//! 已知边界：Electron/自绘控件的 ControlType 可能是 Custom → 无 TextPattern 即拒
//! （精度优先，与 detect_places 同取向），走上面的兼容模式兜底；提权应用受 UIPI
//! 屏障读不到（兼容模式同样打不进去，非提权进程按不了键）。
//! 自绘应用能走到哪一步是可测的：Zed（Windows 版）实测整棵 UIA 树只有顶层
//! Window 一个节点（ControlView/RawView 都无子元素、无 TextPattern、无
//! LegacyIAccessible）——这类应用走链与兜底焦点都无解，只有兼容模式能取到词。
//! 漏捕归因数据（层数/文本模式层数/停因）随 miss 日志落 magpie.log，见
//! `WalkReport`。

use std::collections::HashMap;
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::AppHandle;
use uiautomation::types::ControlType;
use windows::Win32::Foundation::{LPARAM, LRESULT, POINT, WPARAM};
use windows::Win32::Graphics::Gdi::{MonitorFromPoint, MONITOR_DEFAULTTONEAREST};
use windows::Win32::System::DataExchange::IsClipboardFormatAvailable;
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Ole::{CF_DIB, CF_DIBV5, CF_HDROP};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetDoubleClickTime, KEYBD_EVENT_FLAGS, KEYBDINPUT, KEYEVENTF_KEYUP, SendInput, VK_C,
    VK_CONTROL, VK_ESCAPE, VK_INSERT, VIRTUAL_KEY, INPUT_0, INPUT_KEYBOARD, INPUT,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, GetAncestor, GetMessageW, GetWindowThreadProcessId, SetWindowsHookExW,
    WindowFromPoint, GA_ROOT, KBDLLHOOKSTRUCT, MSLLHOOKSTRUCT, WH_KEYBOARD_LL, WH_MOUSE_LL,
    WM_KEYDOWN, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MOUSEMOVE, WM_SYSKEYDOWN,
};

use super::{debug_log, CaptureEvent};

/// 能力位：捕获后端已启用（前端「划词/黑名单」导航据此显示）
pub fn capture_available() -> bool {
    true
}

/// Windows 无 TCC 辅助功能开关；UIA 可用性由 COM 初始化决定，探针恒真
pub fn is_accessibility_granted() -> bool {
    true
}

pub fn ax_service_probe() -> bool {
    true
}

/// Windows 无「输入监控」权限；低级钩子无需授权
pub fn listen_event_access() -> bool {
    true
}

/// Windows 无屏幕录制权限体系；OCR 截屏无门槛
pub fn screen_capture_access() -> bool {
    true
}

/// 无对应设置页可打开（无权限体系）
pub fn open_accessibility_settings() {}

pub fn prompt_accessibility() -> bool {
    true
}

// ---------- 钩子线程 → detect 线程的原始事件 ----------

enum RawEvent {
    /// (消息, 物理x, 物理y, 钩子时间戳ms)
    Mouse(u32, i32, i32, u32),
    /// (vkCode, 是否按下)
    Key(u32, bool),
}

static RAW_TX: Mutex<Option<Sender<RawEvent>>> = Mutex::new(None);

extern "system" fn mouse_proc(n_code: i32, w: WPARAM, l: LPARAM) -> LRESULT {
    if n_code >= 0 {
        let info = unsafe { &*(l.0 as *const MSLLHOOKSTRUCT) };
        let msg = w.0 as u32;
        if matches!(msg, WM_MOUSEMOVE | WM_LBUTTONDOWN | WM_LBUTTONUP) {
            if let Ok(guard) = RAW_TX.lock() {
                if let Some(tx) = guard.as_ref() {
                    let _ = tx.send(RawEvent::Mouse(msg, info.pt.x, info.pt.y, info.time));
                }
            }
        }
    }
    unsafe { CallNextHookEx(None, n_code, w, l) }
}

extern "system" fn key_proc(n_code: i32, w: WPARAM, l: LPARAM) -> LRESULT {
    if n_code >= 0 {
        let info = unsafe { &*(l.0 as *const KBDLLHOOKSTRUCT) };
        let down = w.0 as u32 == WM_KEYDOWN || w.0 as u32 == WM_SYSKEYDOWN;
        if info.vkCode == VK_ESCAPE.0 as u32 {
            if let Ok(guard) = RAW_TX.lock() {
                if let Some(tx) = guard.as_ref() {
                    let _ = tx.send(RawEvent::Key(info.vkCode, down));
                }
            }
        }
    }
    unsafe { CallNextHookEx(None, n_code, w, l) }
}

// ---------- 入口：起钩子线程 + detect 线程 ----------

pub fn start(app: &AppHandle, tx: Sender<CaptureEvent>, _debounce_ms: u64) {
    let (raw_tx, raw_rx) = channel::<RawEvent>();
    *RAW_TX.lock().unwrap() = Some(raw_tx);

    // 钩子线程：低级钩子要求常驻消息泵；回调只投递事件，绝不做查询
    std::thread::Builder::new()
        .name("capture-hook".into())
        .spawn(move || unsafe {
            let hmod = match GetModuleHandleW(None) {
                Ok(m) => m.into(),
                Err(e) => {
                    debug_log(format!("capture/windows: GetModuleHandleW 失败 {e}"));
                    return;
                }
            };
                if SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_proc), Some(hmod), 0).is_err() {
                    debug_log("capture/windows: 鼠标钩子安装失败");
                    return;
                }
                if SetWindowsHookExW(WH_KEYBOARD_LL, Some(key_proc), Some(hmod), 0).is_err() {
                    debug_log("capture/windows: 键盘钩子安装失败");
                    return;
                }
            debug_log("capture/windows: 钩子已安装");
            let mut msg = windows::Win32::UI::WindowsAndMessaging::MSG::default();
            while GetMessageW(&mut msg, None, 0, 0).as_bool() {}
        })
        .expect("capture/windows: 钩子线程启动失败");

    // detect 线程：手势状态机 + UIA 查询（COM 在本线程初始化并独占使用）
    let app = app.clone();
    std::thread::Builder::new()
        .name("capture-detect".into())
        .spawn(move || detect_loop(&app, tx, raw_rx))
        .expect("capture/windows: detect 线程启动失败");

    debug_log("capture/windows: 捕获后端已启用（WH_MOUSE_LL + UIA）");
}

// ---------- detect 线程：手势状态机 + 闸门 + UIA 查询 ----------

#[derive(Clone, Copy, PartialEq)]
enum Gesture {
    /// 拖选（位移超阈值）
    Drag,
    /// 双击选词
    DoubleClick,
}

struct DownState {
    /// 物理坐标
    start: (i32, i32),
    /// 按下点在浮动条上：本次拖动是搬移浮动条而非划词
    bar_drag: bool,
    /// 双击的第二次按下（抬起时按选词手势处理）
    double_pending: bool,
}

fn detect_loop(app: &AppHandle, tx: Sender<CaptureEvent>, rx: Receiver<RawEvent>) {
    let aut = match uiautomation::core::UIAutomation::new() {
        Ok(a) => a,
        Err(e) => {
            debug_log(format!("capture/windows: UIA 初始化失败 {e}"));
            return;
        }
    };
    let my_pid = std::process::id();
    let double_click_ms = unsafe { GetDoubleClickTime() };
    let mut down: Option<DownState> = None;
    let mut last_click: Option<(u32, i32, i32)> = None; // (时间, 物理x, 物理y)
    let mut last_move_sent: u32 = 0;

    while let Ok(ev) = rx.recv() {
        // 静音闸门：模态操作（截屏框选等）期间鼠标事件不入队（AGENTS.md 纪律）
        if super::capture_muted() {
            down = None;
            continue;
        }
        match ev {
            RawEvent::Mouse(msg, px, py, time) => match msg {
                WM_LBUTTONDOWN => {
                    let (lx, ly) = to_logical(px, py);
                    // 拖拽起点只认胶囊卡：二级浮层是独立窗口（分离卡），
                    // 在面板/菜单上按住拖动不是搬移胶囊
                    let bar_drag = crate::floating::capsule_rect_contains(app, lx, ly, 4.0);
                    let double_pending = !bar_drag
                        && last_click
                            .map(|(t, x, y)| {
                                let dist = ((px - x).abs() + (py - y).abs()) as f64;
                                time.wrapping_sub(t) <= double_click_ms && dist < 12.0
                            })
                            .unwrap_or(false);
                    last_click = Some((time, px, py));
                    down = Some(DownState { start: (px, py), bar_drag, double_pending });
                }
                WM_MOUSEMOVE => {
                    let Some(d) = down.as_ref() else {
                        // 无按键移动：浮动条/结果窗可见时转发 hover（合成 :hover）
                        if time.saturating_sub(last_move_sent) > 60
                            && (crate::floating::is_visible(app)
                                || crate::floating::ocr_visible(app))
                        {
                            last_move_sent = time;
                            let (lx, ly) = to_logical(px, py);
                            let _ = tx.send(CaptureEvent::HoverMove { x: lx, y: ly });
                        }
                        continue;
                    };
                    if d.bar_drag
                        && time.saturating_sub(last_move_sent) > 16
                        && ((px - d.start.0).abs() + (py - d.start.1).abs()) > 0
                    {
                        last_move_sent = time;
                        let (lx, ly) = to_logical(px, py);
                        let _ = tx.send(CaptureEvent::DragMove { x: lx, y: ly });
                    }
                }
                WM_LBUTTONUP => {
                    let Some(d) = down.take() else { continue };
                    if d.bar_drag {
                        let _ = tx.send(CaptureEvent::DragEnd);
                        continue;
                    }
                    let moved = ((px - d.start.0).abs() + (py - d.start.1).abs()) as f64 > 8.0;
                    let gesture = if d.double_pending {
                        Gesture::DoubleClick
                    } else if moved {
                        Gesture::Drag
                    } else {
                        // 未构成手势：普通点击 → worker 走 dismiss 判定
                        let (lx, ly) = to_logical(px, py);
                        let _ = tx.send(CaptureEvent::PlainClick { x: lx, y: ly });
                        continue;
                    };
                    // 按下点（手势起点）与抬起点都传给闸门：同形表面看起点，
                    // 选区证据沿终点父链找
                    query_selection(
                        app,
                        &aut,
                        tx.clone(),
                        my_pid,
                        d.start.0,
                        d.start.1,
                        px,
                        py,
                        gesture,
                    );
                }
                _ => {}
            },
            RawEvent::Key(vk, is_down) => {
                if is_down && vk == VK_ESCAPE.0 as u32 {
                    let _ = tx.send(CaptureEvent::Escape);
                }
            }
        }
    }
}

/// 手势完成 → UIA 查询选区 + 闸门 → Selection / PlainClick。
/// 同步执行在 detect 线程（查询耗时 10-50ms 级，鼠标已抬起，不阻塞钩子；
/// 兼容模式命中时另加最多 ~600ms，那已是抬起之后，用户只感觉胶囊晚一点出）。
/// (dpx,dpy) = 按下点、(upx,upy) = 抬起点（物理坐标）：手势同形判定看按下点
/// （拖动从哪里开始就是什么手势），选区证据沿抬起点父链找
#[allow(clippy::too_many_arguments)]
fn query_selection(
    app: &AppHandle,
    aut: &uiautomation::core::UIAutomation,
    tx: Sender<CaptureEvent>,
    my_pid: u32,
    dpx: i32,
    dpy: i32,
    upx: i32,
    upy: i32,
    gesture: Gesture,
) {
    let queried = (|| -> Option<(String, u32)> {
        // 第一道：起点分类。滚动条/标签页/文件树行等表面按下的拖动是成型的
        // 其他手势，从这里拒绝（含自身闸门）。不看抬起点链上的祖先——它们
        // 只是内容外层的容器（如网页外壳的 Tab），连坐会把正常的聊天/网页
        // 划选一起拒掉（实测漏捕主因之一）
        if is_own_window_at(dpx, dpy, my_pid) {
            return None; // 自身闸门（起点）
        }
        if let Ok(start) = aut.element_from_point(uiautomation::types::Point::new(dpx, dpy)) {
            if start.get_process_id().unwrap_or(0) == my_pid {
                return None;
            }
            if let Ok(ct) = start.get_control_type() {
                if is_control_surface(ct) {
                    let s_pid = start.get_process_id().unwrap_or(0);
                    let s_app = process_path(s_pid).unwrap_or_default();
                    debug_log(format!(
                        "capture/windows: 起点为手势同形表面（{ct:?}），跳过 pid={s_pid} app={s_app:?}"
                    ));
                    return None;
                }
            }
        }

        // 自身闸门（终点）：WebView2 内容报运行时进程的 pid，按根 HWND 判归属
        // ——Magpie 自家界面的 UIA 元素挂在 msedgewebview2.exe 名下，pid 闸拦不住
        if is_own_window_at(upx, upy, my_pid) {
            return None;
        }
        let up_el = aut
            .element_from_point(uiautomation::types::Point::new(upx, upy))
            .ok()?;
        let up_pid = up_el.get_process_id().unwrap_or(0);
        if up_pid == 0 || up_pid == my_pid {
            return None;
        }

        // 第二道：应答证据（唯一放行条件）——沿终点父链找 TextPattern 非空选区；
        // 选区为空 = 手势未发生
        let (hit, point_walk) = walk_text_selection(aut, &up_el);
        if let Some(text) = hit {
            return Some((text, up_pid));
        }

        // 焦点元素父链兜底：部分 Electron/自绘应用的可编辑宿主不挂在点位链
        // 上，而选区挂在焦点元素一侧。仅当焦点与终点同进程时采信（跨进程的
        // 焦点选区与本手势无关，不做陈旧背书）
        let mut focus_walk = WalkReport::default();
        if let Ok(focused) = aut.get_focused_element() {
            if focused.get_process_id().unwrap_or(0) == up_pid {
                let (hit, report) = walk_text_selection(aut, &focused);
                if let Some(text) = hit {
                    return Some((text, up_pid));
                }
                focus_walk = report;
            }
        }

        let app_path = process_path(up_pid).unwrap_or_default();

        // 兼容模式（ADR-05 的 Windows 对位，按应用授权）：只在两条父链都没有任何
        // TextPattern 层时才借用一次复制——那是「应用根本不暴露文本接口」，走链
        // 无解；「有接口但这次没选区」是手势未发生，发按键就是把误报换成对他人
        // 剪贴板与焦点应用的干扰。三闸与竞态规则见模块头
        if point_walk.text_levels == 0 && focus_walk.text_levels == 0 {
            let s = crate::settings::current(app);
            // 用户明确禁用的应用同样不发按键：黑名单的原意是「别在我这儿划词」，
            // 借用复制也算打扰
            let permitted = crate::settings::compat_allows(&s, &app_path)
                && !crate::settings::is_blacklisted(app, &app_path, None);
            if permitted {
                if let Some(text) = compat_fetch(&app_path) {
                    return Some((text, up_pid));
                }
            } else {
                // 名单没覆盖到 = 用户还不知道这里有道开关可开
                hint_compat_unavailable(app, &app_path);
            }
        }

        // 漏捕必须可按原因归因（三种原因的修法完全不同）：应用不暴露文本模式
        // （走链无解，只有兼容模式）／暴露了但这次没有选区（拒绝是正确的）／
        // 走链没够到文档节点（放宽层数或换 walker 才对）
        debug_log(format!(
            "capture/windows: 无 TextPattern 选区证据，跳过 pid={up_pid} app={app_path:?} 终点={:?} 点位链[{}] 焦点链[{}]",
            up_el.get_control_type().ok(),
            point_walk.brief(),
            focus_walk.brief(),
        ));
        None
    })();
    let Some((text, pid)) = queried else {
        // 无选区/被闸门拒绝：若确有拖选位移，按普通点击兜底（dismiss 语义）
        if gesture == Gesture::Drag {
            let (lx, ly) = to_logical(upx, upy);
            let _ = tx.send(CaptureEvent::PlainClick { x: lx, y: ly });
        }
        return;
    };

    let (lx, ly) = to_logical(upx, upy);
    let app_path = process_path(pid).unwrap_or_default();
    debug_log(format!(
        "capture/windows: Selection len={} pid={pid} app={app_path:?}",
        text.len()
    ));
    let _ = tx.send(CaptureEvent::Selection {
        text,
        x: lx,
        y: ly,
        app: app_path,
        bid: String::new(), // Windows 无 bundle id，黑名单走进程路径匹配
        pid: pid as i32,
    });
}

/// 父链查找的归因数据（漏捕排查用，随 miss 日志落 magpie.log）：光知道「没取到」
/// 无法决定改哪里——层数说明树有多深、文本模式层数说明应用暴露了什么接口、
/// 停因说明是链走尽了还是撞了上限。
#[derive(Default)]
struct WalkReport {
    /// 这条链是否真的走过（焦点链会因跨进程或取不到焦点而不走）
    tried: bool,
    /// 实际检查过的层数
    levels: usize,
    /// 其中支持 TextPattern 的层数：0 = 该应用根本不暴露文本模式，走链再深也无解
    text_levels: usize,
    /// 停在哪
    end: WalkEnd,
}

#[derive(Default)]
enum WalkEnd {
    /// 走到没有更多父级（链尽）
    #[default]
    Root,
    /// 撞到层数上限，提前收手（树可能更深，文档节点还没看到）
    Cap,
}

impl WalkReport {
    fn brief(&self) -> String {
        if !self.tried {
            return "未走".into();
        }
        let end = match self.end {
            WalkEnd::Root => "到顶",
            WalkEnd::Cap => "触上限",
        };
        format!("层{} 文本模式层{} {}", self.levels, self.text_levels, end)
    }
}

/// 父链查找层数上限：Chromium 系文档节点离叶子可达十几层（实测点位链在 7 层
/// 命中 Document），24 层是给它的余量；自绘/宿主嵌套的树更深，放宽到 40——
/// 每层只是一次 TextPattern 查询，走尽整链的成本在 ms 级
const WALK_MAX_LEVELS: usize = 40;

/// 从起点沿父链找 TextPattern 非空选区，命中即返回；同时带回归因数据。
/// ControlView 断链处改用 RawView 续走：跨 provider 边界（自绘容器、宿主窗格）
/// ControlView 常在此报错，整链即弃会把本可命中的选区误判成「没有」
fn walk_text_selection(
    aut: &uiautomation::core::UIAutomation,
    start: &uiautomation::UIElement,
) -> (Option<String>, WalkReport) {
    let control = aut.get_control_view_walker().ok();
    let raw = aut.get_raw_view_walker().ok();
    let mut report = WalkReport {
        tried: true,
        ..Default::default()
    };
    let mut cursor = start.clone();
    for i in 0..WALK_MAX_LEVELS {
        report.levels = i + 1;
        match probe_text_selection(&cursor) {
            Probe::Hit(text) => return (Some(text), report),
            Probe::NoSelection => report.text_levels += 1,
            Probe::NoPattern => {}
        }
        let parent = control
            .as_ref()
            .and_then(|w| w.get_parent(&cursor).ok())
            .or_else(|| raw.as_ref().and_then(|w| w.get_parent(&cursor).ok()));
        match parent {
            Some(p) => cursor = p,
            None => return (None, report),
        }
    }
    report.end = WalkEnd::Cap;
    (None, report)
}

/// 单层元素的 TextPattern 证据。三态而非 Option：「没有文本模式」（应用能力
/// 缺失）与「有模式但当前无选区」（手势未发生，拒绝是正确的）必须分开计数
enum Probe {
    Hit(String),
    NoSelection,
    NoPattern,
}

fn probe_text_selection(el: &uiautomation::UIElement) -> Probe {
    let Ok(pattern) = el.get_pattern::<uiautomation::patterns::UITextPattern>() else {
        return Probe::NoPattern;
    };
    let text = pattern
        .get_selection()
        .ok()
        .and_then(|ranges| ranges.into_iter().next())
        .and_then(|r| r.get_text(-1).ok())
        .filter(|t| !t.trim().is_empty());
    match text {
        Some(t) => Probe::Hit(t),
        None => Probe::NoSelection,
    }
}

// ---------- 兼容模式：借用一次复制（按应用授权，三闸与键序见模块头） ----------

/// 剪贴板当前装着文件或图片（不是纯文本）。这类内容还原不回来——文本写得回，
/// 文件组与位图写不回，还原等于把用户刚复制的文件/截图换成一段字。命中即整段
/// 跳过兼容模式：宁可不出胶囊，也不动别人的剪贴板。
fn clipboard_holds_rich_payload() -> bool {
    unsafe {
        [CF_HDROP.0, CF_DIB.0, CF_DIBV5.0]
            .into_iter()
            .any(|f| IsClipboardFormatAvailable(f as u32).is_ok())
    }
}

/// 兼容取词用的两根复制键。主键选 Ctrl+Insert 而不是 Ctrl+C：它在终端类界面里
/// 不是中断信号，本功能最痛的那条残余风险（打断用户正在跑的进程）因此基本走不到。
/// 覆盖率是它的代价，所以保留 Ctrl+C 兜底——实测 Zed / 终端 / Chrome / VS Code
/// 四家主键都命中（2026-11-19 用户探针），兜底只在主键不认的应用里发生。
#[derive(Clone, Copy)]
enum Chord {
    CtrlInsert,
    CtrlC,
}

/// 向当前焦点应用投递一次复制键。SendInput 走硬件注入层，目标应用分辨不出它
/// 与真按键的差别——也正因为如此，Ctrl+C 在终端类界面里会真的中断正在运行的进程。
/// 返回 false = 按键被更高权限的输入块挡住（UIPI），静默失败。
///
/// 与 macOS 不同，这里不必绕主线程：Windows 剪贴板是系统级句柄，arboard 每次
/// 调用自开自闭，detect 线程直接读写没有 AppKit 那种 promise 兑现约束。
fn post_chord(chord: Chord) -> bool {
    const KEYEVENTF_EXTENDEDKEY: u32 = 1;
    unsafe {
        let key = |vk: VIRTUAL_KEY, up: bool, extended: bool| {
            let mut flags = 0u32;
            if up {
                flags |= KEYEVENTF_KEYUP.0;
            }
            if extended {
                flags |= KEYEVENTF_EXTENDEDKEY;
            }
            INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: vk,
                        wScan: 0,
                        dwFlags: KEYBD_EVENT_FLAGS(flags),
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            }
        };
        // Insert 是扩展键：不带 KEYEVENTF_EXTENDEDKEY 时部分应用收到的是「无绑定」
        let inputs = match chord {
            Chord::CtrlInsert => [
                key(VK_CONTROL, false, false),
                key(VK_INSERT, false, true),
                key(VK_INSERT, true, true),
                key(VK_CONTROL, true, false),
            ],
            Chord::CtrlC => [
                key(VK_CONTROL, false, false),
                key(VK_C, false, false),
                key(VK_C, true, false),
                key(VK_CONTROL, true, false),
            ],
        };
        if SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) == 0 {
            debug_log("capture/windows: 兼容取词按键被系统拦截（SendInput 返回 0）");
            return false;
        }
        true
    }
}

fn clip_read_text() -> Option<String> {
    arboard::Clipboard::new()
        .ok()
        .and_then(|mut c| c.get_text().ok())
}

impl Chord {
    fn label(self) -> &'static str {
        match self {
            Chord::CtrlInsert => "Ctrl+Insert",
            Chord::CtrlC => "Ctrl+C",
        }
    }
}

/// 发一根复制键并等剪贴板出现新文本。判据是「相对快照变了且非空」——因此「复制
/// 结果恰好等于原剪贴板」这一种命中我们看不见（两种键都一样，换键不解决）
fn copy_once(snapshot: &Option<String>, chord: Chord) -> Option<String> {
    const POLL_TIMES: usize = 40; // 40 × 15ms = 600ms 上限；应用响应后首个周期即命中
    const POLL_INTERVAL: Duration = Duration::from_millis(15);

    if !post_chord(chord) {
        return None;
    }
    for _ in 0..POLL_TIMES {
        std::thread::sleep(POLL_INTERVAL);
        if let Some(now) = clip_read_text() {
            let changed = snapshot.as_ref().map_or(true, |s| *s != now);
            if changed && !now.trim().is_empty() {
                return Some(now);
            }
        }
    }
    None
}

/// 兼容取词一次：快照剪贴板 → Ctrl+Insert（不认则 Ctrl+C）→ 轮询变化 → 取词 → 还原快照。
/// 兜底轮询仍与同一份快照比——主键失败时剪贴板没动过，判据不变。最坏耗时 600ms×2，
/// 只在主键不认的应用里发生；实测四家主流应用首个周期（15ms）就命中。
/// 还原竞态规则与 macOS compat.rs 同源：还原前重读现状，只在「现状仍是我取到的
/// 那段文本」时物归原主，其余一切保留现状——借用期间第三方可能写入比快照更新的
/// 内容，盲目还原会把它覆盖掉。没取到一律静默。
fn compat_fetch(app_path: &str) -> Option<String> {
    if clipboard_holds_rich_payload() {
        debug_log(format!(
            "capture/windows: 兼容取词跳过（剪贴板里是文件或图片，还原没把握）app={app_path:?}"
        ));
        return None;
    }

    let t0 = Instant::now();
    let snapshot = clip_read_text();
    let (mut fetched, mut chord) = (copy_once(&snapshot, Chord::CtrlInsert), Chord::CtrlInsert);
    if fetched.is_none() {
        debug_log(format!(
            "capture/windows: 兼容取词：{} 在此应用没取到，改用 {} 兜底",
            chord.label(),
            Chord::CtrlC.label()
        ));
        chord = Chord::CtrlC;
        fetched = copy_once(&snapshot, chord);
    }

    let now_text = clip_read_text();
    if fetched.is_some() && now_text.as_deref() == fetched.as_deref() {
        if let Ok(mut c) = arboard::Clipboard::new() {
            match &snapshot {
                Some(s) => {
                    let _ = c.set_text(s.clone());
                }
                None => {
                    let _ = c.clear();
                }
            }
        }
    } else if fetched.is_some() {
        debug_log("capture/windows: 兼容取词：借用期间剪贴板有新写入，不还原（保留现状）");
    }

    let text = fetched?;
    debug_log(format!(
        "capture/windows: 兼容取词命中 len={} 耗时={}ms 键={} app={app_path:?}",
        text.len(),
        t0.elapsed().as_millis(),
        chord.label()
    ));
    Some(text)
}

/// 同一个应用第三次「根本不暴露文本接口」时，提示一次去哪儿开这个开关。
///
/// 只提示、不代授权：默认关闭 + 界面先讲清利害关系是这条功能的立场（ADR-05 Windows
/// 对位），不能被一条几秒的 toast 替用户决定。计数与「已提示」标记只在内存里
/// （每次启动重新计），两道闸各有各的原因：阈值挡住「随手拖一下滚动条就冒出来」，
/// 标记挡住刷屏——本函数处在鼠标松开的检测线程上，同一个不暴露文本接口的应用会
/// 反复走到这里，没有标记就变成每次划词失败弹一条提示。
fn hint_compat_unavailable(app: &AppHandle, app_path: &str) {
    const MISS_THRESHOLD: usize = 3;
    // 每应用一条：累计 miss 次数 + 是否已提示过
    static SEEN: Mutex<Option<HashMap<String, (usize, bool)>>> = Mutex::new(None);

    if app_path.is_empty() {
        return; // 连进程路径都拿不到时无法在提示里点名应用，宁可不提示
    }
    let mut guard = match SEEN.lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    let table = guard.get_or_insert_with(HashMap::new);
    let entry = table
        .entry(app_path.to_lowercase())
        .or_insert((0, false));
    if entry.1 {
        return;
    }
    entry.0 += 1;
    if entry.0 < MISS_THRESHOLD {
        return;
    }
    entry.1 = true;
    drop(guard);

    let name = std::path::Path::new(app_path)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| app_path.to_string());
    let msg = crate::i18n::t("toast.compatHint").replace("{app}", &name);
    // 普通 4s 定时 toast（不是 sticky：sticky 没有自动隐藏，指引会挂在那里碍眼）；
    // 嫌短的用户点一下就收场——toast 窗不可聚焦但照常收点击，与胶囊收动作同一套
    crate::toast::show_toast(app, &msg, "info");
    debug_log(format!(
        "capture/windows: 兼容取词提示已出现（miss={}）app={app_path:?}",
        MISS_THRESHOLD
    ));
}

/// 点位是否落在本进程的窗口上（无论其 UIA 元素报哪个进程）。
/// WebView2 的子 HWND 属 msedgewebview2.exe 运行时，但 HWND 树的根一定属
/// 宿主进程——按根窗口归属判定，是 pid 闸在 WebView2 应用上的补丁
fn is_own_window_at(px: i32, py: i32, my_pid: u32) -> bool {
    unsafe {
        let hwnd = WindowFromPoint(POINT { x: px, y: py });
        if hwnd.is_invalid() {
            return false;
        }
        let root = GetAncestor(hwnd, GA_ROOT);
        if root.is_invalid() {
            return false;
        }
        let mut pid = 0u32;
        let _ = GetWindowThreadProcessId(root, Some(&mut pid));
        pid == my_pid
    }
}

/// 手势同形控制表面：按下拖动是成型的其他手势（拖按钮/滑块/滚动条/标签页/
/// 菜单/工具栏/文件树行），且它们的文本祖先可能带着遗留选区——放行进父链
/// 查询就等于让遗留选区替从未发生的手势背书（docs/03 A.3.3 的原初教训）。
/// 硬拒且不做父链查找。文件树行（TreeItem）在此之列，是有意为之
fn is_control_surface(ct: ControlType) -> bool {
    matches!(
        ct,
        ControlType::Button
            | ControlType::SplitButton
            | ControlType::CheckBox
            | ControlType::RadioButton
            | ControlType::ComboBox
            | ControlType::Slider
            | ControlType::Spinner
            | ControlType::ScrollBar
            | ControlType::Thumb
            | ControlType::ProgressBar
            | ControlType::Tab
            | ControlType::TabItem
            | ControlType::Menu
            | ControlType::MenuBar
            | ControlType::MenuItem
            | ControlType::Tree
            | ControlType::TreeItem
            | ControlType::ToolBar
            | ControlType::TitleBar
            | ControlType::StatusBar
            | ControlType::ToolTip
            | ControlType::Calendar
            | ControlType::Separator
            | ControlType::Header
            | ControlType::HeaderItem
            | ControlType::Image
    )
}

// ---------- 坐标与进程信息助手 ----------

/// 物理像素 → 该显示器逻辑坐标（原点 = 虚屏左上，与 macos.rs 语义一致）
fn to_logical(px: i32, py: i32) -> (f64, f64) {
    unsafe {
        let pt = POINT { x: px, y: py };
        let monitor = MonitorFromPoint(pt, MONITOR_DEFAULTTONEAREST);
        let mut dpi_x = 96u32;
        let mut dpi_y = 96u32;
        if !monitor.is_invalid() {
            let _ = GetDpiForMonitor(monitor, MDT_EFFECTIVE_DPI, &mut dpi_x, &mut dpi_y);
        }
        let scale = (dpi_x as f64 / 96.0).max(1.0);
        (px as f64 / scale, py as f64 / scale)
    }
}

/// 进程可执行文件全路径（黑名单按路径子串匹配）；失败返回 None（app 留空）
fn process_path(pid: u32) -> Option<String> {
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = [0u16; 1024];
        let mut size = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            windows::core::PWSTR(buf.as_mut_ptr()),
            &mut size,
        )
        .is_ok();
        let _ = windows::Win32::Foundation::CloseHandle(handle);
        if ok && size > 0 {
            Some(String::from_utf16_lossy(&buf[..size as usize]))
        } else {
            None
        }
    }
}
