//! OCR 文本识别（父进程侧）：把框选 + Vision 识别全部隔离在独立的
//! `ocr_helper` 子进程中执行（src/bin/ocr_helper.rs）——AppKit/Vision 的
//! ObjC 异常或崩溃只影响子进程，主应用任何情况下不会因此 abort。

use std::path::{Path, PathBuf};
use std::process::Command;

use tauri::Emitter;
// Windows 识图流程（下方 cfg(windows) 函数）使用裸 AppHandle；
// macOS 编译路径无此使用，按平台门控导入避免 unused 警告
#[cfg(target_os = "windows")]
use tauri::AppHandle;

#[cfg(target_os = "macos")]
use crate::capture::CaptureMuteGuard;

/// 交互式框选屏幕区域 → PNG 临时文件。阻塞调用（在 spawn_blocking 线程执行）。
/// 取消 / 权限缺失 = Err。仅 macOS（系统 screencapture 交互框选；
/// Windows 走 win_region 遮罩窗事件驱动流程）
#[cfg(target_os = "macos")]
pub fn capture_region_to_file() -> Result<std::path::PathBuf, String> {
    // 截图框选本身是一次鼠标拖选：静音捕获管线，防止被误判为划词
    //（此前会触发 AX 查询 → 截图模态会话内 ObjC 异常 → 进程 abort）
    let _mute = CaptureMuteGuard::new();
    eprintln!("[ocr] 静音已开启，等待框选…");

    // 屏幕录制权限预检：缺失时无法截取其他应用内容，先给引导
    if !screen_capture_preflight() {
        eprintln!("[ocr] 缺少屏幕录制权限，打开系统设置");
        let _ = Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?ScreenCapture")
            .spawn();
        return Err("需要屏幕录制权限\n已打开系统设置，授权后重试".into());
    }

    let dir = std::env::temp_dir();
    let image = dir.join(format!("magpie-capture-{}-{}.png", std::process::id(), timestamp_ms()));
    let _ = std::fs::remove_file(&image);

    // 框选截图（系统原生 ⌘⇧4 交互；-x 静音快门声）
    let status = Command::new("screencapture")
        .args(["-x", "-i"])
        .arg(&image)
        .status()
        .map_err(|e| format!("无法启动截图: {e}"))?;
    if !(status.success() && image.exists()) {
        eprintln!("[ocr] 截图已取消");
        return Err("截图已取消".into());
    }
    Ok(image)
}

#[cfg(target_os = "macos")]
fn timestamp_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// 用助手子进程识别图片文字（Vision；子进程隔离 ObjC 异常）。
/// 助手直连模式：`ocr_helper <图片路径>`，文本走 stdout。
pub fn recognize_file(path: &Path) -> Result<String, String> {
    let helper = helper_path()?;
    eprintln!("[ocr] 启动助手进程：{}", helper.display());
    let output = Command::new(&helper)
        .arg(path)
        .output()
        .map_err(|e| format!("无法启动 OCR 助手: {e}"))?;
    eprintln!("[ocr] 助手退出：status={}", output.status);

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        // 助手以 "ERR:<原因>" 报告失败原因，去掉前缀直接作为提示展示
        //（如「未识别到文字」，不需要「文本识别失败: ERR:」包装）
        if let Some(reason) = stderr.strip_prefix("ERR:") {
            return Err(reason.to_string());
        }
        return Err(format!(
            "文本识别失败{}",
            if stderr.is_empty() {
                String::new()
            } else {
                format!(": {stderr}")
            }
        ));
    }

    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if text.is_empty() {
        return Err("未识别到文字".into());
    }
    eprintln!("[ocr] 识别成功：len={}", text.len());
    Ok(text)
}

