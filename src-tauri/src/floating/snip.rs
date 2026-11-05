//! 截图胶囊会话（snip）：触发后立即出全屏遮罩（洞外变暗），用户直接在遮罩上
//! 拖出选区——选区框与截后遮罩是同一个窗、同一套视觉，无「先系统框选、
//! 松手后补遮罩」的闪变。松手即静默截图（screencapture -R，白环画在矩形
//! 外侧不入镜）：
//! - 识图取字（无自动动作）：截图挂起、胶囊浮在选区右下角，动作选择后才识别
//! - 识图翻译/解释/总结（自动动作）：截图后立即识别执行，会话结束
//! 会话内选区可拖动（snip_frame_move，胶囊实时跟随），拖动后执行时按新矩形
//! 重截当前屏幕。选区阶段误触（过小选区）取消；会话阶段点选区外取消。
//! Windows 复用本模块的 SNIP 状态池与 snip_execute 管线（遮罩窗在
//! ocr::win_region，会话段交互与 macOS 同构：拖动/缩放经 snip_frame_move
//! 上报，执行动作按新矩形 BitBlt 重截）。
//! 纪律：胶囊（置顶层）必须恒在遮罩之上——macOS 遮罩不用 always_on_top
//!（普通层即可盖住应用窗口，遮罩被点击置前也不会盖住胶囊）；Windows 选区
//! 段遮罩须置顶（前台锁会把非 topmost 新窗压在前台应用后面，「遮罩没出现」），
//! 会话段开始即降回普通层（见 ocr::win_region::region_selected）。
//! AppKit 窗口操作必须主线程；macOS 选区/会话全程持 CaptureMuteGuard（在
//! 自家遮罩上的拖选也是拖选手势，不静音会误触发划词管线），Windows 选区
//! 交互段持有、会话段解除（胶囊 hover 依赖捕获管线转发，同一处见上）。
use std::path::PathBuf;
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, LogicalPosition, Manager, WebviewWindow};
// 建遮罩仅在 macOS 会话流程使用（Windows 消费侧只有会话状态池与动作执行命令）
#[cfg(target_os = "macos")]
use tauri::{WebviewUrl, WebviewWindowBuilder};

use crate::capture::{debug_log, CaptureMuteGuard};
use super::{place_rect, snap_pos};
#[cfg(target_os = "macos")]
use super::show_without_activation;
use super::bar::FloatingState;

/// 遮罩窗（snip-frame）label：全屏交互遮罩（选区框选 + 会话视觉共用一窗）
const FRAME_LABEL: &str = "snip-frame";
/// 过小选区阈值（逻辑 px）：低于它视为误触，整段流程取消（与 Windows snap 同策略）
const MIN_REGION: f64 = 8.0;

/// 截图胶囊会话状态（选区完成、动作未选）
struct SnipSession {
    /// 首次框选的截图（未拖动时动作执行直接用它）
    image: PathBuf,
    /// 当前选区（全局逻辑坐标，拖动跟随更新）
    rect: (f64, f64, f64, f64),
    /// 初始选区：rect 与它不一致 = 拖动过，执行时重截
    origin: (f64, f64, f64, f64),
    /// 遮罩窗所在显示器的逻辑矩形 (origin.x, origin.y, w, h)：
    /// 页面（遮罩窗视口）坐标 ↔ 全局逻辑坐标的换算基准
    mon: (f64, f64, f64, f64),
    /// 所在屏缩放：Windows 执行动作时按新矩形 BitBlt 重截，逻辑 → 物理
    /// 坐标换算用（macOS 恒 1.0——snap_region 直收逻辑坐标，不参与）。
    /// 仅 Windows 读写（macOS 编译下无读取方，门控防 dead_code 告警）
    #[cfg(target_os = "windows")]
    scale: f64,
}

static SNIP: Mutex<Option<SnipSession>> = Mutex::new(None);

/// 选区阶段状态：待续流程（自动动作）+ 遮罩所在屏（页面坐标换算基准）
struct SelectState {
    action: Option<&'static str>,
    mon: (f64, f64, f64, f64),
}

