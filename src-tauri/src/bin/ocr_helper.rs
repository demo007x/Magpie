//! OCR 助手进程：screencapture 框选屏幕区域 → Vision 框架离线识别文字。
//!
//! 设计为独立进程：Vision/AppKit 的 ObjC 异常或崩溃只会影响本进程，
//! 主应用通过 stdout 拿结果，任何失败都优雅降级（绝不波及主应用）。
//!
//! 使用 objc2-vision 官方绑定（不手写 objc_msgSend——选择器写错不会编译期发现，
//! 运行时 doesNotRecognizeSelector 会 abort）。
//!
//! 用法：
//!   ocr_helper --capture <图片输出路径>   框选截图并 OCR，文本打印到 stdout
//!   ocr_helper <图片路径>                 直接 OCR 指定图片（调试用）

use std::ffi::CStr;
use std::os::raw::{c_char, c_void};
use std::path::Path;
use std::process::exit;

use objc2::{msg_send, AnyThread};
use objc2_foundation::{NSArray, NSMutableDictionary, NSString, NSURL};
use objc2_vision::{VNImageRequestHandler, VNRecognizeTextRequest};

// 屏幕录制权限预检（CoreGraphics）
extern "C" {
    fn CGPreflightScreenCaptureAccess() -> u8;
    fn objc_autoreleasePoolPush() -> *mut c_void;
    fn objc_autoreleasePoolPop(pool: *mut c_void);
    fn NSSetUncaughtExceptionHandler(handler: *mut c_void);
}

extern "C" fn uncaught_handler(exception: *mut c_void) {
    unsafe {
        let exc = exception as *mut objc2::runtime::NSObject;
        let name: *const c_char = msg_send![exc, UTF8String];
        let name = cstr_to_string(name);
        let reason: *const c_char = msg_send![exc, reason];
        let reason = cstr_to_string(reason);
        let call: *const c_char = msg_send![exc, callStackSymbols];
        let call = cstr_to_string(call);
        eprintln!("[ocr_helper] NSException: {name}");
        eprintln!("[ocr_helper] reason: {reason}");
        eprintln!("[ocr_helper] callStack:\n{call}");
    }
    exit(1);
}

fn cstr_to_string(ptr: *const c_char) -> String {
    if ptr.is_null() {
        return String::new();
    }
    unsafe { CStr::from_ptr(ptr).to_string_lossy().into_owned() }
}

fn main() {
    unsafe {
        NSSetUncaughtExceptionHandler(uncaught_handler as *mut c_void);
    }

    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        eprintln!("usage: ocr_helper --capture <image-output-path>");
        eprintln!("       ocr_helper <image-path>            (直接 OCR 指定图片)");
        exit(2);
    }
    // --capture <out>：框选截图并 OCR；否则把 args[1] 当图片直接 OCR（调试用）
    let (capture, image) = if args[1] == "--capture" {
        (true, args.get(2).cloned().unwrap_or_default())
    } else {
        (false, args[1].clone())
    };
    if image.is_empty() {
        eprintln!("usage: ocr_helper --capture <image-output-path>");
        exit(2);
    }

    // 屏幕录制权限预检：缺失时无法截取其他应用内容（直接 OCR 模式跳过）
    if capture && !screen_capture_preflight() {
        eprintln!("ERR:需要屏幕录制权限");
        exit(3);
    }

    if capture {
        // 框选截图（系统原生 ⌘⇧4 交互；-x 静音）
        let status = std::process::Command::new("screencapture")
            .args(["-x", "-i"])
            .arg(&image)
            .status();
        match status {
            Ok(s) if s.success() && Path::new(&image).exists() => {}
            _ => {
                eprintln!("ERR:截图已取消");
                exit(1);
            }
        }
    } else if !Path::new(&image).exists() {
        eprintln!("ERR:文件不存在");
        exit(1);
    }

    let text = ocr_image_file(Path::new(&image));
    match text {
        Ok(t) if !t.trim().is_empty() => {
            print!("{}", t);
        }
        Ok(_) => {
            eprintln!("ERR:未识别到文字");
            exit(1);
        }
        Err(e) => {
            eprintln!("ERR:{e}");
            exit(1);
        }
    }
}

fn screen_capture_preflight() -> bool {
    unsafe { CGPreflightScreenCaptureAccess() != 0 }
}

/// Vision OCR：准确级别、中英文、语言校正，按行拼接
fn ocr_image_file(path: &Path) -> Result<String, String> {
    use objc2_vision::VNRequestTextRecognitionLevel;

    unsafe {
        let pool = objc_autoreleasePoolPush();

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let request = VNRecognizeTextRequest::init(VNRecognizeTextRequest::alloc());
            // Fast：屏幕截图文字源清晰，速度比 Accurate 快数倍且质量几乎无感差异
            request.setRecognitionLevel(VNRequestTextRecognitionLevel::Fast);

            let langs = NSArray::from_slice(&[
                &*NSString::from_str("zh-Hans"),
                &*NSString::from_str("en-US"),
            ]);
            request.setRecognitionLanguages(&langs);
            request.setUsesLanguageCorrection(true);

            let url = NSURL::fileURLWithPath(&NSString::from_str(
                path.to_string_lossy().as_ref(),
            ));
            let options = NSMutableDictionary::new();
            let handler = VNImageRequestHandler::initWithURL_options(
                VNImageRequestHandler::alloc(),
                &url,
                &options,
            );

            let requests = NSArray::from_slice(&[request.as_ref()]);
            if let Err(e) = handler.performRequests_error(&requests) {
                return Err(format!("OCR 识别失败: {e}"));
            }

            let observations = request
                .results()
                .ok_or_else(|| "OCR 无结果".to_string())?;

            let mut lines: Vec<String> = Vec::new();
            for obs in observations.iter() {
                let candidates = obs.topCandidates(1);
                for cand in candidates.iter() {
                    let line = cand.string().to_string();
                    if !line.trim().is_empty() {
                        lines.push(line);
                    }
                }
            }
            if lines.is_empty() {
                return Err("未识别到文字".into());
            }
            Ok(lines.join("\n"))
        }));

        objc_autoreleasePoolPop(pool);

        match result {
            Ok(Ok(text)) => Ok(text),
            Ok(Err(e)) => Err(e),
            Err(_) => Err("OCR 过程异常".into()),
        }
    }
}
