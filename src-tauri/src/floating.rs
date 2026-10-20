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

/// 原生圆角裁切：macOS 走 NSWindow contentView 图层（12px 精确圆角）；
/// Windows 走 DWM 窗口圆角属性（Win11 22H2+，系统固定约 8px——radius 参数
/// 在 Windows 不生效，视觉略小但远好于 CSS 圆角压透明边界的毛刺）；
/// Win10 对该属性返回错误 → 自动维持 CSS 圆角回退，行为不变
#[cfg(target_os = "windows")]
pub fn apply_native_corner_radius(win: &WebviewWindow, _radius: f64) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE, DWM_WINDOW_CORNER_PREFERENCE,
        DWMWCP_ROUND,
    };

    if let Ok(hwnd) = win.hwnd() {
        // tauri 的 HWND 来自其自身 windows crate 版本，跨版本按裸指针重建
        let hwnd = HWND(hwnd.0);
        unsafe {
            let pref = DWM_WINDOW_CORNER_PREFERENCE(DWMWCP_ROUND.0);
            let _ = DwmSetWindowAttribute(
                hwnd,
                DWMWA_WINDOW_CORNER_PREFERENCE,
                &pref as *const _ as *const std::ffi::c_void,
                std::mem::size_of::<DWM_WINDOW_CORNER_PREFERENCE>() as u32,
            );
            // Win11 21H2+：DWMWA_BORDER_COLOR = DWMWA_COLOR_NONE 去掉带阴影的
            // 无边框窗口自带的 1px 系统强调色边框（阴影保留）。属性值按 SDK
            // 头文件原值书写（部分 windows crate 版本未导出这两个常量；
            // COLOR_NONE = 0xFFFFFFFE，属性枚举是 i32，按位同值即 -2）。
            // Win10 无此属性，调用失败即忽略（CSS 圆角兜底不受影响）
            const DWMWA_BORDER_COLOR: i32 = 34;
            const DWMWA_COLOR_NONE: i32 = -2; // 0xFFFFFFFE
            let none = DWMWA_COLOR_NONE;
            let _ = DwmSetWindowAttribute(
                hwnd,
                windows::Win32::Graphics::Dwm::DWMWINDOWATTRIBUTE(DWMWA_BORDER_COLOR),
                &none as *const _ as *const std::ffi::c_void,
                std::mem::size_of::<i32>() as u32,
            );
        }
    }
}

/// 悬浮卡的 DWM 阴影：不能用 tao 的无边框阴影（set_shadow(true)）——它靠
/// WM_NCCALCSIZE 把客户区从窗口矩形内缩一圈不可见非客户带换阴影（Win11
/// 顶部 round(dpi/96)≈2 物理像素，tao calculate_insets_for_dpi），窗口矩形
/// ≠ 卡片矩形：阴影沿外圈画、带子透出桌面，卡片上缘显形为毛边。
/// 这里在「客户区 = 满窗」（卡片零出血贴边）的前提下，用经典配方自请
/// DWM 边框（DwmExtendFrameIntoClientArea 1px）恢复阴影与圆角：边框线颜色
/// 已由 BORDER_COLOR=NONE 收掉，1px 玻璃边被卡片不透明像素盖住（仅 CSS
/// 圆角外的透明角露出，该处本就被 DWM 圆角裁掉）。前提：set_shadow(false)
/// 先行（否则 MARKER_UNDECORATED_SHADOW 仍会让 WM_NCCALCSIZE 内缩客户区）
#[cfg(target_os = "windows")]
pub fn apply_frame_shadow(win: &WebviewWindow) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Graphics::Dwm::DwmExtendFrameIntoClientArea;
    use windows::Win32::UI::Controls::MARGINS;

    if let Ok(hwnd) = win.hwnd() {
        let hwnd = HWND(hwnd.0);
        unsafe {
            let _ = DwmExtendFrameIntoClientArea(
                hwnd,
                &MARGINS {
                    cxLeftWidth: 1,
                    cxRightWidth: 1,
                    cyTopHeight: 1,
                    cyBottomHeight: 1,
                },
            );
        }
    }
}

