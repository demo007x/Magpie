//! Windows 分离卡二级浮层（方案甲：一卡一窗）：floating-panel / floating-menu
//! 两个预建窗口承载二级菜单，与胶囊窗口组成一张视觉卡。
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewWindow};

use serde_json::json;

use super::{snap_pos, show_without_activation, FloatingState, monitor_rect, CARD_GAP, FLOAT_PAD};

// ---- Windows 分离卡二级浮层（方案甲：一卡一窗 + 出血投影）----
// macOS 的分离卡靠「同窗多卡 + NSWindow 按 alpha 轮廓画影」成立；Windows 的
// DWM 阴影跟窗口矩形走。对等结构：每张卡一扇窗口（floating = 胶囊、
// floating-panel = 收纳面板、floating-menu = 窄单列菜单），窗口 = 卡片 +
// 四周 FLOAT_PAD 出血，投影由 CSS 画在出血区（floating.css html.win 块），
// 卡间缝是真实桌面——点击穿透到下层应用，钩子按缝外点击正常 dismiss，
// 无死区。弹层窗口是哑渲染端：内容数据与锚点由胶囊窗口经 set_floating_pops
// 推来，量得卡片尺寸后经 pop_ready 回传，Rust 负责定位/翻转/钳制/显隐
// （胶囊像素不动）。

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
    use crate::capture::debug_log;
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
pub(super) fn pop_rect_contains(x: f64, y: f64, pad: f64) -> bool {
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
/// width/height = 弹层卡片尺寸（pops.tsx 量 .pop 元素，不含出血 margin）；
/// 定位基准 = 胶囊卡片矩形（FloatingState 存窗口矩形，卡片 = 窗口内缩
/// FLOAT_PAD）。本函数全程以卡片坐标参与锚定/存储（PopRect = 卡片矩形，
/// dismiss/hover/级联锚定都以卡为准），仅最终落位补回出血：窗口 = 卡片 +
/// 2×FLOAT_PAD，窗口原点 = 卡片原点 − FLOAT_PAD
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
    // 钳制/翻转阈值按窗口矩形折算（卡片 + 出血），贴边时出血不越出屏
    let edge = 8.0 + FLOAT_PAD;
    let clamp_x = |x: f64| x.clamp(m_l + edge, (m_r - edge - w).max(m_l + edge));
    let clamp_y = |y: f64| y.clamp(m_t + edge, (m_b - edge - h).max(m_t + edge));
    // 胶囊窗口矩形 → 卡片矩形
    let (bx, by, bw, bh) = (
        cx + FLOAT_PAD,
        cy + FLOAT_PAD,
        cw - 2.0 * FLOAT_PAD,
        ch - 2.0 * FLOAT_PAD,
    );

    let (nx, ny) = {
        let mut s = POPS.lock().unwrap_or_else(|e| e.into_inner());
        if label == "floating-panel" {
            // 锚在胶囊内触发钮 x 左缘（trig_x = 触发钮在胶囊窗口视口内的 x，
            // 窗口坐标系恒成立）；贴屏幕右缘翻转为右对齐胶囊卡片；
            // 胶囊下方放不下翻转到上方（与 macOS 分离卡翻转语义一致）
            let mut x = bx + s.panel_trig_x.unwrap_or(0.0);
            if x + w > m_r - edge {
                x = bx + bw - w;
            }
            let mut y = by + bh + CARD_GAP;
            if y + h > m_b - edge {
                y = by - CARD_GAP - h;
            }
            let (sx, sy) = snap_pos(&fwin, clamp_x(x), clamp_y(y));
            s.panel = Some(PopRect { x: sx, y: sy, w, h });
            (sx, sy)
        } else {
            // 菜单两种锚点：row_y 存在 = 面板行侧弹出（NSMenu 心智，贴屏幕右缘
            // 翻回面板左缘）；否则 = 胶囊触发钮下方（chev:*，翻转同面板）。
            // row_y 是行在面板窗口视口内的 y（含出血偏移）：全局 y = 面板
            // 窗口原点（卡片 y − FLOAT_PAD）+ row_y
            let (x, y) = match (s.menu_row_y, s.panel) {
                (Some(row_y), Some(p)) => {
                    let mut x = p.x + p.w + CARD_GAP;
                    if x + w > m_r - edge {
                        x = p.x - w - CARD_GAP;
                    }
                    (x, p.y - FLOAT_PAD + row_y)
                }
                _ => {
                    let mut x = bx + s.menu_trig_x.unwrap_or(0.0);
                    if x + w > m_r - edge {
                        x = bx + bw - w;
                    }
                    (x, by + bh + CARD_GAP)
                }
            };
            let (sx, sy) = snap_pos(&fwin, clamp_x(x), clamp_y(y));
            s.menu = Some(PopRect { x: sx, y: sy, w, h });
            (sx, sy)
        }
    };
    let _ = window.set_size(LogicalSize::new(w + 2.0 * FLOAT_PAD, h + 2.0 * FLOAT_PAD));
    let _ = window.set_position(LogicalPosition::new(nx - FLOAT_PAD, ny - FLOAT_PAD));
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
