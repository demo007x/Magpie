//! 全局 toast 提示窗：主窗口隐藏（纯菜单栏模式）时，截图/识别失败等提示
//! 也要可见——固定显示在光标所在屏幕的顶部居中，错误停留 5s / 其余 4s，
//! 不抢焦点。出入场 = 窗口整体从屏幕顶缘滚下/收回（macOS 通知横幅的动线）。
//!
//! 三个约束（都踩过坑）：
//! 1. `show_without_activation`（orderFrontRegardless）是裸 AppKit 调用，只能在
//!    主线程执行——本模块可能从 tokio 后台线程（OCR 失败路径）调用，
//!    窗口操作一律经 `run_on_main_thread` 派发，否则 SIGILL 崩溃。
//! 2. 消息不用事件系统投递（toast webview 的 listen 注册时序不稳），改用
//!    `eval` 直调页面上的 `window.__toastShow`。
//! 3. 磨砂材质随窗口走（原生层），出入场动画必须动窗口坐标——
//!    CSS 位移只带得走内容层，会和材质身首分离。动画用原生
//!    NSAnimationContext + animator（CoreAnimation 合成器驱动），
//!    主线程繁忙也不掉帧；逐帧 set_position 的老实现会因跨线程派发延迟而抖。
//! 4. tao 的 set_size/set_position 都是 GCD 异步派发（tao util/async.rs，
//!    排在当前主线程块之后执行），与紧随其后的 animator 动画竞态：
//!    动画起点读 frame() 拿到陈旧尺寸，终点 rect 再把陈旧尺寸钉回窗口
//!    （宽度自适应后表现为玻璃层比卡片宽一圈，set_size 被 setFrame_display
//!    覆盖）。显示+滚入前的定位/缩放一律用 NSWindow setFrame 同步落位
//!    （sync_set_frame），绝不走 tao 的异步窗口接口。

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, LogicalPosition, Manager, WebviewWindow};

/// toast 序号：新提示出现后，旧提示排期的自动隐藏作废（避免刚弹的新提示被旧计时藏掉）
static TOAST_SEQ: AtomicU64 = AtomicU64::new(0);

/// toast 当前是否可见（决定 push 是「滚入」还是「原位换装」）
static TOAST_SHOWN: AtomicBool = AtomicBool::new(false);

/// toast 当前内容尺寸（卡片宽高，由 resize_toast 随内容更新；窗口 = 卡片 + 2×PAD）。
/// 宽度随文案自适应（CSS fit-content，上限 420），高度随折行自适应；
/// 滚入起点/停留位都在量得尺寸之后才计算，不存陈旧值。
/// 初值 = 单行文案的自然尺寸 = conf 窗口初始大小 - 2×PAD，三处对齐后
/// 单行 toast 首次展示不触发 set_size（触发也只是量宽前的保险）
static TOAST_SIZE: Mutex<(f64, f64)> = Mutex::new((360.0, 53.0));

/// 待滚入的 toast：(seq, 屏幕逻辑矩形 left/top/right)。push 时只渲染内容
/// （窗口保持隐藏），前端量尺寸回调（resize_toast）或兜底定时到达后才真正
/// 显示 + 滚入——此时才据最新尺寸算居中 x 与 y0/ny，set_size 与滚入动画
/// 不再交叠（setFrame 会打断 animator 动画），宽度变化也不会横向漂移
static TOAST_PENDING: Mutex<Option<(u64, f64, f64, f64)>> = Mutex::new(None);

/// 量尺寸前的兜底宽度（= 单行文案自然宽，与 toast.css / conf 初值协调）；
/// 仅用于取不到光标时的主屏回退矩形
const TOAST_W: f64 = 360.0;

/// 顶部停留位：紧贴菜单栏（约 24pt）下方留 40pt 呼吸缝，对齐 macOS 原生横幅
const TOAST_TOP: f64 = 64.0;

/// 阴影出血边距：与 toast.css 的 .stage padding 一致。窗口无原生阴影（透明窗口
/// 原生阴影逐帧重算导致窗口动画掉帧），投影由 CSS 自绘——窗口必须比卡片大一圈，
/// 否则 box-shadow 被窗口边界裁掉。所有窗口定位 = 卡片定位 ± TOAST_PAD；
/// 液态玻璃材质层也按此内缩（floating.rs）
pub const TOAST_PAD: f64 = 12.0;

