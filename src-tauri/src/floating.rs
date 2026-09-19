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

/// 弹出层毛玻璃材质：NSVisualEffectView（behind-window 模糊 + 强制 active 态）。
/// 不用 macOS 26 的 NSGlassEffectView：它在非 key 窗口上会以 inactive 态渲染
/// （更实更灰、不可控），且悬停会触发交互式外观变化——对「故意不抢焦点」的
/// HUD 类面板是已知死穴。NSVisualEffectView 有 state 属性可强制激活外观，
/// 材质跟随系统明暗自适应，外观稳定不受焦点与悬停影响
#[cfg(target_os = "macos")]
pub fn apply_liquid_glass(win: &WebviewWindow, radius: f64, inset: f64) -> bool {
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject};
    use std::ffi::CString;

    let Ok(cls_name) = CString::new("NSVisualEffectView") else {
        return false;
    };
    let Some(cls) = AnyClass::get(&cls_name) else {
        return false;
    };
    let Ok(ns_window) = win.ns_window() else {
        return false;
    };
    let ns_window = ns_window as *mut AnyObject;

    unsafe {
        let content: *mut AnyObject = msg_send![ns_window, contentView];
        if content.is_null() {
            return false;
        }
        let bounds: objc2_foundation::NSRect = msg_send![content, bounds];
        objc2::rc::autoreleasepool(|_| {
            let view: *mut AnyObject = msg_send![cls, alloc];
            // inset > 0：材质内缩（toast 窗口带 CSS 阴影出血边，材质须与
            // 卡片对齐，否则磨砂层会从卡片四周露出一圈）
            let frame = objc2_foundation::NSRect::new(
                objc2_foundation::NSPoint::new(inset, inset),
                objc2_foundation::NSSize::new(
                    (bounds.size.width - 2.0 * inset).max(0.0),
                    (bounds.size.height - 2.0 * inset).max(0.0),
                ),
            );
            let view: *mut AnyObject = msg_send![view, initWithFrame: frame];
            if view.is_null() {
                return false;
            }
            // 材质 13 = hudWindow（HUD 风格，跟随系统明暗自适应）；
            // 混合模式 0 = behindWindow（模糊窗口背后的内容）；
            // 状态 1 = active：非 key 窗口也强制激活外观（稳定性的关键）
            let _: () = msg_send![view, setMaterial: 13_isize];
            let _: () = msg_send![view, setBlendingMode: 0_isize];
            let _: () = msg_send![view, setState: 1_isize];
            // 随窗口缩放（width|height sizable = 2|16）+ 原生圆角
            let _: () = msg_send![view, setAutoresizingMask: 18usize];
            let _: () = msg_send![view, setWantsLayer: true];
            let layer: *mut AnyObject = msg_send![view, layer];
            if !layer.is_null() {
                let _: () = msg_send![layer, setCornerRadius: radius];
            }
            // 插到最底层（webview 之下）
            let _: () = msg_send![content,
                addSubview: view, positioned: -1_isize, relativeTo: std::ptr::null_mut::<AnyObject>()];
            if let Ok(mut v) = GLASS_VIEWS.lock() {
                v.push(GlassViewPtr(view));
            }
            true
        })
    }
}

#[cfg(not(target_os = "macos"))]
pub fn apply_liquid_glass(_win: &WebviewWindow, _radius: f64, _inset: f64) -> bool {
    false
}

static LIQUID_GLASS: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// 已挂载的 NSGlassEffectView 指针（三个弹出层窗口与进程同生命周期）
struct GlassViewPtr(*mut objc2::runtime::AnyObject);
unsafe impl Send for GlassViewPtr {}
static GLASS_VIEWS: Mutex<Vec<GlassViewPtr>> = Mutex::new(Vec::new());

/// 卸载全部玻璃视图（关闭 Liquid Glass 时调用）
#[cfg(target_os = "macos")]
fn disable_liquid_glass_views() {
    use objc2::msg_send;
    let views = GLASS_VIEWS.lock().unwrap();
    unsafe {
        for g in views.iter() {
            let _: () = msg_send![g.0, removeFromSuperview];
        }
    }
}