/// 「未识别到文字」的自愈重截（2026-10-27）：快速框选手势下，交互式
/// screencapture 可能在遮罩淡出/页面动画未稳的过渡帧上落图（整图发虚、
/// 笔画重影，Vision 直接返回空——失败截图已在用户日志留证）。此处按事件
/// 钩子记录的拖选矩形（last_snip_rect）延迟静默重截一次（`screencapture -R`
/// 无交互遮罩，此时画面已稳定）再识别。
/// 返回 Some((文本, 新截图路径))：文本有效且原图应替换为重截图（钉图用清晰版）；
/// None = 无可用矩形 / 重截失败 / 仍为空（沿用原失败处理）。
pub fn retry_region_capture() -> Option<(String, PathBuf)> {
    let Some(rect) = crate::capture::macos::last_snip_rect(std::time::Duration::from_millis(5000))
    else {
        eprintln!("[ocr] 无可用框选矩形（事件钩子未记录），跳过重截");
        return None;
    };
    // 画面稳定宽限：遮罩淡出 + 可能的滚动动画收尾
    std::thread::sleep(std::time::Duration::from_millis(350));
    let (x, y, w, h) = rect;
    // 区域过小不重试（误触/极小选区，原失败即真实结果）
    if w < 12.0 || h < 12.0 {
        return None;
    }
    let dir = std::env::temp_dir();
    let retry = dir.join(format!(
        "magpie-capture-retry-{}-{}.png",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    ));
    let status = Command::new("screencapture")
        .args(["-x", "-R", &format!("{x},{y},{w},{h}")])
        .arg(&retry)
        .status()
        .ok()?;
    if !(status.success() && retry.exists()) {
        let _ = std::fs::remove_file(&retry);
        return None;
    }
    eprintln!("[ocr] 首次识别为空，重截 {w}x{h} @({x},{y}) 后重试");
    match recognize_file(&retry) {
        Ok(text) => {
            crate::user_log(&format!(
                "[ocr] 重截自愈成功：{w}x{h} @({x},{y}) → len={}",
                text.len()
            ));
            Some((text, retry))
        }
        Err(e) => {
            let _ = std::fs::remove_file(&retry);
            eprintln!("[ocr] 重截后仍失败：{e}");
            None
        }
    }
}

/// 识别完成，一次性推送结果（文本 + 原图 + 可选自动执行动作）：面板出现即有
/// 完整内容，原图随 pending 保留供「钉图」。run = (动作 id, 服务)，
/// 传 (id, None) 时由前端按该动作既有的默认服务逻辑选择。
/// 事件用全局广播而不是 emit_to：JS listen() 注册的是 Any 目标，
/// emit_to 的按窗口过滤不匹配 Any 监听器（此前识别面板因此永不出现）。
/// 其他窗口收到后按 app=="ocr" 忽略。
pub fn push_ocr_result(
    app: &tauri::AppHandle,
    text: String,
    image: PathBuf,
    run: Option<(String, Option<String>)>,
) {
    super::floating::ocr_set_pending(text, Some(image), run);
    let _ = app.emit(
        "selection://captured",
        serde_json::json!({ "text": "", "x": -1.0, "y": -1.0, "app": "ocr" }),
    );
}

/// macOS 26+ 兼容：中文识别模型改为按需资源——系统更新后首次识别中文会
/// 阻塞十余秒等待模型拉取（实测 13.9s，CPU 占用极低 = 纯等待网络），
/// 之后系统级缓存，所有进程都在半秒内；旧版 macOS 模型内置，无此代价。
/// 启动后后台用内置的含中文小图跑一次微型 OCR 预热，把这次代价挪到
/// 非交互时刻——新旧版本用户在交互流程里都只体验半秒级识别。
pub fn warmup() {
    std::thread::spawn(move || {
        // 错开启动争抢窗口；纯后台，任何失败静默（预热失败 ≠ 功能失败，
        // 真正的识别有自己的错误提示）
        std::thread::sleep(std::time::Duration::from_secs(3));
        let Ok(exe) = std::env::current_exe() else {
            return;
        };
        let Some(dir) = exe.parent() else {
            return;
        };
        let helper = dir.join("ocr_helper");
        if !helper.exists() {
            return; // dev 缺助手二进制时静默跳过（cargo build --bin ocr_helper 可补）
        }
        let img = std::env::temp_dir().join("magpie-ocr-warmup.png");
        if std::fs::write(&img, include_bytes!("../icons/ocr-warmup.png")).is_err() {
            return;
        }
        let mut cmd = Command::new(&helper);
        cmd.arg(&img);
        #[cfg(target_os = "windows")]
        {
            // 同 snap_ocr_capture：隐藏控制台子进程的宿主黑窗
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000);
        }
        let _ = cmd.output();
        let _ = std::fs::remove_file(&img);
        eprintln!("[ocr] 中文模型预热完成");
    });
}

