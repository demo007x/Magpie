//! 实体出口动作（场景能力第一站）：
//! detect_dates = NSDataDetector 日期实体识别——系统级、离线、确定性，
//!   中文相对时间（"周四下午3点/明天/下周三"）自动对照当天解析，是它的本职工作；
//! open_in_calendar = 本地拼 .ics 事件文件交给系统日历（预填新事件，用户确认保存）。
//!
//! 设计依据：todo.md 场景能力探索（2026-09-22）——出口类动作把价值送进用户
//! 已有的系统应用（日历/地图），是对话式 AI 的结构性盲区；全部确定性组件，
//! 零 AI、零外部 API、零新增权限（不碰 EventKit，.ics 文件打开即零权限路径）。

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

#[tauri::command]
pub fn detect_dates(text: String) -> Vec<DateHit> {
    let mut t = text;
    if t.chars().count() > 8192 {
        t = t.chars().take(8192).collect();
    }
    if t.trim().is_empty() {
        return vec![];
    }
    detect_dates_text(&t)
}

/// 平台分发：macOS = NSDataDetector FFI；其余 = 本地规则层（rules 模块）
fn detect_dates_text(t: &str) -> Vec<DateHit> {
    #[cfg(target_os = "macos")]
    return darwin::detect_dates_impl(t);
    #[cfg(not(target_os = "macos"))]
    return rules::detect_dates_impl(t);
}

/// 本地拼 .ics 事件并交给系统日历打开（预填新事件，用户确认后保存）。
/// 不走 EventKit——那需要日历读写授权。时间字符串由 TS 计算后传入（JS 原生
/// Date 处理本地时区，Rust 零日期依赖）：timed = "YYYYMMDDTHHMMSS"（本地时间，
/// 无 Z 后缀即浮墙时间）；all_day = "YYYYMMDD"（end 为次日，含头不含尾）。
#[tauri::command]
pub fn open_in_calendar(start: String, end: String, title: String, all_day: bool) -> bool {
    let summary = escape_ics_text(&title);
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let (dt_start, dt_end) = if all_day {
        (
            format!("DTSTART;VALUE=DATE:{start}"),
            format!("DTEND;VALUE=DATE:{end}"),
        )
    } else {
        (format!("DTSTART:{start}"), format!("DTEND:{end}"))
    };
    let ics = format!(
        "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Magpie//Scene Actions//CN\r\nBEGIN:VEVENT\r\nUID:{millis}@magpie\r\n{dt_start}\r\n{dt_end}\r\nSUMMARY:{summary}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"
    );
    let path = std::env::temp_dir().join(format!("magpie-{millis}.ics"));
    if std::fs::write(&path, ics).is_err() {
        return false;
    }
    #[cfg(target_os = "macos")]
    let opened = std::process::Command::new("open").arg(&path).spawn().is_ok();
    #[cfg(target_os = "windows")]
    let opened = std::process::Command::new("cmd")
        .args(["/C", "start", "", &path.to_string_lossy()])
        .spawn()
        .is_ok();
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let opened = std::process::Command::new("xdg-open").arg(&path).spawn().is_ok();
    opened
}

/// RFC 5545 SUMMARY 转义：反斜杠/分号/逗号需转义，换行压成空格（单行属性）
fn escape_ics_text(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace(';', "\\;")
        .replace(',', "\\,")
        .replace(['\n', '\r'], " ")
}

#[cfg(target_os = "macos")]
mod darwin {
    //! NSDataDetector FFI：手写 objc_msgSend 变体（沿用 capture/macos.rs 范式）。
    //! NSRange 按值传参/返回（16 字节，走寄存器，无需 *_stret 变体）。
    use super::{DateHit, NsRange, NSTEXT_CHECKING_TYPE_DATE};
    use core_foundation::base::TCFType;
    use core_foundation::string::CFString;
    use std::os::raw::{c_char, c_void};

    type CFTypeRefC = *const c_void;

    #[allow(clashing_extern_declarations)]
    extern "C" {
        fn objc_getClass(name: *const c_char) -> *mut c_void;
        fn sel_registerName(name: *const c_char) -> *mut c_void;
        #[link_name = "objc_msgSend"]
        fn msg_send_id_u64_err(
            receiver: *mut c_void,
            sel: *mut c_void,
            types: u64,
            err: *mut *mut c_void,
        ) -> *mut c_void;
        #[link_name = "objc_msgSend"]
        fn msg_send_matches(
            receiver: *mut c_void,
            sel: *mut c_void,
            string: *mut c_void,
            options: u64,
            range: NsRange,
        ) -> *mut c_void;
        #[link_name = "objc_msgSend"]
        fn msg_send_id_inst(receiver: *mut c_void, sel: *mut c_void) -> *mut c_void;
        #[link_name = "objc_msgSend"]
        fn msg_send_f64(receiver: *mut c_void, sel: *mut c_void) -> f64;
        #[link_name = "objc_msgSend"]
        fn msg_send_range(receiver: *mut c_void, sel: *mut c_void) -> NsRange;
        // NSArray 与 CFArray 免税桥接（macos.rs 已有同款声明，模块自包含再声明一份）
        fn CFArrayGetCount(arr: CFTypeRefC) -> isize;
        fn CFArrayGetValueAtIndex(arr: CFTypeRefC, idx: isize) -> CFTypeRefC;
    }

