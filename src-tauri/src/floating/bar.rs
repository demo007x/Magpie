//! 浮动条窗口：光标锚点定位（右下优先、翻转防出屏）、尺寸自适应、显隐、
//! 拖拽（detect 线程经事件转发驱动）、hover 合成数据源与命中路由。
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewWindow};

use serde::Serialize;
use serde_json::json;

use crate::capture::debug_log;

use super::{place, show_without_activation, snap_pos, monitor_rect, WindowPos, DEFAULT_W, DEFAULT_H};
use super::pops::hide_pops;
use super::ocr::ocr_visible;
use super::pops::{pops_visible, pop_rect_contains};
use super::material::{self, MaterialCard};

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

/// hover 合成数据源开关：悬浮胶囊**或结果窗**任一可见时开启，tap 回调据此放行
/// MouseMoved（单独用 AtomicBool 而非读窗口状态——tap 回调线程拿不到 AppHandle）。
/// 各显示/隐藏路径经由 update_hover_feed 维护（唯一写入口，没有独立 setter）
static HOVER_FEED: AtomicBool = AtomicBool::new(false);

/// hover 合成数据源开关：悬浮胶囊**或结果窗**任一可见时开启，tap 回调据此放行
/// MouseMoved（单独用 AtomicBool 而非读窗口状态——tap 回调线程拿不到 AppHandle）。
/// 各显示/隐藏路径经由 update_hover_feed 维护（唯一写入口，没有独立 setter）。
/// 仅 macOS 后端消费（Windows 的 hover 由捕获后端直接转发 MouseMove）
#[cfg(target_os = "macos")]
pub fn hover_feed_active() -> bool {
    HOVER_FEED.load(Ordering::Relaxed)
}

/// 任一 hover 目标窗口（悬浮胶囊 / 结果窗 / 二级浮层）可见即开 feed；
/// 全部不可见则关。每个显示/隐藏路径的收尾处调用
pub fn update_hover_feed(app: &AppHandle) {
    let on = is_visible(app) || ocr_visible(app) || pops_visible(app);
    HOVER_FEED.store(on, Ordering::Relaxed);
    // 关 feed 即光标不再被跟踪：清边沿记忆，避免下次开启后首个事件误发「离开」
    if !on {
        HOVER_IN.store(false, Ordering::Relaxed);
        *HOVER_LAST.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }
}

/// 光标落在哪个 hover 目标窗口内 → (窗口 label, 视口坐标)。
/// 悬浮胶囊优先（同屏叠加时它是最近的交互目标）。视口坐标 = 全局逻辑坐标 − 窗口原点
pub fn hover_target_at(app: &AppHandle, gx: f64, gy: f64) -> Option<(String, f64, f64)> {
    if let Some(state) = app.try_state::<FloatingState>() {
        let r = *state.lock().unwrap();
        if r.visible && gx >= r.x && gx <= r.x + r.w && gy >= r.y && gy <= r.y + r.h {
            return Some(("floating".into(), gx - r.x, gy - r.y));
        }
    }
    if let Some(w) = app.get_webview_window("ocr") {
        if w.is_visible().unwrap_or(false) {
            let scale = w.scale_factor().unwrap_or(2.0);
            if let (Ok(pos), Ok(size)) = (w.outer_position(), w.inner_size()) {
                let lx = pos.x as f64 / scale;
                let ly = pos.y as f64 / scale;
                let lw = size.width as f64 / scale;
                let lh = size.height as f64 / scale;
                if gx >= lx && gx <= lx + lw && gy >= ly && gy <= ly + lh {
                    return Some(("ocr".into(), gx - lx, gy - ly));
                }
            }
        }
    }
    // Windows 分离卡：光标在二级浮层卡内也路由给胶囊窗口——胶囊是唯一交互逻辑端
    // （弹层是哑渲染端），hover 驻留的「离开才收起」判定靠持续收到事件区分
    // 「光标在菜单里挑选」与「光标已划走」，缺这条会在延迟收起时误收。
    // 坐标按胶囊原点换算，落在胶囊视口外属预期（前端命中不了元素即视为浮层区）
    if let Some(state) = app.try_state::<FloatingState>() {
        let r = *state.lock().unwrap();
        if r.visible && pop_rect_contains(gx, gy, 0.0) {
            return Some(("floating".into(), gx - r.x, gy - r.y));
        }
    }
    None
}