/// 把识别文本推给 OCR 独立窗口显示（钉图→识别文字流程：文本就绪、无图）。
/// 事件用全局广播而不是 emit_to：JS listen() 注册的是 Any 目标，
/// emit_to 的按窗口过滤不匹配 Any 监听器（此前识别面板因此永不出现）。
/// 其他窗口收到后按 app=="ocr" 忽略。
pub fn push_text_to_ocr_window(app: &tauri::AppHandle, text: String, image: Option<PathBuf>) {
    super::floating::ocr_set_pending(text, image, None);
    let _ = app.emit(
        "selection://captured",
        serde_json::json!({ "text": "", "x": -1.0, "y": -1.0, "app": "ocr" }),
    );
}

fn helper_path() -> Result<std::path::PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| format!("无法定位应用目录: {e}"))?;
    let dir = exe
        .parent()
        .ok_or_else(|| "无法定位应用目录".to_string())?;
    // Windows 上 std 不会为带目录的路径自动补 .exe，显式声明
    #[cfg(target_os = "windows")]
    return Ok(dir.join("ocr_helper.exe"));
    #[cfg(not(target_os = "windows"))]
    Ok(dir.join("ocr_helper"))
}

/// 屏幕录制权限预检（CoreGraphics；与 macos.rs 各自独立声明）
#[cfg(target_os = "macos")]
pub fn screen_capture_preflight() -> bool {
    extern "C" {
        fn CGPreflightScreenCaptureAccess() -> u8;
    }
    unsafe { CGPreflightScreenCaptureAccess() != 0 }
}

// ---------- Windows 框选识图：遮罩窗交互 + GDI 截屏（helper 子进程执行） ----------
// macOS 用系统 `screencapture -i` 阻塞等用户框选；Windows 无系统级等价物，
// 流程改为事件驱动：遮罩窗（snap.html）里拖拽选区 → 前端 invoke 回调 →
// helper `--snap-ocr` 子进程一次完成 BitBlt 截屏 + Windows.Media.Ocr 识别。

#[cfg(target_os = "windows")]
mod win_region {
    use std::path::PathBuf;
    use std::process::Command;
    use std::sync::Mutex;

    use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

    use crate::capture::{debug_log, CaptureMuteGuard};
    use std::time::Duration;

