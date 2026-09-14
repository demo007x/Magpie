//! 浮动条窗口管理：光标锚点定位（右下优先、翻转防出屏）、尺寸自适应、显隐。
//! TS 渲染后测量内容尺寸，经 show/resize 传入；Rust 只负责放置与钳制。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewWindow};

use crate::capture::debug_log;
use serde::Serialize;
use serde_json::json;

#[cfg(target_os = "macos")]
mod macos_glue {
    use std::os::raw::{c_char, c_void};

    // objc_msgSend 按调用签名分别声明（与 objc crate 内部做法一致）
    #[allow(clashing_extern_declarations)]
    extern "C" {
        fn sel_registerName(name: *const c_char) -> *mut c_void;
        #[link_name = "objc_msgSend"]
        fn msg_send_order_front_regardless(receiver: *mut c_void, sel: *mut c_void);
    }

    /// 显示窗口但不激活本进程（等价 [NSWindow orderFrontRegardless]）。
    /// tao 的 show = makeKeyAndOrderFront 会把激活态抢到本进程，
    /// 目标应用失焦后选区高亮消失——必须绕开。
    pub fn show_without_activation(ns_window: *mut c_void) {
        unsafe {
            let sel = sel_registerName(b"orderFrontRegardless\0".as_ptr() as *const c_char);
            msg_send_order_front_regardless(ns_window, sel);
        }
    }
}

/// 仅置前显示、不改变本进程激活态（浮动条 / OCR / 钉图窗口共用）。
/// tao 的 show = makeKeyAndOrderFront 会抢激活态，目标应用失焦——必须绕开。
pub(crate) fn show_without_activation(win: &WebviewWindow) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let ns = win.ns_window().map_err(|e| e.to_string())?;
        macos_glue::show_without_activation(ns);
    }
    #[cfg(not(target_os = "macos"))]
    win.show().map_err(|e| e.to_string())?;
    Ok(())
}

/// 原生圆角裁切：给 NSWindow contentView 的图层设 cornerRadius + masksToBounds。
/// 透明窗口上 CSS 圆角压在窗口边界，WebKit 透明合成层不做边缘抗锯齿，必然出毛刺；
/// 原生图层裁切由系统合成器完成，圆弧与原生 App 同级平滑。（社区共识方案）
#[cfg(target_os = "macos")]
pub fn apply_native_corner_radius(win: &WebviewWindow, radius: f64) {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;

    let Ok(ns_window) = win.ns_window() else {
        return;
    };
    let ns_window = ns_window as *mut AnyObject;
    unsafe {
        let content: *mut AnyObject = msg_send![ns_window, contentView];
        if content.is_null() {
            return;
        }
        let _: () = msg_send![content, setWantsLayer: true];
        let layer: *mut AnyObject = msg_send![content, layer];
        if layer.is_null() {
            return;
        }
        let _: () = msg_send![layer, setCornerRadius: radius];
        let _: () = msg_send![layer, setMasksToBounds: true];
    }
}

/// TS 未传尺寸时的兜底
pub const DEFAULT_W: f64 = 328.0;
pub const DEFAULT_H: f64 = 54.0;

// ---- 拖拽状态（detect 线程经事件转发驱动，见 capture/macos.rs） ----
static DRAG_ACTIVE: AtomicBool = AtomicBool::new(false);
static DRAG_GRAB: Mutex<(f64, f64)> = Mutex::new((0.0, 0.0)); // 光标相对窗口左上角偏移

pub fn is_dragging() -> bool {
    DRAG_ACTIVE.load(Ordering::Relaxed)
}

// ---- OCR 独立窗口：钉住状态 + 待显示结果（事件可能早于 webview 就绪，先存后取） ----

/// 钉住：OCR 窗口忽略 dismiss / 新选区，就地常驻
static OCR_PINNED: AtomicBool = AtomicBool::new(false);

/// 待显示的识别结果：文本 + 截图原图（原图供面板「钉图」，所有权随取走移交）
struct OcrPending {
    text: String,
    image: Option<std::path::PathBuf>,
}

static OCR_PENDING: Mutex<Option<OcrPending>> = Mutex::new(None);

pub fn ocr_pinned() -> bool {
    OCR_PINNED.load(Ordering::Relaxed)
}

#[tauri::command]
pub fn set_ocr_pinned(pinned: bool) {
    OCR_PINNED.store(pinned, Ordering::Relaxed);
}

/// 当前 webview 是否为 OCR 独立窗口（App 据此决定渲染模式）
#[tauri::command]
pub fn ocr_window_mode(window: WebviewWindow) -> bool {
    window.label() == "ocr"
}

