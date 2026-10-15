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
//!     按下点之外的父亲/容器（如网页外壳的 Tab）不连坐，否则正常划选被误拒
//!   - 应答证据（唯一放行条件）：沿抬起点父链（≤24 层，Chromium 系树很深）
//!     找 TextPattern 非空选区——聊天消息/网页正文的选区常挂在起点上层的
//!     文档节点，起点本身往往是 ListItem/Group 叶子；选区为空 = 手势未发生
//!     → 按普通点击处理。父链无证据时再查焦点元素父链兜底（仅当焦点与
//!     终点同进程，避免跨进程的陈旧选区背书）
//!   （锚定/差分证据为 v2；遇到新误报场景优先扩展表面分类）
//!
//! 已知边界：Electron/自绘控件的 ControlType 可能是 Custom → 无 TextPattern
//! 即拒（精度优先，与 detect_places 同取向）；提权应用受 UIPI 屏障读不到；
//! 兼容模式（Ctrl+C 兜底）为独立事项（winVmac #21）。

use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::Mutex;

use tauri::AppHandle;
use uiautomation::types::ControlType;
use windows::Win32::Foundation::{LPARAM, LRESULT, POINT, WPARAM};
use windows::Win32::Graphics::Gdi::{MonitorFromPoint, MONITOR_DEFAULTTONEAREST};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};
use windows::Win32::UI::Input::KeyboardAndMouse::{GetDoubleClickTime, VK_ESCAPE};
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
/// 同步执行在 detect 线程（查询耗时 10-50ms 级，鼠标已抬起，不阻塞钩子）。
/// (dpx,dpy) = 按下点、(upx,upy) = 抬起点（物理坐标）：手势同形判定看按下点
/// （拖动从哪里开始就是什么手势），选区证据沿抬起点父链找
fn query_selection(
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
                    debug_log(format!(
                        "capture/windows: 起点为手势同形表面（{ct:?}），跳过"
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

        // 第二道：应答证据（唯一放行条件）——沿终点父链（≤24 层，Chromium
        // 系树很深，文档节点常在十几层之上）找 TextPattern 非空选区；
        // 选区为空 = 手势未发生
        if let Some(text) = walk_text_selection(aut, &up_el) {
            return Some((text, up_pid));
        }

        // 焦点元素父链兜底：部分 Electron/自绘应用的可编辑宿主不挂在点位链
        // 上，而选区挂在焦点元素一侧。仅当焦点与终点同进程时采信（跨进程的
        // 焦点选区与本手势无关，不做陈旧背书）
        if let Ok(focused) = aut.get_focused_element() {
            let f_pid = focused.get_process_id().unwrap_or(0);
            if f_pid == up_pid {
                if let Some(text) = walk_text_selection(aut, &focused) {
                    return Some((text, f_pid));
                }
            }
        }

        debug_log("capture/windows: 父链无 TextPattern 选区，跳过");
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

/// 从起点沿父链找 TextPattern 非空选区（≤24 层）。选区提取失败视为该层
/// 无证据，继续向上；链尽 = None
fn walk_text_selection(
    aut: &uiautomation::core::UIAutomation,
    start: &uiautomation::UIElement,
) -> Option<String> {
    let walker = aut.get_control_view_walker().ok()?;
    let mut cursor = start.clone();
    for _ in 0..24 {
        if let Some(text) = text_selection_of(&cursor) {
            return Some(text);
        }
        cursor = walker.get_parent(&cursor).ok()?;
    }
    None
}

/// 单层元素的 TextPattern 非空选区
fn text_selection_of(el: &uiautomation::UIElement) -> Option<String> {
    el.get_pattern::<uiautomation::patterns::UITextPattern>()
        .ok()
        .and_then(|p| p.get_selection().ok())
        .and_then(|ranges| ranges.into_iter().next())
        .and_then(|r| r.get_text(-1).ok())
        .filter(|t| !t.trim().is_empty())
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
