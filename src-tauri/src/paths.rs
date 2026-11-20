//! 本机路径出口动作（0.1.24）：选区整段就是一个本机路径时，「打开位置」把人带到那儿看一眼。
//!
//! 为什么用 Shell 项 API（PIDL）而不是 `explorer.exe` 命令行：
//! ① 不经命令解释器——选区文本永远不可能被拼成一条命令，注入面为零（与 ADR-05 的
//!    「选中文本进 shell 就是本地提权面」同一立场）；
//! ② `explorer /select,<path>` 对带空格路径的引号位置有解析怪癖：社区做法是给整段加引号，
//!    而 std 的 argv 转义会再把引号转义一层，最终行为取决于两层转义如何相互抵消——
//!    这不是能靠读文档定下来的事。Shell 项 API 直接吃 PIDL，没有这条歧义。
//!
//! 动作分级是**安全边界**而不是体验细节：选区里的路径字符串来自屏幕上任意内容（日志、聊天、
//! README），它只能说明「用户在看这个路径」，不能说明「用户想运行它」。
//! - 目录 → 打开该目录
//! - 文档/图片/影音类扩展名 → 放行给系统默认应用（这是这类文件唯一有意义的动作）
//! - 可执行类扩展名 → **只在文件管理器里选中，绝不启动**
//! - 其余扩展名 → 同上，只选中
//!
//! 显隐判据在前端（`shared/textContext.ts::extractPath`，只看语法、不 stat），本模块负责
//! 第二遍校验与执行：前端给的是已经还原过的路径形态，收到别的东西（相对路径、共享盘
//! UNC、控制字符）一律拒绝，不猜。
//!
//! 收下的写法：盘符路径（`E:\a`、`E:/a`）与 WSL 发行版路径（`\\wsl.localhost\Ubuntu\…`
//! 及旧别名 `\\wsl$\`）。后者写法是 UNC，但这条命名空间由 Windows 自己提供，资源管理器
//! 原生能进去，和共享盘不是一回事（用户 2026-11-19 点名要支持）。共享盘
//! （`\\server\share`）与 POSIX 写法（`/home/me/a`）本版不做，理由见 ROADMAP 与
//! textContext.ts 的注释；接口都留在这两处判据里，放开时不用动动作与面板。
//!
//! WSL 里 Linux 文件常没有扩展名（`/usr/bin/vim`），也可能带（`.sh`、`.py`）——这些
//! 一律落在「只选中、不启动」那一档，正好：Linux 的可执行位对 Windows 毫无意义，
//! 按扩展名判断在这里靠不住，所以默认档必须是保守的那一档。
//!
//! 非 Windows 构建里本模块只剩纯函数（校验/分类，供测试与契约形状一致），执行分支是桩。
#![allow(dead_code)]

/// 执行结果，前端据此出一行提示（`path.opened.*`）。刻意不用异常：这一支的失败是
/// 常态（选到已经移走的旧路径），提示语气必须是陈述而不是报错。
/// 成功分三档各说一句真话——「已打开」在目录、启动文档、只是在文件管理器里选中
/// 这三种结局下用户看到的东西完全不同，合成一句就会让人怀疑动作没生效。
pub const OPENED_DIR: &str = "opened-dir";
pub const OPENED_REVEAL: &str = "opened-reveal";
pub const OPENED_APP: &str = "opened-app";
pub const MISSING: &str = "missing";
pub const FAILED: &str = "failed";
pub const UNSUPPORTED: &str = "unsupported";

/// 会被「启动」而不是「显示」的扩展名——命中即只 reveal。`.lnk` 也算：快捷方式的
/// 目标是谁，从路径字符串上完全看不出来。
const EXEC_EXTS: &[&str] = &[
    "exe", "com", "bat", "cmd", "msi", "msp", "msm", "ps1", "psm1", "vbs", "vbe", "js", "jse",
    "wsf", "wsh", "scr", "cpl", "hta", "lnk", "appinstaller", "jar",
];

