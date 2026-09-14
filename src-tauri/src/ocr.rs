//! OCR 文本识别（父进程侧）：把框选 + Vision 识别全部隔离在独立的
//! `ocr_helper` 子进程中执行（src/bin/ocr_helper.rs）——AppKit/Vision 的
//! ObjC 异常或崩溃只影响子进程，主应用任何情况下不会因此 abort。

use std::path::{Path, PathBuf};
use std::process::Command;

use tauri::Emitter;

use crate::capture::CaptureMuteGuard;

/// 框选截图 → OCR 识别，返回（文本, 截图临时文件）。
/// 截图文件不删除：OCR 面板的「钉图」动作要用它钉回屏幕，
/// 所有权随 pending 移交，钉图关闭或被新识别替换时才清理。
/// 阻塞调用（在 spawn_blocking 线程执行）。
pub fn capture_and_recognize() -> Result<(String, PathBuf), String> {
    let image = capture_region_to_file()?;
    match recognize_file(&image) {
        Ok(text) => Ok((text, image)),
        Err(e) => {
            let _ = std::fs::remove_file(&image);
            Err(e)
        }
    }
}

/// 交互式框选屏幕区域 → PNG 临时文件。阻塞调用（在 spawn_blocking 线程执行）。
/// 取消 / 权限缺失 = Err。
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
        return Err("需要屏幕录制权限：已打开系统设置，授权后重新使用".into());
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

/// 把识别文本推给 OCR 独立窗口显示。
/// 文本与截图原图经 pending 存取，事件仅作唤醒——用全局广播而不是 emit_to：
/// JS listen() 注册的是 Any 目标，emit_to 的按窗口过滤不匹配 Any 监听器
/// （此前识别面板因此永不出现）。其他窗口收到后按 app=="ocr" 忽略。
pub fn push_text_to_ocr_window(app: &tauri::AppHandle, text: String, image: Option<PathBuf>) {
    super::floating::ocr_set_pending(text, image);
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
    Ok(dir.join("ocr_helper"))
}

/// 屏幕录制权限预检（CoreGraphics；与 macos.rs 各自独立声明）
pub fn screen_capture_preflight() -> bool {
    extern "C" {
        fn CGPreflightScreenCaptureAccess() -> u8;
    }
    unsafe { CGPreflightScreenCaptureAccess() != 0 }
}