static SELECT: Mutex<Option<SelectState>> = Mutex::new(None);

/// 捕获静音守卫：从触发识图持到会话结束——在自家遮罩上的拖选也是拖选
/// 手势（与系统框选静音同理由），不静音会误触发划词管线
static SNIP_MUTE: Mutex<Option<CaptureMuteGuard>> = Mutex::new(None);

/// 流程期间的 AppHandle 镜像：Esc 转发（tap 回调线程）据此关闭遮罩
#[cfg(target_os = "macos")]
static SNIP_APP: Mutex<Option<AppHandle>> = Mutex::new(None);

/// 遮罩窗的 webview 创建/加载会激活 NSApp（WebKit 已知行为），激活把应用的
/// 关键窗口（主窗口）整组提到前面，盖住同层级的遮罩（2026-11-04 实测：Ctrl+S
/// 后主窗口压住遮罩无法框选）。会话期间隐藏主窗口——遮罩铺满全屏本就看不见
/// 它，且激活无可提升的窗口。**只隐藏不还原**（2026-11-05 用户反馈：点动作后
/// 主窗口跟着弹出是噪音——识别结果才是用户要的）：会话结束后保持隐藏，需要
/// 时从托盘/程序坞打开
#[cfg(target_os = "macos")]
fn hide_main_for_session(app: &AppHandle) {
    let a = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(w) = a.get_webview_window("main") {
            let _ = w.hide();
        }
    });
}

/// 光标所在显示器的逻辑矩形（多显示器 v1 取光标屏，与 Windows snap 同策略）。
/// cursor_position 不可用（Err）时降级主屏——定位失败不该终止整个流程
#[cfg(target_os = "macos")]
fn monitor_at_cursor(app: &AppHandle) -> Option<(f64, f64, f64, f64)> {
    let cur = match app.cursor_position() {
        Ok(p) => p,
        Err(e) => {
            debug_log(format!("[snip] cursor_position 不可用（{e}），降级主屏"));
            return primary_monitor_rect(app);
        }
    };
    for m in app.available_monitors().unwrap_or_default() {
        let (px, py) = (m.position().x as f64, m.position().y as f64);
        let (pw, ph) = (m.size().width as f64, m.size().height as f64);
        if cur.x >= px && cur.x < px + pw && cur.y >= py && cur.y < py + ph {
            let s = m.scale_factor();
            return Some((px / s, py / s, pw / s, ph / s));
        }
    }
    debug_log("[snip] 光标不在任何显示器矩形内，降级主屏");
    primary_monitor_rect(app)
}

/// 主显示器逻辑矩形（取不到时 1920x1080 兜底）
#[cfg(target_os = "macos")]
fn primary_monitor_rect(app: &AppHandle) -> Option<(f64, f64, f64, f64)> {
    app.primary_monitor().ok().flatten().map(|m| {
        let s = m.scale_factor();
        let (px, py) = (m.position().x as f64, m.position().y as f64);
        (
            px / s,
            py / s,
            m.size().width as f64 / s,
            m.size().height as f64 / s,
        )
    })
    .or(Some((0.0, 0.0, 1920.0, 1080.0)))
}