/// 滚动动画时长：与完成回调线程的等待同拍（回调只做收尾，不苛求精确对齐）
const ANIM_MS: u64 = 500;

/// 待滚入兜底等待：前端量高回调（resize_toast）通常 ~50ms 内到达；
/// 未到达（eval 失败等）则到点直接滚入，toast 不至于永不出现
const ROLLIN_FALLBACK_MS: u64 = 300;

/// 触发待滚入的 toast：显示并滚入。resize_toast 量尺寸完成或兜底定时调用；
/// 若序号已过期（被更新的 toast 顶替 / 已被 hide 收场）则丢弃。
/// 居中 x 与滚入起止 y 都在此刻据最新卡片尺寸计算（量尺寸前不定位）
fn try_roll_in(app: &AppHandle) {
    let Some((seq, m_l, m_t, m_r)) = TOAST_PENDING.lock().ok().and_then(|mut p| p.take()) else {
        return;
    };
    if TOAST_SEQ.load(Ordering::Relaxed) != seq {
        eprintln!("[magpie:toast] roll-in seq={seq} 已过期，丢弃");
        return;
    }
    let (w, h) = *TOAST_SIZE.lock().unwrap_or_else(|e| e.into_inner());
    let x = (m_l + ((m_r - m_l) - w) / 2.0 - TOAST_PAD).max(m_l);
    let ny = m_t + TOAST_TOP - TOAST_PAD;
    let y0 = m_t - h - TOAST_PAD;
    eprintln!("[magpie:toast] roll-in seq={seq} 显示+滚入 {w}x{h} x={x} y0={y0} ny={ny}");
    let handle = app.clone();
    let snap_handle = handle.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(win) = handle.get_webview_window("toast") {
            // 同步落位（含窗口尺寸）再显示，见 sync_set_frame / 约束 4
            sync_set_frame(&win, x, y0, w + 2.0 * TOAST_PAD, h + 2.0 * TOAST_PAD);
            let _ = crate::floating::show_without_activation(&win);
            animate_to(&win, x, ny);
        }
    });
    // 动画无完成回调，按同拍时长等待后把窗口钉在停留位（与 roll_out 的收尾
    // 同款保险）：animator 被后续 setFrame 打断时终点不至于悬在半路。
    // 序号/可见性过期则放弃——新 toast 或 hide 已接手定位
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(ANIM_MS));
        let snap_cb = snap_handle.clone();
        let _ = snap_handle.run_on_main_thread(move || {
            if TOAST_SEQ.load(Ordering::Relaxed) != seq || !TOAST_SHOWN.load(Ordering::Relaxed) {
                return;
            }
            if let Some(win) = snap_cb.get_webview_window("toast") {
                let _ = win.set_position(LogicalPosition::new(x, ny));
            }
        });
    });
}

/// 同步落窗口 frame（含位置与尺寸，须在主线程调用）。
/// tao 的 set_position/set_size 都是 GCD 异步派发，排在本主线程块之后才执行，
/// 紧随其后的 show + animator 动画会读到陈旧 frame、并把陈旧尺寸钉回窗口
/// （约束 4）。这里直接 NSWindow setFrame 一次落定——动画起点、终点尺寸
/// 都由此确定。y_top 是窗口顶缘的全局逻辑坐标，换算同 animate_to
#[cfg(target_os = "macos")]
fn sync_set_frame(win: &WebviewWindow, x: f64, y_top: f64, w: f64, h: f64) {
    use objc2_app_kit::NSWindow;

    let Ok(ns) = win.ns_window() else {
        return;
    };
    let Ok(Some(primary)) = win.app_handle().primary_monitor() else {
        return;
    };
    let primary_h = primary.size().height as f64 / primary.scale_factor();
    unsafe {
        let nswin = ns as usize;
        let window = &*(nswin as *const NSWindow);
        let mut rect = window.frame();
        rect.origin.x = x;
        rect.origin.y = primary_h - y_top - h;
        rect.size.width = w;
        rect.size.height = h;
        window.setFrame_display(rect, false);
    }
}

