//! 浮动条窗口管理：光标锚点定位（右下优先、翻转防出屏）、尺寸自适应、显隐。
//! TS 渲染后测量内容尺寸，经 show/resize 传入；Rust 只负责放置与钳制。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, WebviewWindow};

use crate::capture::debug_log;

/// TS 未传尺寸时的兜底
pub const DEFAULT_W: f64 = 328.0;
pub const DEFAULT_H: f64 = 54.0;

// ---- 拖拽状态（detect 线程经事件转发驱动，见 capture/macos.rs） ----
static DRAG_ACTIVE: AtomicBool = AtomicBool::new(false);
static DRAG_GRAB: Mutex<(f64, f64)> = Mutex::new((0.0, 0.0)); // 光标相对窗口左上角偏移

pub fn is_dragging() -> bool {
    DRAG_ACTIVE.load(Ordering::Relaxed)
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

/// (x, y)（逻辑坐标）所在显示器的逻辑右下边界；找不到则回退主显示器
fn monitor_bounds(win: &WebviewWindow, x: f64, y: f64) -> (f64, f64) {
    for m in win.available_monitors().unwrap_or_default() {
        let s = m.scale_factor();
        let pos = m.position();
        let size = m.size();
        let (lx, ly) = (pos.x as f64 / s, pos.y as f64 / s);
        let (lw, lh) = (size.width as f64 / s, size.height as f64 / s);
        if x >= lx && x <= lx + lw && y >= ly && y <= ly + lh {
            return (lx + lw, ly + lh);
        }
    }
    if let Ok(Some(p)) = win.primary_monitor() {
        let s = p.scale_factor();
        return (p.size().width as f64 / s, p.size().height as f64 / s);
    }
    (1920.0, 1080.0)
}

/// 锚点 → 窗口位置：优先光标右下，底部放不下翻转到上方，钳制在显示器内
fn place(win: &WebviewWindow, ax: f64, ay: f64, w: f64, h: f64) -> (f64, f64) {
    let (max_x, max_y) = monitor_bounds(win, ax, ay);
    let nx = (ax + 6.0).clamp(0.0, (max_x - w).max(0.0));
    let ny = if ay + 14.0 + h > max_y {
        (ay - h - 12.0).max(0.0)
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
    win.show().map_err(|e| e.to_string())?;
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

/// 拖动中：光标全局坐标 → 窗口新位置（由 capture worker 转发调用）
pub fn apply_drag(app: &AppHandle, cx: f64, cy: f64) {
    if !is_dragging() {
        return;
    }
    let grab = DRAG_GRAB.lock().map(|g| *g).unwrap_or((0.0, 0.0));
    let (nx, ny) = (cx - grab.0, cy - grab.1);
    if let Some(win) = app.get_webview_window("floating") {
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
