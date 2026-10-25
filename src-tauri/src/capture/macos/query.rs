//! AX 查询链（docs/03 §A.3.3）：聚焦元素 → 范围回退 → 应用级 → Chromium 轻推 →
//! 坐标定位 → 有界子树扫描，各路径应答过角色/锚定/差分证据闸；Safari 分支。
//! 兼容模式（⌘C）见 compat.rs，本模块不含剪贴板路径。
use core_foundation::base::TCFType;
use core_foundation::boolean::CFBoolean;
use core_foundation::string::{CFString, CFStringRef};
use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_int, c_void};
use std::time::{Duration, Instant};

use tauri::AppHandle;

use super::super::debug_log;
use super::compat::{bid_in_editor_family, force_fetch_via_copy, show_editor_ax_guidance};
use super::ffi::*;

pub(super) const AX_ERROR_CANNOT_COMPLETE: c_int = -25204;
/// 应用 AX 未开启（VSCode accessibilitySupport=off 时即此值），见编辑器家族指引
pub(super) const AX_ERROR_API_DISABLED: c_int = -25211;

/// AX 错误码可读名（日志用）
pub(super) fn ax_error_name(rc: i32) -> &'static str {
    // 对照本机 SDK AXError.h 逐条核准（2026-10）——旧表整体错位，曾把 APIDisabled
    // 标成 NotImplemented，误导过 VSCode 取词失败的定位（-25211 实为应用 AX 未开启）
    match rc {
        0 => "Success",
        -25200 => "Failure",
        -25201 => "IllegalArgument",
        -25202 => "InvalidUIElement",
        -25203 => "InvalidUIElementObserver",
        -25204 => "CannotComplete",
        -25205 => "AttributeUnsupported",
        -25206 => "ActionUnsupported",
        -25207 => "NotificationUnsupported",
        -25208 => "NotImplemented",
        -25209 => "NotificationAlreadyRegistered",
        -25210 => "NotificationNotRegistered",
        -25211 => "APIDisabled(应用AX未开启)",
        -25212 => "NoValue",
        -25213 => "ParameterizedAttributeUnsupported",
        -25214 => "NotEnoughPrecision",
        _ => "Unknown",
    }
}

