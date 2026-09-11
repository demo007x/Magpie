#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ai;
mod app_picker;
mod capture;
mod floating;
mod settings;

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, RunEvent,
};

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

/// 用系统默认浏览器打开链接（本地"搜索"动作用）
#[tauri::command]
fn open_url(url: String) {
    // 只接受我们构造的 http(s) 链接，防任意命令注入
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return;
    }
    #[cfg(target_os = "macos")]
    let _ = std::process::Command::new("open").arg(&url).spawn();
    #[cfg(target_os = "windows")]
    let _ = std::process::Command::new("cmd").args(["/C", "start", "", &url]).spawn();
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let _ = std::process::Command::new("xdg-open").arg(&url).spawn();
}

fn main() {
    tauri::Builder::default()
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

            // 划词捕获 → 高层事件（Selection/PlainClick）→ 过滤与转发
            let (tx, rx) = std::sync::mpsc::channel::<capture::CaptureEvent>();
            let debounce_ms = settings::current(&handle).debounce_ms;
            capture::start(tx, debounce_ms);
            capture::spawn_worker(handle.clone(), rx);

            app.manage(floating::FloatingState::default());

            // 状态栏常驻图标：左键进主页面；右键菜单：主页面/功能设置/退出应用
            let home_item = MenuItem::with_id(app, "home", "主页面", true, None::<&str>)?;
            let settings_item =
                MenuItem::with_id(app, "settings", "功能设置", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "退出应用", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&home_item, &settings_item, &quit_item])?;
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