/// 进入截图流程：立即出全屏遮罩进入选区阶段（触发即变暗，无系统框选段）。
/// 幂等闸门：遮罩已存在 = 流程进行中，忽略重复触发。
/// 主体必须在后台线程执行：cursor_position / available_monitors 是
/// 「派发到主线程执行 + 当前线程阻塞等结果」的实现，而本函数从全局快捷键/
/// 托盘菜单 handler（主线程事件循环）同步调用——主线程调它们 = 等自己 =
/// 主线程死锁（2026-11-04 卡死回归；上一版这些调用都在后台线程故无恙）
#[cfg(target_os = "macos")]
pub fn begin_selection(app: &AppHandle, action: Option<&'static str>) {
    if app.get_webview_window(FRAME_LABEL).is_some() {
        debug_log("[snip] 幂等闸门命中（遮罩窗已存在），忽略本次触发");
        return;
    }
    *SNIP_APP.lock().unwrap() = Some(app.clone());
    debug_log("[snip] 选区流程开始（后台线程）");
    let app = app.clone();
    std::thread::spawn(move || {
        #[cfg(target_os = "macos")]
        {
            // 屏幕录制权限预检：缺失时无法截取屏幕内容，引导设置后终止
            if !crate::ocr::screen_capture_preflight() {
                debug_log("[snip] 缺少屏幕录制权限，流程终止");
                let _ = std::process::Command::new("open")
                    .arg("x-apple.systempreferences:com.apple.preference.security?ScreenCapture")
                    .spawn();
                crate::toast::show_toast(&app, "需要屏幕录制权限\n已打开系统设置，授权后重试", "err");
                return;
            }
        }
        let Some(mon) = monitor_at_cursor(&app) else {
            debug_log("[snip] 无法确定任何显示器矩形，流程终止");
            crate::toast::show_toast(&app, "无法定位光标所在显示器", "err");
            return;
        };
        debug_log(format!(
            "[snip] 遮罩落屏：origin=({:.0},{:.0}) size={:.0}x{:.0}",
            mon.0, mon.1, mon.2, mon.3
        ));
        *SELECT.lock().unwrap() = Some(SelectState { action, mon });
        *SNIP_MUTE.lock().unwrap() = Some(CaptureMuteGuard::new());
        // 先隐藏主窗口再建遮罩（同在主队列 FIFO 执行，顺序保证）：遮罩 webview
        // 创建会激活本应用，主窗口若可见会被整组提到遮罩上面
        //（见 hide_main_for_session 注释——只隐藏不还原）
        hide_main_for_session(&app);
        show_frame(&app, mon);
    });
}