#[cfg(not(target_os = "macos"))]
fn sync_set_frame(win: &WebviewWindow, x: f64, y_top: f64, w: f64, h: f64) {
    let _ = win.set_size(tauri::LogicalSize::new(w, h));
    let _ = win.set_position(LogicalPosition::new(x, y_top));
}

/// 滚动动画：系统原生 AppKit 动画——NSAnimationContext.runAnimationGroup 内对
/// NSWindow 的 animator 代理调 setFrame:display:（NSWindow 唯一官方可动画的
/// frame 属性；此前的 setFrameOrigin 裸 msg_send 不生效）。动画由 CoreAnimation
/// 合成器驱动，主线程繁忙也不掉帧，无逐帧开销。
/// 坐标：`to_top` 是窗口顶缘的全局逻辑坐标（原点 = 主屏左上，y 向下）——
/// 目标 frame 用绝对坐标直算，绝不读当前 frame 做差量：set_position 的生效
/// 时机不确定（可能异步落盘），差量法会把陈旧位置带进终点，滚入停留位
/// 每次漂移一个随机量。Cocoa 全局坐标 y 轴向上、原点在主屏左下：
/// cocoa_y = 主屏逻辑高 - 顶缘全局y，再减窗高得底缘
fn animate_to(win: &WebviewWindow, x: f64, to_top: f64) {
    eprintln!("[magpie:toast] animate_to x={x} to_top={to_top}");
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::{NSAnimatablePropertyContainer, NSAnimationContext, NSWindow};
        use objc2_quartz_core::{CAMediaTimingFunction, kCAMediaTimingFunctionEaseOut};

        let Ok(ns) = win.ns_window() else {
            return;
        };
        let Ok(Some(primary)) = win.app_handle().primary_monitor() else {
            return;
        };
        let primary_h = primary.size().height as f64 / primary.scale_factor();
        let nswin = ns as usize; // usize 包裹指针送进 'static 块闭包
        unsafe {
            let window = &*(nswin as *const NSWindow);
            let mut rect = window.frame();
            rect.origin.x = x;
            rect.origin.y = primary_h - to_top - rect.size.height;
            let block = block2::RcBlock::new(
                move |ctx: std::ptr::NonNull<NSAnimationContext>| {
                    let ctx = ctx.as_ref();
                    ctx.setDuration(ANIM_MS as f64 / 1000.0);
                    // ease-out：进出屏的滑动减速收尾，比默认 linear 顺滑
                    ctx.setTimingFunction(Some(&CAMediaTimingFunction::functionWithName(
                        kCAMediaTimingFunctionEaseOut,
                    )));
                    let window = &*(nswin as *const NSWindow);
                    let animator = window.animator();
                    animator.setFrame_display(rect, false);
                },
            );
            NSAnimationContext::runAnimationGroup(&block);
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = win.set_position(LogicalPosition::new(x, to_top));
    }
}

#[repr(C)]
struct CGPoint {
    x: f64,
    y: f64,
}

/// 当前光标位置（全局逻辑坐标，原点 = 主屏左上角）；取不到时回退 None
fn cursor_location() -> Option<(f64, f64)> {
    // CoreGraphics 已随 wry/tauri 链入，无需 #[link]（与 ocr.rs 的声明方式一致）
    unsafe extern "C" {
        fn CGEventCreate(source: *const std::ffi::c_void) -> *mut std::ffi::c_void;
        fn CGEventGetLocation(event: *mut std::ffi::c_void) -> CGPoint;
        fn CFRelease(cf: *mut std::ffi::c_void);
    }
    unsafe {
        let event = CGEventCreate(std::ptr::null());
        if event.is_null() {
            return None;
        }
        let p = CGEventGetLocation(event);
        CFRelease(event);
        Some((p.x, p.y))
    }
}

/// (x, y) 逻辑坐标所在显示器的逻辑矩形 `(left, top, right, bottom)`；找不到回退 None
fn monitor_rect_at(app: &AppHandle, x: f64, y: f64) -> Option<(f64, f64, f64, f64)> {
    for m in app.available_monitors().ok()? {
        let s = m.scale_factor();
        let pos = m.position();
        let size = m.size();
        let (lx, ly) = (pos.x as f64 / s, pos.y as f64 / s);
        let (lw, lh) = (size.width as f64 / s, size.height as f64 / s);
        if x >= lx && x <= lx + lw && y >= ly && y <= ly + lh {
            return Some((lx, ly, lx + lw, ly + lh));
        }
    }
    None
}

