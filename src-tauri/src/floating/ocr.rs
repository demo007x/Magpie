//! 结果窗（OCR 窗口）：钉住状态、位置/尺寸记忆与预设、pending 选区/截图存取
//! （事件可能早于 webview 就绪，先存后取）、显隐与命中判定。
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, LogicalPosition, Manager, WebviewWindow};
use tauri::LogicalSize;

use serde_json::json;

use crate::capture::debug_log;
use super::{clamp_move_window, show_without_activation, snap_pos, WindowPos};
use super::bar::{FloatingState, update_hover_feed};

// ---- OCR 独立窗口：钉住状态 + 待显示结果（事件可能早于 webview 就绪，先存后取） ----

/// 钉住：OCR 窗口忽略 dismiss / 新选区，就地常驻。
/// 这是「用户最后一次点钉/取消钉」的运行时镜像：启动时从 settings 读出
/// （默认钉住），点钉按钮写回磁盘；新结果弹出时不再改写它
static OCR_PINNED: AtomicBool = AtomicBool::new(true);

/// 启动时把磁盘上的「钉住」偏好装进运行时（在 settings::init 之后调用）
pub fn init_result_pin(app: &AppHandle) {
    let pinned = crate::settings::current(app).result_window_pinned;
    OCR_PINNED.store(pinned, Ordering::Relaxed);
}

/// 结果窗口最近一次的逻辑位置：窗口存活期间原地复用（内容刷新不跳位），
/// 关闭后记住、下次（含重启后）在同一位置出现——「钉在我喜欢的位置」
static LAST_RESULT_POS: Mutex<Option<(f64, f64)>> = Mutex::new(None);

/// 结果窗口用户尺寸（逻辑坐标）：宽与高都只由用户拖动改变、内容不参与，
/// 拖动钳制在默认 min/max 内；None = 尚未确定（显示时回退窗口当前尺寸）
static LAST_RESULT_SIZE: Mutex<Option<(f64, f64)>> = Mutex::new(None);

/// 结果窗口默认尺寸上下限（逻辑坐标）：用户怎么拖都不会超出
pub const RESULT_MIN_W: f64 = 320.0;
pub const RESULT_MAX_W: f64 = 560.0;
pub const RESULT_MIN_H: f64 = 200.0;
pub const RESULT_MAX_H: f64 = 800.0;
/// 结果窗口尺寸落位（产品规范，勿改语义）：
/// 窗口尺寸只有两个变化来源——① 用户拖动（拖过的尺寸被记住，跨会话生效）
/// ② 外观配置预设（用户明确选择，写入记忆）。其余任何情况——切换动作、
/// 流式输出、菜单开合——都不得改变窗口尺寸与位置。内容超限时只在结果
/// 滚动区内滚动，窗口不动（长文本、短窗口均如此）
fn apply_result_window_size(win: &WebviewWindow) {
    let scale = win.scale_factor().unwrap_or(2.0);
    let (uw, uh) = match *LAST_RESULT_SIZE.lock().unwrap() {
        Some(sz) => sz,
        None => win
            .inner_size()
            .map(|s| (s.width as f64 / scale, s.height as f64 / scale))
            .unwrap_or((420.0, 340.0)),
    };
    let w = uw.clamp(RESULT_MIN_W, RESULT_MAX_W);
    let h = uh.clamp(RESULT_MIN_H, RESULT_MAX_H);
    let _ = win.set_size(LogicalSize::new(w, h));
    #[cfg(debug_assertions)]
    {
        let phys = win.inner_size().map(|s| format!("{}x{}", s.width, s.height));
        let scale = win.scale_factor().unwrap_or(0.0);
        debug_log(format!(
            "[result-size] rust: user={uw}x{uh} -> set_size {w}x{h} phys={phys:?} scale={scale}"
        ));
    }
    // 窗口底部越出屏幕（预设可能高过小屏）则整体上移，保证完整可见
    if let (Ok(pos), Ok(Some(m))) = (win.outer_position(), win.current_monitor()) {
        let m_pos = m.position();
        let m_size = m.size();
        let mt = m_pos.y as f64 / scale;
        let mb = (m_pos.y as f64 + m_size.height as f64) / scale;
        let bottom = pos.y as f64 / scale + h;
        if bottom > mb - 8.0 {
            let ny = (mb - 8.0 - h).max(mt);
            let _ = win.set_position(LogicalPosition::new(pos.x as f64 / scale, ny));
            if let Ok(mut last) = LAST_RESULT_POS.lock() {
                *last = Some((pos.x as f64 / scale, ny));
            }
        }
    }
}