/// AX 查询选中文本（默认路径），失败时按开关走兼容模式。
/// `down`/`up` 是本次拖选手势的按下/松手点（屏幕坐标），供应答锚定；
/// `baseline` 是按下时刻的选区基线，供容器级应答的差分证据，见各闸注释
pub(super) unsafe fn ax_selected_text(
    app_handle: &AppHandle,
    down: (f64, f64),
    up: (f64, f64),
    baseline: &Option<(i32, String)>,
) -> Option<(String, i32)> {
    let consts = ax_consts();
    let sys = AXUIElementCreateSystemWide();
    if sys.is_null() {
        debug_log("AX: AXUIElementCreateSystemWide 返回 null");
        return None;
    }
    let mut out = None;

    let mut app: CFTypeRefC = std::ptr::null();
    let mut rc_app = AXUIElementCopyAttributeValue(sys, consts.focused_app, &mut app);
    if rc_app == AX_ERROR_CANNOT_COMPLETE && app.is_null() {
        // 树重建期的过渡态，短等一次再取（同聚焦元素查询）
        std::thread::sleep(Duration::from_millis(100));
        rc_app = AXUIElementCopyAttributeValue(sys, consts.focused_app, &mut app);
    }
    if app.is_null() {
        // AX 桥半死时 focused_app 间歇不可读（实测 -25211 且短等重试无效）：按前台
        // 应用 pid 直建应用元素，不经过 focused_app 这条链。VSCode 家族的兼容模式
        // 已被编辑器家族闸禁用，这里的轻推是它们唯一的取词通道——聚焦查询失败
        // 不能让整段主链跳过
        if let Some(fpid) = frontmost_pid() {
            app = AXUIElementCreateApplication(fpid);
            if !app.is_null() {
                debug_log("AX: 聚焦应用查询失败，退回前台应用 pid 直建");
            }
        }
    }
    if !app.is_null() {
        let app_el = app as AXUIElementRef;
        // 拿到句柄立刻校验归属：detect_loop 的闸门与真正查询之间隔着防抖 + 整条
        // 查询链（兼容模式可达 749ms），期间焦点可能切回自己（用户点了胶囊等），
        // 只对「即将下探的这个句柄」校验才没有竞态窗口
        if is_own_element(app_el) {
            debug_log("AX: 聚焦应用是自身进程，跳过取词");
            CFRelease(app as *mut c_void);
            CFRelease(sys as *mut c_void);
            return None;
        }
        // pid 读取失败（0）= 归属不明：聚焦可能在判定后切到了自己（非激活面板
        // 可成为 key window），此时下探会闯进自家 webview 的 AX → WebKit 主动
        // abort。宁可放弃本轮取词
        let mut pid: c_int = 0;
        let _ = AXUIElementGetPid(app_el, &mut pid);
        if pid == 0 {
            debug_log("AX: 聚焦应用 pid 读取失败，放弃本轮取词");
            CFRelease(app as *mut c_void);
            CFRelease(sys as *mut c_void);
            return None;
        }

        // 路径1（主）：聚焦元素级 SelectedText；失败则范围回退（AXSelectedTextRange + StringForRange）
        // —— 微信 4.x 等 Qt 自绘文本视图不暴露 SelectedText，但支持范围取值
        let mut text = query_focused_element(app_el, consts, down, pid, baseline);

        // 路径2：应用级 SelectedText（部分应用只在此暴露）。无元素可锚定、无角色
        // 可卡（应用元素自身不是文本节点），维持原状——它服务的"只暴露应用级选区"
        // 的应用不在本误报类（文档级遗留选区走的是聚焦元素/坐标定位/子树扫描）
        let mut rc_app_level: c_int = -1;
        if text.is_none() {
            let (rc, t) = query_app_level(app_el, consts);
            debug_log(format!("AX: 应用级 SelectedText rc={rc} → {}", t.is_some()));
            rc_app_level = rc;
            text = t;
        }

        // 编辑器家族 + AX 未开启（-25211 APIDisabled）：轻推 = 强制对方进 SR 模式，
        // 不轻推，一次性指引开启后走快通道；兼容模式本就被编辑器家族闸拦住，
        // 这里快速失败，不再空转 500ms 轮询。聚焦应用与应用级两处 rc 任一报
        // APIDisabled 即认定未开启（禁用态在不同调用上表现的错误码不一）
        if text.is_none() {
            let family = running_bundle_id(pid).map_or(false, |b| bid_in_editor_family(&b));
            if family {
                if rc_app == AX_ERROR_API_DISABLED || rc_app_level == AX_ERROR_API_DISABLED {
                    debug_log("AX: 编辑器家族 AX 未开启（APIDisabled），跳过轻推并指引");
                    show_editor_ax_guidance(app_handle);
                    return out;
                }
                debug_log(format!(
                    "AX: 编辑器家族未取到文本（聚焦 rc={rc_app} 应用级 rc={rc_app_level}），非 APIDisabled 不指引"
                ));
            }
        }

        // 路径3：Chromium/Electron 系（Chrome/Edge/VSCode 等）默认不构建 AX 树，
        // 置 AXEnhancedUserInterface / AXManualAccessibility 后才暴露接口。轻推 +
        // 有界轮询。曾经的固定 150ms 等待实测不够：webview 类内容（markdown 预览、
        // AI 侧栏）建树可达数百毫秒且树会被惰性收摊，等不到就表现为「有时取到
        // 有时取不到」——VSCode 家族兼容模式被禁，这条路径就是它们的主通道。
        // 轮询命中即提前续链；上限只在整个 AX 链路本来就要落空的场合支付
        if text.is_none() {
            debug_log("AX: 常规路径无文本，尝试轻推 Chromium/Electron 辅助支持");
            let t_push = Instant::now();
            set_bool_attr(app_el, consts.enhanced_ui);
            set_bool_attr(app_el, consts.manual_accessibility);
            const NUDGE_POLLS: usize = 5;
            const NUDGE_POLL_INTERVAL: Duration = Duration::from_millis(100);
            for i in 0..NUDGE_POLLS {
                std::thread::sleep(NUDGE_POLL_INTERVAL);
                // 轻推写入本身也会被拒（实测一次手势中应用级读写全线 IllegalArgument、
                // 稍后自愈；写入被拒则后续读取一直在撞墙）——每轮重写一次，写入
                // 一旦落地读取随之恢复
                if i > 0 {
                    set_bool_attr(app_el, consts.manual_accessibility);
                }
                text = query_focused_element(app_el, consts, down, pid, baseline);
                if text.is_some() {
                    break;
                }
            }
            if text.is_none() {
                let (rc, t) = query_app_level(app_el, consts);
                debug_log(format!("AX: 轻推后应用级 rc={rc} → {}", t.is_some()));
                text = t;
            }
            debug_log(format!(
                "⏱ Chromium 轻推段（轮询上限 {}ms）：{}ms",
                NUDGE_POLLS * 100,
                t_push.elapsed().as_millis()
            ));
        }

        if let Some(t) = text {
            out = Some((t, pid));
        }
    } else {
        debug_log(format!(
            "AX: 获取聚焦应用失败 rc={rc_app}（{}）——转坐标定位",
            ax_error_name(rc_app)
        ));
    }

    // 路径⑥：坐标定位 + 父链上溯（绕开聚焦链路，鼠标位置即选区位置）
    if out.is_none() {
        if let Some(t) = query_at_position(sys, consts, up) {
            let pid = focused_pid().unwrap_or(0);
            out = Some((t, pid));
        }
    }

    // 路径⑦：兼容模式（常开兜底）——模拟 ⌘C 读剪贴板，微信/Office 等自绘文本应用的行业通行解
    if out.is_none() {
        debug_log("AX 未取到 → 兼容模式：模拟 ⌘C 取词");
        if let Some((text, pid)) = force_fetch_via_copy(app_handle) {
            out = Some((text, pid));
        }
    }

    // 路径⑤（最后兜底）：有界子树扫描——仅当以上全部失败，避免拖慢主路径
    if out.is_none() && !app.is_null() {
        if let Some(t) = scan_focused_subtrees(app as AXUIElementRef, consts, up) {
            let pid = focused_pid().unwrap_or(0);
            out = Some((t, pid));
        }
    }

    if !app.is_null() {
        CFRelease(app as *mut c_void);
    }
    CFRelease(sys as *mut c_void);
    out
}

/// 最后兜底：聚焦元素子树 → 聚焦窗口子树（有界 DFS）。
/// 微信 4.x 的 Qt 桥常把 AXFocusedUIElement 停在输入框（rc=0 但选区为空），
/// 真正的选区在兄弟/子孙节点上，需下探扫描。
/// 扫描按"谁应答谁算数"收集，误收面最大（整个窗口子树），故应答证据闸
/// （角色白名单 + 松手点锚定）在这里最关键——遗留选区的编辑器节点虽是
/// AXTextArea（角色放行），但鼠标松手点不在其框架内，锚定闸拒绝
pub(super) unsafe fn scan_focused_subtrees(
    app_el: AXUIElementRef,
    consts: &AxConsts,
    up: (f64, f64),
) -> Option<String> {
    const SCAN_BUDGET: usize = 64;
    const SCAN_DEPTH: usize = 6;

    let mut focused: CFTypeRefC = std::ptr::null();
    let rc = AXUIElementCopyAttributeValue(app_el, consts.focused_element, &mut focused);
    if rc == 0 && !focused.is_null() {
        debug_log("AX: 扫描聚焦元素子树…");
        let mut budget = SCAN_BUDGET;
        let hit = scan_subtree_for_text(
            focused as AXUIElementRef,
            consts,
            SCAN_DEPTH,
            &mut budget,
            up,
        );
        CFRelease(focused as *mut c_void);
        if hit.is_some() {
            return hit;
        }
    }

    let mut win: CFTypeRefC = std::ptr::null();
    let rc_win = AXUIElementCopyAttributeValue(app_el, consts.focused_window, &mut win);
    if rc_win == 0 && !win.is_null() {
        debug_log("AX: 扫描聚焦窗口子树…");
        let mut budget = SCAN_BUDGET;
        let hit = scan_subtree_for_text(win as AXUIElementRef, consts, SCAN_DEPTH, &mut budget, up);
        CFRelease(win as *mut c_void);
        if hit.is_some() {
            return hit;
        }
    }
    None
}

