//! 钉图：把截图以无边框置顶小窗钉在屏幕上（Snipaste 式）。
//!
//! 入口是 OCR 面板的「钉图」动作（钉图是文本识别的中间状态，非独立功能）：
//! 识别完成时截图原图随 pending 保留，点击「钉图」把原图所有权移交钉图窗口。
//! 每张钉图 = 一个运行时创建的 `pin-{n}` 窗口，复用 floating.html 前端
//! （App 按 label 前缀进入钉图渲染模式）。图片经 data URL 传入 webview；
//! 临时 PNG 保留在磁盘，关窗即删。
//!
//! 交互：img 即拖拽区（data-tauri-drag-region 系统级拖动）；滚轮缩放；
//! 悬停工具条（识别/复制/关闭）；Esc 关闭。钉图不参与划词 dismiss 生命周期。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

use base64::Engine;
use serde::Serialize;
use tauri::{AppHandle, LogicalSize, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::ocr;

/// 钉图上限：防止误操作连按撑爆窗口资源
const MAX_PINS: usize = 8;

/// 待渲染/进行中钉图的元数据（按窗口 label 存取）
struct PinData {
    /// 图片 data URL（CSP img-src 含 data:，直接进 <img>）
    url: String,
    /// 临时 PNG 路径（识别文字用；关窗即删）
    path: PathBuf,
    /// 截图松手位置（逻辑坐标）：窗口出现时就近放置
    anchor: (f64, f64),
}

static PIN_SEQ: AtomicU32 = AtomicU32::new(0);
// HashMap::new 非 const，用 Option 包一层以支持静态初始化
static PINS: Mutex<Option<HashMap<String, PinData>>> = Mutex::new(None);

fn with_pins<T>(f: impl FnOnce(&mut HashMap<String, PinData>) -> T) -> Option<T> {
    let mut guard = PINS.lock().unwrap();
    // 惰性初始化：静态只能写成 None，首次访问时补上空表
    let map = guard.get_or_insert_with(HashMap::new);
    Some(f(map))
}

/// OCR 面板「钉图」：取走 pending 里的截图原图（所有权移交），钉回屏幕。
/// 锚点取 OCR 面板左上角——钉图贴面板上方出现。
#[tauri::command]
pub fn pin_from_ocr(window: WebviewWindow) -> Result<(), String> {
    let result = pin_from_ocr_inner(&window);
    if let Err(e) = &result {
        eprintln!("[pin] pin_from_ocr 失败：{e}");
    }
    result
}

fn pin_from_ocr_inner(window: &WebviewWindow) -> Result<(), String> {
    if window.label() != "ocr" {
        return Err("仅识别面板可钉图".into());
    }
    let Some(path) = crate::floating::ocr_take_image() else {
        return Err("截图原图已不存在，请重新识别".into());
    };
    let bytes = std::fs::read(&path).map_err(|e| format!("读取截图失败: {e}"))?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    let url = format!("data:image/png;base64,{b64}");
    let scale = window.scale_factor().unwrap_or(2.0);
    let anchor = window
        .outer_position()
        .map(|p| (p.x as f64 / scale, p.y as f64 / scale))
        .unwrap_or((0.0, 0.0));
    create_pin_window(window.app_handle(), path, url, anchor)
}

fn create_pin_window(
    app: &AppHandle,
    path: PathBuf,
    url: String,
    anchor: (f64, f64),
) -> Result<(), String> {
    if with_pins(|m| m.len()).unwrap_or(0) >= MAX_PINS {
        return Err("钉图数量已达上限（8），请先关闭部分钉图".into());
    }
    let n = PIN_SEQ.fetch_add(1, Ordering::Relaxed);
    let label = format!("pin-{n}");
    with_pins(|m| {
        m.insert(
            label.clone(),
            PinData {
                url,
                path,
                anchor,
            },
        );
    });

    WebviewWindowBuilder::new(app, &label, WebviewUrl::App("floating.html".into()))
        .title("钉图")
        .visible(false)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .shadow(false)
        .focused(false)
        .accept_first_mouse(true)
        .build()
        .map_err(|e| {
            // 建窗失败：回滚状态与临时文件
            cleanup(&label);
            e.to_string()
        })?;
    // 运行时建窗赶不上启动时的外观批量应用：按当前设置补原生主题
    // （CSS 变量由前端 get_settings 初始化时自行挂 class，无需在此处理）
    let native = match crate::settings::current(app).appearance.as_str() {
        "light" => Some(tauri::Theme::Light),
        "dark" => Some(tauri::Theme::Dark),
        _ => None,
    };
    if let Some(win) = app.get_webview_window(&label) {
        let _ = win.set_theme(native);
    }
    Ok(())
}

/// 关窗收尾：移除元数据 + 删临时 PNG
fn cleanup(label: &str) {
    if let Some(Some(data)) = with_pins(|m| m.remove(label)) {
        let _ = std::fs::remove_file(&data.path);
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PinPayload {
    url: String,
    scale: f64,
    anchor: (f64, f64),
}

/// 前端取钉图数据（只读不取走：webview 重载后仍能恢复）
#[tauri::command]
pub fn pin_get_data(window: WebviewWindow) -> Option<PinPayload> {
    let label = window.label();
    if !label.starts_with("pin-") {
        return None;
    }
    let scale = window.scale_factor().unwrap_or(2.0);
    with_pins(|m| {
        m.get(label).map(|d| PinPayload {
            url: d.url.clone(),
            scale,
            anchor: d.anchor,
        })
    })
    .flatten()
}

/// 图片加载完成：按像素尺寸换算逻辑尺寸（px / 缩放系数），
/// 锚点就近放置并钳制在屏内，先渲染后显示（无白屏/动画）。
/// width/height 为图片像素尺寸（物理像素）。
#[tauri::command]
pub fn pin_window_ready(window: WebviewWindow, width: f64, height: f64) -> Result<(), String> {
    if !window.label().starts_with("pin-") {
        return Ok(());
    }
    let scale = window.scale_factor().unwrap_or(2.0);
    let lw = (width / scale).max(48.0);
    let lh = (height / scale).max(36.0);
    let anchor = with_pins(|m| m.get(window.label()).map(|d| d.anchor)).flatten();
    window
        .set_size(LogicalSize::new(lw, lh))
        .map_err(|e| e.to_string())?;
    if let Some((ax, ay)) = anchor {
        // 贴锚点（识别面板左上角）上方摆放，形成「图在上、文在下」的对照视图；
        // 屏幕顶部放不下则退到锚点下方，并始终钳制在锚点所在显示器内
        let (m_l, m_t, m_r, m_b) = crate::floating::monitor_rect(&window, ax, ay);
        let nx = ax.clamp(m_l, (m_r - lw).max(m_l));
        let ny = if ay - lh - 8.0 >= m_t {
            ay - lh - 8.0
        } else {
            ay + 12.0
        };
        let ny = ny.clamp(m_t, (m_b - lh).max(m_t));
        window
            .set_position(tauri::LogicalPosition::new(nx, ny))
            .map_err(|e| e.to_string())?;
    }
    crate::floating::show_without_activation(&window)
}

/// 滚轮缩放后的窗口尺寸同步（前端传逻辑尺寸 + 光标锚点比例）。
/// 以光标下的点为锚缩放（fx/fy = 光标在窗口内的相对位置）：光标指着哪，
/// 哪一点保持不动——图不会「向右下跑」；之后仍做屏内钳制
#[tauri::command]
pub fn resize_pin(
    window: WebviewWindow,
    width: f64,
    height: f64,
    fx: Option<f64>,
    fy: Option<f64>,
) -> Result<(), String> {
    if !window.label().starts_with("pin-") {
        return Ok(());
    }
    let w = width.max(48.0);
    let h = height.max(36.0);
    let scale = window.scale_factor().unwrap_or(2.0);
    // 旧尺寸（物理像素换算逻辑）：用于锚点补偿计算，需在 set_size 前读取
    let (old_w, old_h) = window
        .inner_size()
        .ok()
        .map(|s| (s.width as f64 / scale, s.height as f64 / scale))
        .unwrap_or((w, h));
    window.set_size(LogicalSize::new(w, h)).map_err(|e| e.to_string())?;
    if let Ok(pos) = window.outer_position() {
        let (m_l, m_t, m_r, m_b) = {
            let cx = pos.x as f64 / scale + w / 2.0;
            let cy = pos.y as f64 / scale + h / 2.0;
            crate::floating::monitor_rect(&window, cx, cy)
        };
        let fx = fx.unwrap_or(0.0).clamp(0.0, 1.0);
        let fy = fy.unwrap_or(0.0).clamp(0.0, 1.0);
        let mut nx = pos.x as f64 / scale + fx * (old_w - w);
        let mut ny = pos.y as f64 / scale + fy * (old_h - h);
        nx = nx.clamp(m_l, (m_r - w).max(m_l));
        ny = ny.clamp(m_t, (m_b - h).max(m_t));
        if (nx - pos.x as f64 / scale).abs() > 0.5 || (ny - pos.y as f64 / scale).abs() > 0.5 {
            let _ = window.set_position(tauri::LogicalPosition::new(nx, ny));
        }
    }
    Ok(())
}

/// 当前窗口位置（逻辑坐标，左上角）——前端拖拽起点
#[tauri::command]
pub fn pin_window_pos(window: WebviewWindow) -> Option<crate::floating::WindowPos> {
    if !window.label().starts_with("pin-") {
        return None;
    }
    let scale = window.scale_factor().unwrap_or(2.0);
    window.outer_position().ok().map(|p| crate::floating::WindowPos {
        x: p.x as f64 / scale,
        y: p.y as f64 / scale,
    })
}

/// 拖动中：目标位置（逻辑坐标，左上角）钳制在窗口所在显示器内后落位。
/// 前端自定义拖拽驱动（data-tauri-drag-region 走系统拖动，无法钳制边界）。
#[tauri::command]
pub fn move_pin(window: WebviewWindow, x: f64, y: f64) {
    if !window.label().starts_with("pin-") {
        return;
    }
    crate::floating::clamp_move_window(&window, x, y);
}

/// 关闭钉图（✕ / Esc）
#[tauri::command]
pub fn close_pin(window: WebviewWindow) {
    let label = window.label();
    if !label.starts_with("pin-") {
        return;
    }
    cleanup(&label);
    let _ = window.close();
}

/// 复制钉图到剪贴板（PNG → RGBA → arboard）
#[tauri::command]
pub async fn pin_copy_image(window: WebviewWindow) -> Result<(), String> {
    let path = with_pins(|m| m.get(window.label()).map(|d| d.path.clone())).flatten();
    let Some(path) = path else {
        return Err("钉图数据不存在".into());
    };
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = std::fs::read(&path).map_err(|e| format!("读取截图失败: {e}"))?;
        let img = image::load_from_memory(&bytes).map_err(|e| format!("解码截图失败: {e}"))?;
        let rgba = img.to_rgba8();
        let data = arboard::ImageData {
            width: rgba.width() as usize,
            height: rgba.height() as usize,
            bytes: std::borrow::Cow::Owned(rgba.into_raw()),
        };
        arboard::Clipboard::new()
            .and_then(|mut c| c.set_image(data))
            .map_err(|e| format!("写入剪贴板失败: {e}"))
    })
    .await
    .map_err(|e| format!("任务执行失败: {e}"))?
}

/// 钉图 → 识别文字：助手子进程离线 OCR 该图，结果推给 OCR 面板
#[tauri::command]
pub async fn pin_to_ocr(window: WebviewWindow) -> Result<(), String> {
    let path = with_pins(|m| m.get(window.label()).map(|d| d.path.clone())).flatten();
    let Some(path) = path else {
        return Err("钉图数据不存在".into());
    };
    let app = window.app_handle().clone();
    let result = tauri::async_runtime::spawn_blocking(move || ocr::recognize_file(&path))
        .await
        .map_err(|e| format!("任务执行失败: {e}"))?;
    match result {
        Ok(text) => {
            // 原图归钉图窗口所有，不再随 pending 传递
            ocr::push_text_to_ocr_window(&app, text, None);
            Ok(())
        }
        Err(e) => Err(e),
    }
}
