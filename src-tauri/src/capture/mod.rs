//! 划词捕获（docs/03-模块设计-划词捕获.md）：
//! 平台后端（macOS: CGEventTap+AX；Windows M2: UIA）→ 高层事件 → 本模块过滤与转发。
//! 全程不读写剪贴板；捕获失败静默。

pub enum CaptureEvent {
    Selection {
        text: String,
        x: f64,
        y: f64,
        app: String,
        /// 运行中应用的 bundle identifier（如 com.apple.Safari）；解析失败为空
        bid: String,
        pid: i32,
    },
    PlainClick {
        x: f64,
        y: f64,
    },
    /// 拖动浮动条中：光标全局坐标
    DragMove {
        x: f64,
        y: f64,
    },
    DragEnd,
    /// 全局按下 Esc（回调侧已过滤为仅 Esc 按下，且浮动条/面板可能并未显示）
    Escape,
}

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
pub use macos::start;
#[cfg(target_os = "macos")]
use macos::{
    ax_service_probe as platform_ax_service_probe,
    is_accessibility_granted,
    listen_event_access as platform_listen_event_access,
    open_accessibility_settings as open_platform_settings,
    prompt_accessibility as prompt_platform_accessibility,
    request_listen_access as platform_request_listen_access,
    request_screen_capture_access as platform_request_screen_capture_access,
    screen_capture_access as platform_screen_capture_access,
};

#[cfg(not(target_os = "macos"))]
mod other;
#[cfg(not(target_os = "macos"))]
pub use other::start;
#[cfg(not(target_os = "macos"))]
use other::{
    ax_service_probe as platform_ax_service_probe,
    is_accessibility_granted,
    listen_event_access as platform_listen_event_access,
    open_accessibility_settings as open_platform_settings,
};

use serde::Serialize;
use serde_json::json;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Receiver;
use tauri::{AppHandle, Emitter};

use crate::{floating, settings};

/// 捕获静音开关：截图取词等系统交互期间置位，鼠标事件不入队、不触发划词判定
static CAPTURE_MUTED: AtomicBool = AtomicBool::new(false);

pub fn set_capture_muted(muted: bool) {
    CAPTURE_MUTED.store(muted, Ordering::Relaxed);
}

pub fn capture_muted() -> bool {
    CAPTURE_MUTED.load(Ordering::Relaxed)
}

/// RAII 守卫：创建即静音，Drop 时自动解除（任何退出路径都不会漏）
pub struct CaptureMuteGuard;

impl CaptureMuteGuard {
    pub fn new() -> Self {
        set_capture_muted(true);
        Self
    }
}

