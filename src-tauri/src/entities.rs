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
    darwin::detect_dates_impl(&t)
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
mod darwin {
    //! 非 macOS 占位：Windows M2 的等价物是 WinRT DateTimeFormatting / 正则，接入时再议
    use super::DateHit;
    pub(super) fn detect_dates_impl(_text: &str) -> Vec<DateHit> {
        Vec::new()
    }
}

/// NSTextCheckingTypeDate = 1 << 3（NSTextCheckingType 枚举顺序：Orthography=1<<0,
/// Spelling=1<<1, Grammar=1<<2, **Date=1<<3**…——凭"日期排第一"的直觉写成 1 会抛
/// NSInvalidArgumentException "no data detector types specified"。常量必须对照
/// SDK 头文件，勿凭记忆——这是继 CFRange 之后第二例）
const NSTEXT_CHECKING_TYPE_DATE: u64 = 1 << 3;

#[repr(C)]
struct NsRange {
    location: usize,
    length: usize,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detect_chinese_datetime() {
        let hits = darwin::detect_dates_impl("周四下午3点来国贸B座开会");
        println!("hits = {hits:?}");
        assert!(!hits.is_empty(), "应识别出日期");
    }

    #[test]
    fn detect_pure_ascii() {
        let hits = darwin::detect_dates_impl("meeting at 3pm on Oct 1st");
        println!("ascii hits = {hits:?}");
    }

    #[test]
    fn detect_empty_and_short() {
        let a = darwin::detect_dates_impl("");
        let b = darwin::detect_dates_impl("无日期的普通句子");
        println!("empty = {a:?}, plain = {b:?}");
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

    #[test]
    fn ner_recognizes_benchmark_places() {
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



