#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ai;
mod app_picker;
mod capture;
mod entities;
mod floating;
mod obsidian;
mod ocr;
mod pageurl;
mod pin;
mod settings;
mod toast;
mod translate;
mod update;

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, RunEvent,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

/// 通用页开关：登录时自动启动。先改 LaunchAgent（OS 侧事实），成功才落 settings；
/// 失败时返回错误由前端 toast，settings 保持原状——OS 状态与镜像不同步比失败更糟。
/// debug 构建拒绝开启：dev 二进制的页面在 devUrl（Vite 开发服务器），开机
/// 自拉起时 Vite 不在运行，窗口必然「localhost 拒绝连接」——自启动只属于
/// 打包安装版（前端资源嵌在 exe 内）。前端 catch 现成 toast，无需额外 UI
#[tauri::command]
fn set_launch_at_login(app: AppHandle, enabled: bool) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    if cfg!(debug_assertions) && enabled {
        return Err("开发版不能设置自启动，请使用打包安装版".into());
    }
    let al = app.autolaunch();
    if enabled {
        al.enable().map_err(|e| e.to_string())?;
    } else {
        al.disable().map_err(|e| e.to_string())?;
    }
    crate::settings::patch(&app, |s| s.launch_at_login = enabled);
    Ok(())
}

/// 快捷键的托盘菜单显示形式：macOS "Alt+S" → "⌥S"；Windows 保留 "Alt+S" 原文
/// （与前端 App.tsx displayShortcut 的 IS_MAC 分叉同一套映射，两处需同步）
fn shortcut_display(s: &str) -> String {
    let is_mac = cfg!(target_os = "macos");
    let parts: Vec<String> = s
        .trim()
        .split('+')
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(|p| match p.to_ascii_lowercase().as_str() {
            "cmdorctrl" | "cmd" | "command" | "ctrl" | "control" => {
                if is_mac { "⌘".into() } else { "Ctrl".into() }
            }
            "alt" | "option" | "opt" => {
                if is_mac { "⌥".into() } else { "Alt".into() }
            }
            "shift" => {
                if is_mac { "⇧".into() } else { "Shift".into() }
            }
            "super" | "meta" => {
                if is_mac { "⌘".into() } else { "Win".into() }
            }
            other => other.to_uppercase(),
        })
        .collect();
    // macOS 符号连写（⌘⇧O）；Windows 用 + 连接（Ctrl+Shift+O）
    if is_mac {
        parts.concat()
    } else {
        parts.join("+")
    }
}

