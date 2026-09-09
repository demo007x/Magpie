//! 非 macOS 平台占位（M2: Windows UIA，预设计见 docs/03 §7）。
#![allow(dead_code)]

use std::sync::mpsc::Sender;

use super::CaptureEvent;

pub fn start(_tx: Sender<CaptureEvent>, _debounce_ms: u64) {
    // M2: SetWindowsHookEx(WH_MOUSE_LL) + UI Automation（TextPattern::GetSelection）
}

pub fn is_accessibility_granted() -> bool {
    true // Windows UIA 无系统级权限开关；占位
}

pub fn open_accessibility_settings() {}

pub fn prompt_accessibility() -> bool {
    true
}