/// 聚焦应用 pid（兼容模式取词后归属过滤用；查不到为 0，worker 侧黑名单跳过）
pub(super) fn focused_pid() -> Option<i32> {
    unsafe {
        let sys = AXUIElementCreateSystemWide();
        if sys.is_null() {
            return None;
        }
        let mut app: CFTypeRefC = std::ptr::null();
        let rc = AXUIElementCopyAttributeValue(sys, ax_consts().focused_app, &mut app);
        let mut pid: c_int = 0;
        if rc == 0 && !app.is_null() {
            let _ = AXUIElementGetPid(app as AXUIElementRef, &mut pid);
            CFRelease(app as *mut c_void);
        }
        CFRelease(sys as *mut c_void);
        (pid != 0).then_some(pid)
    }
}

/// 聚焦元素的角色（AXRole）。查询失败 = None（AX 服务异常/无聚焦元素）。
pub(super) unsafe fn focused_element_role() -> Option<String> {
    let sys = AXUIElementCreateSystemWide();
    if sys.is_null() {
        return None;
    }
    let mut el: CFTypeRefC = std::ptr::null();
    let rc = AXUIElementCopyAttributeValue(sys, ax_consts().focused_element, &mut el);
    let mut role = None;
    if rc == 0 && !el.is_null() {
        // 闸门判定与本次查询之间焦点可能切回自身（是 Finder 的分支判定在前），
        // 下探进自家 WKWebView 的辅助功能树会触发 WebKit 主线程断言，先验归属
        if is_own_element(el as AXUIElementRef) {
            CFRelease(el as *mut c_void);
            CFRelease(sys as *mut c_void);
            return None;
        }
        let mut val: CFTypeRefC = std::ptr::null();
        let rc_role =
            AXUIElementCopyAttributeValue(el as AXUIElementRef, ax_consts().role, &mut val);
        if rc_role == 0 {
            role = cf_type_to_string(val);
        }
        CFRelease(el as *mut c_void);
    }
    CFRelease(sys as *mut c_void);
    role
}

/// 聚焦元素是否为真文本编辑框（重命名/输入框/前往文件夹等）。
/// 角色查询失败按非文本处理——Finder 场景宁可漏一次取词也不误弹胶囊。
pub(super) fn focused_element_is_text_editor() -> bool {
    match unsafe { focused_element_role() } {
        Some(role) => matches!(
            role.as_str(),
            "AXTextField" | "AXTextArea" | "AXTextView" | "AXComboBox"
        ),
        None => false,
    }
}

/// Finder 闸门：聚焦应用是 Finder 且聚焦元素不是文本框 → 本次"拖选/双击"
/// 实为文件交互（拖动移动 / 双击打开），跳过取词。
///
/// 为什么要这道闸：拖动文件夹位移必 >6px，状态机判为拖选，而 Finder 图标视图的
/// 文件项是 AXGroup>AXImage（文件名标签不暴露为文本节点），AX 查询链全部落空 →
/// 落入兼容模式模拟 ⌘C —— 实测 Finder 对 ⌘C 的响应是把**选中项的文件名**作为
/// 纯文本写入剪贴板，文件名随即被当成划词，胶囊误弹、用户剪贴板被短暂改写。
/// 仅重命名等真文本框（focused_element_is_text_editor）放行取词。
pub(super) fn in_finder_file_context() -> bool {
    let finder = focused_pid()
        .and_then(running_bundle_id)
        .map_or(false, |bid| bid.eq_ignore_ascii_case("com.apple.finder"));
    finder && !focused_element_is_text_editor()
}

/// 非文本表面闸门：拖拽**起点**的命中元素（含 ≤3 层祖先）属于"文本选区不可能
/// 开始的表面"——交互控件与可选中元素（AXSelected 元素状态语义，非文本选区）——
/// 是滚动/调参/换位/拖放手势，整链跳过。
///
/// 划界原则是"表面能否产生文本选区"，不是逐个手势/逐个应用打点：文本拖选只会
/// 从文本承载表面（文本框/文本域/静态文本）开始；从按钮、标签页（AXRadioButton）、
/// 列表树行、图标、菜单上开始的拖拽永远不会是选词。这条一般化闸门收编了整个
/// 误报家族——拖标签弹胶囊、拖工具栏/书签、拖文件树/消息列表行、Finder 图标
/// （原先靠 in_finder_file_context 按应用打点）——它们是同一本质的不同切面。
///
/// 有意不放行的成员之外一律放行：未知角色、AXGroup/AXWindow/AXScrollArea 等
/// 泛容器（真实文本藏在里面）、AXUnknown（信息不足）。Electron 未建 AX 树时
/// 命中元素退化为泛容器，不能因此误杀真选词；此时由查询侧应答证据闸兜底。
///
/// 实证案例：VSCode 水平滚动条拖动被状态机判为拖选，Monaco 滚动条是
/// role="presentation" 的自绘 div（不暴露为 AXScrollBar），原生角色闸拦不住，
/// 由编辑器家族闸门（skip_compat_for_focused_app）兜住 ⌘C 误捕——本表是
/// AX 暴露为真实角色时的第一道闸。
pub(super) fn drag_starts_on_control(x: f64, y: f64) -> bool {
    const CONTROL_ROLES: [&str; 29] = [
        "AXScrollBar",
        "AXSlider",
        "AXValueIndicator",
        "AXSplitter",
        "AXButton",
        "AXCheckBox",
        "AXRadioButton",
        "AXToggleButton",
        "AXPopUpButton",
        "AXMenuButton",
        "AXToolbar",
        "AXTabGroup",
        "AXImage",
        "AXLink",
        "AXRow",
        "AXTreeItem",
        "AXListItem",
        "AXOutline",
        "AXTable",
        "AXList",
        "AXMenu",
        "AXMenuItem",
        "AXMenuBar",
        "AXMenuBarItem",
        "AXProgressIndicator",
        "AXIncrementor",
        "AXDisclosureTriangle",
        "AXHandle",
        "AXColorWell",
    ];
    unsafe {
        let sys = AXUIElementCreateSystemWide();
        if sys.is_null() {
            return false;
        }
        let mut el: CFTypeRefC = std::ptr::null();
        let rc = AXUIElementCopyElementAtPosition(sys, x as f32, y as f32, &mut el);
        let mut hit = false;
        if rc == 0 && !el.is_null() {
            if is_own_element(el as AXUIElementRef) {
                CFRelease(el as *mut c_void);
            } else {
                let mut cur = el as AXUIElementRef;
                for depth in 0..=3 {
                    let mut rv: CFTypeRefC = std::ptr::null();
                    let rc_role = AXUIElementCopyAttributeValue(cur, ax_consts().role, &mut rv);
                    let role = if rc_role == 0 { cf_type_to_string(rv) } else { None };
                    debug_log(format!(
                        "AX: 拖拽起点命中角色（上溯 {depth}）：{}",
                        role.as_deref().unwrap_or("?")
                    ));
                    if role.map_or(false, |r| CONTROL_ROLES.contains(&r.as_str())) {
                        hit = true;
                        break;
                    }
                    if depth == 3 {
                        break;
                    }
                    let mut parent: CFTypeRefC = std::ptr::null();
                    let rc_p = AXUIElementCopyAttributeValue(cur, ax_consts().parent, &mut parent);
                    if rc_p != 0 || parent.is_null() {
                        break;
                    }
                    if is_own_element(parent as AXUIElementRef) {
                        CFRelease(parent as *mut c_void);
                        break;
                    }
                    CFRelease(cur);
                    cur = parent as AXUIElementRef;
                }
                CFRelease(cur);
            }
        } else if rc != 0 {
            debug_log(format!(
                "AX: 拖拽起点定位不可用 rc={rc}（{}）",
                ax_error_name(rc)
            ));
        }
        CFRelease(sys as *mut c_void);
        hit
    }
}

