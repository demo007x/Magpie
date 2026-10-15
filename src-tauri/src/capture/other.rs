//! 非 macOS / 非 Windows 平台占位（Linux 等，无划词能力）。
#![allow(dead_code)]

use std::sync::mpsc::Sender;

use tauri::AppHandle;

use super::CaptureEvent;

pub fn start(_app: &AppHandle, _tx: Sender<CaptureEvent>, _debounce_ms: u64) {
    // 仅保证可编译运行；划词为 macOS/Windows 平台能力
}

/// 能力位：本平台无划词能力
pub fn capture_available() -> bool {
    false
}

pub fn is_accessibility_granted() -> bool {
    true
}

pub fn ax_service_probe() -> bool {
    true
}

pub fn listen_event_access() -> bool {
    true
}

pub fn screen_capture_access() -> bool {
    false
}

pub fn open_accessibility_settings() {}

pub fn prompt_accessibility() -> bool {
    true
}