/// WebView2 不透明背景：透明弹层的 DefaultBackgroundColor 被 wry 在创建分支
/// 写死为全透明，窗口层也没有 WM_ERASEBKGND 画刷——拖拽放大结果窗时，新露出
/// 的区域在渲染帧跟上前直接透出桌面，经 DWM 合成呈「透明白闪」。给弹层设
/// 不透明的卡片底色（与 floating.css/toast.css 的 --surf 同值）后，未绘制
/// 区域按底色出现，闪动不可见。代价：页面透明像素（CSS 圆角外四角）变成
/// 底色实心——Win11 22H2+ 由 DWM 原生圆角裁切兜住；Win10 无此能力，探测
/// 失败即跳过（维持旧行为：闪但角圆）。底色随主题：appearance 传
/// "light"/"dark" 用指定值，传 "auto" 按窗口当前生效主题取值
/// （「跟随系统」下系统主题切换由 ThemeChanged 事件再次驱动到这里）
#[cfg(target_os = "windows")]
pub fn apply_webview_background(win: &WebviewWindow, appearance: &str) {
    use tauri::utils::config::Color;
    use tauri::Theme;

    if !native_corner_rounding_active(win) {
        return;
    }
    let theme = match appearance {
        "light" => Some(Theme::Light),
        "dark" => Some(Theme::Dark),
        _ => win.theme().ok(),
    }
    .unwrap_or(Theme::Dark);
    let (r, g, b) = if theme == Theme::Light { (255, 255, 255) } else { (40, 40, 40) };
    let _ = win.set_background_color(Some(Color(r, g, b, 255)));
}

/// 探测 DWM 原生圆角是否可用（Win11 22H2+）：重设 ROUND 属性并检查结果，
/// 与 apply_native_corner_radius 的设置幂等；Win10 对该属性返回错误
#[cfg(target_os = "windows")]
fn native_corner_rounding_active(win: &WebviewWindow) -> bool {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWM_WINDOW_CORNER_PREFERENCE, DWMWA_WINDOW_CORNER_PREFERENCE,
        DWMWCP_ROUND,
    };

    win.hwnd().map_or(false, |hwnd| unsafe {
        let hwnd = HWND(hwnd.0);
        let pref = DWM_WINDOW_CORNER_PREFERENCE(DWMWCP_ROUND.0);
        DwmSetWindowAttribute(
            hwnd,
            DWMWA_WINDOW_CORNER_PREFERENCE,
            &pref as *const _ as *const std::ffi::c_void,
            std::mem::size_of::<DWM_WINDOW_CORNER_PREFERENCE>() as u32,
        )
        .is_ok()
    })
}

/// 其余平台无原生圆角能力，CSS 圆角兜底
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn apply_native_corner_radius(_win: &WebviewWindow, _radius: f64) {}

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

/// 分离卡四周透明留白（窗口边缘到卡片边缘）。卡片圆角/描边必须落在窗口
/// 内部（CSS 圆角压窗口边界会出毛刺）。
/// macOS：留白 8px，窗口阴影按内容 alpha 轮廓画，留白区被投影衬住。
/// Windows：方案甲「一卡一窗」——窗口矩形 = 卡片矩形，留白归零
/// （任何出血都会原样透出桌面成「透明圈」，见 docs/03 §B.1.1）。
/// 与 src/floating/App.tsx 的 FLOAT_PAD 保持一致
pub const FLOAT_PAD: f64 = if cfg!(target_os = "windows") { 0.0 } else { 8.0 };

/// 卡间缝：胶囊卡与二级卡片之间的空隙（逻辑坐标）。
/// 与 src/floating/App.tsx 的 CARD_GAP 保持一致
pub const CARD_GAP: f64 = 3.0;

// ---- Windows 分离卡二级浮层（方案甲：一卡一窗）----
// macOS 的分离卡靠「同窗多卡 + NSWindow 按 alpha 轮廓画影」成立；Windows 的
// DWM 阴影跟窗口矩形走，任何出血/卡间缝都会原样透出桌面。对等结构改为：
// 每张卡就是一扇零出血窗口（floating = 胶囊、floating-panel = 收纳面板、
// floating-menu = 窄单列菜单），DWM 矩形阴影恰好就是卡片阴影，卡间缝是
// 真实桌面——点击穿透到下层应用，钩子按缝外点击正常 dismiss，无死区。
// 弹层窗口是哑渲染端：内容数据与锚点由胶囊窗口经 set_floating_pops 推来，
// 量得尺寸后经 pop_ready 回传，Rust 负责定位/翻转/钳制/显隐（胶囊像素不动）。

