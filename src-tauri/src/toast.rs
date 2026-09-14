//! 全局 toast 提示窗：主窗口隐藏（纯菜单栏模式）时，截图/识别失败等提示
//! 也要可见——独立小窗口主屏底部居中，显示 4 秒自动隐藏，不抢焦点。
//!
//! 两个约束（都踩过坑）：
//! 1. `show_without_activation`（orderFrontRegardless）是裸 AppKit 调用，只能在
//!    主线程执行——本模块可能从 tokio 后台线程（OCR 失败路径）调用，
//!    窗口操作一律经 `run_on_main_thread` 派发，否则 SIGILL 崩溃。
//! 2. 消息不用事件系统投递（toast webview 的 listen 注册时序不稳），改用
//!    `eval` 直调页面上的 `window.__toastShow`。

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager};

/// toast 序号：新提示出现后，旧提示排期的自动隐藏作废（避免刚弹的新提示被旧计时藏掉）
static TOAST_SEQ: AtomicU64 = AtomicU64::new(0);

/// 当前窗口逻辑尺寸（由 resize_toast 随内容更新；定位钳制用）
static TOAST_SIZE: Mutex<(f64, f64)> = Mutex::new((360.0, 52.0));

/// 窗口逻辑尺寸（需与 toast.css 的 .toast-pop 保持一致）
const TOAST_W: f64 = 360.0;
const TOAST_H: f64 = 52.0;

#[repr(C)]
struct CGPoint {
    x: f64,
    y: f64,
}

/// 当前光标位置（全局逻辑坐标，原点 = 主屏左上角）；取不到时回退屏幕底部居中
fn cursor_location() -> Option<(f64, f64)> {
    // CoreGraphics 已随 wry/tauri 链入，无需 #[link]（与 ocr.rs 的声明方式一致）
    unsafe extern "C" {
        fn CGEventCreate(source: *const std::ffi::c_void) -> *mut std::ffi::c_void;
        fn CGEventGetLocation(event: *mut std::ffi::c_void) -> CGPoint;
        fn CFRelease(cf: *mut std::ffi::c_void);
    }
    unsafe {
        let event = CGEventCreate(std::ptr::null());
        if event.is_null() {
            return None;
        }
        let p = CGEventGetLocation(event);
        CFRelease(event);
        Some((p.x, p.y))
    }
}

/// (x, y) 所在显示器的逻辑矩形 `(left, top, right, bottom)`；找不到回退 None
fn monitor_at(win: &tauri::WebviewWindow, x: f64, y: f64) -> Option<(f64, f64, f64, f64)> {
    for m in win.available_monitors().ok()? {
        let s = m.scale_factor();
        let pos = m.position();
        let size = m.size();
        let (lx, ly) = (pos.x as f64 / s, pos.y as f64 / s);
        let (lw, lh) = (size.width as f64 / s, size.height as f64 / s);
        if x >= lx && x <= lx + lw && y >= ly && y <= ly + lh {
            return Some((lx, ly, lx + lw, ly + lh));
        }
    }
    None
}

pub fn show_toast(app: &AppHandle, message: &str, kind: &str) {
    if app.get_webview_window("toast").is_none() {
        eprintln!("[magpie:toast] toast 窗口不存在：{message}");
        return;
    }
    let seq = TOAST_SEQ.fetch_add(1, Ordering::Relaxed) + 1;
    let (w, h) = *TOAST_SIZE.lock().unwrap_or_else(|e| e.into_inner());

    // 定位 + 置前 + 推送文本：必须在主线程（AppKit 线程约束，见模块注释）
    let handle = app.clone();
    let kind = serde_json::to_string(kind).unwrap_or_else(|_| "\"info\"".into());
    let js = format!(
        "window.__toastShow && window.__toastShow({}, {kind})",
        serde_json::to_string(message).unwrap_or_else(|_| "\"\"".into())
    );
    let _ = app.run_on_main_thread(move || {
        let Some(win) = handle.get_webview_window("toast") else {
            return;
        };
        // 光标右下优先弹出；所在屏放不下翻转到光标上方，再钳制在屏内；
        // 取不到光标时回退主屏底部居中（Dock 上方留 48pt）
        let mut placed = false;
        if let Some((cx, cy)) = cursor_location() {
            if let Some((m_l, m_t, m_r, m_b)) = monitor_at(&win, cx, cy) {
                let nx = (cx + 12.0).clamp(m_l, (m_r - w).max(m_l));
                let ny = if cy + 18.0 + h > m_b {
                    (cy - h - 12.0).max(m_t)
                } else {
                    cy + 18.0
                };
                let _ = win.set_position(LogicalPosition::new(nx, ny));
                placed = true;
            }
        }
        if !placed {
            if let Ok(Some(m)) = win.primary_monitor() {
                let s = m.scale_factor();
                let (mp, ms) = (m.position(), m.size());
                let (mw, mh) = (ms.width as f64 / s, ms.height as f64 / s);
                let _ = win.set_position(LogicalPosition::new(
                    mp.x as f64 / s + (mw - TOAST_W) / 2.0,
                    mp.y as f64 / s + mh - TOAST_H - 48.0,
                ));
            }
        }
        let _ = crate::floating::show_without_activation(&win);
        let _ = win.eval(&js);
    });

    // 4s 后自动隐藏（隐藏同样走主线程；新 toast 会使旧排期作废）
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(4));
        if TOAST_SEQ.load(Ordering::Relaxed) == seq {
            let value = handle.clone();
            let _ = handle.run_on_main_thread(move || {
                if let Some(w) = value.get_webview_window("toast") {
                    let _ = w.hide();
                }
            });
        }
    });
}

/// 内容测量 → 缩放窗口（JS 渲染后调用；+12 是 .stage 的投影边距）
#[tauri::command]
pub fn resize_toast(window: tauri::WebviewWindow, width: f64, height: f64) {
    if window.label() != "toast" {
        return;
    }
    let w = width.clamp(120.0, 440.0);
    let h = height.max(32.0);
    if let Ok(mut s) = TOAST_SIZE.lock() {
        *s = (w, h);
    }
    let _ = window.set_size(LogicalSize::new(w, h));
}