/// 托盘右键菜单（快捷键变更后重建，让识图类各项旁始终显示当前设定的键）。
/// 按功能分组：识图动作 / 应用导航 / 退出，组间用分隔线
fn build_tray_menu(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let s = settings::current(app);
    let label = |base: &str, shortcut: &str| {
        let display = shortcut_display(shortcut);
        if display.is_empty() {
            base.to_string()
        } else {
            format!("{base}  {display}")
        }
    };
    let ocr_item = MenuItem::with_id(app, "ocr", &label("识图取字", &s.ocr_shortcut), true, None::<&str>)?;
    let tr_item = MenuItem::with_id(app, "ocr_translate", &label("识图翻译", &s.ocr_translate_shortcut), true, None::<&str>)?;
    let ex_item = MenuItem::with_id(app, "ocr_explain", &label("识图解释", &s.ocr_explain_shortcut), true, None::<&str>)?;
    let su_item = MenuItem::with_id(app, "ocr_summarize", &label("识图总结", &s.ocr_summarize_shortcut), true, None::<&str>)?;
    let file_ocr_item = MenuItem::with_id(app, "file_ocr", &label("访达选图取字", &s.file_ocr_shortcut), true, None::<&str>)?;
    let home_item = MenuItem::with_id(app, "home", "主页面", true, None::<&str>)?;
    let settings_item = MenuItem::with_id(app, "settings", "功能设置", true, None::<&str>)?;
    let github_item = MenuItem::with_id(app, "github", "GitHub 仓库", true, None::<&str>)?;
    let feedback_item = MenuItem::with_id(app, "feedback", "反馈问题", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "退出应用", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    Menu::with_items(app, &[
        &ocr_item,
        &tr_item,
        &ex_item,
        &su_item,
        &file_ocr_item,
        &sep1,
        &home_item,
        &settings_item,
        &github_item,
        &feedback_item,
        &sep2,
        &quit_item,
    ])
}

/// 识图类快捷键槽位表：(settings 字段, 触发后的流程)。
/// Panel = 截图→只弹结果面板；Auto(id) = 截图→识别→面板自动执行该动作
/// （service 传 None，由前端按各动作既有的默认服务逻辑选择）；
/// FilePick = 选图片文件→识别→结果面板（无截图步骤，访达选图取字）
#[derive(Clone, Copy)]
pub enum OcrSlot {
    Panel,
    Auto(&'static str),
    FilePick,
}
const OCR_SHORTCUT_SLOTS: [(&str, OcrSlot); 5] = [
    ("ocr_shortcut", OcrSlot::Panel),
    ("ocr_translate_shortcut", OcrSlot::Auto("translate")),
    ("ocr_explain_shortcut", OcrSlot::Auto("explain")),
    ("ocr_summarize_shortcut", OcrSlot::Auto("summarize")),
    ("file_ocr_shortcut", OcrSlot::FilePick),
];

/// 各槽位当前注册的全局快捷键（流程见 OcrSlot）；handler 据此比对触发
pub struct OcrShortcuts(pub std::sync::Mutex<Vec<(Shortcut, OcrSlot)>>);

/// 识图取字流程（托盘菜单与全局快捷键共用）：
/// 后台线程执行框选+识别，完成后推给 OCR 独立窗口（原图供「钉图」）。
/// action 不为空时随 pending 携带自动执行的动作（识图翻译/解释/总结）
fn start_ocr_flow(app: tauri::AppHandle, action: Option<&'static str>) {
    eprintln!(
        "[magpie:ocr] 识图取字开始{}",
        action.map_or(String::new(), |a| format!("（自动执行 {a}）"))
    );
    // 翻译动作：此处按设置解析默认翻译服务（default 不在启用列表则顺延到首个启用项），
    // 显式随 pending 传递——结果窗口设置可能尚未加载完，不能依赖前端自行解析默认值
    //（与划词导流由浮动条侧解析 service 同理）。无启用服务传空串，前端提示「未启用翻译服务」。
    let service = action.filter(|a| *a == "translate").map(|_| {
        let s = settings::current(&app);
        let d = s.translate.default;
        if s.translate.enabled.iter().any(|e| e == &d) {
            d
        } else {
            s.translate.enabled.first().cloned().unwrap_or_default()
        }
    });
    // Windows：无系统级框选命令，流程由遮罩窗事件驱动（选区回调续跑识别）
    #[cfg(target_os = "windows")]
    ocr::start_region_capture_windows(&app, action, service);
    #[cfg(not(target_os = "windows"))]
    tauri::async_runtime::spawn(async move {
        let image = match tauri::async_runtime::spawn_blocking(ocr::capture_region_to_file).await
        {
            Ok(Ok(image)) => image,
            Ok(Err(e)) => {
                eprintln!("[magpie:ocr] 失败：{e}");
                // 取消是正常交互，不弹提示；其余失败走全局 toast 窗口
                //（主窗口隐藏时也能看到）
                if e != "截图已取消" {
                    toast::show_toast(&app, &e, "err");
                }
                return;
            }
            Err(e) => {
                eprintln!("[magpie:ocr] 任务失败: {e}");
                return;
            }
        };
        // 识别完成后一次性呈现（识别级别 Fast，通常亚秒级）：
        // 面板出现即有结果，失败则只有 toast——没有「弹出又消失」的闪烁。
        // 「正在识别…」无条件立即常驻（不设延时阈值），填补串行化的感知空窗；
        // 成功 → 撤场让位面板，失败 → 原位换装为错误两段话术
        eprintln!("[magpie:ocr] 截图完成，开始识别");
        toast::show_toast_sticky(&app, "正在识别…", "progress");
        let img = image.clone(); // 识别在闭包内消费，image 留给失败清理与钉图
        match tauri::async_runtime::spawn_blocking(move || ocr::recognize_file(&img)).await {
            Ok(Ok(text)) => {
                eprintln!("[magpie:ocr] 成功：len={}", text.len());
                toast::hide_toast(&app);
                ocr::push_ocr_result(
                    &app,
                    text,
                    image,
                    action.map(|a| (a.to_string(), Some(service.clone().unwrap_or_default()))),
                );
            }
            Ok(Err(e)) => {
                eprintln!("[magpie:ocr] 失败：{e}");
                // 失败证据落用户日志（stderr 仅 dev 可见）：尺寸 + 路径。「未识别到
                // 文字」时**保留**截图供事后复核（2026-10-27：有字的区域被判空，
                // 删文件 = 删证据，一次都复现不出）；其余失败照常清理
                let dims = image::image_dimensions(&image)
                    .map(|(w, h)| format!("{w}x{h}"))
                    .unwrap_or_else(|_| "?".into());
                user_log(&format!(
                    "[ocr] 识别失败：{e}；截图 {dims} {}",
                    image.display()
                ));
                if e != "未识别到文字" {
                    let _ = std::fs::remove_file(&image);
                }
                if e != "截图已取消" {
                    // 统一话术：主行说发生了什么，次行说该怎么办（toast 两段式）
                    let msg = if e == "未识别到文字" {
                        "未检测到文字\n重新框选，确认区域内有清晰的文字".to_string()
                    } else {
                        e.clone()
                    };
                    toast::show_toast(&app, &msg, "err");
                }
            }
            Err(e) => eprintln!("[magpie:ocr] 任务失败: {e}"),
        }
    });
}

/// 访达选图取字：文件选择 → 识别 → OCR 独立窗口。结果链路（toast 话术、
/// 原图生命周期、动作面板）与识图取字全同，仅输入从截图换成图片文件。
/// 文件对话框不能在托盘菜单事件回调里同步弹出：菜单收尾的 run loop 状态
/// 与面板的模态循环互斥，实测面板渲染但无响应（卡死）。先让回调返回、
/// 菜单完全收起，再经 run_on_main_thread 派回主线程弹面板——环境与设置页
/// 的同步命令选择器一致（那里长期验证可用）。取消 = 静默结束。
/// 所选图片拷贝进临时目录再走统一生命周期（钉图引用副本，替换/清理逻辑见
/// floating::replace_ocr_image），原文件不动。
fn start_file_ocr_flow(app: tauri::AppHandle) {
    // 线程模型（sample 实证的死锁，勿改回主线程直调）：
    // global-shortcut 插件在调用 with_handler 期间持有自身快捷键表锁（其 lib.rs
    // 的 MutexGuard 横跨整个 if let），而 run_on_main_thread 在主线程调用时是
    // 同步内联执行——从快捷键回调直调 rfd 会形成「持锁 → runModal → 模态循环
    // 重派发按键 → 二次进 handler → 重入非重入锁」的自锁死（面板渲染但永无响应）。
    // 独立线程承载对话框：handler 即刻返回放锁；rfd 自行把 runModal 派发到主线程
    // 呈现，本线程只阻塞等待结果。FILE_OCR_ACTIVE 去重：模态循环会重派发同一
    // 按键，二次触发直接跳过，避免叠出第二个面板。
    static FILE_OCR_ACTIVE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if FILE_OCR_ACTIVE
        .swap(true, std::sync::atomic::Ordering::Relaxed)
    {
        eprintln!("[magpie:ocr] 文件识别已在进行，忽略重复触发");
        return;
    }
    eprintln!("[magpie:ocr] 文件识别流程开始");
    std::thread::spawn(move || {
        let t0 = std::time::Instant::now();
        // rfd 从后台线程调用时会自行把 runModal 派发到主线程，本线程阻塞等结果；
        // 实测主队列派发延迟为毫秒级，面板打开速度由 AppKit 面板首次初始化主导。
        // 勿在此前插入主线程激活往返：run_on_main_thread 的代理事件实测可能
        // 迟迟不被处理（曾有 2s 等待），激活调用在 macOS 14+ 也已无效果
        let picked = app_picker::pick_image_file();
        eprintln!(
            "[magpie:ocr] ⏱ 面板关闭，全程 {}ms",
            t0.elapsed().as_millis()
        );
        FILE_OCR_ACTIVE.store(false, std::sync::atomic::Ordering::Relaxed);
        let Some(picked) = picked else {
            eprintln!("[magpie:ocr] 文件面板取消");
            return;
        };
        let ext = picked
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("png")
            .to_string();
        let dest = std::env::temp_dir().join(format!(
            "magpie-file-ocr-{}.{ext}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis()
        ));
        if std::fs::copy(&picked, &dest).is_err() {
            toast::show_toast(&app, "图片读取失败\n文件可能已被移动或删除", "err");
            return;
        }
        tauri::async_runtime::spawn(async move {
            eprintln!("[magpie:ocr] 文件识别开始：{}", dest.display());
            toast::show_toast_sticky(&app, "正在识别…", "progress");
            let src = dest.clone(); // 闭包消费副本，外层保留 dest 供成功推送与失败清理
            match tauri::async_runtime::spawn_blocking(move || ocr::recognize_file(&src)).await {
                Ok(Ok(text)) => {
                    eprintln!("[magpie:ocr] 成功：len={}", text.len());
                    toast::hide_toast(&app);
                    ocr::push_ocr_result(&app, text, dest, None);
                }
                Ok(Err(e)) => {
                    eprintln!("[magpie:ocr] 失败：{e}");
                    // 面板未创建，临时副本没有存在价值：直接清理
                    let _ = std::fs::remove_file(&dest);
                    let msg = if e == "未识别到文字" {
                        "未检测到文字\n换一张清晰的图片试试".to_string()
                    } else {
                        e
                    };
                    toast::show_toast(&app, &msg, "err");
                }
                Err(e) => eprintln!("[magpie:ocr] 文件识别任务失败: {e}"),
            }
        });
    });
}

/// 按当前设置注册全部识图类全局快捷键（启动与保存设置时调用；清空 = 禁用）。
/// 单个槽位注册失败（格式错误/被系统占用）不影响其他槽位，仅记日志并不生效。
pub fn apply_ocr_shortcuts(app: &tauri::AppHandle) {
    use tauri::State;
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    let state: State<OcrShortcuts> = app.state();
    let s = settings::current(app);
    let mut registered = Vec::new();
    for (field, slot) in OCR_SHORTCUT_SLOTS {
        let text = match field {
            "ocr_shortcut" => s.ocr_shortcut.clone(),
            "ocr_translate_shortcut" => s.ocr_translate_shortcut.clone(),
            "ocr_explain_shortcut" => s.ocr_explain_shortcut.clone(),
            "file_ocr_shortcut" => s.file_ocr_shortcut.clone(),
            _ => s.ocr_summarize_shortcut.clone(),
        }
        .trim()
        .to_string();
        if text.is_empty() {
            eprintln!("[magpie:ocr] 快捷键已禁用：{field}");
            continue;
        }
        match text.parse::<Shortcut>() {
            Ok(sc) => match gs.register(sc.clone()) {
                Ok(_) => {
                    eprintln!("[magpie:ocr] 快捷键已注册：{text}（{field}）");
                    registered.push((sc, slot));
                }
                Err(e) => {
                    eprintln!("[magpie:ocr] 快捷键注册失败（可能被其他应用占用）：{text}: {e}");
                }
            },
            Err(e) => {
                eprintln!("[magpie:ocr] 快捷键格式无法解析：{text}: {e}");
            }
        }
    }
    *state.0.lock().unwrap() = registered;
    rebuild_tray_menu(app);
}

/// 重建托盘菜单（托盘尚未创建时静默跳过：setup 里首次由托盘构建流程负责）
fn rebuild_tray_menu(app: &tauri::AppHandle) {
    if let Some(tray) = app.tray_by_id("main") {
        if let Ok(menu) = build_tray_menu(app) {
            let _ = tray.set_menu(Some(menu));
        }
    }
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// dev 模式（裸二进制）托盘在 macOS 26+ 不显示（tray-icon#273：非 bundle
/// 二进制的状态项被系统隐藏）——而应用是菜单栏常驻形态，主窗口启动即隐藏，
/// 没有托盘就没有任何入口能再打开它。debug 构建启动即显示主窗口保底，
/// 让 dev 环境在托盘缺席时依然可操作；release 构建不受影响。
#[cfg(debug_assertions)]
fn dev_show_main_window(app: &tauri::AppHandle) {
    eprintln!("[magpie:dev] 裸二进制托盘在 macOS 26+ 不显示，主窗口已自动打开");
    show_main_window(app);
}

#[cfg(not(debug_assertions))]
fn dev_show_main_window(_app: &tauri::AppHandle) {}

/// 用户日志文件（与 settings.json 同目录）：调试日志此前仅 debug 构建输出，
/// release 用户报问题时无日志可看——「关于 › 反馈问题 › 复制日志」的数据源。
/// setup 时解析路径；超过 128KB 裁到尾段 32KB（环形上限防无限增长，32KB
/// ≈ 数百行，够回放最近操作且粘贴不臃肿）
static LOG_PATH: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();

/// 追加一行日志（时间戳 = unix 秒）。路径未就绪（早于 setup）时静默丢弃
pub(crate) fn user_log(msg: &str) {
    use std::io::Write;
    let Some(path) = LOG_PATH.get() else { return };
    if let Ok(md) = std::fs::metadata(path) {
        if md.len() > 128 * 1024 {
            if let Ok(bytes) = std::fs::read(path) {
                let tail = &bytes[bytes.len().saturating_sub(32 * 1024)..];
                let start = tail.iter().position(|&b| b == b'\n').map(|i| i + 1).unwrap_or(0);
                let _ = std::fs::write(path, &tail[start..]);
            }
        }
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let s = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let _ = writeln!(f, "[{s}] {msg}");
    }
}

/// 把日志文件复制到剪贴板（反馈用：用户粘进表单/Issue）。文件不存在 = 空日志
#[tauri::command]
fn copy_debug_log() -> Result<usize, String> {
    let empty_ok = || {
        use std::io::Write;
        if let Some(path) = LOG_PATH.get() {
            if !path.exists() {
                if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
                    let _ = writeln!(f, "（日志为空：启动后尚未记录任何事件）");
                }
            }
        }
    };
    empty_ok();
    let Some(path) = LOG_PATH.get() else {
        return Err("日志不可用".into());
    };
    let text = std::fs::read_to_string(path).unwrap_or_default();
    let len = text.chars().count();
    // 命令跑在异步运行时线程，同步写剪贴板无重入风险
    let mut clip = arboard::Clipboard::new().map_err(|e| format!("打开剪贴板失败: {e}"))?;
    clip.set_text(text).map_err(|e| format!("写入剪贴板失败: {e}"))?;
    Ok(len)
}

/// TS 侧调试日志通道（仅 debug 构建输出），用于照亮 Rust→TS 事件链路。
/// 自动带调用窗口的 label——同一日志在 floating/ocr/toast 各实例都会触发，
/// 不标来源的话重复行无法区分。双写 /tmp/magpie-debug.log（与 capture 的
/// debug_log 同一文件，[floating]/[ocr] 前缀区分来源）：排查时可直接读文件，
/// 不必盯 dev 终端
#[tauri::command]
fn ui_debug_log(window: tauri::WebviewWindow, msg: String) {
    if cfg!(debug_assertions) {
        eprintln!("[magpie:ui][{}] {msg}", window.label());
    }
    // release 也落盘（复制日志按钮的数据源）；stderr 只留 debug
    user_log(&format!("[{}] {}", window.label(), msg));
}

/// 用系统默认浏览器/邮件客户端打开链接（本地"搜索/打开链接/写邮件"动作用）
#[tauri::command]
fn open_url(url: String) -> bool {
    if !is_safe_url(&url) {
        return false;
    }
    #[cfg(target_os = "macos")]
    let _ = std::process::Command::new("open").arg(&url).spawn();
    #[cfg(target_os = "windows")]
    {
        // cmd.exe 是控制台程序：GUI 进程直接拉起会闪现黑色控制台窗口。
        // CREATE_NO_WINDOW 隐藏宿主 cmd（浏览器窗口照常弹出）
        use std::os::windows::process::CommandExt;
        let _ = std::process::Command::new("cmd")
            .args(["/C", "start", "", &url])
            .creation_flags(0x0800_0000)
            .spawn();
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let _ = std::process::Command::new("xdg-open").arg(&url).spawn();
    true
}

/// 白名单：http(s)；mailto（严格 local@domain，无空格无路径，杜绝注入面）；
/// maps://（原生地图搜索，[打开地图] 场景动作——查询由 encodeURIComponent 编码，
/// 仅要求无空白/控制字符且总长受限）
fn is_safe_url(url: &str) -> bool {
    if url.starts_with("https://") || url.starts_with("http://") {
        return true;
    }
    if let Some(addr) = url.strip_prefix("mailto:") {
        if addr.is_empty() || addr.contains([' ', '/', '?', '#']) {
            return false;
        }
        return matches!(addr.split_once('@'), Some((local, domain)) if !local.is_empty() && domain.contains('.'));
    }
    if url.starts_with("maps://") {
        return url.len() < 512 && !url.chars().any(|c| c.is_whitespace() || c.is_control());
    }
    false
}

fn main() {
    tauri::Builder::default()
        // 状态必须先于窗口创建就位：Windows 上 webview 加载极快，ocr/floating
        // 窗口一就绪就会 invoke 命令（实测早于 setup 尾部的 manage → panic）
        .manage(floating::FloatingState::default())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        let hit = app
                            .state::<OcrShortcuts>()
                            .0
                            .lock()
                            .unwrap()
                            .iter()
                            .find(|(s, _)| s == shortcut)
                            .map(|(_, slot)| *slot);
                        if let Some(slot) = hit {
                            match slot {
                                OcrSlot::FilePick => start_file_ocr_flow(app.clone()),
                                OcrSlot::Panel => start_ocr_flow(app.clone(), None),
                                OcrSlot::Auto(a) => start_ocr_flow(app.clone(), Some(a)),
                            }
                        }
                    }
                })
                .build(),
        )
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![]),
        ))
        .setup(|app| {
            let handle = app.handle().clone();
            settings::init(&handle);
            // 网页唤起（deep link）：magpie://feedback → 打开主窗口的
            // 「关于 › 反馈问题」（官网/推广页的一键反馈入口）
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let h = handle.clone();
                handle.deep_link().on_open_url(move |event| {
                    for url in event.urls() {
                        if url.host_str() == Some("feedback") {
                            show_main_window(&h);
                            let _ = h.emit_to("main", "nav://page", "about");
                        }
                    }
                });
            }
            // dev 裸二进制未打 Info.plist，手动向 LaunchServices 注册 scheme
            //（release 由 bundle 的 Info.plist 承担；失败静默）
            #[cfg(debug_assertions)]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let _ = handle.deep_link().register_all();
            }
            // 日志文件路径（与 settings 同目录）就位后 user_log 才开始落盘
            if let Ok(dir) = handle.path().app_config_dir() {
                let _ = LOG_PATH.set(dir.join("magpie.log"));
                user_log(&format!(
                    "=== 拾趣启动 v{} ===",
                    handle.package_info().version
                ));
            }
            // macOS 条窗关闭原生窗口阴影（2026-10-25 用户定稿：零边缘信号）：
            // 阴影按内容 alpha 轮廓画——白胶囊贴深色壁纸时读作一圈清晰黑环
            // （用户多次反馈的「黑边」最终来源，CSS 边线已全删后仍可见）；
            // 胶囊轮廓只靠面板与背景的亮度对比（demo 边缘策略·处方一完整形态）。
            // 结果窗/钉图不受影响（大面积阅读面，阴影是必要的深度线索）
            #[cfg(target_os = "macos")]
            if let Some(w) = handle.get_webview_window("floating") {
                let _ = w.set_shadow(false);
            }
            // 结果面板「钉住」偏好：沿用用户最后一次点钉的选择（默认钉住）
            floating::init_result_pin(&handle);
            app.manage(OcrShortcuts(std::sync::Mutex::new(Vec::new())));
            // 配置窗口统一延后到全部共享状态就位后创建（各窗口 create:false）：
            // Windows 上 WebView2 加载极快，IPC 派发可以早于 setup 完成——
            // 窗口若由 build() 预建，主窗口首发的 get_settings 会撞上尚未
            // manage 的设置状态而失败，前端又把失败吞掉，表现为设置页永远
            // 停在「正在载入」。窗口创建即开始加载页面，放在此处保证任何
            // 早期 invoke 都命中完整状态。
            for cfg in &app.config().app.windows {
                tauri::WebviewWindowBuilder::from_config(app, cfg)?.build()?;
            }
            // Windows 分离卡（方案甲一卡一窗）：先建二级浮层窗口，
            // 后面的窗口属性循环才能覆盖到它们
            #[cfg(target_os = "windows")]
            floating::init_pop_windows(&handle);

            // 自启状态同步：LaunchAgent 是 OS 侧事实，settings 只是镜像——
            // 应用启动时若两者漂移（系统清理了 plist 等），按 settings 静默拉齐。
            // debug 构建只降不升（禁用照常执行，启用跳过）——否则 dev 运行期间
            // 会把 target/debug 的 exe 静默注册成自启动项（dev 二进制无前端可加载）
            {
                use tauri_plugin_autostart::ManagerExt;
                let enabled = settings::current(&handle).launch_at_login;
                let al = handle.autolaunch();
                match al.is_enabled() {
                    Ok(true) if !enabled => {
                        let _ = al.disable();
                    }
                    Ok(false) if enabled && !cfg!(debug_assertions) => {
                        let _ = al.enable();
                    }
                    _ => {}
                }
            }

            // dev 调试入口：MAGPIE_DEBUG_FILE_OCR=1 启动后自动开一次选图对话框
            //（合成按键触发不了 Carbon 热键，自动化验证用；release 构建无此分支）
            #[cfg(debug_assertions)]
            if std::env::var("MAGPIE_DEBUG_FILE_OCR").as_deref() == Ok("1") {
                let dbg_handle = handle.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(6));
                    start_file_ocr_flow(dbg_handle);
                });
            }

            // 按用户配置决定是否在 Dock 显示图标（默认关：纯菜单栏常驻）
            #[cfg(target_os = "macos")]
            {
                let show = settings::current(&handle).show_dock_icon;
                let policy = if show {
                    tauri::ActivationPolicy::Regular
                } else {
                    tauri::ActivationPolicy::Accessory
                };
                let _ = handle.set_activation_policy(policy);
            }

            // 识图类全局快捷键（设置页可配，保存即时生效）：识别 + 可选自动执行动作
            apply_ocr_shortcuts(&handle);
            // 中文识别模型预热（macOS 26+ 按需资源，见 ocr.rs）：后台静默，一次即缓存
            ocr::warmup();
            // dev 保底：托盘缺席时主窗口是唯一入口（见 dev_show_main_window 注释）
            dev_show_main_window(&handle);

            // 弹出层窗口原生圆角（CSS 圆角压在透明窗口边界必出毛刺，见 floating.rs）；
            // Windows 一并去掉带阴影窗口自带的 1px 系统强调色边框（Win11，
            // DWMWA_BORDER_COLOR = NONE，见 floating.rs）。弹层标签在 macOS 不存在，
            // get_webview_window 返回 None 自动跳过
            for label in ["floating", "ocr", "toast", "floating-panel", "floating-menu"] {
                if let Some(w) = app.get_webview_window(label) {
                    // floating = 8：与 CSS 卡片圆角、vibrancy 材质 radius 三者对齐——
                    // 原生遮罩 12 > 卡片 8 时，角部 8→12 环带露出材质深色（角部黑块）
                    floating::apply_native_corner_radius(
                        &w,
                        if label == "floating" { 8.0 } else { 12.0 },
                    );
                }
            }

            // Windows：方案甲「一卡一窗 + 出血投影」——每张卡一扇窗口，
            // 窗口 = 卡片 + 四周 FLOAT_PAD(8px) 出血，CSS 轻投影画在出血区
            // （floating.css html.win 块，2026-10-26 恢复出血）。
            // tao 的无边框阴影仍必须关：它以 WM_NCCALCSIZE 内缩客户区一圈换
            // 阴影（窗口矩形 ≠ 卡片矩形，带子透出桌面成毛边）。DWM 方形阴影
            // （apply_frame_shadow）也已弃用：投影跟窗口矩形走，而卡片是
            // CSS 圆角，四角处阴影从圆弧外侧漏出，亮背景上呈灰斑
            // （2026-10-25 用户反馈「毛刺」；配方存档 chrome.rs）。
            // 不可聚焦（WS_EX_NOACTIVATE，对位 macOS orderFrontRegardless）：
            // 划词弹出浮动条不抢焦点，目标应用保持选区高亮。点击/滚轮不受
            // 影响；排除 snap（遮罩要收 Esc 键盘）与 pin（Esc 关闭需键盘）
            #[cfg(target_os = "windows")]
            for label in ["floating", "floating-panel", "floating-menu", "ocr", "toast"] {
                if let Some(w) = app.get_webview_window(label) {
                    let _ = w.set_shadow(false);
                    let _ = w.set_focusable(false);
                }
            }

            // 非激活窗口的 hover：悬浮条/结果窗不抢焦点（非 key），默认收不到
            // mouseMoved 事件——不开启则 CSS :hover 在首次点击前不生效
            for label in ["floating", "ocr", "floating-panel", "floating-menu"] {
                if let Some(w) = app.get_webview_window(label) {
                    floating::apply_hover_tracking(&w);
                }
            }

            // 用户强制外观（亮/暗）：原生窗口主题 + 前端 CSS 变量双轨同步。
            // 广播此刻未必有人听（webview 可能未挂载），各前端启动时也会主动读一次
            settings::apply_appearance(&app.handle());

            // 划词捕获 → 高层事件（Selection/PlainClick）→ 过滤与转发
            let (tx, rx) = std::sync::mpsc::channel::<capture::CaptureEvent>();
            let debounce_ms = settings::current(&handle).debounce_ms;
            capture::start(&handle, tx, debounce_ms);
            capture::spawn_worker(handle.clone(), rx);

            // 状态栏常驻图标：左键进主页面；右键菜单含「识图取字」当前快捷键提示
            let menu = build_tray_menu(&handle)?;
            TrayIconBuilder::with_id("main")
                // 状态栏专用模板图（单色鹊形 + alpha，白斑/眼为镂空）：
                // icon_as_template 让系统按菜单栏明暗自动反色，浅色渲染黑、深色渲染白
                .icon(
                    tauri::image::Image::from_bytes(include_bytes!("../icons/tray-icon.png"))
                        .expect("加载托盘图标失败"),
                )
                .icon_as_template(true)
                .tooltip("拾趣")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "home" => show_main_window(app),
                    "settings" => {
                        show_main_window(app);
                        let _ = app.emit_to("main", "nav://page", "model");
                    }
                    "ocr" => start_ocr_flow(app.clone(), None),
                    "ocr_translate" => start_ocr_flow(app.clone(), Some("translate")),
                    "ocr_explain" => start_ocr_flow(app.clone(), Some("explain")),
                    "ocr_summarize" => start_ocr_flow(app.clone(), Some("summarize")),
                    "file_ocr" => start_file_ocr_flow(app.clone()),
                    "github" => {
                        let _ = open_url("https://github.com/demo007x/Magpie".into());
                    }
                    "feedback" => {
                        // 与设置 › 关于 的「飞书反馈」同源（AboutPage.tsx FEEDBACK_FORM_URL）
                        let _ = open_url(
                            "https://tvxjr8zl48.feishu.cn/share/base/form/shrcnF78Kl495G3iUVz8iWvnA6e"
                                .into(),
                        );
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main_window(tray.app_handle());
                    }
                })
                .build(app)?;

            // 启动后台版本检查：错峰 20s 让窗口先建好；同版本只提示一次，
            // 24h 内不重复请求（GitHub 匿名 API 限 60 次/小时/IP）
            {
                let app_handle = handle.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(20));
                    let info =
                        tauri::async_runtime::block_on(update::check_update(app_handle.clone(), false));
                    update::announce(&app_handle, &info);
                });
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // 主窗口关闭 = 隐藏（捕获与浮动条继续常驻）；macOS 点 Dock 图标可再次打开
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            ui_debug_log,
            copy_debug_log,
            open_url,
            translate::baidu_translate,
            translate::deepl_translate,
            translate::google_translate,
            translate::azure_translate,
            translate::youdao_translate,
            translate::tencent_translate,
            translate::aliyun_translate,
            translate::volcano_translate,
            translate::caiyun_translate,
            ai::ai_chat,
            entities::detect_dates,
            obsidian::obsidian_append,
            entities::detect_places,
            entities::open_in_calendar,
            pageurl::frontmost_web_url,
            floating::bar::show_floating_bar,
            floating::bar::resize_floating,
            floating::bar::hide_floating_bar,
            floating::bar::begin_floating_drag,
            floating::material::update_floating_material,
            settings::get_settings,
            settings::save_settings,
            settings::set_appearance,
            capture::capture_status,
            capture::open_accessibility_settings,
            capture::prompt_accessibility,
            capture::request_listen_access,
            capture::request_screen_capture_access,
            floating::ocr::set_ocr_pinned,
            update::check_update,
            floating::ocr::ocr_window_mode,
            floating::ocr::ocr_window_pos,
            floating::ocr::ocr_take_pending,
            floating::ocr::ocr_window_ready,
            floating::ocr::hide_ocr_window,
            floating::ocr::push_selection_result,
            floating::ocr::focus_ocr_window,
            floating::ocr::set_result_window_size,
            floating::ocr::apply_result_preset,
            set_launch_at_login,
            floating::ocr::persist_result_window_state,
            floating::bar::screen_rect_at,
            floating::bar::floating_window_pos,
            floating::pops::set_floating_pops,
            floating::pops::pop_ready,
            floating::pops::floating_pick,
            floating::ocr::move_ocr,
            ocr::ocr_region_selected,
            ocr::ocr_region_cancel,
            pin::pin_get_data,
            pin::pin_window_ready,
            toast::notify,
            toast::resize_toast,
            pin::pin_window_pos,
            pin::resize_pin,
            pin::move_pin,
            pin::close_pin,
            pin::pin_copy_image,
            pin::pin_to_ocr,
            pin::pin_from_ocr,
            app_picker::pick_app_bundle,
            app_picker::pick_vault_dir,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // 启动即静默退出的排查插桩（debug 构建输出）
            if cfg!(debug_assertions) {
                match &event {
                    RunEvent::ExitRequested { code, .. } => {
                        eprintln!("[magpie] ExitRequested code={code:?}")
                    }
                    RunEvent::Exit => eprintln!("[magpie] EventLoop Exit"),
                    _ => {}
                }
            }
            #[cfg(target_os = "macos")]
            if let RunEvent::Reopen { .. } = event {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (app, &event);
        });
}