/// 把最近位置镜像写入设置持久化（低频调用：显示定位与关闭时）
fn persist_result_pos(app: &AppHandle, pos: (f64, f64)) {
    crate::settings::patch(app, |s| s.result_window_pos = Some([pos.0, pos.1]));
}
/// 结果窗口的定位模式：贴着胶囊锚点下方（划词结果）或屏幕居中（识图结果）
static RESULT_BELOW_ANCHOR: AtomicBool = AtomicBool::new(false);

/// 待显示的结果：文本 + 可选的自动执行动作
/// （划词结果导流：面板弹出后自动跑翻译/解释/总结，run = 动作 id + 服务）。
/// 识别截图原图不在此保存——见 OCR_IMAGE（钉图数据源）
struct OcrPending {
    text: String,
    from_ocr: bool,
    run: Option<(String, Option<String>)>,
    /// 选区来源进程 pid（划词导流时携带）：智能提取/日历路径反查页面 URL 用；
    /// 截屏 OCR 无来源进程，置 0
    pid: i32,
}

static OCR_PENDING: Mutex<Option<OcrPending>> = Mutex::new(None);

/// 识别截图原图路径（独立于 pending：面板消费 pending 后仍保留，
/// 供「钉图」取走所有权；新识别/划词导流时清理旧文件）
static OCR_IMAGE: Mutex<Option<std::path::PathBuf>> = Mutex::new(None);

/// 替换 OCR_IMAGE 内容，旧路径与新路径不同时删除旧临时文件
pub(crate) fn replace_ocr_image(image: Option<std::path::PathBuf>) {
    let mut slot = OCR_IMAGE.lock().unwrap();
    if let Some(old_path) = slot.as_ref() {
        if image.as_deref() != Some(old_path.as_path()) {
            let _ = std::fs::remove_file(old_path);
        }
    }
    *slot = image;
}

pub fn ocr_pinned() -> bool {
    OCR_PINNED.load(Ordering::Relaxed)
}

#[tauri::command]
pub fn set_ocr_pinned(app: AppHandle, pinned: bool) {
    OCR_PINNED.store(pinned, Ordering::Relaxed);
    // 钉/取消钉是用户对结果面板关闭方式的偏好，落盘跨重启保留
    crate::settings::patch(&app, |st| st.result_window_pinned = pinned);
}

/// 当前 webview 是否为 OCR 独立窗口（App 据此决定渲染模式）
#[tauri::command]
pub fn ocr_window_mode(window: WebviewWindow) -> bool {
    window.label() == "ocr"
}

/// 待显示结果视图（序列化给前端）
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingResult {
    pub text: String,
    pub from_ocr: bool,
    pub pinned: bool,
    /// 是否携带截图（文本识别流程：面板先以图片预览占位）
    pub has_image: bool,
    /// 截图路径（前端 convertFileSrc 预览用；不参与钉图所有权移交）
    pub image: Option<String>,
    pub run: Option<PendingRun>,
    /// 选区来源进程 pid（0 = 无来源，如截屏 OCR）
    pub pid: i32,
}

/// 自动执行的动作（id + 可选翻译服务）
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PendingRun {
    pub id: String,
    pub service: Option<String>,
}

