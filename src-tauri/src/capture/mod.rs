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
        /// Ctrl/⌘ 正在被按住（用于"按住 Ctrl 再选中文本"的交互，直接弹出不挂起）
        ctrl_held: bool,
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
    /// 全局鼠标移动（悬浮胶囊可见时节流转发）：供前端合成 hover——
    /// 非 key 窗口收不到 mouseMoved，WebKit 只给活动页面渲染 :hover
    HoverMove {
        x: f64,
        y: f64,
    },
    /// 全局按下 Esc（回调侧已过滤为仅 Esc 按下，且浮动条/面板可能并未显示）
    Escape,
}

#[cfg(target_os = "macos")]
pub mod macos;
#[cfg(target_os = "macos")]
pub use macos::start;
#[cfg(target_os = "macos")]
use macos::{
    ax_service_probe as platform_ax_service_probe,
    capture_available as platform_capture_available,
    is_accessibility_granted,
    listen_event_access as platform_listen_event_access,
    open_accessibility_settings as open_platform_settings,
    prompt_accessibility as prompt_platform_accessibility,
    request_listen_access as platform_request_listen_access,
    request_screen_capture_access as platform_request_screen_capture_access,
    screen_capture_access as platform_screen_capture_access,
};

// Windows 后端：WH_MOUSE_LL 低级钩子 + UI Automation 选区查询（docs/03 §A.7）
#[cfg(target_os = "windows")]
mod windows;
#[cfg(target_os = "windows")]
pub use windows::start;
#[cfg(target_os = "windows")]
use windows::{
    ax_service_probe as platform_ax_service_probe,
    capture_available as platform_capture_available,
    is_accessibility_granted,
    listen_event_access as platform_listen_event_access,
    open_accessibility_settings as open_platform_settings,
    prompt_accessibility as prompt_platform_accessibility,
    screen_capture_access as platform_screen_capture_access,
};

// 其余平台占位（Linux 等，无划词能力）
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod other;
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub use other::start;
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
use other::{
    ax_service_probe as platform_ax_service_probe,
    capture_available as platform_capture_available,
    is_accessibility_granted,
    listen_event_access as platform_listen_event_access,
    open_accessibility_settings as open_platform_settings,
    prompt_accessibility as prompt_platform_accessibility,
    screen_capture_access as platform_screen_capture_access,
};

use serde::Serialize;
use serde_json::json;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::Receiver;
use std::sync::Mutex;
use std::time::{Duration, Instant};
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

// ---------- 划词弹出门控（capture_mode == "ctrl" 时的等待槽） ----------

/// 等待 Ctrl/⌘ 触发的挂起选区。deadline 线程在 2s 后清空；新手势覆盖；PlainClick/Escape
/// 清空；暂停清空。key_proc / tap callback 在修饰键单独抬起时读取并 emit。
pub(crate) struct PendingPop {
    pub text: String,
    pub x: f64,
    pub y: f64,
    pub app: String,
    #[allow(dead_code)]
    pub bid: String,
    pub pid: i32,
    pub gen: u64,
    #[allow(dead_code)]
    pub deadline: Instant,
}

pub(crate) static PENDING_POP: Mutex<Option<PendingPop>> = Mutex::new(None);
pub(crate) static POP_GEN: AtomicU64 = AtomicU64::new(0);

/// 挂起一个选区等待 Ctrl/⌘ 触发。返回本次的 gen（用于 deadline 线程校验）。
pub(crate) fn park_selection(p: PendingPop) -> u64 {
    let gen = p.gen;
    *PENDING_POP.lock().unwrap() = Some(p);
    gen
}

/// 弹出挂起的选区（修饰键单独抬起时调用）。返回 Some(payload) 表示有东西可弹。
pub(crate) fn pop_pending() -> Option<(String, f64, f64, String, i32)> {
    PENDING_POP
        .lock()
        .unwrap()
        .take()
        .map(|p| (p.text, p.x, p.y, p.app, p.pid))
}

/// 清空挂起槽（取消条件：新手势覆盖、PlainClick、Escape、暂停）。
pub(crate) fn clear_pending() {
    *PENDING_POP.lock().unwrap() = None;
}