/// 控件表面手势的差分放行（A.3.2 非文本表面闸的例外）：拖拽起点命中控件/
/// 可选中元素，但松手后屏幕上真的出现了按下时不存在的文本选区——差分
/// 应答证据成立，这是"起点落在可选中元素上、却拉出了真选区"的文本拖选
/// （实证：网页表格的 AXCell→AXRow 内拖选/双击，被行项族角色表连坐）。
/// 复用按下基线 down_baseline（容器差分同款语义）：应答 ≠ 基线 ⇒ 采信；
/// 相同 ⇒ 遗留选区背书 ⇒ 拒绝；基线缺失（静音期/查询失败/聚焦在自身）
/// 或复核查询失败 = 拒绝——证据不足永远倾向拦截（误报代价大于漏报）。
/// 放行后落入正常防抖+查询链路，AX 查询的应答证据闸会再复核一次
pub(super) fn control_drag_gained_selection(baseline: &Option<(i32, String)>) -> bool {
    let Some((_, base)) = baseline else {
        return false;
    };
    match selection_baseline() {
        Some((_, now)) if !now.is_empty() && now != *base => {
            debug_log("控件表面手势内出现新选区（差分应答成立），放行取词");
            true
        }
        _ => false,
    }
}

/// 元素是否属于本进程：下探进本进程 WKWebView 的辅助功能树会在后台线程触发
/// WebKit 主线程断言（EXC_BREAKPOINT 必崩）；跨进程元素走 XPC 由对端 servicing，
/// 对端崩是自己崩，伤不到我们。凡对拿到的 AX 句柄做下探，先过这道闸
pub(super) fn is_own_element(el: AXUIElementRef) -> bool {
    unsafe {
        let mut pid: c_int = 0;
        AXUIElementGetPid(el, &mut pid);
        pid == std::process::id() as i32
    }
}

/// 坐标定位回退：AXUIElementCopyElementAtPosition（top-left 原点，与 CGEvent 同系）
/// 取光标下元素，沿 AXParent 向上找带选区文本的节点。绕开聚焦链路。
/// 应答证据闸：只有文本承载节点可应答（见 is_text_answer_role）——泛容器
/// （AXWebArea 等）只作上溯通路不作应答者，其文档级"选区"是应用遗留状态，
/// 实测静止时也非空；上溯到泛容器才命中 = 鼠标点下方没有任何文本持有选区，
/// 即本次手势没有产生选区
pub(super) unsafe fn query_at_position(
    sys: AXUIElementRef,
    consts: &AxConsts,
    up: (f64, f64),
) -> Option<String> {
    let mut el: CFTypeRefC = std::ptr::null();
    let mut rc = AXUIElementCopyElementAtPosition(sys, up.0 as f32, up.1 as f32, &mut el);
    if rc == AX_ERROR_CANNOT_COMPLETE && el.is_null() {
        // 树重建期过渡态，短等一次再取（同聚焦元素查询）
        std::thread::sleep(Duration::from_millis(100));
        rc = AXUIElementCopyElementAtPosition(sys, up.0 as f32, up.1 as f32, &mut el);
    }
    if rc != 0 || el.is_null() {
        debug_log(format!(
            "AX: 坐标定位不可用 rc={rc}（{}）",
            ax_error_name(rc)
        ));
        return None;
    }
    let mut cur = el as AXUIElementRef;
    // 光标下的元素可能是自己的浮层（结果窗/钉图恰好在光标处而聚焦应用是别的应用），
    // 同属禁行区；父链沿元素自身向上，归属不变，查一次即可
    if is_own_element(cur) {
        CFRelease(cur as *mut c_void);
        return None;
    }
    let mut text = None;
    for depth in 0..=5 {
        if role_of(cur).map_or(false, |r| is_text_answer_role(&r)) {
            text = copy_selected_text(cur, consts, true)
                .or_else(|| query_text_via_range(cur, consts, true));
            if text.is_some() {
                debug_log(format!("AX: 坐标定位命中（向上 {depth} 层）"));
                break;
            }
        }
        let mut parent: CFTypeRefC = std::ptr::null();
        let rc_p = AXUIElementCopyAttributeValue(cur, consts.parent, &mut parent);
        if rc_p != 0 || parent.is_null() {
            break;
        }
        CFRelease(cur as *mut c_void);
        cur = parent as AXUIElementRef;
    }
    CFRelease(cur as *mut c_void);
    text
}

