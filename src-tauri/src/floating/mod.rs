//! 浮动条窗口管理：光标锚点定位（右下优先、翻转防出屏）、尺寸自适应、显隐。
//! TS 渲染后测量内容尺寸，经 show/resize 传入；Rust 只负责放置与钳制。

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

pub mod bar;
pub mod chrome;
pub mod material;
pub mod ocr;
pub mod pops;

pub use bar::{
    apply_drag, apply_hover_tracking, clamp_move_window, end_drag, is_visible,
    rect_contains, route_hover, FloatingState,
};
// 仅对应平台的捕获后端消费（capture/macos 的拖拽驱动、capture/windows 的
// 拖拽起点判定）——按平台导出，另一侧不产生未使用告警
#[cfg(target_os = "macos")]
pub use bar::{hover_feed_active, is_dragging};
#[cfg(target_os = "windows")]
pub use bar::capsule_rect_contains;
pub use chrome::apply_native_corner_radius;
pub use ocr::{dismiss_ocr_if_unpinned, init_result_pin, ocr_peek_image, ocr_rect_contains, ocr_set_pending, ocr_visible};
#[cfg(target_os = "windows")]
pub use pops::init_pop_windows;

use serde::Serialize;
use tauri::WebviewWindow;

/// TS 未传尺寸时的兜底
pub const DEFAULT_W: f64 = 328.0;
pub const DEFAULT_H: f64 = 54.0;

/// 分离卡四周透明留白（窗口边缘到卡片边缘）。卡片圆角/描边必须落在窗口
/// 内部（CSS 圆角压窗口边界会出毛刺）。
/// macOS：留白 8px，原生 NSWindow shadow 按内容 alpha 轮廓画影，留白区被
/// 投影衬住（2026-10-24 恢复：此前「黑边晕」的根因是材质/发丝/影子三个边缘
/// 信号叠加，CSS 边缘信号收敛后不再复现）。
/// Windows：方案甲「一卡一窗」——窗口矩形 = 卡片矩形，留白归零
/// （任何出血都会原样透出桌面成「透明圈」，见 docs/03 §B.1.1）。
/// 与 src/floating/App.tsx 的 FLOAT_PAD 保持一致。
#[cfg(target_os = "macos")]
pub const FLOAT_PAD: f64 = 8.0;
#[cfg(not(target_os = "macos"))]
pub const FLOAT_PAD: f64 = 0.0;

/// 卡间缝：胶囊卡与二级卡片之间的空隙（逻辑坐标）。
/// 与 src/floating/App.tsx 的 CARD_GAP 保持一致
pub const CARD_GAP: f64 = 3.0;
/// 窗口位置（逻辑坐标，左上角）。元组会序列化成 JSON 数组，
/// 前端按对象解构会拿到 undefined，必须用命名字段。
#[derive(Debug, Clone, Copy, Serialize)]
pub struct WindowPos {
    pub x: f64,
    pub y: f64,
}

/// (x, y)（逻辑坐标）所在屏的可用区域 `visibleFrame`（top-left 原点逻辑坐标）：
/// 排除菜单栏与 Dock。钳制若按显示器整幅矩形算，贴边时窗口会被推到 Dock
/// 底下——Dock 恒在最上层且点击不可穿透，压住的部分无法操作。
/// 取不到（非 macOS / API 失败 / 坐标不在任何屏）时返回 None，调用方回退整幅矩形
#[cfg(target_os = "macos")]
pub fn visible_rect_at(win: &WebviewWindow, x: f64, y: f64) -> Option<(f64, f64, f64, f64)> {
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
pub fn place(win: &WebviewWindow, ax: f64, ay: f64, w: f64, h: f64) -> (f64, f64) {
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
pub fn snap_pos(win: &WebviewWindow, x: f64, y: f64) -> (f64, f64) {
    let scale = win.scale_factor().unwrap_or(2.0);
    let step = 1.0 / scale;
    ((x / step).round() * step, (y / step).round() * step)
}