/// 放行给系统默认应用打开的文档/媒体类。`.svg` 刻意不在列：默认应用多半是浏览器，
/// 等于把选区里的一个字符串交给浏览器渲染；文件管理器里的缩略图已经够回答
/// 「这个文件长什么样」。`.html` 同理不入列（网页不是「本机位置」，是内容）。
const OPEN_EXTS: &[&str] = &[
    "txt", "md", "markdown", "log", "pdf", "epub", "mobi", "doc", "docx", "rtf", "xls", "xlsx",
    "csv", "tsv", "ppt", "pptx", "odt", "ods", "odp", "json", "xml", "yml", "yaml", "toml", "ini",
    "png", "jpg", "jpeg", "gif", "bmp", "webp", "tif", "tiff", "ico", "heic", "mp3", "wav", "m4a",
    "flac", "aac", "ogg", "mp4", "mov", "avi", "mkv", "webm",
];

/// 路径长度上限：正常路径远不到这里，超长串基本是误选（整段日志、base64）。
/// 语法判据不看文件系统，没有长度闸门就会把一坨文本当成路径给出动作。
const MAX_LEN: usize = 1024;

#[derive(Debug, PartialEq, Eq)]
enum PathClass {
    /// 交给系统默认应用
    Open,
    /// 只在文件管理器里选中
    Reveal,
}

#[tauri::command]
pub fn open_local_path(path: String) -> &'static str {
    open_path_impl(&path)
}

/// 规范化后的本机位置？只做语法判断，不碰文件系统。
/// 接受三种写法：`E:\a\b`、`E:/a/b`（Win32 与 Shell 都吃正斜杠）、
/// `\\wsl.localhost\Ubuntu\home\me\a`（含旧别名 `\\wsl$\`）。
/// 拒绝：空、超长、含控制字符与 `*?"<>|`（NTFS 非法字符，出现即说明这不是路径而是
/// 混了别的内容）、相对路径、盘符后没有分隔符（`C:` / `C:x`）、`file:///` 这种
/// URL 形态（前端已还原，走到这里说明调用方没走判据）、以及共享盘 UNC。
fn approved_form(raw: &str) -> Option<&str> {
    let p = raw.trim();
    if p.is_empty() || p.len() > MAX_LEN {
        return None;
    }
    if p.chars().any(|c| c.is_control() || matches!(c, '*' | '?' | '"' | '<' | '>' | '|')) {
        return None;
    }
    // 用 get 而非下标：盘符形态最短 3 字节，但选区可能只有一个字符或一个冒号，
    // 直接下标会 panic（命令跑在主进程里，不能为一个字符串越界）
    let bytes = p.as_bytes();
    let drive_form = matches!(
        (bytes.first(), bytes.get(1), bytes.get(2)),
        (Some(letter), Some(b':'), Some(sep)) if letter.is_ascii_alphabetic() && (*sep == b'\\' || *sep == b'/')
    );
    if drive_form || wsl_form(p) {
        Some(p)
    } else {
        None
    }
}