/// hover 路由的「光标在目标窗口内」边沿记忆（配合 route_hover 的离开信号）
static HOVER_IN: AtomicBool = AtomicBool::new(false);
/// 上次命中的窗口 label：离开边沿要发回光标实际划出的那个窗口
///（胶囊与结果窗都有 hover 菜单，发错窗口菜单会悬空不收）
static HOVER_LAST: Mutex<Option<&'static str>> = Mutex::new(None);

/// capture 线程的 HoverMove 消费：命中目标窗口发坐标事件（同 hover_target_at）；
/// 光标从目标窗口内划出的瞬间补发一次 `hover://left` 边沿给最后命中的窗口——
/// Windows 分离卡下胶囊文档看不到弹层窗口的边界，光标从弹层直接划走时
/// 胶囊收不到任何 mouseleave，没有这条信号「延迟收起」判定会失灵（菜单悬空不收）
pub fn route_hover(app: &AppHandle, gx: f64, gy: f64) {
    if let Some((label, cx, cy)) = hover_target_at(app, gx, gy) {
        *HOVER_LAST.lock().unwrap_or_else(|e| e.into_inner()) = Some(match label.as_str() {
            "ocr" => "ocr",
            _ => "floating",
        });
        HOVER_IN.store(true, Ordering::Relaxed);
        // pop 标记仅 floating 消费：光标在哪张分离卡内（panel/menu，见
        // pop_rect_at），胶囊驻留区判定用；macOS 恒 None
        let pop = if label == "floating" {
            super::pops::pop_rect_at(gx, gy)
        } else {
            None
        };
        let _ = app.emit_to(
            label.as_str(),
            "hover://move",
            json!({ "x": cx, "y": cy, "pop": pop }),
        );
    } else if HOVER_IN.swap(false, Ordering::Relaxed) {
        let last = HOVER_LAST.lock().unwrap_or_else(|e| e.into_inner()).take();
        if let Some(label) = last {
            let _ = app.emit_to(label, "hover://left", json!({}));
        }
    }
}

pub fn is_visible(app: &AppHandle) -> bool {
    app.try_state::<FloatingState>()
        .map(|s| s.lock().unwrap().visible)
        .unwrap_or(false)
}

/// 点是否落在胶囊窗口矩形内（含四周 FLOAT_PAD 出血，另加 pad 边距）——
/// 拖拽起点判定用：按住二级浮层卡拖动不是搬移胶囊。出血环内的按下也算
/// 胶囊（拖拽把手外扩 8px），不会误触下层应用的划词
pub fn capsule_rect_contains(app: &AppHandle, x: f64, y: f64, pad: f64) -> bool {
    app.try_state::<FloatingState>().map_or(false, |s| {
        let r = *s.lock().unwrap();
        r.visible
            && x >= r.x - pad
            && x <= r.x + r.w + pad
            && y >= r.y - pad
            && y <= r.y + r.h + pad
    })
}

/// 点是否落在任一可见卡（胶囊或二级浮层）内（含 pad 边距）——
/// 用于抑制"点击卡片本身"触发的 dismiss。pad 让卡间缝也不触发：
/// 瞄准二级时鼠标掠过缝内的误点不该把整条收掉（缝内点击会同时落到
/// 下层应用，但收起胶囊比误穿透更伤）
pub fn rect_contains(app: &AppHandle, x: f64, y: f64, pad: f64) -> bool {
    capsule_rect_contains(app, x, y, pad) || pop_rect_contains(x, y, pad)
}