impl Default for CaptureMuteGuard {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for CaptureMuteGuard {
    fn drop(&mut self) {
        set_capture_muted(false);
    }
}

/// 捕获链路调试日志（仅 debug 构建输出到 stderr / dev 终端）
pub(crate) fn debug_log(msg: impl std::fmt::Display) {
    if cfg!(debug_assertions) {
        eprintln!("[magpie:capture] {msg}");
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureStatus {
    pub granted: bool,
    /// AX 服务实测可用（TCC 信任 ≠ AX 放行，缓存异常时割裂）
    pub ax_service_ok: bool,
    /// 输入监控权限（缺失时事件 tap 收不到其他应用的事件，浮动条不弹）
    pub listen_event_access: bool,
    /// 屏幕录制权限（OCR 截图取词需要）
    pub screen_capture_access: bool,
    pub platform: String,
}

#[tauri::command]
pub fn capture_status(app: AppHandle) -> CaptureStatus {
    let granted = is_accessibility_granted();
    let status = CaptureStatus {
        granted,
        ax_service_ok: platform_ax_service_probe(),
        listen_event_access: platform_listen_event_access(),
        screen_capture_access: platform_screen_capture_access(),
        platform: std::env::consts::OS.to_string(),
    };
    let _ = app.emit("capture://permission", json!({ "granted": granted }));
    status
}

/// 发起输入监控授权请求（macOS）：系统自动注册当前二进制进「输入监控」列表；
/// 未通过时代开设置面板。非 macOS 恒 true（无该权限开关）
#[tauri::command]
pub fn request_listen_access() -> bool {
    #[cfg(target_os = "macos")]
    return platform_request_listen_access();
    #[cfg(not(target_os = "macos"))]
    return true;
}

/// 发起屏幕录制授权请求（macOS）：系统弹窗授权。非 macOS 恒 true
#[tauri::command]
pub fn request_screen_capture_access() -> bool {
    #[cfg(target_os = "macos")]
    return platform_request_screen_capture_access();
    #[cfg(not(target_os = "macos"))]
    return true;
}

#[tauri::command]
pub fn open_accessibility_settings() {
    open_platform_settings();
}

/// 让应用自己发起授权请求：系统自动把当前运行的二进制注册进辅助功能列表，
/// 返回当前是否已授权（未授权时系统已代为打开设置面板）
#[tauri::command]
pub fn prompt_accessibility() -> bool {
    prompt_platform_accessibility()
}

/// 过滤 + 转发（docs/03 §3.4，顺序即优先级）：
/// 1. 自身进程 2. 应用黑名单 3.（重复抑制在平台后端做）
pub fn spawn_worker(app: AppHandle, rx: Receiver<CaptureEvent>) {
    std::thread::spawn(move || {
        let my_pid = std::process::id() as i32;
        while let Ok(ev) = rx.recv() {
            match ev {
                CaptureEvent::Selection { text, x, y, app: app_path, bid, pid } => {
                    if pid == my_pid {
                        debug_log("selection 跳过：自身进程");
                        continue;
                    }
                    // 无效选区：双击空白等场景取不到内容，不弹胶囊
                    if text.trim().is_empty() {
                        debug_log("selection 跳过：空选区");
                        continue;
                    }
                    if settings::is_blacklisted(&app, &app_path, Some(&bid)) {
                        debug_log(format!(
                            "selection 跳过：黑名单命中 app={app_path} bid={bid}"
                        ));
                        continue;
                    }
                    debug_log(format!(
                        "selection 通过 → 发事件：pid={pid} app={app_path} bid={bid} len={} ({x:.0},{y:.0})",
                        text.len()
                    ));
                    let _ = app.emit(
                        "selection://captured",
                        json!({ "text": text, "x": x, "y": y, "app": app_path }),
                    );
                    // 新选区：未钉住的 OCR 独立窗口随收起（钉住则保留）
                    floating::dismiss_ocr_if_unpinned(&app);
                }
                CaptureEvent::PlainClick { x, y } => {
                    // 点击浮动条/识别面板本身：不 dismiss（避免点面板反而被隐藏）
                    let in_ocr = floating::ocr_rect_contains(&app, x, y, 8.0);
                    if floating::rect_contains(&app, x, y, 4.0) || in_ocr {
                        continue;
                    }
                    if floating::is_visible(&app) {
                        let _ = app.emit("selection://dismiss", json!({}));
                    }
                    // 未钉住的 OCR 窗口随普通单击收起（钉住则保留）
                    floating::dismiss_ocr_if_unpinned(&app);
                }
                CaptureEvent::DragMove { x, y } => floating::apply_drag(&app, x, y),
                CaptureEvent::DragEnd => floating::end_drag(&app),
                CaptureEvent::Escape => {
                    // Esc 收起与点击空白走同一个事件：钉住/流式中的「忽略」判定
                    // 全部留在前端 dismiss 守卫里（单一事实来源），此处只管
                    // 「有没有东西可收」——两者都不可见时不发无谓的事件
                    if floating::is_visible(&app) || floating::ocr_visible(&app) {
                        let _ = app.emit("selection://dismiss", json!({}));
                    }
                }
            }
        }
    });
}