/// 启动 deadline 线程：2s 后若 gen 仍匹配则清空槽。
pub(crate) fn spawn_deadline(app: AppHandle, gen: u64) {
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(2000));
        let mut guard = PENDING_POP.lock().unwrap();
        if let Some(p) = guard.as_ref() {
            if p.gen == gen {
                *guard = None;
            }
        }
        drop(guard);
        // 避免 unused warning
        let _ = &app;
    });
}

/// 捕获链路调试日志：stderr 仅 debug 构建；文件（magpie.log，与 settings 同
/// 目录）全构建落盘——release 用户的「复制日志」按钮依赖它
pub(crate) fn debug_log(msg: impl std::fmt::Display) {
    if cfg!(debug_assertions) {
        eprintln!("[magpie:capture] {msg}");
    }
    crate::user_log(&format!("[capture] {msg}"));
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
    /// 划词捕获在本平台是否真实可用：前端据此显隐「划词/黑名单」导航
    ///（无能力的菜单不显示，winVmac Windows 适配约定）
    pub capture_available: bool,
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
        capture_available: platform_capture_available(),
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
            // 划词功能总开关：托盘菜单关闭后，所有选区事件直接丢弃
            if !settings::current(&app).capture_enabled {
                continue;
            }
            match ev {
                CaptureEvent::Selection { text, x, y, app: app_path, bid, pid, ctrl_held } => {
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

                    // 划词弹出门控：capture_mode == "ctrl" 时，
                    // 若 Ctrl 正在被按住（"按住 Ctrl 再选中文本"），直接弹出；
                    // 否则挂起等待 Ctrl 抬起
                    let mode = settings::current(&app).capture_mode;
                    if mode == "ctrl" && !ctrl_held {
                        let gen = POP_GEN.fetch_add(1, Ordering::Relaxed) + 1;
                        let pending = PendingPop {
                            text,
                            x,
                            y,
                            app: app_path.clone(),
                            bid,
                            pid,
                            gen,
                            deadline: Instant::now(),
                        };
                        park_selection(pending);
                        spawn_deadline(app.clone(), gen);
                        debug_log(format!(
                            "selection 挂起等待 Ctrl/⌘ gen={gen} app={app_path:?}"
                        ));
                        continue;
                    }

                    // 正常通过不发日志：取词侧（forward_selection）已打完整信息，
                    // 这里再打一遍即每次划词双份刷屏
                    let _ = app.emit(
                        "selection://captured",
                        // pid 供智能提取/日历路径反查来源页面 URL（AXFocusedApplication
                        // 在点击瞬间不稳定，按 pid 直连可靠，见 pageurl.rs）
                        json!({ "text": text, "x": x, "y": y, "app": app_path, "pid": pid }),
                    );
                    // 新选区：未钉住的 OCR 独立窗口随收起（钉住则保留）
                    floating::dismiss_ocr_if_unpinned(&app);
                }
                CaptureEvent::PlainClick { x, y } => {
                    // 取消挂起的选区（用户点了别处）
                    clear_pending();
                    // 点击浮动条/识别面板/截图遮罩本身：不 dismiss（避免点面板
                    // 反而被隐藏）。遮罩上的取消由遮罩页自己判定（点选区外发
                    // cancel 命令）——Windows 拖选被自身闸门拒绝后兜底的
                    // PlainClick 落点必在遮罩上，不抑制会把会话胶囊误杀
                    let in_ocr = floating::ocr_rect_contains(&app, x, y, 8.0);
                    if floating::rect_contains(&app, x, y, 4.0)
                        || in_ocr
                        || floating::snip::mask_rect_contains(&app, x, y, 4.0)
                    {
                        continue;
                    }
                    if floating::is_visible(&app) {
                        let _ = app.emit("selection://dismiss", json!({}));
                    }
                    // 未钉住的 OCR 窗口随普通单击收起（钉住则保留）
                    floating::dismiss_ocr_if_unpinned(&app);
                }
                CaptureEvent::DragMove { x, y } => floating::apply_drag(&app, x, y),
                CaptureEvent::HoverMove { x, y } => floating::route_hover(&app, x, y),
                CaptureEvent::DragEnd => floating::end_drag(&app),
                CaptureEvent::Escape => {
                    // 取消挂起的选区
                    clear_pending();
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
