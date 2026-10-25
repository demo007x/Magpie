//! 条窗 vibrancy 材质（macOS）：NSVisualEffectView 每卡一个，挂在窗口
//! contentView 的最底层（webview 之下）。TS 布局 effect 量出每张卡片的窗口
//! 内矩形后经 update_floating_material 上报，这里按矩形摆放视图（不够则建、
//! 多余则藏——视图池复用，随弹层开合不反复创建/销毁）。
//!
//! ⚠️ 2026-10-25 停用（用户定稿）：menu 材质自带基色亮度（非纯黑），叠任何
//! 半透明墨度都会「黑中有灰」——真机多轮调墨度（50%→74%）不达「高级的纯粹」，
//! 定稿回退不透明哑光 + B+ 细节层（floating.css 深色材质节）。本模块保留，
//! 重开 = bar.rs 两处 apply 调用 + App.tsx MATERIAL_ENABLED + CSS 半透明墨度
//! 节三处一起翻开（窗口架构演进后再评估）。
//!
//! 为什么每卡一个而不是整窗一个：弹层展开后窗口生长为「胶囊+浮层」的不规则
//! 并集，整窗材质视图会把材质矩形外露在卡片缝隙与轮廓之外成黑边（2026-10-24
//! vibrancy 首次接入的翻案根因）；每卡视图经 layer 圆角裁切，缝隙处无视图 =
//! 真实桌面透出，黑边从结构上不存在。
//!
//! AppKit 调用必须主线程：command 内经 run_on_main_thread 派发（AGENTS 约定）。

/// vibrancy 总开关（false = 纯 CSS 哑光材质，视图不创建不挂载）
pub const ENABLED: bool = false;

use std::os::raw::c_void;

use serde::Deserialize;
#[cfg(target_os = "macos")]
use tauri::Manager;

