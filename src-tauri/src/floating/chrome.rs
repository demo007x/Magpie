//! 窗口外观（原生层）：圆角裁切、阴影、防闪不透明底——双平台各自实现。
use tauri::WebviewWindow;

#[cfg(target_os = "windows")]
use std::sync::atomic::{AtomicBool, Ordering};

/// 原生圆角裁切：macOS 走 NSWindow contentView 图层（12px 精确圆角）；
/// Windows 走 DWM 窗口圆角属性（Win11 22H2+，系统固定约 8px——radius 参数
/// 在 Windows 不生效）。注意 DWM 对无边框窗口是否真的按此属性裁圆角**因机器
/// 而异**：属性调用恒返回成功，但部分机器（Win11 ARM64 实测）视觉不裁切，
/// 且与 THICKFRAME/CAPTION/透明与否均无关——不得押注。因此 webview 底色
/// 常驻透明，CSS 圆角是所有机器的兜底；DWM 肯裁的机器上裁切顺带消除了
/// CSS 圆角压窗口边界的毛刺，双轨并存无害
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
/// 已由 BORDER_COLOR=NONE 收掉，1px 玻璃边被卡片像素盖住（CSS 圆角外的
/// 透明角在有 DWM 圆角的机器上被 DWM 裁掉，其余机器透出桌面）。
/// 前提：set_shadow(false) 先行（否则 MARKER_UNDECORATED_SHADOW 仍会让
/// WM_NCCALCSIZE 内缩客户区）
/// 【暂存未用】DWM 方形阴影（ExtendFrame 1px 自请）：投影跟窗口矩形走，
/// 而 CSS 卡片是圆角——四角漏影在亮背景上呈灰斑（2026-10-25 弃用）。
/// 若做「窗口出血 + CSS 圆角投影」方案可参考此 DWM 配方
#[cfg(target_os = "windows")]
#[allow(dead_code)]
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

/// 结果窗拖拽缩放期间的不透明底色守卫（Windows）：拖拽放大时新露出的窗口
/// 区域在 WebView2 渲染帧跟上前直接透出桌面，呈「透明白闪」（0.1.15 修）。
/// 但不透明底色常驻会让 CSS 圆角外的四角变实心——在 DWM 不给无边框窗口
/// 裁圆角的机器上（见 apply_native_corner_radius 注释）卡片 silhouette
/// 整个变直角。所以底色只在拖拽进行中不透明（直角一闪而过），松手/隐藏
/// 即恢复全透明，圆角由 CSS 常驻。颜色按窗口当前生效主题取 --surf 同值；
/// 同值重复设置经 RESULT_OPAQUE 边沿记忆跳过（拖拽 tick 高频调用）
#[cfg(target_os = "windows")]
static RESULT_OPAQUE: AtomicBool = AtomicBool::new(false);

#[cfg(target_os = "windows")]
pub fn set_result_window_opaque(win: &WebviewWindow, opaque: bool) {
    if RESULT_OPAQUE.swap(opaque, Ordering::Relaxed) == opaque {
        return;
    }
    use tauri::utils::config::Color;
    use tauri::Theme;

    let theme = win.theme().ok().unwrap_or(Theme::Dark);
    let (r, g, b) = if theme == Theme::Light { (255, 255, 255) } else { (40, 40, 40) };
    let _ = win.set_background_color(Some(Color(r, g, b, if opaque { 255 } else { 0 })));
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