/// 推送 toast 内容到窗口，返回本次序号。
/// 不可见 = 从屏幕顶缘滚入；已可见但内容不同 = 旧的整条滚出隐藏，新的再滚入
/// （两条 toast 先后出场，而不是一个窗口里换文字）
fn push_toast(app: &AppHandle, message: &str, kind: &str) -> u64 {
    let seq = TOAST_SEQ.fetch_add(1, Ordering::Relaxed) + 1;
    eprintln!("[magpie:toast] push seq={seq} kind={kind} msg={message:?} was_shown={}", TOAST_SHOWN.load(Ordering::Relaxed));

    // 定位基准：光标所在屏幕；取不到光标回退主屏。
    // 只记屏幕矩形，居中 x 与 y0/ny 由 try_roll_in 据量得的最新尺寸计算
    let (m_l, m_t, m_r, _m_b) = cursor_location()
        .and_then(|(cx, cy)| monitor_rect_at(app, cx, cy))
        .or_else(|| {
            app.primary_monitor().ok().flatten().map(|m| {
                let s = m.scale_factor();
                let (p, z) = (m.position(), m.size());
                (
                    p.x as f64 / s,
                    p.y as f64 / s,
                    (p.x as f64 + z.width as f64) / s,
                    (p.y as f64 + z.height as f64) / s,
                )
            })
        })
        .unwrap_or((0.0, 0.0, TOAST_W, 600.0));
    let was_shown = TOAST_SHOWN.load(Ordering::Relaxed);

    let handle = app.clone();
    let kind = serde_json::to_string(kind).unwrap_or_else(|_| "\"info\"".into());
    let js = format!(
        "window.__toastShow && window.__toastShow({}, {kind})",
        serde_json::to_string(message).unwrap_or_else(|_| "\"\"".into())
    );
    // 交接统一走「渲染内容（窗口隐藏）→ 量高回调/兜底触发滚入」：
    // 显示、set_size、动画三者不再交叠，避免 setFrame 打断 animator
    let schedule_roll_in = |seq: u64, delay_ms: u64| {
        let handle = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(delay_ms));
            if TOAST_SEQ.load(Ordering::Relaxed) == seq {
                try_roll_in(&handle);
            }
        });
    };
    if was_shown {
        // 已有 toast 在展示：旧的整条滚出隐藏，完成后新的渲染并滚入（先后两条）
        TOAST_SHOWN.store(false, Ordering::Relaxed);
        let handle2 = handle.clone();
        let js2 = js.clone();
        roll_out(app, Some(Box::new(move || {
            let recv = handle2.clone();
            let cb = handle2.clone();
            let _ = recv.run_on_main_thread(move || {
                if let Some(win) = cb.get_webview_window("toast") {
                    let _ = win.eval(&js2);
                    TOAST_SHOWN.store(true, Ordering::Relaxed);
                    if let Ok(mut p) = TOAST_PENDING.lock() {
                        *p = Some((seq, m_l, m_t, m_r));
                    }
                }
            });
        })));
        // 兜底 = 滚出时长 + 渲染 + 余量
        schedule_roll_in(seq, ANIM_MS + ROLLIN_FALLBACK_MS);
        return seq;
    }
    let _ = app.run_on_main_thread(move || {
        let Some(win) = handle.get_webview_window("toast") else {
            eprintln!("[magpie:toast] seq={seq} 窗口不存在");
            return;
        };
        if let Err(e) = win.eval(&js) {
            eprintln!("[magpie:toast] seq={seq} eval 失败：{e}");
        }
        TOAST_SHOWN.store(true, Ordering::Relaxed);
        if let Ok(mut p) = TOAST_PENDING.lock() {
            *p = Some((seq, m_l, m_t, m_r));
        }
        eprintln!("[magpie:toast] seq={seq} 已渲染内容，待量尺寸滚入");
    });
    schedule_roll_in(seq, ROLLIN_FALLBACK_MS);
    seq
}