// ---------- Safari：AppleScript 取词（Safari 不暴露 AX SelectedText；剪贴板-free，参考 Easydict GUIDE） ----------

pub(super) fn focused_is_safari() -> bool {
    focused_pid()
        .and_then(proc_path)
        .map(|p| p.to_lowercase().contains("safari"))
        .unwrap_or(false)
}

/// Safari 取词：do JavaScript 读 window.getSelection()，并暂存选区 Range。
/// 需 Safari 开发菜单开启「允许来自 Apple 事件的 JavaScript」；未开启/超时/空选区 = None。
/// 副作用处理：浮动条出现/失焦可能清掉页面选区，读取时把 Range 存到 window.__magpieSel，
/// 350ms 后检测到选区被清空则重新套用（还原高亮）。
pub(super) fn safari_selected_text() -> Option<String> {
    use std::io::Read;
    use std::process::{Command, Stdio};

    // 读取 + 暂存 Range（选区收起/无选区时返回空串）
    let script = r#"tell application "Safari" to do JavaScript "(function(){var s=getSelection();if(!s.rangeCount||s.isCollapsed)return '';window.__magpieSel=s.getRangeAt(0).cloneRange();return s.toString()})()" in current tab of front window"#;
    // 还原：仅当选区被清空/收起时重新套用，避免重复叠加
    let restore = r#"tell application "Safari" to do JavaScript "(function(){var r=window.__magpieSel;if(!r)return;var s=getSelection();if(s.rangeCount===0||s.isCollapsed){s.removeAllRanges();s.addRange(r);}delete window.__magpieSel})()" in current tab of front window"#;

    let mut child = Command::new("osascript")
        .arg("-e")
        .arg(script)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;

    // 有界等待：Safari 响应通常 <100ms，超时视为失败
    let deadline = Instant::now() + Duration::from_millis(800);
    let mut done = false;
    while Instant::now() < deadline {
        match child.try_wait() {
            Ok(Some(_)) => {
                done = true;
                break;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(_) => return None,
        }
    }
    if !done {
        let _ = child.kill();
        let _ = child.wait();
        debug_log("Safari AppleScript 超时");
        return None;
    }

    let mut stdout = String::new();
    if let Some(mut pipe) = child.stdout.take() {
        let _ = pipe.read_to_string(&mut stdout);
    }
    let text = stdout.trim().to_string();
    if text.is_empty() {
        debug_log("Safari AppleScript：未取到文本（检查 开发菜单 → 允许来自 Apple 事件的 JavaScript）");
        return None;
    }
    debug_log(format!("Safari AppleScript 取词成功 len={}", text.len()));

    // 延时还原选区高亮：等浮动条出现、可能的清选区动作发生后执行
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(350));
        let _ = Command::new("osascript")
            .arg("-e")
            .arg(restore)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    });

    Some(text)
}

/// 聚焦元素级取文本：SelectedText → 范围回退（轻量路径；子树扫描见 scan_focused_subtrees）。
/// 应答证据闸按角色分两路：
/// · 文本承载节点（AXTextArea 等）：**按下点锚定**——真拖选必然从选中文本内部
///   开始（长选自动滚出的边界只影响松手端），拖标签后聚焦切到残留旧选区的编辑
///   器时，角色闸放行它（确实是 AXTextArea），锚定闸拒绝它（手势起点在标签栏，
///   永远不在编辑器内容区）；
/// · 容器节点（AXGroup/AXWebArea 等）：VSCode AI 侧栏等 webview 的选区主要在
///   容器级聚合暴露，一刀切除名会让这类划词时有时无，放行又让遗留选区复活
///   （容器框架包含一切手势点，几何锚定对它失效）——改用**差分证据**：按下时
///   读基线（selection_baseline），容器应答 ≠ 基线 ⇒ 选区在本次手势期间发生过
///   变化（新手势所建）⇒ 采信；相同 ⇒ 遗留选区原样背书 ⇒ 拒绝。
///   基线缺失（读失败/按下时聚焦在自身/静音期按下）= 拒绝。
unsafe fn query_focused_element(
    app_el: AXUIElementRef,
    consts: &AxConsts,
    down: (f64, f64),
    pid: c_int,
    baseline: &Option<(i32, String)>,
) -> Option<String> {
    let mut focused: CFTypeRefC = std::ptr::null();
    let mut rc_focus = AXUIElementCopyAttributeValue(app_el, consts.focused_element, &mut focused);
    if rc_focus == AX_ERROR_CANNOT_COMPLETE && focused.is_null() {
        // 树重建期（Chromium 轻推/收摊的过渡态）短等一次再取——webview 类应用的
        // AX 树状态抖动是「有时取不到」的主要间歇源
        std::thread::sleep(Duration::from_millis(100));
        rc_focus = AXUIElementCopyAttributeValue(app_el, consts.focused_element, &mut focused);
    }
    if rc_focus != 0 || focused.is_null() {
        debug_log(format!("AX: 聚焦元素不可达 rc_focus={rc_focus}"));
        return None;
    }
    let el = focused as AXUIElementRef;
    let role = role_of(el);
    let mut text = None;
    if role.as_deref().map_or(false, is_text_answer_role) {
        text = copy_selected_text(el, consts, false);
        if text.is_none() {
            text = query_text_via_range(el, consts, false);
        }
        if text.is_some() && !anchored_to_gesture(el, down.0, down.1) {
            debug_log("AX: 聚焦元素应答未锚定按下点（遗留选区），拒绝");
            text = None;
        }
    } else if role.is_some() {
        // 角色可读但非文本承载 = 容器。角色查询本身失败（None）不进此分支：
        // 未知角色的应答无从校验，一律不要
        text = copy_selected_text(el, consts, false);
        if text.is_none() {
            text = query_text_via_range(el, consts, false);
        }
        if let Some(t) = &text {
            let gesture_made = baseline
                .as_ref()
                .map_or(false, |(bpid, btext)| *bpid == pid && btext != t);
            if gesture_made {
                debug_log("AX: 容器应答经差分采信（选区在本次手势中已变化）");
            } else {
                debug_log("AX: 容器应答与按下基线一致（选区非本次手势所建），拒绝");
                text = None;
            }
        }
    }
    CFRelease(focused as *mut c_void);
    text
}