/// 二级浮层卡片的落位（逻辑矩形）。存在即可见——hide_pops 会清空
#[derive(Debug, Clone, Copy)]
pub struct PopRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// 弹层运行时状态：各卡落位 + 下次定位锚点。
/// 锚点 None = 沿用上次值（payload 重发刷新内容时不得把面板拽回默认位）
#[derive(Debug, Default)]
struct PopsState {
    panel: Option<PopRect>,
    menu: Option<PopRect>,
    panel_trig_x: Option<f64>,
    menu_trig_x: Option<f64>,
    menu_row_y: Option<f64>,
}

static POPS: Mutex<PopsState> = Mutex::new(PopsState {
    panel: None,
    menu: None,
    panel_trig_x: None,
    menu_trig_x: None,
    menu_row_y: None,
});

/// 创建二级浮层窗口（预建常驻隐藏，配置与 floating 一致；仅 Windows 存在，
/// macOS 不建——分离卡由单窗原生阴影承担，不多养两份 WKWebView）
#[cfg(target_os = "windows")]
pub fn init_pop_windows(app: &AppHandle) {
    use tauri::{WebviewUrl, WebviewWindowBuilder};
    for label in ["floating-panel", "floating-menu"] {
        if app.get_webview_window(label).is_some() {
            continue;
        }
        let built = WebviewWindowBuilder::new(app, label, WebviewUrl::App("floating.html".into()))
            .title("Magpie")
            .decorations(false)
            .transparent(true)
            .visible(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(false)
            .shadow(true)
            .focused(false)
            .inner_size(220.0, 120.0)
            .build();
        if let Err(e) = built {
            debug_log(format!("floating: 创建 {label} 失败 {e}"));
        }
    }
}

/// 收起全部二级浮层窗口并清空状态（无窗口/未创建时静默，跨平台可调）
pub fn hide_pops(app: &AppHandle) {
    if let Ok(mut s) = POPS.lock() {
        *s = PopsState::default();
    }
    for label in ["floating-panel", "floating-menu"] {
        if let Some(w) = app.get_webview_window(label) {
            let _ = w.hide();
        }
    }
}

/// 二级浮层窗口是否至少有一个可见（卡片存在即可见，见 PopRect 注释）
pub fn pops_visible(app: &AppHandle) -> bool {
    let _ = app;
    let s = POPS.lock().unwrap_or_else(|e| e.into_inner());
    s.panel.is_some() || s.menu.is_some()
}

/// 点是否落在任一可见二级浮层卡内（含 pad 边距）
fn pop_rect_contains(x: f64, y: f64, pad: f64) -> bool {
    let s = POPS.lock().unwrap_or_else(|e| e.into_inner());
    [s.panel, s.menu].iter().any(|r| {
        r.map_or(false, |r| {
            x >= r.x - pad && x <= r.x + r.w + pad && y >= r.y - pad && y <= r.y + r.h + pad
        })
    })
}

/// Windows 分离卡：胶囊窗口推送二级浮层的渲染数据与锚点。
/// target："panel"（收纳面板）| "menu"（窄单列菜单）| "close-panel" / "close-menu"
/// （单收一张卡——同屏只开一个入口，胶囊 ⌄ 与面板 ⌄ 互斥）| "none"（全收起）；
/// trig_x = 触发钮在胶囊内的 x（chev:* 菜单锚点）；row_y = 行在面板内的 y
/// （pmenu 行侧菜单锚点）。data 由胶囊按当前状态组装（弹层是哑渲染端）。
/// 锚点传 None 表示沿用上次值（内容刷新不得移动已定位的面板）
#[tauri::command]
pub fn set_floating_pops(
    app: AppHandle,
    target: String,
    data: serde_json::Value,
    trig_x: Option<f64>,
    row_y: Option<f64>,
) {
    match target.as_str() {
        "panel" => {
            if let Ok(mut s) = POPS.lock() {
                if trig_x.is_some() {
                    s.panel_trig_x = trig_x;
                }
            }
            let _ = app.emit_to("floating-panel", "floating://pop", json!({ "open": true, "data": data }));
        }
        "menu" => {
            if let Ok(mut s) = POPS.lock() {
                if trig_x.is_some() {
                    s.menu_trig_x = trig_x;
                }
                if row_y.is_some() {
                    s.menu_row_y = row_y;
                }
            }
            let _ = app.emit_to("floating-menu", "floating://pop", json!({ "open": true, "data": data }));
        }
        "close-panel" => {
            if let Ok(mut s) = POPS.lock() {
                s.panel = None;
                s.panel_trig_x = None;
            }
            if let Some(w) = app.get_webview_window("floating-panel") {
                let _ = w.hide();
            }
        }
        "close-menu" => {
            if let Ok(mut s) = POPS.lock() {
                s.menu = None;
                s.menu_trig_x = None;
                s.menu_row_y = None;
            }
            if let Some(w) = app.get_webview_window("floating-menu") {
                let _ = w.hide();
            }
        }
        _ => hide_pops(&app),
    }
}

/// 弹层窗口渲染并量得卡片尺寸后回调：按锚点定位（翻转 + 防出屏钳制）后显示。
/// 定位基准 = 胶囊卡矩形（窗口即卡片，Windows 零出血）与已落位的面板矩形
#[tauri::command]
pub fn pop_ready(window: WebviewWindow, width: f64, height: f64) {
    let label = window.label().to_string();
    if label != "floating-panel" && label != "floating-menu" {
        return;
    }
    let app = window.app_handle();
    let (cx, cy, cw, ch, visible) = {
        let r = *app.state::<FloatingState>().lock().unwrap();
        (r.x, r.y, r.w, r.h, r.visible)
    };
    if !visible {
        return;
    }
    let Some(fwin) = app.get_webview_window("floating") else {
        return;
    };
    let w = width.max(60.0);
    let h = height.max(28.0);
    let (m_l, m_t, m_r, m_b) = monitor_rect(&fwin, cx, cy);
    let clamp_x = |x: f64| x.clamp(m_l + 8.0, (m_r - 8.0 - w).max(m_l + 8.0));
    let clamp_y = |y: f64| y.clamp(m_t + 8.0, (m_b - 8.0 - h).max(m_t + 8.0));

    let (nx, ny) = {
        let mut s = POPS.lock().unwrap_or_else(|e| e.into_inner());
        if label == "floating-panel" {
            // 锚在胶囊内触发钮 x 左缘；贴屏幕右缘翻转为右对齐胶囊；
            // 胶囊下方放不下翻转到上方（与 macOS 分离卡翻转语义一致）
            let mut x = cx + s.panel_trig_x.unwrap_or(0.0);
            if x + w > m_r - 8.0 {
                x = cx + cw - w;
            }
            let mut y = cy + ch + CARD_GAP;
            if y + h > m_b - 8.0 {
                y = cy - CARD_GAP - h;
            }
            let (sx, sy) = snap_pos(&fwin, clamp_x(x), clamp_y(y));
            s.panel = Some(PopRect { x: sx, y: sy, w, h });
            (sx, sy)
        } else {
            // 菜单两种锚点：row_y 存在 = 面板行侧弹出（NSMenu 心智，贴屏幕右缘
            // 翻回面板左缘）；否则 = 胶囊触发钮下方（chev:*，翻转同面板）
            let (x, y) = match (s.menu_row_y, s.panel) {
                (Some(row_y), Some(p)) => {
                    let mut x = p.x + p.w + CARD_GAP;
                    if x + w > m_r - 8.0 {
                        x = p.x - w - CARD_GAP;
                    }
                    (x, p.y + row_y)
                }
                _ => {
                    let mut x = cx + s.menu_trig_x.unwrap_or(0.0);
                    if x + w > m_r - 8.0 {
                        x = cx + cw - w;
                    }
                    (x, cy + ch + CARD_GAP)
                }
            };
            let (sx, sy) = snap_pos(&fwin, clamp_x(x), clamp_y(y));
            s.menu = Some(PopRect { x: sx, y: sy, w, h });
            (sx, sy)
        }
    };
    let _ = window.set_size(LogicalSize::new(w, h));
    let _ = window.set_position(LogicalPosition::new(nx, ny));
    let _ = show_without_activation(&window);
    // 置顶带内提到最上：菜单必须盖过面板（show 的相对次序不保证）
    let _ = window.set_always_on_top(true);
}

/// 二级浮层窗口的点击回传：转发给胶囊窗口执行。动作语义、选区上下文、
/// 服务选择与反馈全部活在胶囊窗口——浮层是哑渲染端，不做任何业务
#[tauri::command]
pub fn floating_pick(app: AppHandle, kind: String, key: String, row_y: Option<f64>) {
    let _ = app.emit_to(
        "floating",
        "floating://pick",
        json!({ "kind": kind, "key": key, "rowY": row_y }),
    );
}

// ---- 拖拽状态（detect 线程经事件转发驱动，见 capture/macos.rs） ----
static DRAG_ACTIVE: AtomicBool = AtomicBool::new(false);
static DRAG_GRAB: Mutex<(f64, f64)> = Mutex::new((0.0, 0.0)); // 光标相对窗口左上角偏移

pub fn is_dragging() -> bool {
    DRAG_ACTIVE.load(Ordering::Relaxed)
}

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
}

