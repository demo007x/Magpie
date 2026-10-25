//! 来源页面 URL 提取（智能提取的上下文增强）：打开「提取信息」面板/点「加入日历」
//! 时，按选区来源进程 pid 直连 AX（AXUIElementCreateApplication），在焦点窗口里
//! 找 AXWebArea → AXURL，拿到选区所在网页的链接。
//! 用途有二：提交给 AI 时作为来源上下文（原文没有的链接模型也能感知）；
//! 写日历事件时填 URL 字段（活动页链接随事件进日历）。
//!
//! 为什么按 pid 而不是 AXFocusedApplication：点击浮动条/胶囊的瞬间系统焦点
//! 处于不定状态，systemwide 的 AXFocusedApplication 会返回错误（2026-10-24 实测）；
//! 而 captured 事件本就携带来源 pid，直连可靠且与 capture 模块的查询范式一致。
//! pid 由划词事件带入，OCR 流无来源 pid（pid=0）直接返回 None。
//! macOS 之外的平台暂无对位实现，返回 None。
//!
//! FFI 范式与 capture/macos.rs 一致：AX 常量用 ax_string() 构造 CFString
//!（勿 dlsym / extern static），Copy 返回值 +1 所有权及时 CFRelease。

/// 来源进程的页面 URL（仅 http/https）；pid<=0/非浏览器/非 macOS → None。
/// async：AX 查询含轮询等待（≤300ms），放线程池执行，不占主线程 IPC 派发
#[tauri::command]
pub async fn frontmost_web_url(pid: i32) -> Option<String> {
    imp::web_url_of_pid(pid)
}

#[cfg(target_os = "macos")]
mod imp {
    use core_foundation::base::{TCFType, CFTypeID};
    use core_foundation::boolean::CFBoolean;
    use core_foundation::string::{CFString, CFStringRef};
    use core_foundation::url::{CFURL, CFURLRef};
    use std::os::raw::{c_int, c_void};