/// TS 上报的卡片矩形（窗口内容坐标，CSS px = 逻辑点，top-left 原点）。
#[derive(Deserialize, Clone)]
pub struct MaterialCard {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// TS 主题切换后同步材质明暗（尺寸不变，无 resize 在途）。非 macOS 空实现
/// （Windows 分离卡走 CSS 不透明哑光，floating.css 的 html.win 分支）。
#[tauri::command]
pub fn update_floating_material(
    window: tauri::WebviewWindow,
    cards: Vec<MaterialCard>,
    dark: bool,
) {
    #[cfg(target_os = "macos")]
    {
        if let Ok(ns) = window.ns_window() {
            let key = ns as usize;
            // 闭包只捕获窗口键与数据、不借引用——run_on_main_thread 要求 'static
            let _ = window.app_handle().run_on_main_thread(move || {
                // 高度传 0 = 读实时 bounds：此路径无 resize 在途，bounds 可靠
                // （布局落位走 apply，必须传最终高度，见其注释）
                imp::update(key as *mut c_void, &cards, dark, 0.0);
            });
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, cards, dark);
    }
}

/// 布局落位入口（bar.rs 的 show_floating_bar / resize_floating 调用）。
/// window_height = 本命令 set_size 即将设置的最终窗口高度：y 翻转用它换算，
/// **不读应用时刻的 contentView bounds**——真机实测 set_size 的实际生效晚于
/// 本函数的 run_on_main 闭包（两者虽同为主线程队列，路径不同），按旧高度换算
/// 会产出错位悬空的材质视图（「残影圆角矩形」根因）。用最终高度表达坐标后，
/// 闭包无论在 resize 前还是后执行，算出的都是最终窗口坐标系里的正确位置。
pub(crate) fn apply(
    window: &tauri::WebviewWindow,
    cards: &[MaterialCard],
    dark: bool,
    window_height: f64,
) {
    #[cfg(target_os = "macos")]
    {
        if let Ok(ns) = window.ns_window() {
            let key = ns as usize;
            let cards = cards.to_vec();
            let _ = window.app_handle().run_on_main_thread(move || {
                imp::update(key as *mut c_void, &cards, dark, window_height);
            });
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, cards, dark, window_height);
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use std::collections::HashMap;
    use std::os::raw::{c_char, c_void};
    use std::sync::{LazyLock, Mutex};

    use objc2::runtime::AnyObject;
    use objc2_foundation::{NSPoint, NSRect, NSSize};

    use super::MaterialCard;

    // 常量对照 SDK 头文件（AppKit.framework/Headers），勿凭记忆改：
    // NSVisualEffectView.h — NSVisualEffectMaterialMenu = 5、
    //   NSVisualEffectBlendingModeBehindWindow = 0、NSVisualEffectStateActive = 1；
    // NSWindow.h — NSWindowOrderingMode NSWindowBelow = -1。
    const MATERIAL_MENU: isize = 5;
    const BLENDING_BEHIND_WINDOW: isize = 0;
    const STATE_ACTIVE: isize = 1;
    const WINDOW_BELOW: isize = -1;

    /// 材质视图圆角：与 .bar/.pop 的 8px 同步（floating.css）
    const CORNER_RADIUS: f64 = 8.0;

    /// 材质视图池：窗口键（ns_window 指针值）→ 已挂视图列表。视图随卡片数量
    /// 只增不减（多余的 setHidden），避免弹层开合反复创建/销毁；窗口为预建
    /// 常驻，池上限 = 单窗最多同时出现的卡片数（胶囊 + 收纳面板 + 级联 ≈ 4）。
    /// 仅主线程读写（update 经 run_on_main_thread 派发），Mutex 只护跨线程的
    /// 静态访问合法性。
    struct ViewPool(Mutex<HashMap<usize, Vec<*mut AnyObject>>>);
    unsafe impl Send for ViewPool {}
    unsafe impl Sync for ViewPool {}

    static POOL: LazyLock<ViewPool> = LazyLock::new(|| ViewPool(Mutex::new(HashMap::new())));

    /// 按卡片矩形同步材质视图。cards 为空 = 无卡可铺（全部隐藏）。
    /// window_height = 最终窗口高度（y 翻转基准，见 apply 注释——不读实时 bounds）。
    pub(super) fn update(
        ns_window: *mut c_void,
        cards: &[MaterialCard],
        dark: bool,
        window_height: f64,
    ) {
        if ns_window.is_null() {
            return;
        }
        unsafe {
            let content: *mut AnyObject = objc2::msg_send![ns_window as *mut AnyObject, contentView];
            if content.is_null() {
                return;
            }
            // y 翻转基准：布局落位（apply）传最终窗口高度、与应用时刻无关；
            // 主题路径（window_height = 0）无 resize 在途，读实时 bounds 可靠
            let height = if window_height > 0.0 {
                window_height
            } else {
                let bounds: NSRect = objc2::msg_send![content, bounds];
                bounds.size.height
            };
            let mut pool = POOL.0.lock().unwrap();
            let views = pool.entry(ns_window as usize).or_default();
            let first_setup = views.is_empty();
            while views.len() < cards.len() {
                let v = create_view(dark);
                if v.is_null() {
                    break;
                }
                // 置于 subview 列表最底（webview 之下），材质只从窗口背后透出
                let _: () = objc2::msg_send![content,
                    addSubview: v, positioned: WINDOW_BELOW, relativeTo: std::ptr::null_mut::<AnyObject>()];
                views.push(v);
            }
            for (i, v) in views.iter().enumerate() {
                // 主题切换时已有视图也要刷新明暗（appearance 只在创建时设过的话，
                // 切主题后旧视图维持旧观感）
                apply_appearance(*v, dark);
                if i < cards.len() {
                    let c = &cards[i];
                    // NSView 默认 bottom-left 原点：按最终窗口高度做 top-left 翻转
                    let frame = NSRect::new(
                        NSPoint::new(c.x, height - c.y - c.h),
                        NSSize::new(c.w, c.h),
                    );
                    let _: () = objc2::msg_send![*v, setFrame: frame];
                    // 圆角裁切每次落位都补一次：layer 在视图入窗前可能尚未创建
                    apply_clip(*v);
                    let _: () = objc2::msg_send![*v, setHidden: false];
                } else {
                    let _: () = objc2::msg_send![*v, setHidden: true];
                }
            }
            // 首次挂载诊断（排查「亮色系统下胶囊呈暗材质」）：contentView 的真实
            // 子视图层级（材质视图是否真的在 webview 之下）+ 每个材质视图的
            // effectiveAppearance（系统实际渲染的明暗，可能与 setAppearance 不一致）
            if first_setup && !views.is_empty() {
                let subs: *mut AnyObject = objc2::msg_send![content, subviews];
                let n: usize = objc2::msg_send![subs, count];
                let mut layer = String::new();
                for i in 0..n.min(6) {
                    let sv: *mut AnyObject = objc2::msg_send![subs, objectAtIndex: i];
                    let cls: *mut AnyObject = objc2::msg_send![sv, class];
                    // Class 对象须先取 description（NSString）再读 UTF8String——
                    // 直接对 Class 发 UTF8String 会 unrecognized selector 抛
                    // ObjC 异常（不可跨 FFI 捕获，直接 abort）
                    let d: *mut AnyObject = objc2::msg_send![cls, description];
                    layer.push_str(&format!(" {}", ns_desc(d)));
                }
                let mut looks = String::new();
                for v in views.iter() {
                    let ea: *mut AnyObject = objc2::msg_send![*v, effectiveAppearance];
                    let name: *mut AnyObject = objc2::msg_send![ea, name];
                    looks.push_str(&format!(" {}", ns_desc(name)));
                }
                crate::capture::debug_log(format!(
                    "material: dark={dark} cards={cards_len} subviews({n}):{layer} appearance:{looks}",
                    cards_len = cards.len(),
                ));
            }
        }
    }

    /// ObjC description/name（NSString）→ Rust String，仅诊断用
    unsafe fn ns_desc(p: *mut AnyObject) -> String {
        if p.is_null() {
            return "nil".into();
        }
        let utf8: *const c_char = objc2::msg_send![p, UTF8String];
        if utf8.is_null() {
            return "?".into();
        }
        std::ffi::CStr::from_ptr(utf8).to_string_lossy().into_owned()
    }

    /// 材质/混合/明暗配置。appearance 强制跟随应用主题——系统外观与应用设置
    /// 可能不同步（跟随系统亮色 + 应用强制暗色），menu 材质随视图 appearance 走。
    /// 每次同步都对全部视图重设（主题切换时已有视图随之刷新）。
    unsafe fn apply_appearance(v: *mut AnyObject, dark: bool) {
        let _: () = objc2::msg_send![v, setMaterial: MATERIAL_MENU];
        let _: () = objc2::msg_send![v, setBlendingMode: BLENDING_BEHIND_WINDOW];
        // 浮层不抢焦点（非 key 窗口），FollowsWindowActiveState 会长期呈
        // inactive 灰态——恒取 active 观感
        let _: () = objc2::msg_send![v, setState: STATE_ACTIVE];
        let name: &[u8] = if dark {
            b"NSAppearanceNameVibrantDark\0"
        } else {
            b"NSAppearanceNameVibrantLight\0"
        };
        let ns_name: *mut AnyObject = objc2::msg_send![objc2::class!(NSString),
            stringWithUTF8String: name.as_ptr() as *const c_char];
        let appearance: *mut AnyObject = objc2::msg_send![objc2::class!(NSAppearance),
            appearanceNamed: ns_name];
        let _: () = objc2::msg_send![v, setAppearance: appearance];
        let _: () = objc2::msg_send![v, setWantsLayer: true];
    }

    unsafe fn create_view(dark: bool) -> *mut AnyObject {
        let v: *mut AnyObject = objc2::msg_send![objc2::class!(NSVisualEffectView), alloc];
        let v: *mut AnyObject = objc2::msg_send![v, init];
        if v.is_null() {
            return v;
        }
        apply_appearance(v, dark);
        v
    }

    /// layer 圆角 + masksToBounds：材质视图随卡片圆角成形。
    /// layer 在视图尚未入窗时可能为 nil，故由 update 落位时反复补设。
    unsafe fn apply_clip(v: *mut AnyObject) {
        let layer: *mut AnyObject = objc2::msg_send![v, layer];
        if layer.is_null() {
            return;
        }
        let _: () = objc2::msg_send![layer, setCornerRadius: CORNER_RADIUS];
        let _: () = objc2::msg_send![layer, setMasksToBounds: true];
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        /// FFI 链接 + 类/选择器存在性烟雾测试：不建窗口（无需 NSApplication /
        /// 主线程），只验证 NSVisualEffectView 可创建、关键属性可设可读。
        #[test]
        fn visual_effect_view_creates_and_configures() {
            unsafe {
                let v = create_view(true);
                assert!(!v.is_null());
                let material: isize = objc2::msg_send![v, material];
                assert_eq!(material, MATERIAL_MENU);
                let blending: isize = objc2::msg_send![v, blendingMode];
                assert_eq!(blending, BLENDING_BEHIND_WINDOW);
                let state: isize = objc2::msg_send![v, state];
                assert_eq!(state, STATE_ACTIVE);
                let wants_layer: bool = objc2::msg_send![v, wantsLayer];
                assert!(wants_layer);
            }
        }
    }
}