/// (x, y)（逻辑坐标，窗口左上角）落位：钳制在窗口中心所在显示器内。
/// OCR 面板 / 钉图窗口的自定义拖拽共用。
pub fn clamp_move_window(win: &WebviewWindow, x: f64, y: f64) {
    let scale = win.scale_factor().unwrap_or(2.0);
    let (w, h) = win
        .outer_size()
        .map(|s| (s.width as f64 / scale, s.height as f64 / scale))
        .unwrap_or((100.0, 80.0));
    // 用窗口中心判定所在显示器（跨屏拖动时随中心切换钳制范围）
    let (m_l, m_t, m_r, m_b) = monitor_rect(win, x + w / 2.0, y + h / 2.0);
    let nx = x.clamp(m_l, (m_r - w).max(m_l));
    let ny = y.clamp(m_t, (m_b - h).max(m_t));
    let (nx, ny) = snap_pos(win, nx, ny);
    let _ = win.set_position(LogicalPosition::new(nx, ny));
}

/// 让非激活窗口也接收 mouseMoved 事件：悬浮条/结果窗不抢焦点（非 key window），
/// macOS 默认不向非 key 窗口派发 mouseMoved——CSS :hover 需要**先点击一次**
/// 唤醒窗口才生效。而胶囊配置了 acceptFirstMouse（首点即触发动作），
/// "点之前帮你瞄准"的 hover 意义全在点击之前，故必须打开
pub fn apply_hover_tracking(win: &WebviewWindow) {
    #[cfg(not(target_os = "macos"))]
    let _ = win; // Windows 不抢焦点窗口天然收 WM_MOUSEMOVE，无需处理
    #[cfg(target_os = "macos")]
    unsafe {
        use objc2::runtime::AnyObject;
        let Ok(ns_window) = win.ns_window() else {
            return;
        };
        let ns_window = ns_window as *mut AnyObject;
        let _: () = objc2::msg_send![ns_window, setAcceptsMouseMovedEvents: true];
    }
}

/// 指定点所在显示器的逻辑矩形（前端做浮层翻转判定用）
#[derive(Debug, Clone, Copy, Serialize)]
pub struct ScreenRect {
    pub left: f64,
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
}

#[tauri::command]
pub fn screen_rect_at(app: AppHandle, x: f64, y: f64) -> Result<ScreenRect, String> {
    let win = window(&app)?;
    let (l, t, r, b) = monitor_rect(&win, x, y);
    Ok(ScreenRect { left: l, top: t, right: r, bottom: b })
}

/// 浮动条窗口当前落位（逻辑坐标）：拖拽会绕过前端改窗口位置，
/// 拖拽结束后前端回读，恢复「窗口位置 + 内部偏移 = 卡片屏幕坐标」基准
#[tauri::command]
pub fn floating_window_pos(app: AppHandle) -> Result<WindowPos, String> {
    let state = app.state::<FloatingState>();
    let r = state.lock().unwrap();
    Ok(WindowPos { x: r.x, y: r.y })
}

#[tauri::command]
pub fn show_floating_bar(
    app: AppHandle,
    x: f64,
    y: f64,
    width: Option<f64>,
    height: Option<f64>,
    cards: Option<Vec<MaterialCard>>,
    dark: Option<bool>,
) -> Result<WindowPos, String> {
    let win = window(&app)?;
    // 新选区 = 新胶囊：展开中的二级浮层一并收起（Windows 分离卡；macOS 单窗自然重置）
    hide_pops(&app);
    let w = width.unwrap_or(DEFAULT_W).max(120.0);
    // 下限只需兜底极小值：窗口高度必须贴合表面，否则表面下缘落在窗口
    // 内部、原生圆角裁不到，胶囊下角会变直角
    let h = height.unwrap_or(DEFAULT_H).max(24.0);
    let (nx, ny) = place(&win, x, y, w, h);
    win.set_size(LogicalSize::new(w, h))
        .map_err(|e| e.to_string())?;
    win.set_position(LogicalPosition::new(nx, ny))
        .map_err(|e| e.to_string())?;
    // tao 的 show() = makeKeyAndOrderFront：会把激活态抢到本进程，目标应用失焦后
    // 选区高亮消失（macOS 不为非激活窗口绘制高亮）。改用 orderFrontRegardless：
    // 仅把窗口置前显示，不改变激活态，保住用户的选词效果。
    show_without_activation(&win)?;
    // 材质与落位同命令：set_size/set_position 先入主线程队列，本闭包后入，
    // 读到的 contentView bounds 必为落位后的新值（分两条命令会按旧高度换算
    // 出错位材质视图——「残影」根因，见 material::apply 注释）
    if let Some(cards) = &cards {
        if material::ENABLED {
            material::apply(&win, cards, dark.unwrap_or(true), h);
        }
    }
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
    update_hover_feed(&app);
    Ok(WindowPos { x: nx, y: ny })
}

