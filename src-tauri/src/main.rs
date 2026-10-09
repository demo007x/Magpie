#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ai;
mod app_picker;
mod capture;
mod entities;
mod floating;
mod obsidian;
mod ocr;
mod pin;
mod settings;
mod toast;
mod update;

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, RunEvent,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

/// 通用页开关：登录时自动启动。先改 LaunchAgent（OS 侧事实），成功才落 settings；
/// 失败时返回错误由前端 toast，settings 保持原状——OS 状态与镜像不同步比失败更糟
#[tauri::command]
fn set_launch_at_login(app: AppHandle, enabled: bool) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    let al = app.autolaunch();
    if enabled {
        al.enable().map_err(|e| e.to_string())?;
    } else {
        al.disable().map_err(|e| e.to_string())?;
    }
    crate::settings::patch(&app, |s| s.launch_at_login = enabled);
    Ok(())
}

/// 快捷键的菜单栏显示形式："Alt+S" → "⌥S"，"CmdOrCtrl+Shift+O" → "⌘⇧O"
fn shortcut_display(s: &str) -> String {
    s.trim()
        .split('+')
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(|p| match p.to_ascii_lowercase().as_str() {
            "cmdorctrl" | "cmd" | "command" | "ctrl" | "control" => "⌘".to_string(),
            "alt" | "option" | "opt" => "⌥".to_string(),
            "shift" => "⇧".to_string(),
            "super" | "meta" => "⊞".to_string(),
            other => other.to_uppercase(),
        })
        .collect()
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
                // 面板未创建，临时截图也没有存在价值：直接清理
                let _ = std::fs::remove_file(&image);
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

/// TS 侧调试日志通道（仅 debug 构建输出），用于照亮 Rust→TS 事件链路。
/// 自动带调用窗口的 label——同一日志在 floating/ocr/toast 各实例都会触发，
/// 不标来源的话重复行无法区分
#[tauri::command]
fn ui_debug_log(window: tauri::WebviewWindow, msg: String) {
    if cfg!(debug_assertions) {
        eprintln!("[magpie:ui][{}] {msg}", window.label());
    }
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
    let _ = std::process::Command::new("cmd").args(["/C", "start", "", &url]).spawn();
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
            // 结果面板「钉住」偏好：沿用用户最后一次点钉的选择（默认钉住）
            floating::init_result_pin(&handle);

            // 自启状态同步：LaunchAgent 是 OS 侧事实，settings 只是镜像——
            // 应用启动时若两者漂移（系统清理了 plist 等），按 settings 静默拉齐
            {
                use tauri_plugin_autostart::ManagerExt;
                let enabled = settings::current(&handle).launch_at_login;
                let al = handle.autolaunch();
                match al.is_enabled() {
                    Ok(true) if !enabled => {
                        let _ = al.disable();
                    }
                    Ok(false) if enabled => {
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
            app.manage(OcrShortcuts(std::sync::Mutex::new(Vec::new())));
            apply_ocr_shortcuts(&handle);
            // 中文识别模型预热（macOS 26+ 按需资源，见 ocr.rs）：后台静默，一次即缓存
            ocr::warmup();
            // dev 保底：托盘缺席时主窗口是唯一入口（见 dev_show_main_window 注释）
            dev_show_main_window(&handle);

            // 弹出层窗口原生圆角（CSS 圆角压在透明窗口边界必出毛刺，见 floating.rs）
            for label in ["floating", "ocr", "toast"] {
                if let Some(w) = app.get_webview_window(label) {
                    floating::apply_native_corner_radius(&w, 12.0);
                }
            }

            // 非激活窗口的 hover：悬浮条/结果窗不抢焦点（非 key），默认收不到
            // mouseMoved 事件——不开启则 CSS :hover 在首次点击前不生效
            for label in ["floating", "ocr"] {
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

            app.manage(floating::FloatingState::default());

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
            open_url,
            ai::baidu_translate,
            ai::deepl_translate,
            ai::ai_chat,
            entities::detect_dates,
            obsidian::obsidian_append,
            entities::detect_places,
            entities::open_in_calendar,
            floating::show_floating_bar,
            floating::resize_floating,
            floating::hide_floating_bar,
            floating::begin_floating_drag,
            settings::get_settings,
            settings::save_settings,
            settings::set_appearance,
            capture::capture_status,
            capture::open_accessibility_settings,
            capture::prompt_accessibility,
            capture::request_listen_access,
            capture::request_screen_capture_access,
            floating::set_ocr_pinned,
            update::check_update,
            floating::ocr_window_mode,
            floating::ocr_window_pos,
            floating::ocr_take_pending,
            floating::ocr_window_ready,
            floating::hide_ocr_window,
            floating::set_result_menu_grow,
            floating::push_selection_result,
            floating::focus_ocr_window,
            floating::set_result_window_size,
            floating::apply_result_preset,
            set_launch_at_login,
            floating::persist_result_window_state,
            floating::screen_rect_at,
            floating::floating_window_pos,
            floating::move_ocr,
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
