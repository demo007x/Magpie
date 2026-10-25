//! 实体出口动作（场景能力第一站）：
//! detect_dates = NSDataDetector 日期实体识别——系统级、离线、确定性，
//!   中文相对时间（"周四下午3点/明天/下周三"）自动对照当天解析，是它的本职工作；
//! open_in_calendar = 本地拼 .ics 事件文件交给系统日历（预填新事件，用户确认保存）。
//!
//! 设计依据：todo.md 场景能力探索（2026-09-22）——出口类动作把价值送进用户
//! 已有的系统应用（日历/地图），是对话式 AI 的结构性盲区；全部确定性组件，
//! 零 AI、零外部 API、零新增权限（不碰 EventKit，.ics 文件打开即零权限路径）。


mod calendar;
mod dates;
mod places;

// #[tauri::command] 包装器必须留在本模块：generate_handler!(entities::xxx) 在
// 此路径解析宏生成的 __cmd__ 项，子模块 re-export 不可靠（tauri-macros 的
// macro_export 落 crate 根，跨模块 use 不生效）
#[tauri::command]
pub fn detect_dates(text: String) -> Vec<DateHit> {
    dates::detect_dates(text)
}

#[tauri::command]
pub fn detect_places(text: String) -> Vec<String> {
    places::detect_places(text)
}

#[tauri::command]
pub fn open_in_calendar(
    start: String,
    end: String,
    title: String,
    all_day: bool,
    url: Option<String>,
    notes: Option<String>,
    attendees: Option<Vec<String>>,
) -> bool {
    calendar::open_in_calendar(start, end, title, all_day, url, notes, attendees)
}

/// 一个日期实体命中。unix 由 NSDataDetector 的 NSDate 直接换算（含时区），
/// duration = 0 表示文本未给出事件时长。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DateHit {
    pub unix: i64,
    pub duration: i64,
    /// 命中区间（UTF-16 单位，供将来截取标题/高亮）
    pub start: usize,
    pub len: usize,
}
