//! 地名实体识别（NER）：macOS = NLTagger；其余平台为空实现桩（Windows M2 时
//! 评估 WinRT NER）。命令入口 detect_places 在 mod.rs。

/// 原 entities.rs 根共享的 NSRange 副本（与 dates.rs 各持一份，均为模块私有）：
/// NLTagger 的 enumerateTags 回调按值返回 range
#[cfg(target_os = "macos")]
#[repr(C)]
struct NsRange {
    location: usize,
    length: usize,
}

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