/// 调整浮动条窗口尺寸。x/y = 目标窗口左/上缘（逻辑坐标）：分离卡二级展开时
/// 前端按「锚定/翻转」算好整窗矩形传入（含四周留白），钳制在显示器内后返回
/// 实际落位，前端以此为基准同步内部偏移；None = 按锚点常规定位。
/// 垂直翻转（面板贴屏底放不下）由前端算好 y 下发，Rust 只做钳制。
#[tauri::command]
pub fn resize_floating(
    app: AppHandle,
    width: f64,
    height: f64,
    x: Option<f64>,
    y: Option<f64>,
    cards: Option<Vec<MaterialCard>>,
    dark: Option<bool>,
) -> Result<WindowPos, String> {
    let win = window(&app)?;
    let state = app.state::<FloatingState>();
    let mut r = state.lock().unwrap();
    let (ax, ay) = (r.anchor_x, r.anchor_y);
    let w = width.max(120.0);
    let h = height.max(24.0);
    let (nx, ny) = match (x, y) {
        (Some(wx), Some(wy)) => {
            let (m_l, m_t, m_r, m_b) = monitor_rect(&win, wx, wy);
            let (sx, sy) = snap_pos(
                &win,
                wx.clamp(m_l, (m_r - w).max(m_l)),
                wy.clamp(m_t, (m_b - h).max(m_t)),
            );
            (sx, sy)
        }
        _ => place(&win, ax, ay, w, h),
    };
    win.set_size(LogicalSize::new(w, h))
        .map_err(|e| e.to_string())?;
    if r.visible {
        win.set_position(LogicalPosition::new(nx, ny))
            .map_err(|e| e.to_string())?;
    }
    // 材质与落位同命令（同 show_floating_bar 注释）：先落窗后摆材质，无缝位竞态
    if let Some(cards) = &cards {
        if material::ENABLED {
            material::apply(&win, cards, dark.unwrap_or(true), h);
        }
    }
    r.x = nx;
    r.y = ny;
    r.w = w;
    r.h = h;
    Ok(WindowPos { x: nx, y: ny })
}

/// 开始拖动：记录光标抓取偏移，激活拖拽态（此后 tap 的 DragMove 事件驱动窗口移动）
#[tauri::command]
pub fn begin_floating_drag(app: AppHandle, x: f64, y: f64) -> Result<(), String> {
    let win = window(&app)?;
    // 拖动胶囊即收起二级浮层（Windows 分离卡是独立窗口，不随胶囊联动移动；
    // macOS 单窗结构浮层随窗走，此调用为静默空操作）
    hide_pops(&app);
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
        let (nx, ny) = snap_pos(&win, nx, ny);
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
    let win = window(&app)?;
    win.hide().map_err(|e| e.to_string())?;
    // 胶囊隐藏时二级浮层必收（Windows 分离卡；dismiss 后前端随后同步菜单状态）
    hide_pops(&app);
    update_hover_feed(&app);
    app.state::<FloatingState>().lock().unwrap().visible = false;
    Ok(())
}