/// 有界 DFS：在子树每个节点上尝试 SelectedText / 范围回退（静默，避免日志刷屏）。
/// budget 跨递归共享，防止大 UI 树拖垮查询耗时。
pub(super) unsafe fn scan_subtree_for_text(
    el: AXUIElementRef,
    consts: &AxConsts,
    depth: usize,
    budget: &mut usize,
    up: (f64, f64),
) -> Option<String> {
    // 铁闸：绝不查询本进程自己的元素——自家 webview 的 AX 仅限主线程访问，
    // 后台线程一碰即被 WebKit 主动 abort（崩溃报告实锤：拖动结果窗缩放把手时
    // 聚焦切回自己，扫描下探进自家 webview → EXC_BREAKPOINT）。
    // AXUIElementGetPid 偶发失败返回 0 时 is_own_element 会误判放行，
    // 故对每个下探元素独立复核
    if is_own_element(el) {
        return None;
    }
    if *budget == 0 {
        return None;
    }
    *budget -= 1;

    // 应答证据闸：角色白名单 + 松手点锚定（详见 is_text_answer_role 注释）。
    // 角色不过的节点仍照常递归——选区文本多藏在泛容器的子孙里（微信 Qt 桥场景）
    if role_of(el).map_or(false, |r| is_text_answer_role(&r)) {
        let mut text = copy_selected_text(el, consts, true);
        if text.is_none() {
            text = query_text_via_range(el, consts, true);
        }
        if text.is_some() {
            if anchored_to_gesture(el, up.0, up.1) {
                debug_log(format!("AX: 子树扫描命中（剩余预算 {budget}）"));
                return text;
            }
            debug_log("AX: 子树扫描应答未锚定松手点（遗留选区），继续扫描");
        }
    }
    if depth == 0 {
        return None;
    }

    let mut kids: CFTypeRefC = std::ptr::null();
    let rc = AXUIElementCopyAttributeValue(el, consts.children, &mut kids);
    if rc != 0 || kids.is_null() {
        return None;
    }
    let n = CFArrayGetCount(kids);
    for i in 0..n {
        let child = CFArrayGetValueAtIndex(kids, i);
        if child.is_null() {
            continue;
        }
        // 数组持有引用，元素无需释放；找到即提前返回（kids 由 CFRelease 释放）
        if let Some(t) =
            scan_subtree_for_text(child as AXUIElementRef, consts, depth - 1, budget, up)
        {
            CFRelease(kids as *mut c_void);
            return Some(t);
        }
        if *budget == 0 {
            break;
        }
    }
    CFRelease(kids as *mut c_void);
    None
}

/// 直接取 AXSelectedText；rc=0 时区分 空值/非字符串/空串 三种情况（verbose=false 时静默）
pub(super) unsafe fn copy_selected_text(el: AXUIElementRef, consts: &AxConsts, quiet: bool) -> Option<String> {
    let mut val: CFTypeRefC = std::ptr::null();
    let rc_sel = AXUIElementCopyAttributeValue(el, consts.selected_text, &mut val);
    if rc_sel != 0 {
        if !quiet {
            debug_log(format!("AX: SelectedText rc_sel={rc_sel}"));
        }
        return None;
    }
    match describe_value(val) {
        Ok(t) => Some(t),
        Err(why) => {
            if !quiet {
                debug_log(format!("AX: SelectedText rc_sel=0 但{why}"));
            }
            None
        }
    }
}

/// 与 C CFRange 二进制布局一致（CFIndex = long = isize）
#[repr(C)]
struct CfRange {
    location: isize,
    length: isize,
}

/// AXValue 包装类型常量（AXValue.h：CGPoint=1 CGSize=2 CGRect=3 CFRange=4）。
/// 类型错一个位，AXValueGetValue 就因类型不匹配静默失败——曾把 CFRange 写成 3
/// 导致「范围回退」路径从未生效，此处值必须与 SDK 头文件一致
pub(super) const K_AX_VALUE_CG_POINT: usize = 1;
pub(super) const K_AX_VALUE_CG_SIZE: usize = 2;
pub(super) const K_AX_VALUE_CF_RANGE: usize = 4;

/// 元素角色；查询失败 = None
pub(super) unsafe fn role_of(el: AXUIElementRef) -> Option<String> {
    let mut val: CFTypeRefC = std::ptr::null();
    let rc = AXUIElementCopyAttributeValue(el, ax_consts().role, &mut val);
    if rc == 0 {
        cf_type_to_string(val)
    } else {
        None
    }
}

/// 应答角色白名单：文本承载路径的资格线（容器级应答不走这里，走差分通道，
/// 见 query_focused_element 容器分支）。
///
/// 为什么文本路径必须卡角色：AXSelectedText 是**应用状态查询**（"现在选中了
/// 什么"），不是**手势结果查询**（"这次操作选中了什么"）——编辑器里的遗留选区
/// （双击选词后长期残留，Monaco 还按编辑器各自保存、切回即恢复）会让任何应答者
/// 背书一次从未发生的选区。实测 VSCode 静止时 AXWebArea/AXGroup 即以数分钟前的
/// 选区作答（len=16 非空）；真选区由文本叶节点应答（Chromium 给选区命中的
/// static text 逐节点下发偏移），文本叶节点独占应答失效的应用下沉到兼容模式
/// ⌘C 兜底，捕获能力不受损
pub(super) fn is_text_answer_role(role: &str) -> bool {
    matches!(
        role,
        "AXTextArea" | "AXTextField" | "AXTextView" | "AXComboBox" | "AXStaticText"
    )
}

#[repr(C)]
struct CgSize {
    w: f64,
    h: f64,
}

