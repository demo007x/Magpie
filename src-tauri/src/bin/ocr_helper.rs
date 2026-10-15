//! OCR 助手进程（双平台）：macOS = screencapture 框选 + Vision 识别；
//! Windows = Windows.Media.Ocr 识别（框选由主应用遮罩窗完成，不走助手）。
//!
//! 设计为独立进程：平台 OCR 栈的异常或崩溃只会影响本进程，
//! 主应用通过 stdout 拿结果，任何失败都优雅降级（绝不波及主应用）。
//! stdout 协议两平台一致：识别文本直接打印；失败向 stderr 输出 `ERR:<原因>`。
//!
//! macOS 使用 objc2-vision 官方绑定（不手写 objc_msgSend——选择器写错不会
//! 编译期发现，运行时 doesNotRecognizeSelector 会 abort）。
//! Windows 使用官方 windows crate 的 WinRT 投影（Media_Ocr / Graphics_Imaging）。
//!
//! 用法：
//!   ocr_helper --capture <图片输出路径>   （仅 macOS）框选截图并 OCR
//!   ocr_helper <图片路径>                 直接 OCR 指定图片（调试用）

#[cfg(target_os = "macos")]
mod macos {
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

    pub fn install_uncaught_handler() {
        unsafe {
            NSSetUncaughtExceptionHandler(uncaught_handler as *mut c_void);
        }
    }

    pub fn screen_capture_preflight() -> bool {
        unsafe { CGPreflightScreenCaptureAccess() != 0 }
    }