/// WSL 发行版路径。写法是 UNC，但这条命名空间由 Windows 自己提供：不开网络会话、
/// 不要凭据，资源管理器原生就能进去，所以和 `\\server\share` 不是一回事
/// （用户 2026-11-19 点名要支持）。共享盘本版仍拒绝：判在不在要发起 SMB 会话，
/// 服务器掉线时以十秒计，还可能弹凭据窗
fn wsl_form(p: &str) -> bool {
    let lower = p.to_ascii_lowercase();
    lower == r"\\wsl.localhost"
        || lower == r"\\wsl$"
        || lower.starts_with(r"\\wsl.localhost\")
        || lower.starts_with(r"\\wsl$\")
}

/// 扩展名分类：可执行类与没见过的都只选中，只有文档/媒体类才交给默认应用
fn classify(ext: &str) -> PathClass {
    let e = ext.to_ascii_lowercase();
    if OPEN_EXTS.contains(&e.as_str()) {
        PathClass::Open
    } else {
        PathClass::Reveal
    }
}

/// 取扩展名（最后一个点之后，不含点）；点若在名首（`.gitignore`）或结尾则无扩展名
fn extension_of(p: &str) -> &str {
    let name = p.rsplit(['\\', '/']).next().unwrap_or("");
    match name.rfind('.') {
        Some(i) if i > 0 && i + 1 < name.len() => &name[i + 1..],
        _ => "",
    }
}

#[cfg(windows)]
fn open_path_impl(raw: &str) -> &'static str {
    let Some(path) = approved_form(raw) else {
        crate::user_log(&format!("paths: 形态不接受，拒绝执行 len={}", raw.len()));
        return UNSUPPORTED;
    };

    // stat 在执行期是允许的（「显隐」那次才刻意不 stat）。不存在 = 「找不到这个位置」，
    // 这一支是常态：选区里的路径常来自日志或聊天记录，早就不在了。
    // 交给 Shell 的永远是原始写法：探针实测 `\\?\` 与 `\\?\UNC\` 前缀 SHParseDisplayName
    // 一律回 0x80070057（E_INVALIDARG），前缀只用来判存在，不能拿去执行。
    let Some(is_dir) = exists(path) else {
        return MISSING;
    };
    // 目录一律 = 打开目录；文件按扩展名分档，可执行类永不启动
    if is_dir {
        open_dir(path)
    } else if classify(extension_of(path)) == PathClass::Open {
        shell_open(path)
    } else {
        reveal(path)
    }
}

/// 存在吗？是目录吗。先按原样查，失败时补一次长路径前缀再查：超过 260 的路径在
/// MAX_PATH 闸门上必然报错，而那些路径真实存在（构建产物、深度嵌套的仓库目录、
/// WSL 里的 node_modules）。前缀写法分两种：盘符路径加 `\\?\`，UNC 与 WSL 要把开头的
/// `\\server` 换成 `\\?\UNC\server`——直接前缀会拼出三段反斜杠的错误路径。
/// 前缀只参与这一次判定，不作为交给 Shell 的字符串（见上）。
#[cfg(windows)]
fn exists(path: &str) -> Option<bool> {
    if let Ok(m) = std::fs::metadata(path) {
        return Some(m.is_dir());
    }
    let prefixed = match path.strip_prefix(r"\\") {
        Some(unc) => format!(r"\\?\UNC\{unc}"),
        None => format!(r"\\?\{path}"),
    };
    std::fs::metadata(&prefixed).ok().map(|m| m.is_dir())
}

/// 宽字符 + 结尾 0，PCWSTR 要的形态
#[cfg(windows)]
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// 打开目录（Explorer 窗口落在该目录）
#[cfg(windows)]
fn open_dir(path: &str) -> &'static str {
    use windows::Win32::UI::Shell::{ILFree, SHOpenFolderAndSelectItems};
    let Some(pidl) = parse_pidl(path) else {
        return FAILED;
    };
    let opened = unsafe { SHOpenFolderAndSelectItems(pidl as *const _, None, 0) };
    unsafe { ILFree(Some(pidl as *const _)) };
    match opened {
        Ok(()) => {
            crate::user_log(&format!("paths: 打开目录 {path}"));
            OPENED_DIR
        }
        Err(_) => FAILED,
    }
}

/// 在文件管理器里选中该文件（不启动、不打开任何内容）
#[cfg(windows)]
fn reveal(path: &str) -> &'static str {
    use windows::Win32::UI::Shell::{ILFindLastID, ILFree, ILRemoveLastID, SHOpenFolderAndSelectItems};
    let Some(pidl) = parse_pidl(path) else {
        return FAILED;
    };
    // 顺序不能反：先取出「最后一段」（它指向缓冲区内部，截断后仍在原地），
    // 再把缓冲区截成父目录。反过来做，最后一段就没了。
    let child = unsafe { ILFindLastID(pidl as *const _) };
    let _removed = unsafe { ILRemoveLastID(Some(pidl)) };
    let items = [child as *const _];
    let shown = unsafe { SHOpenFolderAndSelectItems(pidl as *const _, Some(&items), 0) };
    unsafe { ILFree(Some(pidl as *const _)) };
    match shown {
        Ok(()) => {
            crate::user_log(&format!("paths: 在文件管理器里选中 {path}"));
            OPENED_REVEAL
        }
        Err(_) => FAILED,
    }
}

/// 交给系统默认应用（只给文档/媒体类扩展名走到这里）。ShellExecuteW 返回的
/// HINSTANCE 在 ≤32 时是错误码（SE_ERR_*），不是句柄
#[cfg(windows)]
fn shell_open(path: &str) -> &'static str {
    use windows::core::PCWSTR;
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    let verb = wide("open");
    let w = wide(path);
    let ret = unsafe {
        ShellExecuteW(
            None,
            PCWSTR(verb.as_ptr()),
            PCWSTR(w.as_ptr()),
            None,
            None,
            SW_SHOWNORMAL,
        )
    };
    if (ret.0 as isize) > 32 {
        crate::user_log(&format!("paths: 用默认应用打开 {path}"));
        OPENED_APP
    } else {
        crate::user_log(&format!(
            "paths: 默认应用拒绝打开 {path}（ShellExecuteW={}）",
            ret.0 as isize
        ));
        FAILED
    }
}