    fn objc_class(name: &str) -> *mut c_void {
        let c = std::ffi::CString::new(name).unwrap();
        unsafe { objc_getClass(c.as_ptr()) }
    }

    fn objc_sel(name: &str) -> *mut c_void {
        let c = std::ffi::CString::new(name).unwrap();
        unsafe { sel_registerName(c.as_ptr()) }
    }

    pub(super) fn detect_dates_impl(text: &str) -> Vec<DateHit> {
        unsafe {
            let class = objc_class("NSDataDetector");
            if class.is_null() {
                return vec![];
            }
            let mut err: *mut c_void = std::ptr::null_mut();
            let detector = msg_send_id_u64_err(
                class,
                objc_sel("dataDetectorWithTypes:error:"),
                NSTEXT_CHECKING_TYPE_DATE,
                &mut err,
            );
            if detector.is_null() {
                return vec![];
            }
            let cf = CFString::new(text);
            let ns_text = cf.as_concrete_TypeRef() as *mut c_void;
            // NSString 长度按 UTF-16 单位计（与 char 数在 emoji 处不一致，必须用 encode_utf16）
            let range = NsRange {
                location: 0,
                length: text.encode_utf16().count(),
            };
            let matches = msg_send_matches(
                detector,
                objc_sel("matchesInString:options:range:"),
                ns_text,
                0,
                range,
            );
            if matches.is_null() {
                return vec![];
            }
            let arr = matches as CFTypeRefC;
            let n = CFArrayGetCount(arr);
            let mut out = Vec::new();
            for i in 0..n {
                let r = CFArrayGetValueAtIndex(arr, i);
                if r.is_null() {
                    continue;
                }
                let date = msg_send_id_inst(r as *mut c_void, objc_sel("date"));
                if date.is_null() {
                    continue;
                }
                let unix = msg_send_f64(date, objc_sel("timeIntervalSince1970"));
                if !unix.is_finite() || unix <= 0.0 {
                    continue;
                }
                let dur = msg_send_f64(r as *mut c_void, objc_sel("duration"));
                let rg = msg_send_range(r as *mut c_void, objc_sel("range"));
                out.push(DateHit {
                    unix: unix as i64,
                    duration: if dur.is_finite() && dur > 0.0 { dur as i64 } else { 0 },
                    start: rg.location,
                    len: rg.length,
                });
            }
            out
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod rules {
    //! 非 macOS 日期实体：本地规则层（NSDataDetector 的 Windows 对位）。
    //! 正则 + chrono 本地时区日历运算，零 AI、零网络。范围从严：歧义形态
    //! （裸 10/14、无月份的"3号"）宁可不识别，与 detect_places 的精度优先
    //! 取向一致。与 macOS 端输出契约一致：DateHit（unix 含时区，start/len
    //! 为 UTF-16 单位）。日期与时间相邻时合并为单条命中（"周四下午3点" →
    //! 周四 15:00 一条，而非两条碎片）。
    //!
    //! 已知取舍（v1）：不支持时间段范围（"2pm to 4pm" 的 duration）、
    //! 中文数字日期（"十月十四日"）、"N小时后"；命中优先级碰撞时靠
    //! 重叠丢弃兜底。
    use super::DateHit;
    use chrono::{
        Datelike, Duration as ChronoDuration, Local, NaiveDate, NaiveDateTime, NaiveTime, TimeZone,
    };
    use regex::Regex;

    /// 中间命中：正则直接产物，date/time 至少一项存在，允许重叠（后置合并）
    #[derive(Debug)]
    struct RawHit {
        start: usize,
        end: usize,
        date: Option<NaiveDate>,
        time: Option<NaiveTime>,
        /// 原文未含年份：无年份且已过去的日期滚到明年（11 月说 "Oct 1st" → 明年）
        year_absent: bool,
    }

    fn hit(
        m: regex::Match<'_>,
        date: Option<NaiveDate>,
        time: Option<NaiveTime>,
        year_absent: bool,
    ) -> RawHit {
        RawHit { start: m.start(), end: m.end(), date, time, year_absent }
    }

    fn utf16_len(s: &str) -> usize {
        s.encode_utf16().count()
    }

    pub(super) fn detect_dates_impl(text: &str) -> Vec<DateHit> {
        let today = Local::now().date_naive();
        let mut raws = collect_raw(text);
        merge_date_time(text, &mut raws);
        raws.sort_by_key(|r| (r.start, r.end));

        let mut out: Vec<DateHit> = Vec::new();
        let mut last_end = 0usize; // UTF-16 单位
        for r in &raws {
            let s = utf16_len(&text[..r.start]);
            // 重叠丢弃：多正则碰撞的兜底（如 ISO 日期与中文日期部分重叠）
            if s < last_end {
                continue;
            }
            if let Some(h) = to_hit(text, r, today) {
                last_end = h.start + h.len;
                out.push(h);
            }
        }
        out
    }

    /// RawHit → DateHit：时间缺失补当日 00:00；日期缺失补今天；
    /// 无年份且已过去 → 明年。本地时区换算，DST 歧义取单一解或最早解
    fn to_hit(text: &str, raw: &RawHit, today: NaiveDate) -> Option<DateHit> {
        let mut date = match (raw.date, raw.time) {
            (Some(d), _) => d,
            (None, Some(_)) => today,
            (None, None) => return None,
        };
        if raw.year_absent && date < today {
            date = date.with_year(date.year() + 1).unwrap_or(date);
        }
        let time = raw.time.unwrap_or_else(|| NaiveTime::from_hms_opt(0, 0, 0).unwrap());
        let ndt = NaiveDateTime::new(date, time);
        let unix = Local
            .from_local_datetime(&ndt)
            .single()
            .or_else(|| Local.from_local_datetime(&ndt).earliest())
            .map(|dt| dt.timestamp())
            .unwrap_or(0);
        Some(DateHit {
            unix,
            duration: 0,
            start: utf16_len(&text[..raw.start]),
            len: utf16_len(&text[raw.start..raw.end]),
        })
    }

    /// 全部正则收集原始命中。交替分支一律长词在前（大后天 > 后天，
    /// saturday > sat），杜绝子串抢先匹配
    fn collect_raw(text: &str) -> Vec<RawHit> {
        let mut out: Vec<RawHit> = Vec::new();
        let today = Local::now().date_naive();
        let this_year = today.year();

        // 中文绝对日期：2026年10月14日 / 10月14日 / 10月14号
        if let Ok(re) = Regex::new(r"(?:(\d{4})\s*年)?\s*(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]") {
            for m in re.captures_iter(text) {
                let whole = m.get(0).unwrap();
                let y = m.get(1).and_then(|g| g.as_str().parse::<i32>().ok());
                let mo = m.get(2).and_then(|g| g.as_str().parse::<u32>().ok());
                let d = m.get(3).and_then(|g| g.as_str().parse::<u32>().ok());
                let (Some(mo), Some(d)) = (mo, d) else { continue };
                match y {
                    Some(y) => {
                        if let Some(date) = NaiveDate::from_ymd_opt(y, mo, d) {
                            out.push(hit(whole, Some(date), None, false));
                        }
                    }
                    None => {
                        if let Some(date) = NaiveDate::from_ymd_opt(this_year, mo, d) {
                            out.push(hit(whole, Some(date), None, true));
                        }
                    }
                }
            }
        }

        // ISO 风格：2026-10-14 / 2026.10.14 / 2026/10/14（必须含年份，
        // 杜绝 "3/4"、"3.14" 一类分数/版本号歧义）
        if let Ok(re) = Regex::new(r"(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})") {
            for m in re.captures_iter(text) {
                let whole = m.get(0).unwrap();
                let y = m.get(1).and_then(|g| g.as_str().parse::<i32>().ok());
                let mo = m.get(2).and_then(|g| g.as_str().parse::<u32>().ok());
                let d = m.get(3).and_then(|g| g.as_str().parse::<u32>().ok());
                if let (Some(y), Some(mo), Some(d)) = (y, mo, d) {
                    if let Some(date) = NaiveDate::from_ymd_opt(y, mo, d) {
                        out.push(hit(whole, Some(date), None, false));
                    }
                }
            }
        }

        // 中文星期：下周三 / 本周五 / 礼拜天 / 周六（末 = 周六）
        if let Ok(re) = Regex::new(r"(这|本|下下|下)?(?:周|礼拜|星期)([一二三四五六日天]|末)") {
            for m in re.captures_iter(text) {
                let whole = m.get(0).unwrap();
                let prefix = m.get(1).map(|g| g.as_str());
                let wd = m.get(2).unwrap().as_str();
                let target = match wd {
                    "一" => 0u32,
                    "二" => 1,
                    "三" => 2,
                    "四" => 3,
                    "五" => 4,
                    "六" => 5,
                    "日" | "天" => 6,
                    "末" => 5,
                    _ => continue,
                };
                out.push(hit(whole, Some(resolve_weekday(target, prefix, today)), None, true));
            }
        }

        // 中文相对日（大后天必须在后天之前，否则只匹配到"后天"）
        if let Ok(re) = Regex::new(r"(大后天|后天|今天|今日|今晚|明天|明日|明晚)") {
            for m in re.captures_iter(text) {
                let whole = m.get(0).unwrap();
                let (delta, evening) = match whole.as_str() {
                    "今天" | "今日" => (0i64, false),
                    "今晚" => (0, true),
                    "明天" | "明日" => (1, false),
                    "明晚" => (1, true),
                    "后天" => (2, false),
                    "大后天" => (3, false),
                    _ => continue,
                };
                let date = today + ChronoDuration::days(delta);
                let time = if evening { NaiveTime::from_hms_opt(20, 0, 0) } else { None };
                out.push(hit(whole, Some(date), time, true));
            }
        }

        // N天后 / N天後
        if let Ok(re) = Regex::new(r"(\d{1,3})\s*天[后後]") {
            for m in re.captures_iter(text) {
                let whole = m.get(0).unwrap();
                if let Some(n) = m.get(1).and_then(|g| g.as_str().parse::<i64>().ok()) {
                    out.push(hit(whole, Some(today + ChronoDuration::days(n)), None, true));
                }
            }
        }

        // 英文相对词
        if let Ok(re) = Regex::new(r"(?i)\b(today|tonight|tomorrow|yesterday)\b") {
            for m in re.captures_iter(text) {
                let whole = m.get(0).unwrap();
                let (delta, evening) = match whole.as_str().to_ascii_lowercase().as_str() {
                    "today" => (0i64, false),
                    "tonight" => (0, true),
                    "tomorrow" => (1, false),
                    "yesterday" => (-1, false),
                    _ => continue,
                };
                let date = today + ChronoDuration::days(delta);
                let time = if evening { NaiveTime::from_hms_opt(20, 0, 0) } else { None };
                out.push(hit(whole, Some(date), time, true));
            }
        }

        // 英文星期（全词交替、长词在前："saturate" 不会命中 sat）
        if let Ok(re) = Regex::new(
            r"(?i)\b(next|this|last)?\s?(monday|mon|tuesday|tues|tue|wednesday|wed|thursday|thurs|thur|thu|friday|fri|saturday|sat|sunday|sun)\b",
        ) {
            for m in re.captures_iter(text) {
                let whole = m.get(0).unwrap();
                let prefix = m.get(1).map(|g| g.as_str().to_ascii_lowercase());
                let wd = m.get(2).unwrap().as_str().to_ascii_lowercase();
                let target = match wd.as_str() {
                    "monday" | "mon" => 0u32,
                    "tuesday" | "tues" | "tue" => 1,
                    "wednesday" | "wed" => 2,
                    "thursday" | "thurs" | "thur" | "thu" => 3,
                    "friday" | "fri" => 4,
                    "saturday" | "sat" => 5,
                    "sunday" | "sun" => 6,
                    _ => continue,
                };
                // this/next 与中文对齐：未来最近一次 / 下周同星期；last = 过去最近一次
                let today_w = today.weekday().num_days_from_monday();
                let fwd = (target + 7 - today_w) % 7;
                let back = (today_w + 7 - target) % 7;
                let date = match prefix.as_deref() {
                    Some("next") => today + ChronoDuration::days(fwd as i64 + 7),
                    Some("last") => today - ChronoDuration::days(back as i64),
                    _ => today + ChronoDuration::days(fwd as i64),
                };
                out.push(hit(whole, Some(date), None, true));
            }
        }

        // 英文月日：Oct 1st / October 14, 2026（全词 + 边界，"octopus 5" 不命中）
        if let Ok(re) = Regex::new(
            r"(?i)\b(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec)\b\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s*,?\s*(\d{4}))?",
        ) {
            for m in re.captures_iter(text) {
                let whole = m.get(0).unwrap();
                let mon = m.get(1).unwrap().as_str().to_ascii_lowercase();
                let mo = match mon.as_str() {
                    "january" | "jan" => 1u32,
                    "february" | "feb" => 2,
                    "march" | "mar" => 3,
                    "april" | "apr" => 4,
                    "may" => 5,
                    "june" | "jun" => 6,
                    "july" | "jul" => 7,
                    "august" | "aug" => 8,
                    "september" | "sept" | "sep" => 9,
                    "october" | "oct" => 10,
                    "november" | "nov" => 11,
                    "december" | "dec" => 12,
                    _ => continue,
                };
                let d = m.get(2).and_then(|g| g.as_str().parse::<u32>().ok());
                let y = m.get(3).and_then(|g| g.as_str().parse::<i32>().ok());
                let Some(d) = d else { continue };
                match y {
                    Some(y) => {
                        if let Some(date) = NaiveDate::from_ymd_opt(y, mo, d) {
                            out.push(hit(whole, Some(date), None, false));
                        }
                    }
                    None => {
                        if let Some(date) = NaiveDate::from_ymd_opt(this_year, mo, d) {
                            out.push(hit(whole, Some(date), None, true));
                        }
                    }
                }
            }
        }

        // 中文时间：下午3点 / 15点30分 / 9点半 / 晚上8点
        if let Ok(re) = Regex::new(
            r"(上午|早上|凌晨|中午|午后|下午|傍晚|晚上|夜里|深夜)?\s*(\d{1,2})\s*[点时]\s*(?:半|(\d{1,2})\s*分?)?",
        ) {
            for m in re.captures_iter(text) {
                let whole = m.get(0).unwrap();
                // "第3点"（要点列举）不是时间：跳过紧贴"第"的命中
                if text[..whole.start()].ends_with('第') {
                    continue;
                }
                let daypart = m.get(1).map(|g| g.as_str());
                let h = m.get(2).and_then(|g| g.as_str().parse::<u32>().ok());
                let min = if let Some(mm) = m.get(3) {
                    mm.as_str().parse::<u32>().ok()
                } else if whole.as_str().contains('半') {
                    Some(30)
                } else {
                    Some(0)
                };
                if let (Some(h), Some(min)) = (h, min) {
                    if let Some(t) = map_time(daypart, h, min) {
                        out.push(hit(whole, None, Some(t), true));
                    }
                }
            }
        }

        // 冒号时间：15:30 / 9：05（冒号形态无上午下午歧义，直接 24 小时制；
        // 分钟必须两位，"比例 3:2" 不命中。regex crate 无 lookaround，
        // 边界用 \b：不会命中 "2026-10-14" 的 "10-14"（无冒号）与 URL 端口）
        if let Ok(re) = Regex::new(r"\b(\d{1,2})\s*[:：]\s*(\d{2})\b") {
            for m in re.captures_iter(text) {
                let whole = m.get(0).unwrap();
                let h = m.get(1).and_then(|g| g.as_str().parse::<u32>().ok());
                let min = m.get(2).and_then(|g| g.as_str().parse::<u32>().ok());
                if let (Some(h), Some(min)) = (h, min) {
                    if h < 24 && min < 60 {
                        out.push(hit(whole, None, NaiveTime::from_hms_opt(h, min, 0), true));
                    }
                }
            }
        }

        // 英文 am/pm：3pm / at 10:30 am
        if let Ok(re) = Regex::new(r"(?i)\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?\b") {
            for m in re.captures_iter(text) {
                let whole = m.get(0).unwrap();
                let h = m.get(1).and_then(|g| g.as_str().parse::<u32>().ok());
                let min = m
                    .get(2)
                    .and_then(|g| g.as_str().parse::<u32>().ok())
                    .unwrap_or(0);
                let pm = m
                    .get(3)
                    .map(|g| g.as_str().to_ascii_lowercase() == "p")
                    .unwrap_or(false);
                if let Some(h) = h {
                    if (1..=12).contains(&h) && min < 60 {
                        let h24 = match (pm, h) {
                            (true, 12) => 12,
                            (true, _) => h + 12,
                            (false, 12) => 0,
                            (false, _) => h,
                        };
                        out.push(hit(whole, None, NaiveTime::from_hms_opt(h24, min, 0), true));
                    }
                }
            }
        }

        // noon / midnight
        if let Ok(re) = Regex::new(r"(?i)\b(noon|midnight)\b") {
            for m in re.captures_iter(text) {
                let whole = m.get(0).unwrap();
                let t = match whole.as_str().to_ascii_lowercase().as_str() {
                    "noon" => NaiveTime::from_hms_opt(12, 0, 0),
                    _ => NaiveTime::from_hms_opt(0, 0, 0),
                };
                out.push(hit(whole, None, t, true));
            }
        }

        out
    }

    /// 星期解析：无前缀/这/本 = 未来最近一次（含今天）；下 = 下周；下下 = 下下周。
    /// chrono 周一 = 0
    fn resolve_weekday(target: u32, prefix: Option<&str>, today: NaiveDate) -> NaiveDate {
        let today_w = today.weekday().num_days_from_monday();
        let fwd = (target + 7 - today_w) % 7;
        match prefix {
            Some("下下") => today + ChronoDuration::days(fwd as i64 + 14),
            Some("下") => today + ChronoDuration::days(fwd as i64 + 7),
            _ => today + ChronoDuration::days(fwd as i64),
        }
    }

    /// 中文时段映射（口语惯例启发式）：
    /// - 下午/午后：h<12 → +12（下午3点 = 15:00）
    /// - 晚上/傍晚/夜里/深夜：h<12 → +12；h==12 → 0（晚上12点 = 午夜）
    /// - 凌晨/中午/上午/早上：原样
    /// - 无时段：1-7点口语偏向下午（+12），8-11 与 12 原样
    fn map_time(daypart: Option<&str>, h: u32, min: u32) -> Option<NaiveTime> {
        let h24 = match daypart {
            Some("下午") | Some("午后") => {
                if h < 12 {
                    h + 12
                } else {
                    h
                }
            }
            Some("傍晚") | Some("晚上") | Some("夜里") | Some("深夜") => {
                if h == 12 {
                    0
                } else if h < 12 {
                    h + 12
                } else {
                    h
                }
            }
            None => {
                if (1..=7).contains(&h) {
                    h + 12
                } else {
                    h
                }
            }
            _ => h,
        };
        NaiveTime::from_hms_opt(h24.min(23), min, 0)
    }

    /// 日期 + 时间相邻合并（"周四下午3点"、"10月14日 15:30"、"3pm on Oct 1st"）：
    /// 时间命中与日期命中间隔 ≤6 字节且中间只允许空白/的/at → 合并为一条
    fn merge_date_time(text: &str, raws: &mut Vec<RawHit>) {
        let mut used = vec![false; raws.len()];
        let mut out: Vec<RawHit> = Vec::with_capacity(raws.len());
        for i in 0..raws.len() {
            if used[i] {
                continue;
            }
            if raws[i].date.is_some() && raws[i].time.is_none() {
                let mut best: Option<(usize, usize)> = None; // (j, gap)
                for j in 0..raws.len() {
                    if j == i || used[j] || raws[j].date.is_some() || raws[j].time.is_none() {
                        continue;
                    }
                    let (a_end, b_start) = if raws[j].end <= raws[i].start {
                        (raws[j].end, raws[i].start)
                    } else if raws[i].end <= raws[j].start {
                        (raws[i].end, raws[j].start)
                    } else {
                        continue;
                    };
                    if !gap_ok(text, a_end, b_start) {
                        continue;
                    }
                    let gap = b_start - a_end;
                    if best.map(|(_, g)| gap < g).unwrap_or(true) {
                        best = Some((j, gap));
                    }
                }
                if let Some((j, _)) = best {
                    let (s, e) = (raws[i].start.min(raws[j].start), raws[i].end.max(raws[j].end));
                    let date = raws[i].date;
                    let time = raws[j].time;
                    let year_absent = raws[i].year_absent && raws[j].year_absent;
                    used[i] = true;
                    used[j] = true;
                    out.push(RawHit { start: s, end: e, date, time, year_absent });
                    continue;
                }
            }
            used[i] = true;
            let taken = std::mem::replace(
                &mut raws[i],
                RawHit { start: 0, end: 0, date: None, time: None, year_absent: true },
            );
            out.push(taken);
        }
        *raws = out;
    }

    /// 合并间隔合法性：≤6 字节，内容 = 空白 + 至多一个连接词（的/at/on）
    fn gap_ok(text: &str, start: usize, end: usize) -> bool {
        let Some(g) = text.get(start..end) else {
            return false;
        };
        if g.len() > 6 {
            return false;
        }
        let t = g.trim();
        t.is_empty()
            || t == "的"
            || t.eq_ignore_ascii_case("at")
            || t.eq_ignore_ascii_case("on")
    }
}

/// NSTextCheckingTypeDate = 1 << 3（NSTextCheckingType 枚举顺序：Orthography=1<<0,
/// Spelling=1<<1, Grammar=1<<2, **Date=1<<3**…——凭"日期排第一"的直觉写成 1 会抛
/// NSInvalidArgumentException "no data detector types specified"。常量必须对照
/// SDK 头文件，勿凭记忆——这是继 CFRange 之后第二例）
#[cfg(target_os = "macos")]
const NSTEXT_CHECKING_TYPE_DATE: u64 = 1 << 3;

#[cfg(target_os = "macos")]
#[repr(C)]
struct NsRange {
    location: usize,
    length: usize,
}

#[cfg(test)]
mod tests {
    use super::*;

    // 平台无关：macOS 跑 NSDataDetector，其余跑本地规则层，均应命中。
    // macOS CI 例外：runner 的裸虚拟机缺中文语言资产/locale（同机英文用例
    // 过、中文一律检空即证据），断言的是「系统中文能力在场」而非代码正确性
    // ——跳过、只在真机验；非 macOS 走本地规则层与资产无关，CI 照常跑
    #[test]
    fn detect_chinese_datetime() {
        #[cfg(target_os = "macos")]
        if std::env::var_os("CI").is_some() {
            return;
        }
        let hits = detect_dates_text("周四下午3点来国贸B座开会");
        println!("hits = {hits:?}");
        assert!(!hits.is_empty(), "应识别出日期");
    }

    #[test]
    fn detect_pure_ascii() {
        let hits = detect_dates_text("meeting at 3pm on Oct 1st");
        println!("ascii hits = {hits:?}");
        assert!(!hits.is_empty(), "应识别出英文日期");
    }

    #[test]
    fn detect_empty_and_short() {
        let a = detect_dates_text("");
        let b = detect_dates_text("无日期的普通句子");
        println!("empty = {a:?}, plain = {b:?}");
    }

    // 规则层语义断言（macOS 端语义归 NSDataDetector，不适用）
    #[cfg(not(target_os = "macos"))]
    mod rule_semantics {
        use super::*;
        use chrono::{Datelike, Local, TimeZone, Timelike};

        fn decode(hits: &[DateHit]) -> Vec<(i32, u32, u32, u32, u32)> {
            hits.iter()
                .map(|h| {
                    let dt = Local.timestamp_opt(h.unix, 0).unwrap();
                    (dt.year(), dt.month(), dt.day(), dt.hour(), dt.minute())
                })
                .collect()
        }

        #[test]
        fn absolute_chinese_datetime_merges() {
            let hits = detect_dates_text("2026年10月14日下午3点30分评审");
            let got = decode(&hits);
            println!("got = {got:?}");
            assert_eq!(hits.len(), 1, "日期+时间应合并为一条");
            assert_eq!(got[0], (2026, 10, 14, 15, 30));
            assert!(hits[0].len > 0);
        }

        #[test]
        fn iso_date() {
            let hits = detect_dates_text("发布日 2026-12-01，记得 review");
            let got = decode(&hits);
            assert_eq!(got[0], (2026, 12, 1, 0, 0));
        }

        #[test]
        fn tomorrow_with_half() {
            let tomorrow = Local::now().date_naive().succ_opt().unwrap();
            let hits = detect_dates_text("明天下午3点半碰一下");
            let got = decode(&hits);
            assert_eq!(hits.len(), 1, "明天+时间应合并为一条");
            assert_eq!((got[0].0, got[0].1, got[0].2), (tomorrow.year(), tomorrow.month(), tomorrow.day()));
            assert_eq!((got[0].3, got[0].4), (15, 30));
        }

        #[test]
        fn colon_time_only() {
            let hits = detect_dates_text("我们 15:30 见");
            let got = decode(&hits);
            assert_eq!((got[0].3, got[0].4), (15, 30));
        }

        #[test]
        fn no_false_positive_on_versions_and_ratios() {
            assert!(detect_dates_text("版本 3.14 发布说明").is_empty(), "版本号不是日期");
            assert!(detect_dates_text("比例 3:2 混合").is_empty(), "单数字分钟不是时间");
            assert!(detect_dates_text("第3点很有道理").is_empty(), "要点列举不是时间");
        }

        #[test]
        fn english_words_not_substring_matched() {
            // saturate / octopus 不得作为 sat/oct 命中
            assert!(detect_dates_text("we saturate the market").is_empty());
            assert!(detect_dates_text("octopus 5 legs").is_empty());
        }

        #[test]
        fn english_merged_time_then_date() {
            let hits = detect_dates_text("meeting at 3pm on Oct 1st");
            assert_eq!(hits.len(), 1, "3pm 与 Oct 1st 应合并");
            let got = decode(&hits);
            assert_eq!(got[0].1, 10);
            assert_eq!(got[0].2, 1);
            assert_eq!(got[0].3, 15);
        }
    }
}

// ---------- 地点实体：NLTagger NER（placeName） ----------
// 产品决策（2026-09-25）：地点识别只用 Apple NaturalLanguage 的命名实体识别，
// 精度优先——识别出来的是准的，漏了就漏了，不做后缀启发式备选。
// 后缀正则方案（原 extractPlaces）实测会产出裸类型词（"校区/园区"）与句子碎片
// （"我们将在大学校区"），NER 从语义层面天然排除这两类垃圾。
// 选择器用非回调版 tagsInRange:unit:scheme:options:tokenRanges:（避开 block FFI）。

#[tauri::command]
pub fn detect_places(text: String) -> Vec<String> {
    let mut t = text;
    if t.chars().count() > 8192 {
        t = t.chars().take(8192).collect();
    }
    if t.trim().is_empty() {
        return vec![];
    }
    let mut hits = darwin_nlp::detect_places_impl(&t);
    hits.dedup();
    hits.truncate(10);
    hits
}

#[cfg(target_os = "macos")]
mod darwin_nlp {
    use core_foundation::base::TCFType;
    use core_foundation::string::CFString;
    use std::os::raw::{c_char, c_void};

    type CFTypeRefC = *const c_void;

    #[link(name = "NaturalLanguage", kind = "framework")]
    #[allow(clashing_extern_declarations)]
    extern "C" {
        fn objc_getClass(name: *const c_char) -> *mut c_void;
        fn sel_registerName(name: *const c_char) -> *mut c_void;
        #[link_name = "objc_msgSend"]
        fn msg_send_id_inst(receiver: *mut c_void, sel: *mut c_void) -> *mut c_void;
        #[link_name = "objc_msgSend"]
        fn msg_send_id_ptr(receiver: *mut c_void, sel: *mut c_void, arg: *mut c_void) -> *mut c_void;
        #[link_name = "objc_msgSend"]
        fn msg_send_void_ptr(receiver: *mut c_void, sel: *mut c_void, arg: *mut c_void);
        #[link_name = "objc_msgSend"]
        fn msg_send_tags(
            receiver: *mut c_void,
            sel: *mut c_void,
            range: super::NsRange,
            unit: u64,
            scheme: *mut c_void,
            options: u64,
            token_ranges: *mut *mut c_void,
        ) -> *mut c_void;
        #[link_name = "objc_msgSend"]
        fn msg_send_range(receiver: *mut c_void, sel: *mut c_void) -> super::NsRange;
        #[link_name = "objc_msgSend"]
        fn msg_send_utf8(receiver: *mut c_void, sel: *mut c_void) -> *const c_char;
        fn CFArrayGetCount(arr: CFTypeRefC) -> isize;
        fn CFArrayGetValueAtIndex(arr: CFTypeRefC, idx: isize) -> CFTypeRefC;
    }

    fn objc_class(name: &str) -> *mut c_void {
        unsafe { objc_getClass(std::ffi::CString::new(name).unwrap().as_ptr()) }
    }

    fn objc_sel(name: &str) -> *mut c_void {
        unsafe { sel_registerName(std::ffi::CString::new(name).unwrap().as_ptr()) }
    }

    pub(super) fn detect_places_impl(text: &str) -> Vec<String> {
        unsafe {
            // NSMutableArray array → 方案表（仅 NameType）
            let array = msg_send_id_inst(
                objc_class("NSMutableArray"),
                objc_sel("array"),
            );
            if array.is_null() {
                return vec![];
            }
            let scheme = CFString::new("NameType");
            msg_send_void_ptr(array, objc_sel("addObject:"), scheme.as_concrete_TypeRef() as *mut c_void);

            // [[NLTagger alloc] initWithTagSchemes:] + setString:
            let tagger = msg_send_id_ptr(
                msg_send_id_inst(objc_class("NLTagger"), objc_sel("alloc")),
                objc_sel("initWithTagSchemes:"),
                array,
            );
            if tagger.is_null() {
                return vec![];
            }
            let cf = CFString::new(text);
            msg_send_void_ptr(tagger, objc_sel("setString:"), cf.as_concrete_TypeRef() as *mut c_void);

            // tagsInRange:unit:scheme:options:tokenRanges:
            // unit: NLTokenUnitWord = 0。options 必须为 0——实测
            // omitPunctuation|omitWhitespace(3) 在中文上会把全部标签清空
            //（英文不受影响，Apple 的坑，见矩阵测试记录）；
            // 非地名 token 由下方 "PlaceName" 过滤兜住
            let mut token_ranges: *mut c_void = std::ptr::null_mut();
            let range = super::NsRange {
                location: 0,
                length: text.encode_utf16().count(),
            };
            let tags = msg_send_tags(
                tagger,
                objc_sel("tagsInRange:unit:scheme:options:tokenRanges:"),
                range,
                0,
                scheme.as_concrete_TypeRef() as *mut c_void,
                0,
                &mut token_ranges,
            );
            // alloc/init 的对象归我们所有，用完释放（tags/tokenRanges 是 autoreleased，不动）
            msg_send_void_ptr(tagger, objc_sel("release"), std::ptr::null_mut());
            if tags.is_null() || token_ranges.is_null() {
                return vec![];
            }

            // 平行数组：tags（NLTag 值）与 tokenRanges（NSValue 包 NSRange）
            let n = CFArrayGetCount(tags as CFTypeRefC).min(CFArrayGetCount(token_ranges as CFTypeRefC));
            let utf16: Vec<u16> = text.encode_utf16().collect();
            let mut out = Vec::new();
            for i in 0..n {
                let tag = CFArrayGetValueAtIndex(tags as CFTypeRefC, i);
                if tag.is_null() {
                    continue;
                }
                let ptr = msg_send_utf8(tag as *mut c_void, objc_sel("UTF8String"));
                if ptr.is_null() {
                    continue;
                }
                if std::ffi::CStr::from_ptr(ptr).to_string_lossy() != "PlaceName" {
                    continue;
                }
                let v = CFArrayGetValueAtIndex(token_ranges as CFTypeRefC, i);
                if v.is_null() {
                    continue;
                }
                let rg = msg_send_range(v as *mut c_void, objc_sel("rangeValue"));
                if rg.length == 0 || rg.location + rg.length > utf16.len() {
                    continue;
                }
                if let Ok(s) = String::from_utf16(&utf16[rg.location..rg.location + rg.length]) {
                    if !s.trim().is_empty() {
                        out.push(s);
                    }
                }
            }
            out
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod darwin_nlp {
    //! 非 macOS 占位：Windows M2 时评估 WinRT NER 或云端方案
    pub(super) fn detect_places_impl(_text: &str) -> Vec<String> {
        Vec::new()
    }
}

#[cfg(test)]
mod place_tests {
    use super::*;

    // NLTagger NER 行为基准（macOS 专属；非 macOS 为空实现桩）。
    // macOS CI 跳过：中文 NER 依赖系统语言模型，runner 裸 VM 未装（返回空），
    // 该断言在 CI 上恒假、红着没有信息量——真机 cargo test 全量验
    #[cfg(target_os = "macos")]
    #[test]
    fn ner_recognizes_benchmark_places() {
        if std::env::var_os("CI").is_some() {
            return;
        }
        let hits = darwin_nlp::detect_places_impl("我在北京天安门附近看到了国贸B座");
        println!("北京/天安门 → {hits:?}");
        assert!(!hits.is_empty(), "北京/天安门应被识别为地名");
    }

    #[test]
    fn ner_ignores_generic_type_words() {
        let hits = darwin_nlp::detect_places_impl("我们将在大学校区召开会议");
        println!("大学校区句子 → {hits:?}");
        assert!(hits.is_empty(), "裸类型词不应被识别为地名（精度优先）");
    }
}