/// 元素屏幕框架 (x, y, w, h)。AXPosition/AXSize 与 CGEvent 同为 top-left 原点
/// 屏幕坐标，免转换；任一属性读取失败 = None
pub(super) unsafe fn element_frame(el: AXUIElementRef) -> Option<(f64, f64, f64, f64)> {
    let consts = ax_consts();
    let mut pos_val: CFTypeRefC = std::ptr::null();
    let rc_p = AXUIElementCopyAttributeValue(el, consts.position, &mut pos_val);
    if rc_p != 0 || pos_val.is_null() {
        return None;
    }
    let mut pos = CGPoint { x: 0.0, y: 0.0 };
    let ok_p = AXValueGetValue(pos_val, K_AX_VALUE_CG_POINT, &mut pos as *mut _ as *mut c_void);
    CFRelease(pos_val as *mut c_void);
    if ok_p == 0 {
        return None;
    }
    let mut size_val: CFTypeRefC = std::ptr::null();
    let rc_s = AXUIElementCopyAttributeValue(el, consts.size, &mut size_val);
    if rc_s != 0 || size_val.is_null() {
        return None;
    }
    let mut size = CgSize { w: 0.0, h: 0.0 };
    let ok_s = AXValueGetValue(size_val, K_AX_VALUE_CG_SIZE, &mut size as *mut _ as *mut c_void);
    CFRelease(size_val as *mut c_void);
    if ok_s == 0 {
        return None;
    }
    Some((pos.x, pos.y, size.w, size.h))
}

/// 锚定容差：吸收行距间隙、边框内衬等贴边误差——远小于"标签栏到编辑器内容区"
/// 这类跨表面距离，不构成误放行通道
pub(super) const ANCHOR_SLACK: f64 = 8.0;

pub(super) fn point_in_frame(frame: (f64, f64, f64, f64), x: f64, y: f64) -> bool {
    let (fx, fy, fw, fh) = frame;
    x >= fx - ANCHOR_SLACK && x <= fx + fw + ANCHOR_SLACK && y >= fy - ANCHOR_SLACK && y <= fy + fh + ANCHOR_SLACK
}

/// 应答锚定：应答元素框架须含给定的手势点。真拖选的手势点落在选区所在的文本
/// 元素内；控件拖拽（拖标签、拖工具栏）的手势点在文本元素外——聚焦编辑器里
/// 残留的旧选区即便应答（角色闸放行它：确实是 AXTextArea）也因锚定不成立被拒。
/// 框架读不到（个别桥实现不暴露几何）= 放行：不因辅助信息缺失拒绝主路径
pub(super) unsafe fn anchored_to_gesture(el: AXUIElementRef, x: f64, y: f64) -> bool {
    match element_frame(el) {
        Some(f) => point_in_frame(f, x, y),
        None => true,
    }
}

/// 聚焦元素的 AXSelectedText（容器级聚合应答用的轻量读取；失败 = None）
pub(super) unsafe fn focused_element_selected_text() -> Option<String> {
    let sys = AXUIElementCreateSystemWide();
    if sys.is_null() {
        return None;
    }
    let mut el: CFTypeRefC = std::ptr::null();
    let rc = AXUIElementCopyAttributeValue(sys, ax_consts().focused_element, &mut el);
    let mut out = None;
    if rc == 0 && !el.is_null() && !is_own_element(el as AXUIElementRef) {
        let mut val: CFTypeRefC = std::ptr::null();
        let rc_s = AXUIElementCopyAttributeValue(
            el as AXUIElementRef,
            ax_consts().selected_text,
            &mut val,
        );
        if rc_s == 0 {
            out = cf_type_to_string(val);
        }
    }
    if !el.is_null() {
        CFRelease(el as *mut c_void);
    }
    CFRelease(sys as *mut c_void);
    out
}

/// 按下时刻的选区基线 (聚焦应用 pid, 聚焦元素 SelectedText)——容器级应答的差分
/// 证据基准，见 query_focused_element 容器分支。读失败 / 聚焦是自身进程 = None
/// （差分闸对无基线的容器应答一律拒绝：宁可漏一次，不给无证据的应答放行）；
/// 空选区是合法基线 Some((pid, ""))
pub(super) fn selection_baseline() -> Option<(i32, String)> {
    unsafe {
        let sys = AXUIElementCreateSystemWide();
        if sys.is_null() {
            return None;
        }
        let mut app: CFTypeRefC = std::ptr::null();
        let rc = AXUIElementCopyAttributeValue(sys, ax_consts().focused_app, &mut app);
        let mut pid: c_int = 0;
        if rc == 0 && !app.is_null() {
            let _ = AXUIElementGetPid(app as AXUIElementRef, &mut pid);
            CFRelease(app as *mut c_void);
        }
        CFRelease(sys as *mut c_void);
        if pid == 0 || pid == std::process::id() as i32 {
            return None;
        }
        Some((pid, focused_element_selected_text().unwrap_or_default()))
    }
}

/// 范围回退：AXSelectedTextRange → AXStringForRange（参数化查询）。
/// 部分自绘文本视图（如微信 4.x 的 Qt 控件）不暴露 SelectedText 但支持范围取值。
pub(super) unsafe fn query_text_via_range(
    el: AXUIElementRef,
    consts: &AxConsts,
    quiet: bool,
) -> Option<String> {
    let mut range_val: CFTypeRefC = std::ptr::null();
    let rc_range = AXUIElementCopyAttributeValue(el, consts.selected_text_range, &mut range_val);
    if rc_range != 0 || range_val.is_null() {
        if !quiet {
            debug_log(format!("AX: 范围回退不可用 rc_range={rc_range}"));
        }
        return None;
    }
    let mut range = CfRange { location: 0, length: 0 };
    let ok = AXValueGetValue(range_val, K_AX_VALUE_CF_RANGE, &mut range as *mut _ as *mut c_void);
    CFRelease(range_val as *mut c_void);
    if ok == 0 || range.length <= 0 {
        if !quiet {
            debug_log(format!(
                "AX: 范围取值失败 ok={ok} len={}（选区为空或值类型非 Range）",
                range.length
            ));
        }
        return None;
    }

    let param = AXValueCreate(K_AX_VALUE_CF_RANGE, &range as *const _ as *const c_void);
    if param.is_null() {
        return None;
    }
    let mut out: CFTypeRefC = std::ptr::null();
    let rc_str = AXUIElementCopyParameterizedAttributeValue(
        el,
        consts.string_for_range,
        param,
        &mut out,
    );
    CFRelease(param);
    let text = if rc_str == 0 {
        cf_type_to_string(out)
    } else {
        None
    };
    if text.is_none() && !quiet {
        debug_log(format!("AX: StringForRange rc_str={rc_str}"));
    }
    text
}