/// 取走待显示的识别文本（App 挂载或收到事件时调用，只消费文本，原图留给「钉图」）
#[tauri::command]
pub fn ocr_take_pending() -> Option<String> {
    OCR_PENDING
        .lock()
        .unwrap()
        .as_ref()
        .map(|p| p.text.clone())
}

/// 取走截图原图（「钉图」动作，所有权移交钉图窗口；取走后面板不再可钉）
pub fn ocr_take_image() -> Option<std::path::PathBuf> {
    OCR_PENDING.lock().unwrap().as_mut().and_then(|p| p.image.take())
}

/// 存入待显示识别结果（托盘「文本识别」流程调用）。
/// 替换旧 pending 时顺带清理其遗留的截图临时文件。
pub fn ocr_set_pending(text: String, image: Option<std::path::PathBuf>) {
    let mut pending = OCR_PENDING.lock().unwrap();
    if let Some(old) = pending.take() {
        if let Some(old_path) = old.image {
            if image.as_deref() != Some(old_path.as_path()) {
                let _ = std::fs::remove_file(old_path);
            }
        }
    }
    *pending = Some(OcrPending { text, image });
}

/// OCR 窗口内容就绪：定位到主屏水平居中、上方 1/3 处并显示（不激活本进程）。
/// 顺序保证"先渲染后显示"——用户看不到白屏/动画。
#[tauri::command]
pub fn ocr_window_ready(window: WebviewWindow) {
    if window.label() != "ocr" {
        return;
    }
    if let Ok(Some(m)) = window.primary_monitor() {
        let s = m.scale_factor();
        let pos = m.position();
        let size = m.size();
        let (mw, mh) = (size.width as f64 / s, size.height as f64 / s);
        let size_l = window.inner_size().map(|v| LogicalSize::new(v.width as f64 / s, v.height as f64 / s)).unwrap_or(LogicalSize::new(420.0, 340.0));
        let (wx, wy) = (size_l.width, size_l.height);
        let _ = window.set_position(LogicalPosition::new(
            pos.x as f64 / s + (mw - wx) / 2.0,
            pos.y as f64 / s + (mh - wy) / 3.0,
        ));
    }
    let _ = show_without_activation(&window);
}

/// 收起 OCR 窗口（解锁/✕）
#[tauri::command]
pub fn hide_ocr_window(window: WebviewWindow) {
    if window.label() == "ocr" {
        let _ = window.hide();
    }
}

/// 内容测量 → 缩放 OCR 窗口（窗口尺寸贴合面板内容，毛玻璃材质填满窗口即面板）
#[tauri::command]
pub fn resize_ocr(window: WebviewWindow, width: f64, height: f64) {
    if window.label() != "ocr" {
        return;
    }
    let w = width.clamp(280.0, 520.0);
    let h = height.clamp(80.0, 460.0);
    let _ = window.set_size(LogicalSize::new(w, h));
}

/// OCR 窗口当前是否可见（供 dismiss 判断）
pub fn ocr_visible(app: &AppHandle) -> bool {
    app.get_webview_window("ocr")
        .map(|w| w.is_visible().unwrap_or(false))
        .unwrap_or(false)
}

/// 点是否落在 OCR 窗口矩形内（含 pad 边距）——抑制「点击识别面板本身」触发的 dismiss
pub fn ocr_rect_contains(app: &AppHandle, x: f64, y: f64, pad: f64) -> bool {
    app.get_webview_window("ocr").map_or(false, |w| {
        if !w.is_visible().unwrap_or(false) {
            return false;
        }
        let scale = w.scale_factor().unwrap_or(2.0);
        let (Ok(pos), Ok(size)) = (w.outer_position(), w.inner_size()) else {
            return false;
        };
        let (lx, ly) = (pos.x as f64 / scale, pos.y as f64 / scale);
        let (lw, lh) = (size.width as f64 / scale, size.height as f64 / scale);
        x >= lx - pad && x <= lx + lw + pad && y >= ly - pad && y <= ly + lh + pad
    })
}