/// 遮罩窗：铺满目标屏的透明交互窗（选区框选 + 会话视觉共用）。不抢焦点；
/// 接收鼠标事件——选区阶段拖出选区、会话阶段拖动选区、点选区外取消。
/// 先建遮罩再弹胶囊：后显示的胶囊窗口置前，盖在遮罩上方（同屏同层级按显示序）。
/// AppKit 窗口操作必须主线程，建窗与显示经 run_on_main_thread 派发；
/// 销毁等待轮询留后台线程防阻塞主循环
#[cfg(target_os = "macos")]
fn show_frame(app: &AppHandle, mon: (f64, f64, f64, f64)) {
    let app = app.clone();
    if let Some(w) = app.get_webview_window(FRAME_LABEL) {
        // 残留旧遮罩先关（重复触发识图）。close 是异步销毁——必须等窗口真正
        // 消失再重建，否则 tauri 对重复 label 直接 panic（snap 遮罩窗同款处理）
        debug_log("[snip] 发现残留遮罩窗，先关再重建");
        let _ = w.close();
        std::thread::spawn(move || {
            for _ in 0..50 {
                if app.get_webview_window(FRAME_LABEL).is_none() {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            let a = app.clone();
            let _ = app.run_on_main_thread(move || build_frame(&a, mon));
        });
    } else {
        let a = app.clone();
        let _ = app.run_on_main_thread(move || build_frame(&a, mon));
    }
}

/// 建遮罩 + 显示（主线程调用）。建不出来（极罕见）不阻断流程：
/// 终止会话并提示，回不到系统框选（已退役）
#[cfg(target_os = "macos")]
fn build_frame(app: &AppHandle, mon: (f64, f64, f64, f64)) {
    // 并发闸：重复触发竞态下旧窗尚未销毁时跳过重建，防重复 label panic
    if app.get_webview_window(FRAME_LABEL).is_some() {
        return;
    }
    let win = WebviewWindowBuilder::new(app, FRAME_LABEL, WebviewUrl::App("snap.html".into()))
        .title("拾趣选区")
        .visible(false) // 落位后 orderFrontRegardless 显示，不激活本进程
        .decorations(false)
        .transparent(true)
        // 不用 always_on_top：胶囊窗口在其上一层级，遮罩被点击时 macOS 会把
        // 被点窗口升到本层最前——always-on-top 层上遮罩升顶会盖住胶囊（拖动
        // 选框后胶囊变暗、点按钮落到遮罩上被当成「点选区外」取消，2026-11-04
        // 实测）。普通层照样盖住所有普通应用窗口，模态语义不变；胶囊（置顶
        // 层）恒在遮罩之上不受点击置前影响
        .skip_taskbar(true)
        .resizable(false)
        .shadow(false)
        .focused(false)
        // 非 key 窗口收鼠标事件两件套（与胶囊同款）：首点即下发（否则第一次
        // 点击只用于激活窗口）+ mouseMoved 跟踪（拖动/悬停判定依赖它）
        .accept_first_mouse(true)
        // 页面加载探针：选区/会话交互都发生在遮罩页上，页面加载失败 =
        // 全透明隐形窗（吞点击、无选框、无变暗，2026-11-04 实测），Started /
        // Finished 事件区分「URL 未请求」与「加载中断」
        .on_page_load(|_webview, payload| {
            debug_log(format!(
                "[snip] 页面加载事件：{:?} url={}",
                payload.event(),
                payload.url()
            ));
        })
        .position(mon.0, mon.1)
        .inner_size(mon.2, mon.3)
        .build();
    match win {
        Ok(w) => {
            super::apply_hover_tracking(&w);
            // 仅置前不激活（tao 的 show = makeKeyAndOrderFront 会抢焦点，
            // 遮罩窗必须保持非 key：键盘留给用户正在用的应用）
            let _ = show_without_activation(&w);
            debug_log("[snip] 遮罩窗已创建并显示");
        }
        Err(e) => {
            debug_log(format!("[snip] 遮罩创建失败：{e}"));
            end_session(app);
            crate::toast::show_toast(app, "截图组件启动失败\n请重新触发识图取字", "err");
        }
    }
}

/// 关闭遮罩窗（execute / cancel / 收尾；窗口不存在则静默）
fn close_frame(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(FRAME_LABEL) {
        let _ = w.close();
    }
}

/// 选区阶段终止（误触取消/截图失败/自动动作收尾）：关遮罩、放静音、清待续。
/// 主窗口不还原（见 hide_main_for_session 注释——保持隐藏）
fn end_session(app: &AppHandle) {
    close_frame(app);
    *SNIP_MUTE.lock().unwrap() = None;
    *SELECT.lock().unwrap() = None;
}

/// 选区完成（页面在 mouseup 上报，页面坐标 = 遮罩窗视口逻辑坐标）：
/// 静默截图后按槽位分流——自动动作立即识别执行；识图取字进胶囊会话
/// （遮罩原位切换到会话模式，选区视觉无缝过渡）
#[tauri::command]
pub fn snip_region_selected(
    app: AppHandle,
    window: WebviewWindow,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) {
    if window.label() != FRAME_LABEL {
        return;
    }
    debug_log(format!(
        "[snip] 选区回调：page=({x:.0},{y:.0}) {w:.0}x{h:.0}"
    ));
    let Some(state) = SELECT.lock().unwrap().take() else {
        debug_log("[snip] 选区回调被忽略：无进行中的选区状态");
        return;
    };
    if w < MIN_REGION || h < MIN_REGION {
        // 过小选区 = 误触：整段流程终止
        end_session(&app);
        return;
    }
    let rect = (state.mon.0 + x, state.mon.1 + y, w, h);
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        // 静默截图：遮罩洞内透明、白环画在矩形外侧，截到的就是屏幕原始内容；
        // 截图期间遮罩保持显示，选区视觉无缝过渡到会话模式
        #[cfg(target_os = "macos")]
        let image = tauri::async_runtime::spawn_blocking(move || snap_region(rect))
            .await
            .ok()
            .flatten();
        #[cfg(not(target_os = "macos"))]
        let image: Option<PathBuf> = None; // 流程仅 macOS 触发，静默截图亦仅 macOS 实现
        let Some(image) = image else {
            debug_log("[snip] 静默截图失败，流程终止");
            end_session(&app2);
            crate::toast::show_toast(&app2, "截图失败\n请重新触发识图取字", "err");
            return;
        };
        debug_log("[snip] 截图完成，按槽位分流");
        match state.action {
            Some(action) => {
                // 自动动作槽位（识图翻译/解释/总结）：截图即识别执行，会话结束。
                // 结果窗落屏锚点 = 选区矩形中心（结果落操作发生的屏）
                end_session(&app2);
                crate::floating::ocr::set_result_anchor((rect.0 + rect.2 / 2.0, rect.1 + rect.3 / 2.0));
                let service = if action == "translate" {
                    Some(crate::resolve_default_translate_service(&app2))
                } else {
                    None
                };
                crate::ocr::recognize_and_push(&app2, image, Some(action.to_string()), service)
                    .await;
            }
            None => {
                // 识图取字：截图挂起进胶囊会话——遮罩原位切到会话模式
                //（固定洞 + 选区可拖动），胶囊浮在选区右下角
                let mon = state.mon;
                {
                    let mut slot = SNIP.lock().unwrap();
                    if let Some(old) = slot.as_ref() {
                        let _ = std::fs::remove_file(&old.image);
                    }
                    *slot = Some(SnipSession {
                        image,
                        rect,
                        origin: rect,
                        mon,
                        #[cfg(target_os = "windows")]
                        scale: 1.0,
                    });
                }
                debug_log("[snip] 胶囊会话建立");
                // 会话矩形发给遮罩页（select → session 切换，同一矩形无缝过渡；
                // 此时页面必然已加载——选区交互就发生在它上面，无注册竞态）
                let _ = app2.emit_to(
                    FRAME_LABEL,
                    "snip://frame",
                    serde_json::json!({
                        "x": rect.0 - mon.0,
                        "y": rect.1 - mon.1,
                        "w": rect.2,
                        "h": rect.3,
                    }),
                );
                let _ = app2.emit_to(
                    "floating",
                    "snip://captured",
                    serde_json::json!({ "x": rect.0, "y": rect.1, "w": rect.2, "h": rect.3 }),
                );
            }
        }
    });
}

