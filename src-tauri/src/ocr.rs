//! OCR 文本识别（父进程侧）：把识别与截屏全部隔离在独立的 `ocr_helper`
//! 子进程中执行（src/bin/ocr_helper.rs；macOS = Vision，Windows = BitBlt
//! 截屏 + Windows.Media.Ocr）——平台 OCR 栈的异常或崩溃只影响子进程，
//! 主应用任何情况下不会因此 abort。

use std::path::{Path, PathBuf};
use std::process::Command;

use tauri::Emitter;

use crate::i18n::t;
// Windows 识图流程（下方 cfg(windows) 函数）使用裸 AppHandle；
// macOS 编译路径无此使用，按平台门控导入避免 unused 警告
#[cfg(target_os = "windows")]
use tauri::AppHandle;

// 交互式系统框选（screencapture -i）已于 2026-11-04 退役：框选挪到自绘遮罩上
// （floating::snip），选区框与截后遮罩同一窗同一视觉，无「先系统框选、松手后
// 补遮罩」的闪变；静默截图走 snap_region（snip.rs）。

/// 用助手子进程识别图片文字（Vision；子进程隔离 ObjC 异常）。
/// 助手直连模式：`ocr_helper <图片路径>`，文本走 stdout。
pub fn recognize_file(path: &Path) -> Result<String, String> {
    let helper = helper_path()?;
    eprintln!("[ocr] 启动助手进程：{}", helper.display());
    let output = Command::new(&helper)
        .arg(path)
        .output()
        .map_err(|e| format!("{}: {e}", t("err.ocrHelperLaunch")))?;
    eprintln!("[ocr] 助手退出：status={}", output.status);

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        // 助手以 "ERR:<原因>" 报告失败原因，去掉前缀直接作为提示展示
        //（如「未识别到文字」，不需要「文本识别失败: ERR:」包装）
        if let Some(reason) = stderr.strip_prefix("ERR:") {
            return Err(reason.to_string());
        }
        return Err(format!(
            "{}{}",
            t("err.recognizeFailed"),
            if stderr.is_empty() {
                String::new()
            } else {
                format!(": {stderr}")
            }
        ));
    }

    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if text.is_empty() {
        return Err(t("ocr.noText").into());
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
/// 仅 macOS：Windows 框选是自家遮罩窗 + BitBlt 一次成帧，无过渡帧问题，
/// 不做无据修复
#[cfg(target_os = "macos")]
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

/// 识别并一次性推送结果：识图快捷键流程后半段与截图胶囊动作执行（snip_execute）
/// 的共用管线。「正在识别…」无条件立即常驻（不设延时阈值），填补串行化的
/// 感知空窗；成功 → 撤场让位面板，失败 → 原位换装为错误两段话术。
/// 「未识别到文字」先走自愈重截（快速手势可能截到遮罩淡出/页面动画未稳的
/// 过渡帧，整图发虚被判空——见 retry_region_capture 注释）：按事件钩子记录的
/// 拖选矩形延迟静默重截再识别，成功即正常展示。
/// 自愈未成（或非空识别错误）：证据落用户日志（stderr 仅 dev 可见）：尺寸 +
/// 路径。「未识别到文字」时**保留**截图供事后复核（删文件 = 删证据）。
/// run = 识别后自动执行的动作（None = 只出文本面板）
pub async fn recognize_and_push(
    app: &tauri::AppHandle,
    image: PathBuf,
    action: Option<String>,
    service: Option<String>,
) {
    eprintln!("[magpie:ocr] 截图完成，开始识别");
    crate::toast::show_toast_sticky(app, t("toast.recognizing"), "progress");
    let run = action.map(|a| (a, service.clone()));
    let img = image.clone(); // 识别在闭包内消费，image 留给失败清理与钉图
    match tauri::async_runtime::spawn_blocking(move || recognize_file(&img)).await {
        Ok(Ok(text)) => {
            eprintln!("[magpie:ocr] 成功：len={}", text.len());
            crate::toast::hide_toast(app);
            push_ocr_result(app, text, image, run);
        }
        Ok(Err(e)) => {
            eprintln!("[magpie:ocr] 失败：{e}");
            // 「未识别到文字」自愈重截仅 macOS（Windows 框选是自家遮罩窗 +
            // BitBlt 一次成帧，无过渡帧问题，不做无据修复）
            #[cfg(target_os = "macos")]
            if e == t("ocr.noText") {
                if let Some((text, retry_image)) = retry_region_capture() {
                    crate::toast::hide_toast(app);
                    push_ocr_result(app, text, retry_image, run);
                    let _ = std::fs::remove_file(&image); // 原糊图已无价值
                    return;
                }
            }
            let dims = image::image_dimensions(&image)
                .map(|(w, h)| format!("{w}x{h}"))
                .unwrap_or_else(|_| "?".into());
            crate::user_log(&format!(
                "[ocr] 识别失败：{e}；截图 {dims} {}",
                image.display()
            ));
            if e != t("ocr.noText") {
                let _ = std::fs::remove_file(&image);
            }
            // 统一话术：主行说发生了什么，次行说该怎么办（toast 两段式）
            let msg = if e == t("ocr.noText") {
                t("toast.noTextHint").to_string()
            } else {
                e.clone()
            };
            crate::toast::show_toast(app, &msg, "err");
        }
        Err(e) => eprintln!("[magpie:ocr] 任务失败: {e}"),
    }
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
            // 同 snap_capture_only：隐藏控制台子进程的宿主黑窗
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
    let exe = std::env::current_exe().map_err(|e| format!("{}: {e}", t("err.appDirLocate")))?;
    let dir = exe
        .parent()
        .ok_or_else(|| t("err.appDirLocate").to_string())?;
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
// 流程对齐 macOS 截图胶囊：遮罩窗（snap.html）拖拽选区 → 前端 invoke 回调 →
// helper `--snap` 子进程只截屏不识别（遮罩窗原位切会话模式，选区洞保留）→
// 识图取字进胶囊会话（选动作才识别），自动动作槽位（识图翻译/解释/总结）
// 截图后立即识别执行。会话终止两路：取消（cancel）与动作执行
//（finish_windows_snap_session，由 snip::snip_execute 调用）。

#[cfg(target_os = "windows")]
mod win_region {
    use std::path::PathBuf;
    use std::process::Command;
    use std::sync::Mutex;

    use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

    use crate::capture::{debug_log, CaptureMuteGuard};
    use crate::i18n::t;
    use std::time::Duration;

    /// 待续流程：(自动执行动作, 翻译服务)。region_selected 后消费
    static PENDING: Mutex<Option<(Option<&'static str>, Option<String>)>> = Mutex::new(None);
    /// 选区交互期间的捕获静音守卫（AGENTS.md：模态鼠标操作期间须静音划词
    /// 管线）；region_selected 解除、异常路径 end_session 释放
    static SNAP_MUTE: Mutex<Option<CaptureMuteGuard>> = Mutex::new(None);

    pub fn start(app: &AppHandle, action: Option<&'static str>, service: Option<String>) {
        // 幂等闸门：遮罩窗存在 = 流程进行中，忽略重复触发（连按 Alt+S 时
        // 旧窗尚未完成异步销毁，此时重建同 label 窗口会让 tauri panic）
        if app.get_webview_window("snap").is_some() {
            debug_log("capture/windows: snap 遮罩窗已存在，忽略重复触发");
            return;
        }
        *PENDING.lock().unwrap() = Some((action, service));
        // 静音守卫：选区交互期间持有——region_selected 解除（胶囊 hover 依赖
        // 捕获管线的 hover 转发），异常路径经 end_session 释放
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
            .ok_or_else(|| t("toast.noMonitor").to_string())?;
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
            // 选区段必须置顶：触发时用户多半在其他应用前台，Windows 前台锁
            // 不允许非前台进程的新窗抢激活——非 topmost 的遮罩会开在前台
            // 应用后面（页面照常加载但用户看不见，幂等闸门还拦住所有重试，
            // 2026-11-05 实测）。置顶冲突只在会话段（胶囊也要置顶），届时
            // region_selected 把遮罩降回普通层（与 macOS snip-frame 同纪律：
            // 胶囊恒在遮罩之上，遮罩被点击置前也盖不住它）
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
    /// 截屏在 helper 子进程；本函数只做坐标换算与线程编排。
    /// 遮罩窗不在此关闭：前端已原位切会话模式（选区洞保留，对齐 macOS 截图
    /// 胶囊），由 cancel / 动作执行收尾关闭（finish_session）
    pub fn region_selected(app: &AppHandle, window: tauri::WebviewWindow, x: f64, y: f64, w: f64, h: f64) {
        let monitor = window
            .current_monitor()
            .ok()
            .flatten();
        let _ = window; // 坐标基准已取走
        let Some(mon) = monitor else {
            finish_session(app);
            return;
        };
        let s = mon.scale_factor();
        // 坐标值拷出（PhysicalPosition/PhysicalSize 是 Copy）：org/size 不能持
        // mon 的引用进下方 spawn 闭包——闭包要求 'static，mon 在函数尾即被
        // drop（E0597）
        let org = *mon.position();
        let size = *mon.size();
        let (rx, ry, rw, rh) = (
            org.x + (x * s).round() as i32,
            org.y + (y * s).round() as i32,
            (w * s).round() as i32,
            (h * s).round() as i32,
        );
        // 待续流程先行消费：识图取字（None）进胶囊会话；自动动作槽位截图后
        // 立即识别执行（无胶囊段，与 macOS snip_region_selected 同分流）
        let pending = PENDING.lock().unwrap().take();
        if rw < 8 || rh < 8 {
            // 过小选区当误触处理：前端已原位切会话模式，关窗终止
            finish_session(app);
            return;
        }
        // 解除静音：胶囊动作 hover 依赖捕获管线的 hover 转发（detect_loop 的
        // 静音闸门连 hover 一起拦）。会话期间的点击都落在本应用窗口，
        // spawn_worker 的自身 PID 过滤兜底误触发划词
        *SNAP_MUTE.lock().unwrap() = None;

        let app2 = app.clone();
        std::thread::spawn(move || {
            // 只截屏不识别（截图胶囊流程，对齐 macOS snip）：识图取字的识别在
            // 用户点胶囊动作后由 snip_execute → recognize_and_push 进行——框选
            // 阶段永不报「未检测到文字」（没字是选完动作后才知道的事）
            match snap_capture_only(rx, ry, rw, rh) {
                Ok(image) => match pending {
                    // 自动动作槽位（识图翻译/解释/总结）：截图即识别执行，会话
                    // 结束。结果窗落屏锚点 = 选区矩形中心（结果落操作发生的屏）
                    //（PENDING 是双层 Option：外层 = 有待续流程，内层 = 槽位动作）
                    Some((Some(action), service)) => {
                        finish_session(&app2);
                        crate::floating::ocr::set_result_anchor((
                            org.x as f64 / s + x + w / 2.0,
                            org.y as f64 / s + y + h / 2.0,
                        ));
                        tauri::async_runtime::spawn(async move {
                            crate::ocr::recognize_and_push(
                                &app2,
                                image,
                                Some(action.to_string()),
                                service,
                            )
                            .await;
                        });
                    }
                    // 识图取字（None 槽位）或无待续流程：截图挂起进胶囊会话
                    _ => {
                        // 会话段开始：遮罩降回普通层——胶囊（置顶层）必须恒在其
                        // 上，遮罩被点击置前也盖不住它（见 show_snap_window 注释：
                        // 置顶只为保证选区段在前台锁下可见，会话段无胶囊竞争后
                        // 即让位）
                        if let Some(snap) = app2.get_webview_window("snap") {
                            let _ = snap.set_always_on_top(false);
                        }
                        // 胶囊锚点/会话矩形用全局逻辑坐标（页面坐标已是逻辑值，
                        // 加显示器逻辑原点；物理矩形只进 BitBlt）。mon 传遮罩所在
                        // 屏的逻辑矩形——snip_frame_move 的钳制与坐标换算、执行时
                        // 重截的逻辑 → 物理换算都依赖它
                        let mon_logical = (
                            org.x as f64 / s,
                            org.y as f64 / s,
                            size.width as f64 / s,
                            size.height as f64 / s,
                        );
                        let lrect = (org.x as f64 / s + x, org.y as f64 / s + y, w, h);
                        crate::floating::snip::store_session(image, lrect, mon_logical, s);
                        let _ = app2.emit_to(
                            "floating",
                            "snip://captured",
                            serde_json::json!({
                                "x": lrect.0, "y": lrect.1, "w": lrect.2, "h": lrect.3
                            }),
                        );
                    }
                },
                Err(e) => {
                    // 截图失败：会话/自动动作都进行不下去，关窗终止 + 报错
                    finish_session(&app2);
                    toast_err(&app2, &e);
                }
            }
        });
    }

    /// 会话终止（误触/取消/截图失败/自动动作收尾）：关遮罩窗、清状态。
    /// 静音已在选区完成时解除（见 region_selected 注释）
    pub(crate) fn finish_session(app: &AppHandle) {
        if let Some(snap) = app.get_webview_window("snap") {
            let _ = snap.close();
        }
        end_session();
    }

    /// 取消整段流程（遮罩页会话点击/Esc/误触调用）：关遮罩窗 + 胶囊随 dismiss
    /// 管线收起 + 挂起截图清理（与 macOS snip_cancel 同语义）
    pub fn cancel(app: &AppHandle) {
        finish_session(app);
        crate::floating::snip::cancel_all(app);
    }

    /// helper 子进程只截屏不识别（截图胶囊流程：截图与识别分离——识图取字的
    /// 识别在用户选动作后由 snip_execute 经 recognize_and_push 进行）
    pub(crate) fn snap_capture_only(x: i32, y: i32, w: i32, h: i32) -> Result<PathBuf, String> {
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
        cmd.arg("--snap")
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
            .map_err(|e| format!("{}: {e}", t("err.snapProcLaunch")))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let reason = stderr.strip_prefix("ERR:").unwrap_or(&stderr).to_string();
            let _ = std::fs::remove_file(&image);
            return Err(reason);
        }
        Ok(image)
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

/// 遮罩窗取消（Esc / 会话阶段点击胶囊外 / 误触）
#[cfg(target_os = "windows")]
#[tauri::command]
pub fn ocr_region_cancel(app: AppHandle) {
    win_region::cancel(&app);
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub fn ocr_region_cancel() {}

/// Windows 胶囊会话收尾（snip_execute 动作执行时调用）：关遮罩窗 + 清状态。
/// 会话段起遮罩窗保留到动作执行才随会话一起关闭（对齐 macOS 时序）；
/// 挂起截图由 SNIP 池在 snip_execute 内取走消费，本函数不碰
#[cfg(target_os = "windows")]
pub fn finish_windows_snap_session(app: &tauri::AppHandle) {
    win_region::finish_session(app);
}

/// Windows：按全局逻辑矩形重截（会话选区拖动/缩放后执行动作时调用）。
/// 逻辑坐标 × 所在屏缩放 → 物理坐标 → helper `--snap` BitBlt。120ms 宽限
/// 先等遮罩窗异步关闭——洞内像素透明、白环画在矩形外侧，截图本不受遮罩
/// 污染，宽限只为与 macOS 重截路径同节奏防边缘竞态。失败返回 None
///（调用方提示后终止，不回退旧图）
#[cfg(target_os = "windows")]
pub async fn resnap_region(
    rect: (f64, f64, f64, f64),
    scale: f64,
) -> Option<std::path::PathBuf> {
    let (rx, ry, rw, rh) = rect;
    let (px, py, pw, ph) = (
        (rx * scale).round() as i32,
        (ry * scale).round() as i32,
        (rw * scale).round() as i32,
        (rh * scale).round() as i32,
    );
    tauri::async_runtime::spawn_blocking(move || {
        std::thread::sleep(std::time::Duration::from_millis(120));
        win_region::snap_capture_only(px, py, pw, ph).ok()
    })
    .await
    .ok()
    .flatten()
}

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

// 非 Windows 编译期的接线空桩：macOS 走自绘遮罩框选（floating::snip），此函数
// 在 macOS 下无调用方（dead_code 警告属预期）——保留以稳定跨平台分发签名
//（Windows 侧接线在 main.rs 的识图流程按 cfg 分发）
#[cfg(not(target_os = "windows"))]
#[allow(dead_code)]
pub fn start_region_capture_windows(
    _app: &tauri::AppHandle,
    _action: Option<&'static str>,
    _service: Option<String>,
) {}