/// 取走待显示结果（App 挂载或收到事件时调用；消费式取走文本，
/// 截图原图留在 OCR_IMAGE 里供「钉图」随时复制）
#[tauri::command]
pub fn ocr_take_pending() -> Option<PendingResult> {
    let mut guard = OCR_PENDING.lock().unwrap();
    let p = guard.take()?;
    let run = p.run.map(|(id, service)| PendingRun { id, service });
    let from_ocr = p.from_ocr;
    // 截图路径从 OCR_IMAGE 读取（peek 不取走，钉图复制副本）
    let (has_image, image_path) = {
        let slot = OCR_IMAGE.lock().unwrap();
        (
            slot.is_some(),
            slot.as_ref().map(|p| p.to_string_lossy().into_owned()),
        )
    };
    // run 不随 take 消费：动作执行期间新事件/挂载仍可拿到（由前端 phase 保证只跑一次）
    if let Some(r) = &run {
        let text = p.text.clone();
        *guard = Some(OcrPending {
            text,
            from_ocr,
            run: Some((r.id.clone(), r.service.clone())),
            pid: p.pid,
        });
    }
    Some(PendingResult {
        has_image,
        image: image_path,
        text: p.text,
        from_ocr,
        pinned: ocr_pinned(),
        run,
        pid: p.pid,
    })
}

/// 取走截图原图（「钉图」动作，所有权移交钉图窗口；取走后面板不再可钉）
/// 钉图数据源：克隆路径不消费——同一识别结果可反复钉/多颗钉（钉图各自持
/// 文件副本，见 pin.rs）。原图生命周期归本槽位：新识别替换时删除旧临时文件
pub fn ocr_peek_image() -> Option<std::path::PathBuf> {
    OCR_IMAGE.lock().unwrap().clone()
}

/// 存入待显示识别结果（托盘「识图取字」与识图快捷键流程调用）。
/// run = (动作 id, 服务)：Some 时面板弹出后自动执行该动作（识图翻译/解释/总结）；
/// None 时只展示识别文本等用户操作。
/// 截图原图存入独立的 OCR_IMAGE（替换时顺带清理旧文件）。
/// 钉住状态沿用用户上次的选择（见 OCR_PINNED 说明），结果本身不改它
pub fn ocr_set_pending(
    text: String,
    image: Option<std::path::PathBuf>,
    run: Option<(String, Option<String>)>,
) {
    replace_ocr_image(image);
    let mut pending = OCR_PENDING.lock().unwrap();
    *pending = Some(OcrPending { text, from_ocr: true, run, pid: 0 });
}

/// 存入划词导流结果（面板弹出后自动执行 run）
pub fn set_selection_pending(text: String, action_id: String, service: Option<String>, pid: i32) {
    // 划词不带图：清掉上一次识别遗留的截图
    replace_ocr_image(None);
    let mut pending = OCR_PENDING.lock().unwrap();
    *pending = Some(OcrPending {
        text,
        from_ocr: false,
        run: Some((action_id, service)),
        pid,
    });
    drop(pending);
    RESULT_BELOW_ANCHOR.store(true, Ordering::Relaxed);
}