/// 选区阶段取消（页面误触/Esc 兜底调用）：整段流程终止
#[tauri::command]
pub fn snip_region_cancel(app: AppHandle) {
    end_session(&app);
}

/// 选区拖动（页面在 mousemove/mouseup 上报，页面坐标 = 遮罩窗视口逻辑坐标）：
/// 更新会话矩形 + 胶囊实时跟随（place_rect 右下角锚定重排）。
/// 拖动后的选区在动作执行时按新矩形重截当前屏幕（snip_execute）
#[tauri::command]
pub fn snip_frame_move(app: AppHandle, x: f64, y: f64, w: f64, h: f64) {
    let rect = {
        let mut guard = SNIP.lock().unwrap();
        let Some(s) = guard.as_mut() else {
            return;
        };
        // 钳制在本屏内（页面也钳，双保险；坐标转全局逻辑）
        let (mw, mh) = (s.mon.2, s.mon.3);
        let w = w.clamp(8.0, mw);
        let h = h.clamp(8.0, mh);
        let x = x.clamp(0.0, (mw - w).max(0.0));
        let y = y.clamp(0.0, (mh - h).max(0.0));
        let rect = (s.mon.0 + x, s.mon.1 + y, w, h);
        s.rect = rect;
        rect
    };
    // 胶囊跟随：按新选区右下角锚定重排（尺寸沿用 FloatingState 记忆值）
    let Some(win) = app.get_webview_window("floating") else {
        return;
    };
    let state = app.try_state::<FloatingState>();
    let (cw, ch) = match &state {
        Some(st) => {
            let r = *st.lock().unwrap();
            (r.w, r.h)
        }
        None => (328.0, 54.0),
    };
    let (nx, ny) = place_rect(&win, rect.0, rect.1, rect.2, rect.3, cw, ch);
    let (nx, ny) = snap_pos(&win, nx, ny);
    let _ = win.set_position(LogicalPosition::new(nx, ny));
    if let Some(st) = state {
        let mut r = st.lock().unwrap();
        // 窗口位置与状态必须同步：hover 路由（hover_target_at）按 r.x/r.y
        // 判定光标落点并换算视口坐标——只移窗口不改状态，坐标基准就是旧的，
        // 合成 hover 会命中错误的按钮（与原生 :hover 双亮，2026-11-04 实测）
        r.x = nx;
        r.y = ny;
        r.snip_rect = Some(rect);
    }
}