    /// Vision OCR：按行拼接识别结果。
    ///
    /// VNRecognizeTextRequest 正确用法（本项目实测踩坑记录，改回去会复发）：
    /// 1. 识别级别必须 Accurate —— Fast 级别在 macOS 上只内置拉丁语系模型
    ///    （supportedRecognitionLanguages 实测仅 en/fr/it/de/es/pt），
    ///    请求 zh-Hans 不会报错，而是静默回退到拉丁模型：中文输出乱码或为空。
    /// 2. 语言要么开 automaticallyDetectsLanguage，要么显式列出目标语种 ——
    ///    两者都不做时默认仅 en-US，中日文整行丢失。
    ///    注意显式列表是硬约束：列表外语种（如日文）会被排除，自动检测则无此限制，
    ///    多语种混排场景优先用自动检测。
    /// 3. usesLanguageCorrection 只在 Accurate 下生效，Fast 下静默无效。
    pub fn ocr_image_file(path: &Path) -> Result<String, String> {
        use objc2_vision::VNRequestTextRecognitionLevel;

        unsafe {
            let pool = objc_autoreleasePoolPush();

            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let request = VNRecognizeTextRequest::init(VNRecognizeTextRequest::alloc());
                // 三个参数的取值依据见上方函数文档：Accurate + 自动检测语言 + 语言校正
                request.setRecognitionLevel(VNRequestTextRecognitionLevel::Accurate);
                request.setAutomaticallyDetectsLanguage(true);
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

    /// macOS 专属入口逻辑：--capture 模式调系统 screencapture 框选。
    pub fn capture_to_file(image: &str) -> Result<(), (i32, String)> {
        if !screen_capture_preflight() {
            return Err((3, "需要屏幕录制权限".into()));
        }
        // 框选截图（系统原生 ⌘⇧4 交互；-x 静音）
        let status = std::process::Command::new("screencapture")
            .args(["-x", "-i"])
            .arg(image)
            .status();
        match status {
            Ok(s) if s.success() && Path::new(image).exists() => Ok(()),
            _ => Err((1, "截图已取消".into())),
        }
    }
}

#[cfg(target_os = "windows")]
mod windows_impl {
    //! Windows.Media.Ocr：内置离线 OCR，语言包随系统（设置 → 时间和语言 → 语言）。
    //! 图片统一经 image crate 解码、超限缩放后转 PNG 字节，再走 BitmapDecoder
    //! 进 WinRT——Vision 端「任何格式直接喂文件」的对位实现，格式支持面一致。
    //! windows 0.62 起命名空间层级化（windows::Media::Ocr），WinRT 异步对象的
    //! 阻塞等待用 windows-future 的 Async::join。
    use std::path::Path;

    use windows::Globalization::Language;
    use windows::Graphics::Imaging::{BitmapDecoder, SoftwareBitmap};
    use windows::Media::Ocr::OcrEngine;
    use windows::Storage::Streams::{DataWriter, InMemoryRandomAccessStream};

    /// 选定 OCR 引擎：用户配置语言优先，其次中文，再次任意可用语言。
    /// 全部失败 = 未装语言包，错误信息直接引导安装路径（对应 winVmac #27）。
    fn pick_engine() -> Result<OcrEngine, String> {
        if let Ok(e) = OcrEngine::TryCreateFromUserProfileLanguages() {
            return Ok(e);
        }
        let langs = OcrEngine::AvailableRecognizerLanguages().map_err(|e| {
            format!("OCR 不可用: {e}；请在 设置 → 时间和语言 → 语言 中添加中文或英文语言包")
        })?;
        let n = langs.Size().unwrap_or(0);
        let mut first: Option<Language> = None;
        let mut zh: Option<Language> = None;
        for i in 0..n {
            let Ok(l) = langs.GetAt(i) else { continue };
            let tag = l.LanguageTag().map(|t| t.to_string()).unwrap_or_default();
            if first.is_none() {
                first = Some(l.clone());
            }
            if tag.to_ascii_lowercase().starts_with("zh") && zh.is_none() {
                zh = Some(l);
            }
        }
        if let Some(l) = zh {
            if let Ok(e) = OcrEngine::TryCreateFromLanguage(&l) {
                return Ok(e);
            }
        }
        if let Some(l) = first {
            if let Ok(e) = OcrEngine::TryCreateFromLanguage(&l) {
                return Ok(e);
            }
        }
        Err("未安装 OCR 语言包；请在 设置 → 时间和语言 → 语言 中添加中文或英文".into())
    }

    /// 图片 → PNG 字节：已是 PNG 且尺寸不超限则原样返回；否则经 image crate
    /// 解码、必要时等比缩放到引擎上限内，再编码 PNG。
    /// 图片 → PNG 字节：小图放大 2 倍（Lanczos）后编码，超大图等比缩到引擎
    /// 上限，其余原样直通。Windows.Media.Ocr 对小字号（UI 默认 12-16px 行高）
    /// 识别率明显下降——形近字误识（全→金、词→i司）与标点漂移，放大后显著改善
    fn prepare_png_bytes(path: &Path) -> Result<Vec<u8>, String> {
        use image::imageops::FilterType;

        let raw = std::fs::read(path).map_err(|e| format!("文件读取失败: {e}"))?;
        let max_dim = OcrEngine::MaxImageDimension().unwrap_or(4096);
        let is_png = path
            .extension()
            .map(|e| e.eq_ignore_ascii_case("png"))
            .unwrap_or(false);

        let img = image::load_from_memory(&raw)
            .map_err(|e| format!("图片解码失败: {e}（HEIC 等专有格式请先转换为 PNG/JPG）"))?;

        // 小图放大 3x（3x 实测可消除形近字误识；2x 不够）。倍数按引擎上限
        // 自适应：3x 超限退 2x，再超限不放大。放大/缩放后必然重编码
        let scale = if img.width() * 3 <= max_dim && img.height() * 3 <= max_dim {
            3u32
        } else if img.width() * 2 <= max_dim && img.height() * 2 <= max_dim {
            2u32
        } else {
            1u32
        };
        let img = if scale > 1 {
            img.resize_exact(img.width() * scale, img.height() * scale, FilterType::Lanczos3)
        } else {
            img
        };
        let oversize = img.width() > max_dim || img.height() > max_dim;
        let img = if oversize { img.thumbnail(max_dim, max_dim) } else { img };

        // 未做任何处理（未放大、原样 PNG、尺寸合规）→ 原字节直通，零重编码损耗
        if is_png && scale == 1 {
            return Ok(raw);
        }
        let mut out = std::io::Cursor::new(Vec::new());
        img.write_to(&mut out, image::ImageFormat::Png)
            .map_err(|e| format!("PNG 编码失败: {e}"))?;
        Ok(out.into_inner())
    }

    fn png_bytes_to_bitmap(png: &[u8]) -> windows::core::Result<SoftwareBitmap> {
        let stream = InMemoryRandomAccessStream::new()?;
        let writer = DataWriter::CreateDataWriter(&stream.GetOutputStreamAt(0)?)?;
        writer.WriteBytes(png)?;
        writer.StoreAsync()?.join()?;
        writer.FlushAsync()?.join()?;
        // 分离流所有权：writer Drop 会关闭输出流，decoder 还要读它
        writer.DetachStream()?;
        drop(writer);
        let decoder = BitmapDecoder::CreateAsync(&stream)?.join()?;
        decoder.GetSoftwareBitmapAsync()?.join()
    }

    /// 进程级 Per-Monitor DPI v2：GDI 坐标才是物理像素（主应用由 tao 设置，
    /// helper 独立进程必须自设，否则截屏坐标被虚拟化错位）
    fn set_dpi_aware() {
        use windows::Win32::UI::HiDpi::{
            SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
        };
        unsafe {
            let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        }
    }

    /// GDI BitBlt 截取屏幕区域 → PNG（物理像素坐标，虚屏坐标系支持多显示器）
    fn capture_region_to_png(x: i32, y: i32, w: i32, h: i32, out: &Path) -> Result<(), String> {
        use windows::Win32::Graphics::Gdi::{
            BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDIBits,
            GetWindowDC, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB,
            CAPTUREBLT, DIB_RGB_COLORS, SRCCOPY,
        };

        if w < 8 || h < 8 {
            return Err("选区过小".into());
        }
        unsafe {
            let screen = GetWindowDC(None);
            if screen.is_invalid() {
                return Err("获取屏幕 DC 失败".into());
            }
            let mem = CreateCompatibleDC(Some(screen));
            if mem.is_invalid() {
                let _ = ReleaseDC(None, screen);
                return Err("创建内存 DC 失败".into());
            }
            let bmp = CreateCompatibleBitmap(screen, w, h);
            if bmp.is_invalid() {
                let _ = DeleteDC(mem);
                let _ = ReleaseDC(None, screen);
                return Err("创建位图失败".into());
            }
            let old = SelectObject(mem, bmp.into());
            let blit = BitBlt(mem, 0, 0, w, h, Some(screen), x, y, SRCCOPY | CAPTUREBLT);

            // 自顶向下 DIB（biHeight 取负），BGRA 4 字节对齐行
            let mut bmi = BITMAPINFO::default();
            bmi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
            bmi.bmiHeader.biWidth = w;
            bmi.bmiHeader.biHeight = -h;
            bmi.bmiHeader.biPlanes = 1;
            bmi.bmiHeader.biBitCount = 32;
            bmi.bmiHeader.biCompression = BI_RGB.0;
            let mut buf = vec![0u8; (w as usize) * (h as usize) * 4];
            let lines = GetDIBits(
                mem,
                bmp,
                0,
                h as u32,
                Some(buf.as_mut_ptr() as *mut std::ffi::c_void),
                &mut bmi,
                DIB_RGB_COLORS,
            );

            let _ = SelectObject(mem, old);
            let _ = DeleteObject(bmp.into());
            let _ = DeleteDC(mem);
            let _ = ReleaseDC(None, screen);

            if blit.is_err() || lines == 0 {
                return Err("屏幕区域截取失败".into());
            }
            // BGRA → RGBA
            for px in buf.chunks_exact_mut(4) {
                px.swap(0, 2);
            }
            let img = image::RgbaImage::from_raw(w as u32, h as u32, buf)
                .ok_or_else(|| "像素缓冲尺寸错误".to_string())?;
            img.save_with_format(out, image::ImageFormat::Png)
                .map_err(|e| format!("PNG 保存失败: {e}"))?;
            Ok(())
        }
    }

    /// 一体模式：截屏 + OCR（主应用遮罩窗完成选区后调用）
    pub fn snap_ocr(spec: &str, out: &Path) -> Result<String, String> {
        set_dpi_aware();
        let parts: Vec<i32> = spec
            .split(',')
            .map(|s| s.trim().parse::<i32>().map_err(|e| format!("坐标参数错误: {e}")))
            .collect::<Result<_, _>>()?;
        if parts.len() != 4 {
            return Err("坐标参数格式应为 x,y,w,h".into());
        }
        capture_region_to_png(parts[0], parts[1], parts[2], parts[3], out)?;
        ocr_image_file(out)
    }

    pub fn ocr_image_file(path: &Path) -> Result<String, String> {
        let engine = pick_engine()?;
        let png = prepare_png_bytes(path)?;
        let bitmap = png_bytes_to_bitmap(&png).map_err(|e| format!("图片导入失败: {e}"))?;
        let result = engine
            .RecognizeAsync(&bitmap)
            .map_err(|e| format!("OCR 识别失败: {e}"))?
            .join()
            .map_err(|e| format!("OCR 识别失败: {e}"))?;

        // 逐行逐词重组：result.Text() 会在每个汉字间插空格（WinOCR 按词切分），
        // 污染搜索/AI 提示词——仅在 ASCII 词边界补空格，中文相邻词直接拼接
        let mut lines_out: Vec<String> = Vec::new();
        let lines = result.Lines().map_err(|e| format!("OCR 结果解析失败: {e}"))?;
        for i in 0..lines.Size().unwrap_or(0) {
            let Ok(line) = lines.GetAt(i) else { continue };
            let Ok(words) = line.Words() else { continue };
            let mut s = String::new();
            let mut prev_ascii = false;
            for j in 0..words.Size().unwrap_or(0) {
                let Ok(w) = words.GetAt(j) else { continue };
                let Ok(t) = w.Text() else { continue };
                let t = t.to_string();
                let cur_ascii = t.chars().next().map(|c| c.is_ascii_alphanumeric()).unwrap_or(false);
                if !s.is_empty() && prev_ascii && cur_ascii {
                    s.push(' ');
                }
                prev_ascii = t.chars().last().map(|c| c.is_ascii_alphanumeric()).unwrap_or(false);
                s.push_str(&t);
            }
            if !s.trim().is_empty() {
                lines_out.push(s);
            }
        }
        let text = lines_out.join("\n");
        if text.trim().is_empty() {
            return Err("未识别到文字".into());
        }
        Ok(text)
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let usage = || {
        eprintln!("usage: ocr_helper --capture <image-output-path>   (仅 macOS：框选+OCR)");
        eprintln!("       ocr_helper --snap-ocr x,y,w,h <out.png>    (仅 Windows：截屏+OCR)");
        eprintln!("       ocr_helper <image-path>                    (直接 OCR 指定图片)");
    };
    if args.len() < 2 {
        usage();
        std::process::exit(2);
    }
    let mode = args[1].as_str();

    #[cfg(target_os = "macos")]
    {
        macos::install_uncaught_handler();
        // --capture <out>：（仅 macOS）系统 screencapture 框选后识别
        let (capture, image) = if mode == "--capture" {
            (true, args.get(2).cloned().unwrap_or_default())
        } else {
            (false, args[1].clone())
        };
        if image.is_empty() {
            usage();
            std::process::exit(2);
        }
        if capture {
            if let Err((code, msg)) = macos::capture_to_file(&image) {
                eprintln!("ERR:{msg}");
                std::process::exit(code);
            }
        } else if !std::path::Path::new(&image).exists() {
            eprintln!("ERR:文件不存在");
            std::process::exit(1);
        }
        match macos::ocr_image_file(std::path::Path::new(&image)) {
            Ok(t) if !t.trim().is_empty() => print!("{t}"),
            Ok(_) => {
                eprintln!("ERR:未识别到文字");
                std::process::exit(1);
            }
            Err(e) => {
                eprintln!("ERR:{e}");
                std::process::exit(1);
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        if mode == "--snap-ocr" {
            let Some(spec) = args.get(2) else {
                usage();
                std::process::exit(2);
            };
            let Some(out) = args.get(3) else {
                usage();
                std::process::exit(2);
            };
            match windows_impl::snap_ocr(spec, std::path::Path::new(out)) {
                Ok(t) => print!("{t}"),
                Err(e) => {
                    eprintln!("ERR:{e}");
                    std::process::exit(1);
                }
            }
        } else {
            // 其余第一个参数当图片路径直接 OCR（调试用）
            if !std::path::Path::new(mode).exists() {
                eprintln!("ERR:文件不存在");
                std::process::exit(1);
            }
            match windows_impl::ocr_image_file(std::path::Path::new(mode)) {
                Ok(t) => print!("{t}"),
                Err(e) => {
                    eprintln!("ERR:{e}");
                    std::process::exit(1);
                }
            }
        }
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = (mode, &args);
        eprintln!("ERR:当前平台无 OCR 后端");
        std::process::exit(2);
    }
}