    type CFTypeRefC = *const c_void;
    type CFArrayRefC = *const c_void;
    type AXUIElementRef = *mut c_void;

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXUIElementCreateApplication(pid: c_int) -> AXUIElementRef;
        fn AXUIElementCopyAttributeValue(
            el: AXUIElementRef,
            attr: CFStringRef,
            value: *mut CFTypeRefC,
        ) -> c_int;
        fn AXUIElementSetAttributeValue(
            el: AXUIElementRef,
            attr: CFStringRef,
            value: CFTypeRefC,
        ) -> c_int;
    }

    #[allow(clashing_extern_declarations)] // capture/macos.rs 里 CFRelease 用的是 *mut 形态
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFRetain(cf: CFTypeRefC) -> CFTypeRefC;
        fn CFRelease(cf: CFTypeRefC);
        fn CFGetTypeID(cf: CFTypeRefC) -> CFTypeID;
        fn CFArrayGetTypeID() -> CFTypeID;
        fn CFArrayGetCount(arr: CFArrayRefC) -> isize;
        fn CFArrayGetValueAtIndex(arr: CFArrayRefC, idx: isize) -> CFTypeRefC;
    }

    struct AxC {
        focused_window: CFStringRef,
        children: CFStringRef,
        role: CFStringRef,
        url: CFStringRef,
        enhanced_ui: CFStringRef,
    }

    // SAFETY: 不可变字符串常量，跨线程共享安全
    unsafe impl Send for AxC {}
    unsafe impl Sync for AxC {}

    fn consts() -> &'static AxC {
        static CACHE: std::sync::OnceLock<AxC> = std::sync::OnceLock::new();
        CACHE.get_or_init(|| AxC {
            focused_window: ax_string("AXFocusedWindow"),
            children: ax_string("AXChildren"),
            role: ax_string("AXRole"),
            url: ax_string("AXURL"),
            enhanced_ui: ax_string("AXEnhancedUserInterface"),
        })
    }

    /// 构造进程生命周期的 CFString 常量（故意不释放）
    fn ax_string(s: &str) -> CFStringRef {
        let cf = CFString::new(s);
        let raw = cf.as_concrete_TypeRef();
        std::mem::forget(cf);
        raw
    }

    /// 读属性（+1 所有权归调用方）；失败/空 → None
    unsafe fn copy_attr(el: AXUIElementRef, attr: CFStringRef) -> Option<CFTypeRefC> {
        let mut v: CFTypeRefC = std::ptr::null();
        if AXUIElementCopyAttributeValue(el, attr, &mut v) != 0 || v.is_null() {
            None
        } else {
            Some(v)
        }
    }

    /// +1 CFTypeRef → String（接管并释放）。AXURL 在 Safari 是 NSURL、
    /// Chromium 是 NSString——CFString/CFURL 两种形态都收
    unsafe fn cf_to_string(v: CFTypeRefC) -> Option<String> {
        let tid = CFGetTypeID(v);
        if tid == <CFString as TCFType>::type_id() {
            Some(CFString::wrap_under_create_rule(v as CFStringRef).to_string())
        } else if tid == <CFURL as TCFType>::type_id() {
            Some(CFURL::wrap_under_create_rule(v as CFURLRef).get_string().to_string())
        } else {
            CFRelease(v);
            None
        }
    }

    /// 深度优先找 AXWebArea → AXURL。层数/子节点数设上限：AX 树最坏可达
    /// 数千节点（长页面 DOM 全量暴露），不能失控。
    /// 所有权（2026-10-24 use-after-free 实证）：root 由调用方持有；子元素经
    /// CFArrayGetValueAtIndex 取出是借用（Get 规则），数组 CFRelease 后指针即
    /// 悬空——入栈前必须 CFRetain，处理完归还，否则遍历 Chrome 完整 DOM 树必崩
    unsafe fn find_web_url(root: AXUIElementRef) -> Option<String> {
        let mut stack: Vec<(AXUIElementRef, u8)> = vec![(root, 0)];
        let mut visited = 0usize;
        let mut web_areas = 0usize;
        while let Some((el, depth)) = stack.pop() {
            visited += 1;
            let mut hit: Option<String> = None;
            if let Some(rv) = copy_attr(el, consts().role) {
                if cf_to_string(rv).as_deref() == Some("AXWebArea") {
                    web_areas += 1;
                    if let Some(uv) = copy_attr(el, consts().url) {
                        if let Some(u) = cf_to_string(uv) {
                            eprintln!("[pageurl] WebArea URL: {u}");
                            if u.starts_with("http://") || u.starts_with("https://") {
                                hit = Some(u);
                            }
                        }
                    } else {
                        eprintln!("[pageurl] WebArea 无 AXURL 属性");
                    }
                }
            }
            if hit.is_none() && depth < 12 {
                if let Some(kids) = copy_attr(el, consts().children) {
                    if CFGetTypeID(kids) == CFArrayGetTypeID() {
                        let n = CFArrayGetCount(kids).min(300);
                        for i in 0..n {
                            let kid = CFArrayGetValueAtIndex(kids, i);
                            if !kid.is_null() {
                                // Get 规则不带所有权：数组释放后栈上还要用，先 Retain
                                stack.push((CFRetain(kid) as AXUIElementRef, depth + 1));
                            }
                        }
                    }
                    CFRelease(kids);
                }
            }
            if depth > 0 {
                CFRelease(el); // 归还入栈时的 Retain（root 是调用方的，不动）
            }
            if let Some(u) = hit {
                for (e, d) in stack.drain(..) {
                    if d > 0 {
                        CFRelease(e);
                    }
                }
                return Some(u);
            }
        }
        eprintln!("[pageurl] 遍历 {visited} 节点，WebArea {web_areas} 个，未取到 URL");
        None
    }

    pub(super) fn web_url_of_pid(pid: c_int) -> Option<String> {
        if pid <= 0 || pid == std::process::id() as c_int {
            return None;
        }
        unsafe {
            let app = AXUIElementCreateApplication(pid);
            if app.is_null() {
                eprintln!("[pageurl] CreateApplication(pid={pid}) = null");
                return None;
            }
            // Chromium 系默认不建 AX 树，轻推一次（不支持则被拒，忽略）；
            // 建树是异步的——轻推后立刻读大概率落空，照 capture 的 NUDGE_POLLS
            // 范式轮询等待（面板/胶囊点击不是热路径，300ms 上限可接受）
            AXUIElementSetAttributeValue(
                app,
                consts().enhanced_ui,
                CFBoolean::true_value().as_concrete_TypeRef() as CFTypeRefC,
            );
            for attempt in 0..3 {
                let url = copy_attr(app, consts().focused_window)
                    .and_then(|win| {
                        let u = find_web_url(win as AXUIElementRef);
                        CFRelease(win);
                        u
                    });
                eprintln!("[pageurl] pid={pid} 第{}轮: {url:?}", attempt + 1);
                if url.is_some() || attempt == 2 {
                    CFRelease(app);
                    return url;
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            CFRelease(app);
            None
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    pub(super) fn web_url_of_pid(_pid: i32) -> Option<String> {
        None
    }
}