/// 未钉住的 OCR 窗口随普通单击/新选区收起（钉住则保留）
pub fn dismiss_ocr_if_unpinned(app: &AppHandle) {
    if !ocr_pinned() && ocr_visible(app) {
        if let Some(w) = app.get_webview_window("ocr") {
            let _ = w.hide();
            let _ = app.emit_to("ocr", "selection://dismiss", json!({}));
        }
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct FloatingRect {
    /// 光标锚点（选词松手位置）——尺寸变化时据此重新放置
    pub anchor_x: f64,
    pub anchor_y: f64,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub visible: bool,
}

pub type FloatingState = Mutex<FloatingRect>;

fn window(app: &AppHandle) -> Result<WebviewWindow, String> {
    app.get_webview_window("floating")
        .ok_or_else(|| "floating window not found".to_string())
}

pub fn is_visible(app: &AppHandle) -> bool {
    app.try_state::<FloatingState>()
        .map(|s| s.lock().unwrap().visible)
        .unwrap_or(false)
}

/// 点是否落在浮动条矩形内（含 pad 边距）——用于抑制"点击浮动条本身"触发的 dismiss
pub fn rect_contains(app: &AppHandle, x: f64, y: f64, pad: f64) -> bool {
    app.try_state::<FloatingState>().map_or(false, |s| {
        let r = *s.lock().unwrap();
        r.visible
            && x >= r.x - pad
            && x <= r.x + r.w + pad
            && y >= r.y - pad
            && y <= r.y + r.h + pad
    })
}

/// (x, y)（逻辑坐标，窗口左上角）落位：钳制在窗口中心所在显示器内。
/// OCR 面板 / 钉图窗口的自定义拖拽共用。
pub(crate) fn clamp_move_window(win: &WebviewWindow, x: f64, y: f64) {
    let scale = win.scale_factor().unwrap_or(2.0);
    let (w, h) = win
        .outer_size()
        .map(|s| (s.width as f64 / scale, s.height as f64 / scale))
        .unwrap_or((100.0, 80.0));
    // 用窗口中心判定所在显示器（跨屏拖动时随中心切换钳制范围）
    let (m_l, m_t, m_r, m_b) = monitor_rect(win, x + w / 2.0, y + h / 2.0);
    let nx = x.clamp(m_l, (m_r - w).max(m_l));
    let ny = y.clamp(m_t, (m_b - h).max(m_t));
    let _ = win.set_position(LogicalPosition::new(nx, ny));
}

/// 窗口位置（逻辑坐标，左上角）。元组会序列化成 JSON 数组，
/// 前端按对象解构会拿到 undefined，必须用命名字段。
#[derive(Debug, Clone, Copy, Serialize)]
pub struct WindowPos {
    pub x: f64,
    pub y: f64,
}

/// OCR 面板当前窗口位置——前端拖拽起点
#[tauri::command]
pub fn ocr_window_pos(window: WebviewWindow) -> Option<WindowPos> {
    if window.label() != "ocr" {
        return None;
    }
    let scale = window.scale_factor().unwrap_or(2.0);
    window.outer_position().ok().map(|p| WindowPos {
        x: p.x as f64 / scale,
        y: p.y as f64 / scale,
    })
}

/// 拖动 OCR 面板：目标位置钳制在屏幕内后落位
#[tauri::command]
pub fn move_ocr(window: WebviewWindow, x: f64, y: f64) {
    if window.label() != "ocr" {
        return;
    }
    clamp_move_window(&window, x, y);
}

/// (x, y)（逻辑坐标）所在显示器的逻辑矩形 `(left, top, right, bottom)`；找不到则回退主显示器
pub(crate) fn monitor_rect(win: &WebviewWindow, x: f64, y: f64) -> (f64, f64, f64, f64) {
    for m in win.available_monitors().unwrap_or_default() {
        let s = m.scale_factor();
        let pos = m.position();
        let size = m.size();
        let (lx, ly) = (pos.x as f64 / s, pos.y as f64 / s);
        let (lw, lh) = (size.width as f64 / s, size.height as f64 / s);
        if x >= lx && x <= lx + lw && y >= ly && y <= ly + lh {
            return (lx, ly, lx + lw, ly + lh);
        }
    }
    if let Ok(Some(p)) = win.primary_monitor() {
        let s = p.scale_factor();
        let pos = p.position();
        let size = p.size();
        return (
            pos.x as f64 / s,
            pos.y as f64 / s,
            pos.x as f64 + size.width as f64 / s,
            pos.y as f64 + size.height as f64 / s,
        );
    }
    (0.0, 0.0, 1920.0, 1080.0)
}

/// 锚点 → 窗口位置：优先光标右下，底部放不下翻转到上方，钳制在显示器内
fn place(win: &WebviewWindow, ax: f64, ay: f64, w: f64, h: f64) -> (f64, f64) {
    let (m_l, m_t, m_r, m_b) = monitor_rect(win, ax, ay);
    let nx = (ax + 6.0).clamp(m_l, (m_r - w).max(m_l));
    let ny = if ay + 14.0 + h > m_b {
        (ay - h - 12.0).max(m_t)
    } else {
        ay + 14.0
    };
    (nx, ny)
}

#[tauri::command]
pub fn show_floating_bar(
    app: AppHandle,
    x: f64,
    y: f64,
    width: Option<f64>,
    height: Option<f64>,
) -> Result<(), String> {
    let win = window(&app)?;
    let w = width.unwrap_or(DEFAULT_W).max(120.0);
    let h = height.unwrap_or(DEFAULT_H).max(40.0);
    let (nx, ny) = place(&win, x, y, w, h);
    win.set_size(LogicalSize::new(w, h))
        .map_err(|e| e.to_string())?;
    win.set_position(LogicalPosition::new(nx, ny))
        .map_err(|e| e.to_string())?;
    // tao 的 show() = makeKeyAndOrderFront：会把激活态抢到本进程，目标应用失焦后
    // 选区高亮消失（macOS 不为非激活窗口绘制高亮）。改用 orderFrontRegardless：
    // 仅把窗口置前显示，不改变激活态，保住用户的选词效果。
    show_without_activation(&win)?;
    let state = app.state::<FloatingState>();
    *state.lock().unwrap() = FloatingRect {
        anchor_x: x,
        anchor_y: y,
        x: nx,
        y: ny,
        w,
        h,
        visible: true,
    };
    Ok(())
}

#[tauri::command]
pub fn resize_floating(app: AppHandle, width: f64, height: f64) -> Result<(), String> {
    let win = window(&app)?;
    let state = app.state::<FloatingState>();
    let mut r = state.lock().unwrap();
    let (ax, ay) = (r.anchor_x, r.anchor_y);
    let w = width.max(120.0);
    let h = height.max(40.0);
    let (nx, ny) = place(&win, ax, ay, w, h);
    win.set_size(LogicalSize::new(w, h))
        .map_err(|e| e.to_string())?;
    if r.visible {
        win.set_position(LogicalPosition::new(nx, ny))
            .map_err(|e| e.to_string())?;
    }
    r.x = nx;
    r.y = ny;
    r.w = w;
    r.h = h;
    Ok(())
}

/// 开始拖动：记录光标抓取偏移，激活拖拽态（此后 tap 的 DragMove 事件驱动窗口移动）
#[tauri::command]
pub fn begin_floating_drag(app: AppHandle, x: f64, y: f64) -> Result<(), String> {
    let win = window(&app)?;
    let scale = win.scale_factor().map_err(|e| e.to_string())?;
    let pos = win.outer_position().map_err(|e| e.to_string())?;
    let grab = (x - pos.x as f64 / scale, y - pos.y as f64 / scale);
    if let Ok(mut g) = DRAG_GRAB.lock() {
        *g = grab;
    }
    DRAG_ACTIVE.store(true, Ordering::Relaxed);
    Ok(())
}

/// 拖动中：光标全局坐标 → 窗口新位置（钳制在光标所在显示器内，由 capture worker 转发调用）
pub fn apply_drag(app: &AppHandle, cx: f64, cy: f64) {
    if !is_dragging() {
        return;
    }
    let grab = DRAG_GRAB.lock().map(|g| *g).unwrap_or((0.0, 0.0));
    let (nx, ny) = (cx - grab.0, cy - grab.1);
    if let Some(win) = app.get_webview_window("floating") {
        let (m_l, m_t, m_r, m_b) = monitor_rect(&win, cx, cy);
        let (w, h) = app
            .try_state::<FloatingState>()
            .map(|s| {
                let r = s.lock().unwrap();
                (r.w, r.h)
            })
            .unwrap_or((DEFAULT_W, DEFAULT_H));
        // 整条窗口保持在光标所在显示器内
        let nx = nx.clamp(m_l, (m_r - w).max(m_l));
        let ny = ny.clamp(m_t, (m_b - h).max(m_t));
        let _ = win.set_position(LogicalPosition::new(nx, ny));
        if let Some(state) = app.try_state::<FloatingState>() {
            let mut r = state.lock().unwrap();
            r.x = nx;
            r.y = ny;
        }
    }
}

/// 拖动结束：收尾并把当前位置作为新锚点（后续展开不跳位）
pub fn end_drag(app: &AppHandle) {
    if !is_dragging() {
        return;
    }
    DRAG_ACTIVE.store(false, Ordering::Relaxed);
    if let Some(state) = app.try_state::<FloatingState>() {
        let mut r = state.lock().unwrap();
        r.anchor_x = r.x;
        r.anchor_y = r.y;
    }
    debug_log("浮动条拖动结束，锚点已更新");
}

#[tauri::command]
pub fn hide_floating_bar(app: AppHandle) -> Result<(), String> {
    debug_log("hide_floating_bar 调用");
    let win = window(&app)?;
    win.hide().map_err(|e| e.to_string())?;
    app.state::<FloatingState>().lock().unwrap().visible = false;
    Ok(())
}
