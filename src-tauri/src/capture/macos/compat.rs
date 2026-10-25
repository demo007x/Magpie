//! 兼容模式（docs/03 §A.3.3.1）：AX 链路全败时模拟 ⌘C 读剪贴板兜底（常开）。
//! 快照还原保证不污染用户剪贴板；编辑器家族（Finder/VSCode 等）有跳过守卫。
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use tauri::AppHandle;

use super::super::debug_log;
use super::ffi::*;
use super::query::{focused_pid, frontmost_pid, running_bundle_id};

// ---------- 兼容模式：模拟 ⌘C 读剪贴板（常开兜底；行业通行解，参考 Easydict #84） ----------

pub(super) const K_VK_ANSI_C: u16 = 8;
pub(super) const K_CG_EVENT_FLAG_COMMAND: u64 = 1 << 20;

pub(super) unsafe fn post_cmd_c() {
    let down = CGEventCreateKeyboardEvent(std::ptr::null_mut(), K_VK_ANSI_C, 1);
    let up = CGEventCreateKeyboardEvent(std::ptr::null_mut(), K_VK_ANSI_C, 0);
    if down.is_null() || up.is_null() {
        if !down.is_null() {
            CFRelease(down);
        }
        if !up.is_null() {
            CFRelease(up);
        }
        return;
    }
    CGEventSetFlags(down, K_CG_EVENT_FLAG_COMMAND);
    CGEventSetFlags(up, K_CG_EVENT_FLAG_COMMAND);
    CGEventPost(K_CG_HID_EVENT_TAP, down);
    CGEventPost(K_CG_HID_EVENT_TAP, up);
    CFRelease(down);
    CFRelease(up);
}

// 剪贴板文本读写必须在主线程：来源应用以「懒加载 promise」提供剪贴板数据时，
// 后台线程读取会触发 AppKit 警告（synchronous promise fulfillment … background
// thread）并可能不稳定。经 Tauri 主线程派发执行，捕获线程阻塞等待结果。
pub(super) fn main_read_text(app: &AppHandle) -> Option<String> {
    let (tx, rx) = std::sync::mpsc::channel();
    let sent = app.run_on_main_thread(move || {
        let text = arboard::Clipboard::new().ok().and_then(|mut b| b.get_text().ok());
        let _ = tx.send(text);
    });
    if sent.is_err() {
        return None;
    }
    rx.recv_timeout(Duration::from_millis(500)).ok().flatten()
}

pub(super) fn main_write_text(app: &AppHandle, text: String) {
    let _ = app.run_on_main_thread(move || {
        if let Ok(mut b) = arboard::Clipboard::new() {
            let _ = b.set_text(text);
        }
    });
}

pub(super) fn main_clear_text(app: &AppHandle) {
    let _ = app.run_on_main_thread(move || {
        if let Ok(mut b) = arboard::Clipboard::new() {
            let _ = b.clear();
        }
    });
}

/// 剪贴板图片快照（RGBA 位图）。仅在没有文本快照时调用——图片常是大位图，
/// 避免无谓的主线程拷贝。读取失败（纯文本剪贴板等）= None。
pub(super) fn main_read_image(app: &AppHandle) -> Option<arboard::ImageData<'static>> {
    let (tx, rx) = std::sync::mpsc::channel();
    let sent = app.run_on_main_thread(move || {
        let img = arboard::Clipboard::new()
            .ok()
            .and_then(|mut b| b.get_image().ok())
            .map(|i| arboard::ImageData {
                width: i.width,
                height: i.height,
                bytes: i.bytes.into_owned().into(),
            });
        let _ = tx.send(img);
    });
    if sent.is_err() {
        return None;
    }
    rx.recv_timeout(Duration::from_millis(500)).ok().flatten()
}

pub(super) fn main_write_image(app: &AppHandle, img: arboard::ImageData<'static>) {
    let _ = app.run_on_main_thread(move || {
        if let Ok(mut b) = arboard::Clipboard::new() {
            let _ = b.set_image(img);
        }
    });
}

/// Electron 编辑器家族（Monaco 系）bundle id：空选区 ⌘C 会复制光标所在行，
/// 兼容模式对该家族只会产出合成文本，真选区经轻推后 AX 链路必然可取（见下）。
pub(super) fn bid_in_editor_family(bid: &str) -> bool {
    matches!(
        bid,
        "com.microsoft.VSCode"
            | "com.microsoft.VSCodeInsiders"
            | "com.vscodium"
            | "com.todesktop.230313mzl4w4u92" // Cursor
            | "com.exafunction.windsurf" // Windsurf
    )
}