static OCR_PENDING: Mutex<Option<OcrPending>> = Mutex::new(None);

/// 识别截图原图路径（独立于 pending：面板消费 pending 后仍保留，
/// 供「钉图」取走所有权；新识别/划词导流时清理旧文件）
static OCR_IMAGE: Mutex<Option<std::path::PathBuf>> = Mutex::new(None);

/// 替换 OCR_IMAGE 内容，旧路径与新路径不同时删除旧临时文件
fn replace_ocr_image(image: Option<std::path::PathBuf>) {
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
}

/// 自动执行的动作（id + 可选翻译服务）
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PendingRun {
    pub id: String,
    pub service: Option<String>,
}

/// 取走待显示结果（App 挂载或收到事件时调用；消费式取走文本，
/// 截图原图留在 OCR_IMAGE 里供「钉图」随时取走）
#[tauri::command]
pub fn ocr_take_pending() -> Option<PendingResult> {
    let mut guard = OCR_PENDING.lock().unwrap();
    let p = guard.take()?;
    let run = p.run.map(|(id, service)| PendingRun { id, service });
    let from_ocr = p.from_ocr;
    // 截图路径从 OCR_IMAGE 读取（peek 不取走，钉图时才移交所有权）
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
        });
    }
    Some(PendingResult {
        has_image,
        image: image_path,
        text: p.text,
        from_ocr,
        pinned: ocr_pinned(),
        run,
    })
}