/// 更新待显示结果的识别文本（两段式推送：先图后文的第二段）
/// OCR 窗口内容就绪：定位到主屏水平居中、上方 1/3 处并显示（不激活本进程）。
/// 顺序保证"先渲染后显示"——用户看不到白屏/动画。
#[tauri::command]
pub fn ocr_window_ready(window: WebviewWindow) {
    if window.label() != "ocr" {
        return;
    }
    // 定位三级优先级：
    // 1. 记忆位置（会话镜像 / 上次持久化）——窗口原地复用，「钉在喜欢的位置」
    // 2. 划词导流：胶囊窗口正下方（左对齐 + 8pt 间隔）
    // 3. 首次识图：主屏居中偏上
    // 用胶囊窗口实际矩形（而非光标锚点），屏边翻转定位时也能精确对齐
    let below_anchor = RESULT_BELOW_ANCHOR.swap(false, Ordering::Relaxed);
    {
        let saved = crate::settings::current(&window.app_handle());
        let mut pos_m = LAST_RESULT_POS.lock().unwrap();
        if pos_m.is_none() {
            *pos_m = saved.result_window_pos.map(|p| (p[0], p[1]));
        }
        drop(pos_m);
        // 用户尺寸：会话内拖拽过的优先，其次持久化值；
        // 都没有则把当前（配置默认）尺寸确立为用户尺寸。
        // 有值时先落到窗口上再定位显示（窗口创建尺寸是配置默认值）
        let mut user = *LAST_RESULT_SIZE.lock().unwrap();
        if user.is_none() {
            user = saved.result_window_size.map(|s| (s[0], s[1]));
        }
        if user.is_none() {
            let scale = window.scale_factor().unwrap_or(2.0);
            user = window
                .inner_size()
                .map(|s| (s.width as f64 / scale, s.height as f64 / scale))
                .ok();
        }
        if let Some((uw, uh)) = user {
            let w = uw.clamp(RESULT_MIN_W, RESULT_MAX_W);
            let h = uh.clamp(RESULT_MIN_H, RESULT_MAX_H);
            *LAST_RESULT_SIZE.lock().unwrap() = Some((w, h));
            let _ = window.set_size(LogicalSize::new(w, h));
        }
    }
    let last = *LAST_RESULT_POS.lock().unwrap();
    let (cap_x, cap_y, cap_h) = {
        let st = window.app_handle().state::<FloatingState>();
        let r = *st.lock().unwrap();
        (r.x, r.y, r.h)
    };
    let (mw, mh) = window
        .primary_monitor()
        .ok()
        .flatten()
        .map(|m| {
            let sc = m.scale_factor();
            let sz = m.size();
            (sz.width as f64 / sc, sz.height as f64 / sc)
        })
        .unwrap_or((1920.0, 1080.0));
    let size_l = window.inner_size().map(|v| LogicalSize::new(v.width as f64 / 2.0, v.height as f64 / 2.0)).unwrap_or(LogicalSize::new(420.0, 340.0));
    let (wx, wy) = (size_l.width, size_l.height);
    let (nx, ny) = if let Some((lx, ly)) = last {
        // 记忆位置：夹取在主屏内（跨屏记忆点落在副屏外时回退主屏）
        (lx.clamp(0.0, (mw - wx).max(0.0)), ly.clamp(0.0, (mh - wy).max(0.0)))
    } else if below_anchor {
        // 胶囊正下方：左对齐、8pt 间隔；下方放不下翻转到胶囊上方
        let nx = cap_x.clamp(0.0, (mw - wx).max(0.0));
        let ny_top = cap_y + cap_h + 8.0;
        let ny = if ny_top + wy > mh {
            (cap_y - wy - 8.0).max(0.0)
        } else {
            ny_top
        };
        (nx, ny)
    } else {
        ((mw - wx) / 2.0, (mh - wy) / 3.0)
    };
    if let Ok(Some(m)) = window.primary_monitor() {
        let s = m.scale_factor();
        let pos = m.position();
        let (sx, sy) = snap_pos(
            &window,
            pos.x as f64 / s + nx,
            pos.y as f64 / s + ny,
        );
        let _ = window.set_position(LogicalPosition::new(sx, sy));
        persist_result_pos(&window.app_handle(), (nx, ny));
    }
    let _ = show_without_activation(&window);
    update_hover_feed(window.app_handle());
}

/// 划词结果导流：结果送入独立结果窗口（复用识图窗口），默认钉住，
/// 定位在胶囊锚点下方；胶囊随即隐藏，避免误触导致结果消失
#[tauri::command]
pub fn push_selection_result(
    app: AppHandle,
    text: String,
    action_id: String,
    service: Option<String>,
    pid: Option<i32>,
) {
    set_selection_pending(text, action_id, service, pid.unwrap_or(0));
    let _ = app.emit(
        "selection://captured",
        serde_json::json!({ "text": "", "x": -1.0, "y": -1.0, "app": "ocr" }),
    );
}