/// 应用级 SelectedText，返回 (错误码, 文本)
pub(super) unsafe fn query_app_level(app_el: AXUIElementRef, consts: &AxConsts) -> (c_int, Option<String>) {
    let mut val: CFTypeRefC = std::ptr::null();
    let rc = AXUIElementCopyAttributeValue(app_el, consts.selected_text, &mut val);
    let text = if rc == 0 {
        cf_type_to_string(val)
    } else {
        None
    };
    (rc, text)
}

/// 布尔属性设置（不支持该属性的应用返回错误码，无害忽略）
pub(super) unsafe fn set_bool_attr(el: AXUIElementRef, attr: CFStringRef) {
    let v = CFBoolean::true_value();
    let rc = AXUIElementSetAttributeValue(el, attr, v.as_concrete_TypeRef() as CFTypeRefC);
    if rc != 0 {
        debug_log(format!("AX: SetAttributeValue rc={rc}（不支持则忽略）"));
    }
}

/// CFTypeRef → String（接管 +1 所有权并负责释放）；空串/非字符串 → None
pub(super) unsafe fn cf_type_to_string(v: CFTypeRefC) -> Option<String> {
    if v.is_null() {
        return None;
    }
    if CFGetTypeID(v) != CFString::type_id() {
        CFRelease(v as *mut c_void);
        return None;
    }
    let s = CFString::wrap_under_create_rule(v as CFStringRef);
    let out = s.to_string();
    if out.trim().is_empty() {
        None
    } else {
        Some(out)
    }
}

/// rc=0 但仍可能无文本：区分 空值 / 非字符串 / 空串（接管值的所有权）
pub(super) unsafe fn describe_value(v: CFTypeRefC) -> Result<String, &'static str> {
    if v.is_null() {
        return Err("值为空");
    }
    if CFGetTypeID(v) != CFString::type_id() {
        CFRelease(v as *mut c_void);
        return Err("值类型非字符串");
    }
    let s = CFString::wrap_under_create_rule(v as CFStringRef);
    let out = s.to_string();
    if out.trim().is_empty() {
        Err("选区为空串")
    } else {
        Ok(out)
    }
}

pub(super) fn proc_path(pid: c_int) -> Option<String> {
    let mut buf = [0 as c_char; 4096];
    let n = unsafe { proc_pidpath(pid, buf.as_mut_ptr(), buf.len() as u32) };
    if n <= 0 {
        return None;
    }
    let bytes: Vec<u8> = buf[..n as usize]
        .iter()
        .map(|&b| b as u8)
        .take_while(|&b| b != 0)
        .collect();
    String::from_utf8(bytes).ok()
}

/// 屏幕录制权限预检（OCR 截图取词需要）
pub fn screen_capture_access() -> bool {
    unsafe { CGPreflightScreenCaptureAccess() != 0 }
}

/// 发起屏幕录制授权请求（系统弹窗）
pub fn request_screen_capture_access() -> bool {
    unsafe { CGRequestScreenCaptureAccess() != 0 }
}

// ---------- NSRunningApplication / NSWorkspace：运行中应用身份（黑名单精确匹配用） ----------

#[link(name = "AppKit", kind = "framework")]
extern "C" {}

// objc_msgSend 按调用签名分别声明（与 objc crate 内部做法一致）
#[allow(clashing_extern_declarations)]
extern "C" {
    fn objc_getClass(name: *const c_char) -> *mut c_void;
    fn sel_registerName(name: *const c_char) -> *mut c_void;
    #[link_name = "objc_msgSend"]
    fn msg_send_id_with_i32(receiver: *mut c_void, sel: *mut c_void, arg: i32) -> *mut c_void;
    #[link_name = "objc_msgSend"]
    fn msg_send_id_inst(receiver: *mut c_void, sel: *mut c_void) -> *mut c_void;
    #[link_name = "objc_msgSend"]
    fn msg_send_i64(receiver: *mut c_void, sel: *mut c_void) -> i64;
    #[link_name = "objc_msgSend"]
    fn msg_send_utf8(receiver: *mut c_void, sel: *mut c_void) -> *const c_char;
}

pub(super) fn objc_class(name: &str) -> *mut c_void {
    let c = CString::new(name).unwrap();
    unsafe { objc_getClass(c.as_ptr()) }
}

pub(super) fn objc_sel(name: &str) -> *mut c_void {
    let c = CString::new(name).unwrap();
    unsafe { sel_registerName(c.as_ptr()) }
}

/// 运行中应用的 bundle identifier（如 com.apple.Safari）；解析失败 = None。
/// 黑名单精确匹配用——Safari 等系统应用的进程路径不含 .app 包名，contains 会漏。
pub(crate) fn running_bundle_id(pid: c_int) -> Option<String> {
    unsafe {
        let app = msg_send_id_with_i32(
            objc_class("NSRunningApplication"),
            objc_sel("runningApplicationWithProcessIdentifier:"),
            pid,
        );
        if app.is_null() {
            return None;
        }
        let bid = msg_send_id_inst(app, objc_sel("bundleIdentifier"));
        if bid.is_null() {
            return None;
        }
        let ptr = msg_send_utf8(bid, objc_sel("UTF8String"));
        if ptr.is_null() {
            return None;
        }
        Some(CStr::from_ptr(ptr).to_string_lossy().into_owned())
    }
}

/// 前台应用 pid（NSWorkspace，**不依赖 AX**）。AX 权限状态异常（如 -25212）时的兜底，
/// 保证黑名单过滤与归属归属判断不失效。
pub(super) fn frontmost_pid() -> Option<i32> {
    unsafe {
        let ws = msg_send_id_inst(objc_class("NSWorkspace"), objc_sel("sharedWorkspace"));
        if ws.is_null() {
            return None;
        }
        let app = msg_send_id_inst(ws, objc_sel("frontmostApplication"));
        if app.is_null() {
            return None;
        }
        let pid = msg_send_i64(app, objc_sel("processIdentifier"));
        (pid > 0).then_some(pid as i32)
    }
}
