#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ai;
mod app_picker;
mod capture;
mod floating;
mod ocr;
mod pin;
mod settings;
mod toast;

use tauri::{
    menu::{Menu, MenuItem},
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

/// 托盘右键菜单（快捷键变更后重建，让「文本识别」旁始终显示当前设定的键）
fn build_tray_menu(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let ocr_label = {
        let display = shortcut_display(&settings::current(app).ocr_shortcut);
        if display.is_empty() {
            "文本识别".to_string()
        } else {
            format!("文本识别  {display}")
        }
    };
    let home_item = MenuItem::with_id(app, "home", "主页面", true, None::<&str>)?;
    let ocr_item = MenuItem::with_id(app, "ocr", &ocr_label, true, None::<&str>)?;
    let settings_item = MenuItem::with_id(app, "settings", "功能设置", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "退出应用", true, None::<&str>)?;
    Menu::with_items(app, &[&home_item, &ocr_item, &settings_item, &quit_item])
}

/// 文本识别当前注册的全局快捷键（None = 未启用）；handler 据此比对触发
pub struct OcrShortcut(pub std::sync::Mutex<Option<Shortcut>>);

/// 文本识别流程（托盘菜单与全局快捷键共用）：
/// 后台线程执行框选+识别，完成后推给 OCR 独立窗口（原图供「钉图」）
fn start_ocr_flow(app: tauri::AppHandle) {
    eprintln!("[magpie:ocr] 文本识别开始");
    tauri::async_runtime::spawn(async move {
        // 两段式（感知提速）：截图完成立即弹面板（图片预览 + 识别中占位），
        // 识别完成后仅回填文本——用户感知等待从「全链路之和」降为「识别本身」
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
        ocr::push_capturing_to_ocr_window(&app, image.clone());
        eprintln!("[magpie:ocr] 截图完成，面板已推送，开始识别");
        match tauri::async_runtime::spawn_blocking(move || ocr::recognize_file(&image)).await {
            Ok(Ok(text)) => {
                eprintln!("[magpie:ocr] 成功：len={}", text.len());
                ocr::push_ocr_text(&app, text);
            }
            Ok(Err(e)) => {
                eprintln!("[magpie:ocr] 失败：{e}");
                if e != "截图已取消" {
                    toast::show_toast(&app, &e, "err");
                }
                ocr::push_ocr_error(&app, e);
            }
            Err(e) => eprintln!("[magpie:ocr] 任务失败: {e}"),
        }
    });
}

/// 按当前设置注册文本识别快捷键（启动与保存设置时调用；清空 = 禁用）。
/// 注册失败（格式错误/被系统占用）不阻塞启动，仅记日志并在 UI 上不生效。
pub fn apply_ocr_shortcut(app: &tauri::AppHandle) {
    use tauri::State;
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    let state: State<OcrShortcut> = app.state();
    let text = settings::current(app).ocr_shortcut.trim().to_string();
    if text.is_empty() {
        *state.0.lock().unwrap() = None;
        eprintln!("[magpie:ocr] 快捷键已禁用");
        rebuild_tray_menu(app);
        return;
    }
    match text.parse::<Shortcut>() {
        Ok(sc) => match gs.register(sc.clone()) {
            Ok(_) => {
                *state.0.lock().unwrap() = Some(sc);
                eprintln!("[magpie:ocr] 快捷键已注册：{text}");
            }
            Err(e) => {
                *state.0.lock().unwrap() = None;
                eprintln!("[magpie:ocr] 快捷键注册失败（可能被其他应用占用）：{text}: {e}");
            }
        },
        Err(e) => {
            *state.0.lock().unwrap() = None;
            eprintln!("[magpie:ocr] 快捷键格式无法解析：{text}: {e}");
        }
    }
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
                        let target = app.state::<OcrShortcut>();
                        let hit = target
                            .0
                            .lock()
                            .unwrap()
                            .as_ref()
                            .map_or(false, |s| s == shortcut);
                        if hit {
                            start_ocr_flow(app.clone());
                        }
                    }
                })
                .build(),
        )
        .setup(|app| {
            let handle = app.handle().clone();
            settings::init(&handle);

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

            // 文本识别全局快捷键（设置页可配，保存即时生效）
            app.manage(OcrShortcut(std::sync::Mutex::new(None)));
            apply_ocr_shortcut(&handle);

            // 弹出层窗口原生圆角（CSS 圆角压在透明窗口边界必出毛刺，见 floating.rs）
            for label in ["floating", "ocr", "toast"] {
                if let Some(w) = app.get_webview_window(label) {
                    floating::apply_native_corner_radius(&w, 12.0);
                }
            }
            // macOS 26 Liquid Glass：挂载成功则前端切换半透明表面
            let liquid_on = floating::enable_liquid_glass(&app.handle());
            let _ = app.emit("theme://liquid-glass", liquid_on);

            // 划词捕获 → 高层事件（Selection/PlainClick）→ 过滤与转发
            let (tx, rx) = std::sync::mpsc::channel::<capture::CaptureEvent>();
            let debounce_ms = settings::current(&handle).debounce_ms;
            capture::start(&handle, tx, debounce_ms);
            capture::spawn_worker(handle.clone(), rx);

            app.manage(floating::FloatingState::default());

            // 状态栏常驻图标：左键进主页面；右键菜单含「文本识别」当前快捷键提示
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
                    "ocr" => start_ocr_flow(app.clone()),
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
            capture::capture_status,
            capture::open_accessibility_settings,
            capture::prompt_accessibility,
            capture::request_listen_access,
            capture::request_screen_capture_access,
            floating::set_ocr_pinned,
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
            floating::liquid_glass_enabled,
            floating::set_liquid_glass,
            floating::liquid_glass_available,
            floating::move_ocr,
            pin::pin_get_data,
            pin::pin_window_ready,
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