/// 兼容模式对 Electron 编辑器家族（VSCode/Cursor/Windsurf 等）跳过：
/// 该家族任何 AX 落空的拖拽（滚动条、文件树、标签页等）经 ⌘C 都会把**光标所在行**
/// 误捕成划词（VSCode 空选区 ⌘C = 复制当前行），而真文本选区在 Chromium 轻推
/// （AXManualAccessibility）后由 AX 链路稳定取到，⌘C 兜底对它只有误报价值。
/// 代价：用户手动关闭编辑器辅助功能支持（accessibilitySupport: "off"）时取词失效。
pub(super) fn skip_compat_for_focused_app() -> bool {
    // 聚焦链失败时退回 NSWorkspace 前台应用（不依赖 AX 消息）：AX 桥半死状态下
    // focused_pid 会间歇不可读，这道闸一漏放，模拟 ⌘C 就打进编辑器家族——
    // 守护闸的判据必须比被守护的通道更耐活
    let pid = focused_pid().or_else(frontmost_pid);
    let skip = pid.and_then(running_bundle_id).map_or(false, |bid| bid_in_editor_family(&bid));
    if skip {
        debug_log("兼容模式：Electron 编辑器家族（空选区 ⌘C 会复制当前行），跳过");
    }
    skip
}

/// 编辑器家族 AX 未开启（-25211 APIDisabled）的一次性指引：对本家族轻推 =
/// 强制对方进 Screen Reader Optimized 模式，代价不可接受——不轻推，指引用户
/// 自行开启（开启后走 AX 快通道，秒出且零误报）。每次启动至多提示一次
pub(super) fn show_editor_ax_guidance(app: &AppHandle) {
    static SHOWN: AtomicBool = AtomicBool::new(false);
    if SHOWN.swap(true, Ordering::Relaxed) {
        return;
    }
    crate::toast::show_toast_sticky(
        app,
        "VS Code 需开启辅助功能支持才能划词：在 VS Code 设置中把 accessibilitySupport 设为 on（VS Code 将进入读屏优化模式）",
        "info",
    );
}

/// 兼容模式取词：快照剪贴板 → 模拟 ⌘C → 轮询变化 → 取词 → 还原快照。
/// 剪贴板操作全部走主线程（见上方 helpers）。
/// 返回 (文本, 聚焦应用 pid（查不到为 0）)；失败 = None（静默）。
pub fn force_fetch_via_copy(app: &AppHandle) -> Option<(String, i32)> {
    if skip_compat_for_focused_app() {
        return None;
    }
    const POLL_TIMES: usize = 60; // 60 × 10ms = 600ms 上限；应用响应后首个周期即命中
    const POLL_INTERVAL: Duration = Duration::from_millis(10);

    let t_copy = Instant::now();
    let snapshot = main_read_text(app);
    // 文本快照为空时补读图片快照：QQ 贴图等场景剪贴板里只有图片——
    // 只还原文本会把整块剪贴板清空/覆盖，图片就丢了（用户实测丢失案例）
    let image_snapshot = if snapshot.is_none() {
        main_read_image(app)
    } else {
        None
    };

    unsafe { post_cmd_c() };

    let mut fetched: Option<String> = None;
    for _ in 0..POLL_TIMES {
        std::thread::sleep(POLL_INTERVAL);
        if let Some(now) = main_read_text(app) {
            let changed = snapshot.as_ref().map_or(true, |s| *s != now);
            if changed && !now.trim().is_empty() {
                fetched = Some(now);
                break;
            }
        }
    }

    // 还原决策。兼容模式是"借用"剪贴板——拿完文本应物归原主，但借用期间
    // 第三方可能写入新内容（QQ 贴图的图片在模拟 ⌘C 之后才落板——快照阶段
    // 读不到它，盲目还原会覆盖比快照更新的东西。用户实测三连：贴图图片丢失、
    // 历史顺序错乱、重复条目——全是这一个竞态的不同切面）。
    // 因此还原前重读现状，只在「取到文本且现状仍是它」时物归原主：
    // · 快照有文本 → 还原文本；原本只有图片 → 还原图片；原本为空 → 清空
    // · 其余一切（取词失败，或现状已变）→ 不动剪贴板，保留现状——
    //   图片不丢、顺序不错乱、也没有同内容重写的重复条目
    let now_text = main_read_text(app);
    if fetched.is_some() && now_text.as_deref() == fetched.as_deref() {
        match &snapshot {
            Some(s) => main_write_text(app, s.clone()),
            None => match &image_snapshot {
                Some(img) => main_write_image(app, img.clone()),
                None => main_clear_text(app),
            },
        };
    } else {
        debug_log(format!(
            "⏱ 兼容模式 ⌘C：未取到文本或现状有新写入，跳过还原（保留现状）"
        ));
    }

    if fetched.is_none() {
        debug_log(format!(
            "⏱ 兼容模式 ⌘C：未取到（轮询耗尽 {}ms）",
            t_copy.elapsed().as_millis()
        ));
    }
    let text = fetched?;
    let pid = focused_pid().unwrap_or(0);
    debug_log(format!(
        "⏱ 兼容模式 ⌘C：取到文本 len={}，耗时 {}ms",
        text.len(),
        t_copy.elapsed().as_millis()
    ));
    Some((text, pid))
}