/// 前端初始化时查询 Liquid Glass 是否生效
#[tauri::command]
pub fn liquid_glass_enabled() -> bool {
    LIQUID_GLASS.load(std::sync::atomic::Ordering::Relaxed)
}

/// 当前系统是否支持玻璃效果（NSVisualEffectView 全平台 macOS 可用）
#[tauri::command]
pub fn liquid_glass_available() -> bool {
    #[cfg(target_os = "macos")]
    {
        true
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

/// 开关 Liquid Glass：持久化 → 挂载/卸载玻璃视图 → 广播状态给所有前端
#[tauri::command]
pub fn set_liquid_glass(app: AppHandle, enabled: bool) {
    crate::settings::patch(&app, |st| st.liquid_glass = enabled);
    let on = if enabled {
        enable_liquid_glass(&app)
    } else {
        #[cfg(target_os = "macos")]
        disable_liquid_glass_views();
        GLASS_VIEWS.lock().unwrap().clear();
        LIQUID_GLASS.store(false, std::sync::atomic::Ordering::Relaxed);
        false
    };
    let _ = app.emit("theme://liquid-glass", on);
}

/// 给所有弹出层窗口挂 Liquid Glass；任一成功即返回 true。
/// 受设置 liquid_glass 控制（默认启用）；已挂载时直接返回，避免重复叠层
pub fn enable_liquid_glass(app: &AppHandle) -> bool {
    if LIQUID_GLASS.load(std::sync::atomic::Ordering::Relaxed) {
        return true;
    }
    if !crate::settings::current(app).liquid_glass {
        return false;
    }
    let mut on = false;
    for label in ["floating", "ocr", "toast"] {
        if let Some(w) = app.get_webview_window(label) {
            // toast 窗口带 12px CSS 阴影出血边，材质须内缩与卡片对齐
            let inset = if label == "toast" {
                crate::toast::TOAST_PAD
            } else {
                0.0
            };
            on |= apply_liquid_glass(&w, 12.0, inset);
        }
    }
    LIQUID_GLASS.store(on, std::sync::atomic::Ordering::Relaxed);
    on
}

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

/// 二级菜单展开的生长高度（逻辑坐标）：唯一的内容相关尺寸例外——
/// 展开时窗口向下长出菜单高度、收起即收回，主菜单（动作行）像素不动
static RESULT_MENU_GROW: Mutex<f64> = Mutex::new(0.0);

/// 结果窗口默认尺寸上下限（逻辑坐标）：用户怎么拖都不会超出
pub const RESULT_MIN_W: f64 = 320.0;
pub const RESULT_MAX_W: f64 = 560.0;
pub const RESULT_MIN_H: f64 = 200.0;
pub const RESULT_MAX_H: f64 = 800.0;
/// 菜单生长的硬上限（防止极端长菜单把窗口顶出屏幕）
pub const RESULT_MENU_MAX: f64 = 440.0;

/// 结果窗口尺寸落位：用户尺寸 + 当前菜单生长高度，钳制后应用。
/// 窗口尺寸只有两个来源——用户拖动、菜单展开生长；内容永不改变窗口尺寸
fn apply_result_window_size(win: &WebviewWindow) {
    let scale = win.scale_factor().unwrap_or(2.0);
    let (uw, uh) = match *LAST_RESULT_SIZE.lock().unwrap() {
        Some(sz) => sz,
        None => win
            .inner_size()
            .map(|s| (s.width as f64 / scale, s.height as f64 / scale))
            .unwrap_or((420.0, 340.0)),
    };
    let grow = *RESULT_MENU_GROW.lock().unwrap();
    let w = uw.clamp(RESULT_MIN_W, RESULT_MAX_W);
    let h = (uh + grow).clamp(RESULT_MIN_H, RESULT_MAX_H + RESULT_MENU_MAX);
    let _ = win.set_size(LogicalSize::new(w, h));
    #[cfg(debug_assertions)]
    debug_log(&format!(
        "[menu-grow] rust: user={uw}x{uh} grow={grow} -> set_size {w}x{h}"
    ));
    // 菜单生长后底部越出屏幕则整体上移，保证生长部分可见
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
        let _ = window.set_position(LogicalPosition::new(
            pos.x as f64 / s + nx,
            pos.y as f64 / s + ny,
        ));
        persist_result_pos(&window.app_handle(), (nx, ny));
    }
    let _ = show_without_activation(&window);
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
/// 宽高只由拖动改变，钳制在默认 min/max 内；若二级菜单正展开，
/// 拖到的总高度扣除菜单生长部分后才是「用户高度」
#[tauri::command]
pub fn set_result_window_size(window: WebviewWindow, width: f64, height: f64) {
    if window.label() != "ocr" {
        return;
    }
    let grow = *RESULT_MENU_GROW.lock().unwrap();
    let w = width.clamp(RESULT_MIN_W, RESULT_MAX_W);
    let h = (height - grow).clamp(RESULT_MIN_H, RESULT_MAX_H);
    if let Ok(mut sz) = LAST_RESULT_SIZE.lock() {
        *sz = Some((w, h));
    }
    apply_result_window_size(&window);
}

/// 二级菜单展开/收起：设置菜单生长高度（0 = 收起）并落位。
/// 窗口向下生长/收回恰好菜单高度——主菜单（动作行）随窗口底边固定，像素不动
#[tauri::command]
pub fn set_result_menu_grow(window: WebviewWindow, grow: f64) {
    if window.label() != "ocr" {
        return;
    }
    *RESULT_MENU_GROW.lock().unwrap() = grow.clamp(0.0, RESULT_MENU_MAX);
    apply_result_window_size(&window);
    #[cfg(debug_assertions)]
    debug_log(&format!("[menu-grow] rust: 收到 grow={grow}"));
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

pub fn is_visible(app: &AppHandle) -> bool {
    app.try_state::<FloatingState>()
        .map(|s| s.lock().unwrap().visible)
        .unwrap_or(false)
}

/// 点是否落在浮动条矩形内（含 pad 边距）——用于抑制"点击浮动条本身"触发的 dismiss
pub fn rect_contains(app: &AppHandle, x: f64, y: f64, pad: f64) -> bool {
    app.try_state::<FloatingState>().map_or(false, |s| {
        let r = *s.lock().unwrap();
        r.visible
            && x >= r.x - pad
            && x <= r.x + r.w + pad
            && y >= r.y - pad
            && y <= r.y + r.h + pad
    })
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

/// (x, y)（逻辑坐标）所在显示器的逻辑矩形 `(left, top, right, bottom)`；找不到则回退主显示器
pub(crate) fn monitor_rect(win: &WebviewWindow, x: f64, y: f64) -> (f64, f64, f64, f64) {
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

/// 锚点 → 窗口位置：优先光标右下，底部放不下翻转到上方，钳制在显示器内
fn place(win: &WebviewWindow, ax: f64, ay: f64, w: f64, h: f64) -> (f64, f64) {
    let (m_l, m_t, m_r, m_b) = monitor_rect(win, ax, ay);
    let nx = (ax + 6.0).clamp(m_l, (m_r - w).max(m_l));
    let ny = if ay + 14.0 + h > m_b {
        (ay - h - 12.0).max(m_t)
    } else {
        ay + 14.0
    };
    (nx, ny)
}

#[tauri::command]
pub fn show_floating_bar(
    app: AppHandle,
    x: f64,
    y: f64,
    width: Option<f64>,
    height: Option<f64>,
) -> Result<(), String> {
    let win = window(&app)?;
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
    Ok(())
}

#[tauri::command]
pub fn resize_floating(app: AppHandle, width: f64, height: f64) -> Result<(), String> {
    let win = window(&app)?;
    let state = app.state::<FloatingState>();
    let mut r = state.lock().unwrap();
    let (ax, ay) = (r.anchor_x, r.anchor_y);
    let w = width.max(120.0);
    let h = height.max(24.0);
    let (nx, ny) = place(&win, ax, ay, w, h);
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
    Ok(())
}

/// 开始拖动：记录光标抓取偏移，激活拖拽态（此后 tap 的 DragMove 事件驱动窗口移动）
#[tauri::command]
pub fn begin_floating_drag(app: AppHandle, x: f64, y: f64) -> Result<(), String> {
    let win = window(&app)?;
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
    debug_log("hide_floating_bar 调用");
    let win = window(&app)?;
    win.hide().map_err(|e| e.to_string())?;
    app.state::<FloatingState>().lock().unwrap().visible = false;
    Ok(())
}