/// macOS：按选区矩形静默截图当前屏幕（screencapture -R，无系统 UI 无遮罩
/// 入镜——白环画在矩形外侧）。截图会话的首次截图与拖动后的重截共用；
/// 遮罩显示期间调用时洞内透明，截到的即屏幕原始内容
#[cfg(target_os = "macos")]
fn snap_region(rect: (f64, f64, f64, f64)) -> Option<PathBuf> {
    let (rx, ry, rw, rh) = rect;
    if rw < 8.0 || rh < 8.0 {
        return None;
    }
    let path = std::env::temp_dir().join(format!(
        "magpie-capture-{}-{}.png",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    ));
    let status = std::process::Command::new("screencapture")
        .args([
            "-x",
            "-R",
            &format!(
                "{},{},{},{}",
                rx.round() as i32, ry.round() as i32, rw.round() as i32, rh.round() as i32
            ),
        ])
        .arg(&path)
        .status()
        .ok()?;
    (status.success() && path.exists()).then_some(path)
}

/// 动作执行：截图移交 OCR_IMAGE，走识别推送管线。动作语义与识图快捷键
/// 一致：ocr = 只出文本面板（识图取字）；translate/explain/summarize =
/// 识别后自动执行该动作。翻译服务在此按设置解析默认项，不依赖结果窗
/// 前端的设置加载时序。
/// 选区拖动过时按新矩形重截当前屏幕（遮罩窗先关、稍候画面还原再截）——
/// 洞里看到的实时画面就是最终识别的内容
#[tauri::command]
pub fn snip_execute(app: AppHandle, action_id: String) {
    debug_log(format!("[snip] 动作执行：{action_id}"));
    close_frame(&app);
    // Windows 遮罩窗（snap）同样保留到动作执行才关：会话段期间遮罩原位显示
    // 选区洞（对齐 macOS 视觉），随本命令一起收场
    #[cfg(target_os = "windows")]
    crate::ocr::finish_windows_snap_session(&app);
    // 会话结束：放静音、清选区阶段残留。主窗口不还原（保持隐藏）
    *SNIP_MUTE.lock().unwrap() = None;
    *SELECT.lock().unwrap() = None;
    let Some(session) = SNIP.lock().unwrap().take() else {
        return;
    };
    tauri::async_runtime::spawn(async move {
        // 拖动过 → 重截新矩形（先等遮罩窗异步关闭、画面还原）
        let image = if session.rect != session.origin {
            #[cfg(target_os = "macos")]
            {
                std::thread::sleep(std::time::Duration::from_millis(120));
                match tauri::async_runtime::spawn_blocking(move || snap_region(session.rect))
                    .await
                    .ok()
                    .flatten()
                {
                    Some(p) => {
                        let _ = std::fs::remove_file(&session.image);
                        p
                    }
                    None => {
                        // 重截失败：会话已清，提示后终止（不回退旧图——区域已变，内容对不上）
                        crate::toast::show_toast(&app, "选区更新失败，请重新截图", "err");
                        let _ = std::fs::remove_file(&session.image);
                        return;
                    }
                }
            }
            #[cfg(target_os = "windows")]
            {
                // Windows：helper 子进程 BitBlt 重截（逻辑矩形 × 屏缩放 → 物理）
                match crate::ocr::resnap_region(session.rect, session.scale).await {
                    Some(p) => {
                        let _ = std::fs::remove_file(&session.image);
                        p
                    }
                    None => {
                        // 重截失败：会话已清，提示后终止（不回退旧图——区域已变，内容对不上）
                        crate::toast::show_toast(&app, "选区更新失败，请重新截图", "err");
                        let _ = std::fs::remove_file(&session.image);
                        return;
                    }
                }
            }
            #[cfg(not(any(target_os = "macos", target_os = "windows")))]
            session.image
        } else {
            session.image
        };
        // 结果窗落屏锚点 = 选区矩形中心（结果落操作发生的屏）
        let r = &session.rect;
        crate::floating::ocr::set_result_anchor((r.0 + r.2 / 2.0, r.1 + r.3 / 2.0));
        crate::floating::ocr::replace_ocr_image(Some(image.clone()));
        let (action, service) = match action_id.as_str() {
            "ocr" | "" => (None, None),
            "translate" => (
                Some("translate".to_string()),
                Some(crate::resolve_default_translate_service(&app)),
            ),
            other => (Some(other.to_string()), None),
        };
        crate::ocr::recognize_and_push(&app, image, action, service).await;
    });
}

