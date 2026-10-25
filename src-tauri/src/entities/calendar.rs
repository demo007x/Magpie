//! 日历出口：本地拼 .ics 事件文件交给系统日历打开（预填新事件，用户确认后保存）。
//! 不走 EventKit——那需要日历读写授权；时间字符串由 TS 计算后传入。

/// 本地拼 .ics 事件并交给系统日历打开（预填新事件，用户确认后保存）。
/// 不走 EventKit——那需要日历读写授权。时间字符串由 TS 计算后传入（JS 原生
/// Date 处理本地时区，Rust 零日期依赖）：timed = "YYYYMMDDTHHMMSS"（本地时间，
/// 无 Z 后缀即浮墙时间）；all_day = "YYYYMMDD"（end 为次日，含头不含尾）。
/// url / notes / attendees 可选：提取信息场景的「连同上下文一起进日历」——
/// url 取选区首个链接，notes 为选区原文，attendees 为选区里的邮箱（受邀人）。
pub fn open_in_calendar(
    start: String,
    end: String,
    title: String,
    all_day: bool,
    url: Option<String>,
    notes: Option<String>,
    attendees: Option<Vec<String>>,
) -> bool {
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
    let mut extra = String::new();
    if let Some(u) = url.as_deref().map(str::trim).filter(|u| !u.is_empty()) {
        // URL 属性值原样写入（URI 类型不转义）；只收 http(s)，防注入伪造属性行
        if u.starts_with("http://") || u.starts_with("https://") {
            extra.push_str(&format!("URL:{u}\r\n"));
        }
    }
    if let Some(n) = notes.as_deref().map(str::trim).filter(|n| !n.is_empty()) {
        extra.push_str(&format!("DESCRIPTION:{}\r\n", escape_ics_multiline(n)));
    }
    if let Some(list) = attendees {
        for a in list.iter().map(|a| a.trim()).filter(|a| !a.is_empty()) {
            // 邮箱形态粗校验（TS 侧已过完整正则，这里只挡 CRLF 注入）
            if a.len() <= 254 && !a.contains(['\r', '\n']) && a.contains('@') {
                extra.push_str(&format!("ATTENDEE:mailto:{a}\r\n"));
            }
        }
    }
    let ics = format!(
        "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Magpie//Scene Actions//CN\r\nBEGIN:VEVENT\r\nUID:{millis}@magpie\r\n{dt_start}\r\n{dt_end}\r\nSUMMARY:{summary}\r\n{extra}END:VEVENT\r\nEND:VCALENDAR\r\n"
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

/// DESCRIPTION 转义：与单行属性同规则，但换行保留为 \n 字面量（日历备注里保留分段）
fn escape_ics_multiline(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace(';', "\\;")
        .replace(',', "\\,")
        .replace('\n', "\\n")
        .replace('\r', "")
}