/// 结果窗口获得焦点：面板被点击后调用，使 Esc/⌘P/⌘W 键盘闭环生效
/// （窗口默认不抢焦点——保持「不打断阅读」的设计，仅在用户主动点击时聚焦）
#[tauri::command]
pub fn focus_ocr_window(window: WebviewWindow) {
    if window.label() == "ocr" {
        let _ = window.set_focus();
    }
}

/// 用户拖拽尺寸手柄：更新用户尺寸并落位。
/// 宽高只由拖动改变，钳制在默认 min/max 内
#[tauri::command]
pub fn set_result_window_size(window: WebviewWindow, width: f64, height: f64) {
    if window.label() != "ocr" {
        return;
    }
    let w = width.clamp(RESULT_MIN_W, RESULT_MAX_W);
    let h = height.clamp(RESULT_MIN_H, RESULT_MAX_H);
    if let Ok(mut sz) = LAST_RESULT_SIZE.lock() {
        *sz = Some((w, h));
    }
    apply_result_window_size(&window);
}

/// 外观页选择结果窗口预设尺寸：写入用户尺寸记忆并持久化；
/// 结果窗口正开着就立即应用（钳制同拖拽路径），关着则下次显示生效。
/// 预设只是「默认尺寸」的便捷入口，用户拖拽微调仍会记忆并优先
#[tauri::command]
pub fn apply_result_preset(app: AppHandle, width: f64, height: f64) {
    let w = width.clamp(RESULT_MIN_W, RESULT_MAX_W);
    let h = height.clamp(RESULT_MIN_H, RESULT_MAX_H);
    if let Ok(mut sz) = LAST_RESULT_SIZE.lock() {
        *sz = Some((w, h));
    }
    crate::settings::patch(&app, |st| st.result_window_size = Some([w, h]));
    if ocr_visible(&app) {
        if let Some(win) = app.get_webview_window("ocr") {
            apply_result_window_size(&win);
        }
    }
}

/// 持久化结果窗口的位置与尺寸（拖拽尺寸结束时调用）
#[tauri::command]
pub fn persist_result_window_state(window: WebviewWindow) {
    if window.label() != "ocr" {
        return;
    }
    let app = window.app_handle();
    let pos = *LAST_RESULT_POS.lock().unwrap();
    let size = *LAST_RESULT_SIZE.lock().unwrap();
    crate::settings::patch(app, |st| {
        st.result_window_pos = pos.map(|p| [p.0, p.1]);
        st.result_window_size = size.map(|s| [s.0, s.1]);
    });
}

/// 收起 OCR 窗口（解锁/✕）
#[tauri::command]
pub fn hide_ocr_window(window: WebviewWindow) {
    if window.label() == "ocr" {
        let app = window.app_handle();
        let pos = *LAST_RESULT_POS.lock().unwrap();
        let size = *LAST_RESULT_SIZE.lock().unwrap();
        crate::settings::patch(app, |st| {
            st.result_window_pos = pos.map(|p| [p.0, p.1]);
            st.result_window_size = size.map(|s| [s.0, s.1]);
        });
        let _ = window.hide();
        update_hover_feed(window.app_handle());
    }
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
        let last = *LAST_RESULT_POS.lock().unwrap();
        if let Some(pos) = last {
            persist_result_pos(app, pos);
        }
        if let Some(w) = app.get_webview_window("ocr") {
            let _ = w.hide();
            let _ = app.emit_to("ocr", "selection://dismiss", json!({}));
            update_hover_feed(app);
        }
    }
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
    if let Ok(pos) = window.outer_position() {
        let scale = window.scale_factor().unwrap_or(2.0);
        if let Ok(mut last) = LAST_RESULT_POS.lock() {
            *last = Some((pos.x as f64 / scale, pos.y as f64 / scale));
        }
    }
}