pub fn show_toast(app: &AppHandle, message: &str, kind: &str) {
    if app.get_webview_window("toast").is_none() {
        eprintln!("[magpie:toast] toast 窗口不存在：{message}");
        return;
    }
    let seq = push_toast(app, message, kind);

    // 自动隐藏：错误两行文案给 5s（阅读量更大），其余 4s。
    // 隐藏同样走主线程；新 toast 会使旧排期作废
    let secs = if kind == "err" { 5 } else { 4 };
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(secs));
        if TOAST_SEQ.load(Ordering::Relaxed) == seq {
            roll_out(&handle, None);
        }
    });
}

/// 常驻 toast（无自动隐藏）：识别进行中等「结果到达后由调用方显式收场」的场景。
/// 被任意后续 show_toast 顶替，或被 hide_toast 收场
pub fn show_toast_sticky(app: &AppHandle, message: &str, kind: &str) {
    if app.get_webview_window("toast").is_none() {
        eprintln!("[magpie:toast] toast 窗口不存在：{message}");
        return;
    }
    push_toast(app, message, kind);
}

/// 立即收场常驻 toast（如「正在识别…」在面板弹出时的撤场）：向上滚出后隐藏。
/// 若识别快到滚入还没触发（PENDING 未消费），直接丢弃——闪现不如不出现
pub fn hide_toast(app: &AppHandle) {
    // 序号推进：作废所有尚未触发的自动隐藏排期与待滚入
    TOAST_SEQ.fetch_add(1, Ordering::Relaxed);
    if let Ok(mut p) = TOAST_PENDING.lock() {
        *p = None;
    }
    roll_out(app, None);
}

/// 整条向上滚出（收回屏幕顶缘外）后隐藏；`done` 在隐藏后执行，
/// 用于衔接下一条 toast 的滚入（两条 toast 先后出场）
fn roll_out(app: &AppHandle, done: Option<Box<dyn FnOnce() + Send + 'static>>) {
    eprintln!("[magpie:toast] roll_out，当前 shown={}", TOAST_SHOWN.load(Ordering::Relaxed));
    if !TOAST_SHOWN.swap(false, Ordering::Relaxed) {
        if let Some(d) = done {
            d();
        }
        return;
    }
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let Some(win) = handle.get_webview_window("toast") else {
            if let Some(d) = done {
                d();
            }
            return;
        };
        let scale = win.scale_factor().unwrap_or(2.0);
        let (_w, h) = *TOAST_SIZE.lock().unwrap_or_else(|e| e.into_inner());
        let Ok(pos) = win.outer_position() else {
            let _ = win.hide();
            if let Some(d) = done {
                d();
            }
            return;
        };
        let (x, y) = (pos.x as f64 / scale, pos.y as f64 / scale);
        // 滚出终点：所在屏幕顶缘之上
        let (_m_l, m_t, _m_r, _m_b) =
            crate::floating::monitor_rect(&win, x + 10.0, y + h / 2.0);
        let ty = m_t - h - TOAST_PAD;
        animate_to(&win, x, ty);
        // 动画无完成回调（NSAnimationContext 不便回传 block），按同拍时长等待后收尾；
        // animator 即使被后续动画顶替，最终 set_position 也会把窗口钉在目标位
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(ANIM_MS));
            let recv = handle.clone();
            let cb = handle.clone();
            let _ = recv.run_on_main_thread(move || {
                if let Some(w) = cb.get_webview_window("toast") {
                    let _ = w.set_position(LogicalPosition::new(x, ty));
                    let _ = w.hide();
                }
                if let Some(d) = done {
                    d();
                }
            });
        });
    });
}

/// 前端内容测量回调：渲染完成后量宽高（卡片尺寸），记入 TOAST_SIZE 后触发滚入。
/// 窗口不在此缩放——tao 的 set_size 是 GCD 异步派发，会与滚入动画竞态
/// （约束 4），窗口尺寸由 try_roll_in 滚入前 sync_set_frame 同步落定
#[tauri::command]
pub fn resize_toast(window: WebviewWindow, width: f64, height: f64) {
    if window.label() != "toast" {
        return;
    }
    // 卡片宽度上限 420 与 toast.css 的 .toast-pop max-width 对齐
    let w = width.max(120.0).min(420.0);
    let h = height.max(32.0);
    eprintln!("[magpie:toast] resize_toast {w}x{h}");
    if let Ok(mut s) = TOAST_SIZE.lock() {
        *s = (w, h);
    }
    try_roll_in(&window.app_handle());
}