    /// 待续流程：(自动执行动作, 翻译服务)。region_selected 后消费
    static PENDING: Mutex<Option<(Option<&'static str>, Option<String>)>> = Mutex::new(None);
    /// 遮罩窗存续期间的捕获静音守卫（AGENTS.md：模态鼠标操作期间须静音划词管线）
    static SNAP_MUTE: Mutex<Option<CaptureMuteGuard>> = Mutex::new(None);

    pub fn start(app: &AppHandle, action: Option<&'static str>, service: Option<String>) {
        // 幂等闸门：遮罩窗存在 = 流程进行中，忽略重复触发（连按 Alt+S 时
        // 旧窗尚未完成异步销毁，此时重建同 label 窗口会让 tauri panic）
        if app.get_webview_window("snap").is_some() {
            debug_log("capture/windows: snap 遮罩窗已存在，忽略重复触发");
            return;
        }
        *PENDING.lock().unwrap() = Some((action, service));
        // 静音守卫持有到 region_selected/cancel 释放（遮罩窗生命周期）
        *SNAP_MUTE.lock().unwrap() = Some(CaptureMuteGuard::new());
        if let Err(e) = show_snap_window(app) {
            debug_log(format!("capture/windows: 遮罩窗创建失败：{e}"));
            end_session();
            toast_err(app, &e);
        }
    }

    fn end_session() {
        *SNAP_MUTE.lock().unwrap() = None;
        *PENDING.lock().unwrap() = None;
    }

    fn toast_err(app: &AppHandle, msg: &str) {
        let _ = app.emit("ocr://error", msg.to_string());
        crate::toast::show_toast(app, msg, "err");
    }

    fn show_snap_window(app: &AppHandle) -> Result<(), String> {
        // 物理光标坐标 → 所在显示器 → 遮罩窗铺满该屏（多显示器 v1 取光标所在屏）
        let (px, py) = physical_cursor();
        let mon = app
            .monitor_from_point(px as f64, py as f64)
            .ok()
            .flatten()
            .ok_or_else(|| "无法定位光标所在显示器".to_string())?;
        let s = mon.scale_factor();
        let (pos, size) = (mon.position(), mon.size());
        // 残留旧窗先关（异常退出可能留下）。close 是异步销毁——必须等窗口
        // 真正消失再重建，否则 tauri 对重复 label 直接 panic（实测崩溃源）
        if let Some(w) = app.get_webview_window("snap") {
            let _ = w.close();
            for _ in 0..50 {
                if app.get_webview_window("snap").is_none() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        }
        WebviewWindowBuilder::new(app, "snap", WebviewUrl::App("snap.html".into()))
            .title("拾趣截屏")
            .decorations(false)
            .transparent(true)
            .always_on_top(true)
            .skip_taskbar(true)
            .shadow(false)
            .resizable(false)
            .position(pos.x as f64 / s, pos.y as f64 / s)
            .inner_size(size.width as f64 / s, size.height as f64 / s)
            .build()
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    fn physical_cursor() -> (i32, i32) {
        use windows::Win32::Foundation::POINT;
        use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
        let mut pt = POINT::default();
        let _ = unsafe { GetCursorPos(&mut pt) };
        (pt.x, pt.y)
    }

    /// 遮罩窗回调：选区完成（逻辑坐标，相对遮罩窗 = 所在显示器）。
    /// 截屏 + 识别都在 helper 子进程；本函数只做坐标换算与线程编排
    pub fn region_selected(app: &AppHandle, window: tauri::WebviewWindow, x: f64, y: f64, w: f64, h: f64) {
        if let Some(snap) = app.get_webview_window("snap") {
            let _ = snap.close();
        }
        let monitor = window
            .current_monitor()
            .ok()
            .flatten();
        let _ = window; // 坐标基准已取走
        let Some(mon) = monitor else {
            end_session();
            return;
        };
        let s = mon.scale_factor();
        let org = mon.position();
        let (rx, ry, rw, rh) = (
            org.x + (x * s).round() as i32,
            org.y + (y * s).round() as i32,
            (w * s).round() as i32,
            (h * s).round() as i32,
        );
        if rw < 8 || rh < 8 {
            // 过小选区当误触处理：结束会话即可
            end_session();
            return;
        }
        let (action, service) = PENDING.lock().unwrap().take().unwrap_or((None, None));
        *SNAP_MUTE.lock().unwrap() = None; // 截屏交互结束，解除静音

        let app2 = app.clone();
        std::thread::spawn(move || {
            // 「正在识别…」在框选结束即弹出：此前的实现等 helper 子进程跑完
            // 截屏+识别才弹，最耗时的时段反而没有任何提示（toast 慢的根因）
            crate::toast::show_toast_sticky(&app2, "正在识别…", "progress");
            match snap_ocr_capture(rx, ry, rw, rh) {
                // 文本随子进程一次取回——此前把 stdout 丢弃后再起一个子进程
                // 对同一张图重新识别，双进程双识别（结果慢的根因）
                Ok((image, Some(text))) => {
                    crate::toast::hide_toast(&app2);
                    super::push_ocr_result(
                        &app2,
                        text,
                        image,
                        action.map(|a| (a.to_string(), Some(service.clone().unwrap_or_default()))),
                    );
                }
                Ok((image, None)) => {
                    // 截屏成功但无可识别文字：留证后引导。Windows 侧尚未观察到
                    // 此失败（macOS 的过渡帧根因在此架构上不存在——BitBlt 一次
                    // 成帧、遮罩是自家窗口），留图为真出现时提供判据，不做无据修复
                    let dims = image::image_dimensions(&image)
                        .map(|(w, h)| format!("{w}x{h}"))
                        .unwrap_or_else(|_| "?".into());
                    crate::user_log(&format!(
                        "[ocr][win] 识别失败：未识别到文字；截图 {dims} {}",
                        image.display()
                    ));
                    crate::toast::hide_toast(&app2);
                    toast_err(&app2, "未检测到文字\n重新框选，确认区域内有清晰的文字");
                }
                Err(e) => {
                    crate::toast::hide_toast(&app2);
                    toast_err(&app2, &e);
                }
            }
        });
    }

    pub fn cancel(app: &AppHandle) {
        if let Some(snap) = app.get_webview_window("snap") {
            let _ = snap.close();
        }
        end_session();
    }

    /// helper 子进程：BitBlt 截屏 + OCR 一步完成（PNG 落盘，文本走 stdout）。
    /// 返回 (图片路径, 识别文本)：截屏成功但无可识别文字 = Ok((路径, None))
    /// （helper 以 ERR:未识别到文字 退出，但 PNG 已在 OCR 前落盘）。
    /// 文本必须在此一次取回——调用方不再二次起进程识别
    fn snap_ocr_capture(x: i32, y: i32, w: i32, h: i32) -> Result<(PathBuf, Option<String>), String> {
        let helper = super::helper_path()?;
        let image = std::env::temp_dir().join(format!(
            "magpie-capture-{}-{}.png",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0)
        ));
        let mut cmd = Command::new(&helper);
        cmd.arg("--snap-ocr")
            .arg(format!("{x},{y},{w},{h}"))
            .arg(&image);
        #[cfg(target_os = "windows")]
        {
            // ocr_helper 是控制台子系统程序：GUI 进程直接拉起会新建一个可见
            // 控制台窗口（新建控制台默认级联在屏幕左侧，识别完成即消失）——
            // 「识图时屏幕左边黑窗一闪」的根因。CREATE_NO_WINDOW 只隐藏宿主
            // 控制台，stdout/stderr 管道不受影响
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000);
        }
        let output = cmd
            .output()
            .map_err(|e| format!("无法启动截屏进程: {e}"))?;
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if !output.status.success() {
            let reason = stderr
                .strip_prefix("ERR:")
                .map(|s| s.to_string())
                .unwrap_or(stderr);
            if reason == "未识别到文字" && image.exists() {
                return Ok((image, None));
            }
            return Err(reason);
        }
        let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if text.is_empty() {
            return Err("识别结果为空".into());
        }
        Ok((image, Some(text)))
    }
}

/// 遮罩窗选区完成回调（仅 Windows 注册；见 ocr_region_selected_windows）
#[cfg(target_os = "windows")]
#[tauri::command]
pub fn ocr_region_selected(
    app: AppHandle,
    window: tauri::WebviewWindow,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) {
    win_region::region_selected(&app, window, x, y, w, h);
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub fn ocr_region_selected(_x: f64, _y: f64, _w: f64, _h: f64) {}

/// 遮罩窗取消（Esc / 误触）
#[cfg(target_os = "windows")]
#[tauri::command]
pub fn ocr_region_cancel(app: AppHandle) {
    win_region::cancel(&app);
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub fn ocr_region_cancel() {}

/// Windows 识图入口：起遮罩窗（主线程；由 start_ocr_flow 在事件线程调用前转投）
#[cfg(target_os = "windows")]
pub fn start_region_capture_windows(
    app: &tauri::AppHandle,
    action: Option<&'static str>,
    service: Option<String>,
) {
    let app2 = app.clone();
    let _ = app.run_on_main_thread(move || {
        win_region::start(&app2, action, service);
    });
}

// 非 Windows 编译期的接线空桩：macOS 走 capture_region_to_file，此函数在
// macOS 下无调用方（dead_code 警告属预期）——保留以稳定跨平台分发签名，
// Windows 侧接线（main.rs 的识图流程按 cfg 分发）在 M2 接入
#[cfg(not(target_os = "windows"))]
#[allow(dead_code)]
pub fn start_region_capture_windows(
    _app: &tauri::AppHandle,
    _action: Option<&'static str>,
    _service: Option<String>,
) {}