/// 存入截图会话（Windows 胶囊流程：region_selected 只截屏不发识别，会话
/// 交由胶囊动作驱动——与 macOS snip_region_selected 的会话建立同一状态池）。
/// mon 传遮罩所在显示器的逻辑矩形（页面坐标 ↔ 全局逻辑换算基准，
/// snip_frame_move 的钳制依赖它）；scale 为该屏缩放（执行时按新矩形
/// BitBlt 重截的逻辑 → 物理换算用）。
/// 仅 Windows 消费（macOS 在 snip_region_selected 内联填充 SNIP）
#[cfg(target_os = "windows")]
pub fn store_session(
    image: PathBuf,
    rect: (f64, f64, f64, f64),
    mon: (f64, f64, f64, f64),
    scale: f64,
) {
    let mut slot = SNIP.lock().unwrap();
    if let Some(old) = slot.as_ref() {
        let _ = std::fs::remove_file(&old.image);
    }
    *slot = Some(SnipSession {
        image,
        rect,
        origin: rect,
        mon,
        scale,
    });
}

/// 取消整段流程（选区阶段或会话阶段通用）：关遮罩、放静音、清待续、删临时图。
/// 胶囊随 dismiss 管线收起（Esc/点选区外取消时不留孤儿胶囊；选区阶段胶囊
/// 本就未显示，dismiss 为无害空操作）
pub(crate) fn cancel_all(app: &AppHandle) {
    end_session(app);
    let _ = app.emit_to("floating", "selection://dismiss", serde_json::json!({}));
    if let Some(s) = SNIP.lock().unwrap().take() {
        let _ = std::fs::remove_file(&s.image);
    }
}

/// 取消会话：删除挂起的截图临时文件并关闭遮罩（dismiss/点选区外时调用）
#[tauri::command]
pub fn snip_cancel(app: AppHandle) {
    cancel_all(&app);
}

/// 点是否落在截图会话遮罩窗（macOS snip-frame / Windows snap）内——遮罩
/// 铺满所在屏，会话期间的点击都落它上面，是否取消由遮罩页自行判定
///（点选区外 = cancel 命令），捕获管线的 dismiss 不得越权收胶囊：Windows
/// 拖选手势被自身闸门拒绝后兜底的 PlainClick 尤其如此——拖动/缩放选区的
/// mouseup 会误杀胶囊（2026-11-05 实测）。dismiss 判定（capture worker）
/// 调用，与 ocr_rect_contains 同构
pub fn mask_rect_contains(app: &AppHandle, x: f64, y: f64, pad: f64) -> bool {
    [FRAME_LABEL, "snap"].iter().any(|label| {
        app.get_webview_window(label).map_or(false, |w| {
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
    })
}

/// Esc 按下（事件 tap 回调转发）：取消进行中的截图流程。遮罩窗是非 key
/// 窗口收不到键盘——选区阶段唯一的取消途径就是这条全局转发（上一版
/// 遮罩关不掉、用户狂按 Esc 只能重启的教训）。tap 回调线程调用：
/// 这里只做轻量锁操作与 close（事件消息），无阻塞调用
#[cfg(target_os = "macos")]
pub fn esc_pressed() {
    let active = SELECT.lock().unwrap().is_some() || SNIP.lock().unwrap().is_some();
    if !active {
        return;
    }
    if let Some(app) = SNIP_APP.lock().unwrap().clone() {
        cancel_all(&app);
    }
}