/// 把路径解析成 Shell 项（PIDL）。解析失败 = 这个位置 Shell 自己都不认，按失败处理
#[cfg(windows)]
fn parse_pidl(path: &str) -> Option<*mut windows::Win32::UI::Shell::Common::ITEMIDLIST> {
    use windows::core::PCWSTR;
    use windows::Win32::UI::Shell::SHParseDisplayName;
    let w = wide(path);
    let mut pidl: *mut windows::Win32::UI::Shell::Common::ITEMIDLIST = std::ptr::null_mut();
    match unsafe { SHParseDisplayName(PCWSTR(w.as_ptr()), None, &mut pidl, 0, None) } {
        Ok(()) if !pidl.is_null() => Some(pidl),
        _ => None,
    }
}

#[cfg(not(windows))]
fn open_path_impl(raw: &str) -> &'static str {
    // 非 Windows：命令照常注册（前端调用形状三平台一致），但一律答「这台电脑不支持」。
    // POSIX 路径的识别接口同样预留，见 textContext.ts 的注释
    crate::user_log(&format!("paths: 本平台不支持 open_local_path len={}", raw.len()));
    UNSUPPORTED
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_drive_and_wsl_forms() {
        assert_eq!(approved_form(r"E:\Project\Magpie"), Some(r"E:\Project\Magpie"));
        assert_eq!(approved_form(r"E:/Project"), Some(r"E:/Project"));
        assert_eq!(approved_form(r"C:\"), Some(r"C:\"));
        assert_eq!(approved_form("  E:\\a  "), Some(r"E:\a"));
        // WSL 写法由 Windows 自己提供，资源管理器原生能进，所以收下（含旧别名与大写）
        assert_eq!(
            approved_form(r"\\wsl.localhost\Ubuntu\home\me\Project"),
            Some(r"\\wsl.localhost\Ubuntu\home\me\Project")
        );
        assert_eq!(approved_form(r"\\wsl$\Ubuntu\home\me\a"), Some(r"\\wsl$\Ubuntu\home\me\a"));
        assert_eq!(approved_form(r"\\WSL.LOCALHOST\"), Some(r"\\WSL.LOCALHOST\"));
        assert_eq!(approved_form(r"\\wsl.localhost"), Some(r"\\wsl.localhost"));
    }

    /// 拒绝面：相对路径、共享盘 UNC、别的平台的写法、缺分隔符、越界长度、非法字符与
    /// 控制字符——要么本版刻意不做，要么根本不是路径
    #[test]
    fn rejects_relative_share_and_dirty_strings() {
        for bad in [
            "",
            "Project\\Magpie",
            r"\\server\share\x",
            r"\\wsl.localhostx\Ubuntu", // 前缀差一个字符就不是 WSL 命名空间
            "/home/me/project",
            "C:",
            "C:x",
            r"E:\a*b",
            r"E:\a?b",
            "E:\\a\u{1}b",
            "E:\\a\nb",
            "file:///E:/",
        ] {
            assert_eq!(approved_form(bad), None, "{bad:?} 不该被接受");
        }
        let long = format!(r"E:\{}", "a".repeat(MAX_LEN));
        assert_eq!(approved_form(&long), None);
    }

    #[test]
    fn extension_split_ignores_directories_and_dotted_names() {
        assert_eq!(extension_of(r"E:\a\b\c.MD"), "MD");
        assert_eq!(extension_of(r"E:\a\b\c"), "");
        assert_eq!(extension_of(r"E:\a\b\c."), "");
        assert_eq!(extension_of(r"E:\a\.gitignore"), "");
        assert_eq!(extension_of(r"E:\Program Files\x.txt"), "txt");
    }

    /// 可执行类永远只选中；文档类才放行给默认应用；没见过的扩展名走最保守的一支
    #[test]
    fn executables_and_unknown_extensions_are_never_launched() {
        for never in ["exe", "EXE", "lnk", "cmd", "ps1", "msi", "html", "svg", "", "unknown"] {
            assert_eq!(classify(never), PathClass::Reveal, "{never:?} 不该被启动");
        }
        for open in ["md", "PDF", "png", "docx", "mp4"] {
            assert_eq!(classify(open), PathClass::Open);
        }
    }
}
