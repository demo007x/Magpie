#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ai;
mod app_picker;
mod capture;
mod floating;
mod ocr;
mod pin;
mod settings;
mod toast;
mod update;

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, RunEvent,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

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
    let home_item = MenuItem::with_id(app, "home", "主页面", true, None::<&str>)?;
    let settings_item = MenuItem::with_id(app, "settings", "功能设置", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "退出应用", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    Menu::with_items(app, &[
        &ocr_item,
        &tr_item,
        &ex_item,
        &su_item,
        &sep1,
        &home_item,
        &settings_item,
        &sep2,
        &quit_item,
    ])
}

/// 识图类快捷键槽位表：(settings 字段, 识别完成后自动执行的动作)。
/// action = None → 只弹结果面板；Some(id) → 面板弹出后自动执行该动作
/// （service 传 None，由前端按各动作既有的默认服务逻辑选择）
const OCR_SHORTCUT_SLOTS: [(&str, Option<&str>); 4] = [
    ("ocr_shortcut", None),
    ("ocr_translate_shortcut", Some("translate")),
    ("ocr_explain_shortcut", Some("explain")),
    ("ocr_summarize_shortcut", Some("summarize")),
];

/// 各槽位当前注册的全局快捷键（action = None 表示只识别不执行动作）；
/// handler 据此比对触发
pub struct OcrShortcuts(pub std::sync::Mutex<Vec<(Shortcut, Option<&'static str>)>>);

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

/// 按当前设置注册全部识图类全局快捷键（启动与保存设置时调用；清空 = 禁用）。
/// 单个槽位注册失败（格式错误/被系统占用）不影响其他槽位，仅记日志并不生效。
pub fn apply_ocr_shortcuts(app: &tauri::AppHandle) {
    use tauri::State;
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    let state: State<OcrShortcuts> = app.state();
    let s = settings::current(app);
    let mut registered = Vec::new();
    for (field, action) in OCR_SHORTCUT_SLOTS {
        let text = match field {
            "ocr_shortcut" => s.ocr_shortcut.clone(),
            "ocr_translate_shortcut" => s.ocr_translate_shortcut.clone(),
            "ocr_explain_shortcut" => s.ocr_explain_shortcut.clone(),
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
                    registered.push((sc, action));
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

/// TS 侧调试日志通道（仅 debug 构建输出），用于照亮 Rust→TS 事件链路
#[tauri::command]
fn ui_debug_log(msg: String) {
    if cfg!(debug_assertions) {
        eprintln!("[magpie:ui] {msg}");
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

/// 白名单：http(s)；mailto（严格 local@domain，无空格无路径，杜绝注入面）
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
                            .map(|(_, action)| *action);
                        if let Some(action) = hit {
                            start_ocr_flow(app.clone(), action);
                        }
                    }
                })
                .build(),
        )
        .setup(|app| {
            let handle = app.handle().clone();
            settings::init(&handle);
            // 结果面板「钉住」偏好：沿用用户最后一次点钉的选择（默认钉住）
            floating::init_result_pin(&handle);

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

            // 弹出层窗口原生圆角（CSS 圆角压在透明窗口边界必出毛刺，见 floating.rs）
            for label in ["floating", "ocr", "toast"] {
                if let Some(w) = app.get_webview_window(label) {
                    floating::apply_native_corner_radius(&w, 12.0);
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