/// 取走截图原图（「钉图」动作，所有权移交钉图窗口；取走后面板不再可钉）
pub fn ocr_take_image() -> Option<std::path::PathBuf> {
    OCR_IMAGE.lock().unwrap().take()
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
    *pending = Some(OcrPending { text, from_ocr: true, run });
}

/// 存入划词导流结果（面板弹出后自动执行 run）
pub fn set_selection_pending(text: String, action_id: String, service: Option<String>) {
    // 划词不带图：清掉上一次识别遗留的截图
    replace_ocr_image(None);
    let mut pending = OCR_PENDING.lock().unwrap();
    *pending = Some(OcrPending {
        text,
        from_ocr: false,
        run: Some((action_id, service)),
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
) {
    set_selection_pending(text, action_id, service);
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
        let _ = app.emit_to(label.as_str(), "hover://move", json!({ "x": cx, "y": cy }));
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

/// 点是否落在胶囊卡矩形内（含 pad 边距，不含二级浮层）——
/// 拖拽起点判定用：按住二级浮层卡拖动不是搬移胶囊
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
    let (nx, ny) = snap_pos(win, nx, ny);
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
    if let Ok(pos) = window.outer_position() {
        let scale = window.scale_factor().unwrap_or(2.0);
        if let Ok(mut last) = LAST_RESULT_POS.lock() {
            *last = Some((pos.x as f64 / scale, pos.y as f64 / scale));
        }
    }
}

/// (x, y)（逻辑坐标）所在屏的可用区域 `visibleFrame`（top-left 原点逻辑坐标）：
/// 排除菜单栏与 Dock。钳制若按显示器整幅矩形算，贴边时窗口会被推到 Dock
/// 底下——Dock 恒在最上层且点击不可穿透，压住的部分无法操作。
/// 取不到（非 macOS / API 失败 / 坐标不在任何屏）时返回 None，调用方回退整幅矩形
#[cfg(target_os = "macos")]
fn visible_rect_at(win: &WebviewWindow, x: f64, y: f64) -> Option<(f64, f64, f64, f64)> {
    use objc2::runtime::AnyObject;
    use objc2_foundation::NSRect;

    unsafe {
        let Ok(ns_window) = win.ns_window() else {
            return None;
        };
        let _ = ns_window; // 仅要求窗口活着：screens 是全局类方法，与窗口无关
        let screens: *mut AnyObject = objc2::msg_send![objc2::class!(NSScreen), screens];
        if screens.is_null() {
            return None;
        }
        let count: usize = objc2::msg_send![screens, count];
        if count == 0 {
            return None;
        }
        // 主屏 = screens[0]（Cocoa 全局坐标原点所在屏），坐标翻转以此为基准
        let primary: *mut AnyObject = objc2::msg_send![screens, objectAtIndex: 0usize];
        let pframe: NSRect = objc2::msg_send![primary, frame];
        let primary_h = pframe.size.height;

        for i in 0..count {
            let s: *mut AnyObject = objc2::msg_send![screens, objectAtIndex: i];
            let frame: NSRect = objc2::msg_send![s, frame];
            // Cocoa frame（bottom-left 全局原点）→ top-left 逻辑矩形
            let fl = frame.origin.x;
            let ft = primary_h - frame.origin.y - frame.size.height;
            let fr = frame.origin.x + frame.size.width;
            let fb = primary_h - frame.origin.y;
            if x < fl || x > fr || y < ft || y > fb {
                continue;
            }
            let visible: NSRect = objc2::msg_send![s, visibleFrame];
            let l = visible.origin.x;
            let t = primary_h - visible.origin.y - visible.size.height;
            let r = visible.origin.x + visible.size.width;
            let b = primary_h - visible.origin.y;
            return Some((l, t, r, b));
        }
        None
    }
}

/// (x, y)（逻辑坐标）所在显示器的逻辑矩形 `(left, top, right, bottom)`；找不到则回退主显示器。
/// macOS 上优先返回可见区域（排除菜单栏与 Dock），钳制语义 = 「不落在 Dock / 菜单栏底下」
pub(crate) fn monitor_rect(win: &WebviewWindow, x: f64, y: f64) -> (f64, f64, f64, f64) {
    #[cfg(target_os = "macos")]
    if let Some(v) = visible_rect_at(win, x, y) {
        return v;
    }
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

/// 锚点 → 窗口位置：优先光标右下，底部放不下翻转到上方，钳制在显示器内。
/// dx/dy = 相对「锚点+(6,14)」标准位的窗口偏移：胶囊卡片位于窗口内
/// (FLOAT_PAD, FLOAT_PAD) 处（四周透明留白），show 路径传 (-FLOAT_PAD,-FLOAT_PAD)
/// 抵消留白，保持卡片与选区锚点的视觉间距不变
/// 光标锚点 → 窗口位置：胶囊水平中心对光标、卡片底边距光标上方 16px——
/// 「跟随鼠标上方」（豆包同款；12px 会贴到光标，16px 避免误触且不失紧凑，
/// 在业界弹出层间距惯例 12–16px 内，见 ADR-06）。
/// 单行/短选区时光标即在选区行内，视觉上等效「选区上方」。
/// 屏顶放不下翻到光标下方；均含防出屏钳制。窗口含 FLOAT_PAD 四周透明
/// 留白，卡片才是视觉边界，偏移按卡片边缘折算
fn place(win: &WebviewWindow, ax: f64, ay: f64, w: f64, h: f64) -> (f64, f64) {
    let (m_l, m_t, m_r, m_b) = monitor_rect(win, ax, ay);
    let nx = (ax - w / 2.0).clamp(m_l, (m_r - w).max(m_l));
    // 卡片底 = ay - 16：ny = ay - 16 - (h - FLOAT_PAD)
    let ny_above = ay + FLOAT_PAD - 16.0 - h;
    let ny = if ny_above >= m_t {
        ny_above
    } else {
        // 下方：卡片顶 = ay + 14；下方也放不下钳回屏内
        (ay + 14.0 - FLOAT_PAD).min((m_b - h).max(m_t))
    };
    snap_pos(win, nx, ny)
}

/// 窗口位置吸附到物理像素网格：0.5px 发丝描边只有在卡片边缘落在设备像素
/// 边界上时才锐利——浮点位置（光标坐标/拖拽运算）会让描边被抗锯齿糊开，
/// 且上下/左右边因奇偶不同一边锐一边糊（"胶囊上下形态不一致"的根源）。
/// 吸附步长 = 1/backingScaleFactor（@2x 屏即 0.5 逻辑像素），偏差 ≤ 半设备像素，无感
fn snap_pos(win: &WebviewWindow, x: f64, y: f64) -> (f64, f64) {
    let scale = win.scale_factor().unwrap_or(2.0);
    let step = 1.0 / scale;
    ((x / step).round() * step, (y / step).round() * step)
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
