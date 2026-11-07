//! 界面语言（中/英）Rust 侧：生效语言解析 + 词典。与 src/shared/i18n（TS）共用
//! 同一套键名与同一条 auto 解析规则（系统语言 zh*→中文，其余→英文），改动两侧同步。
//!
//! 语言偏好存 Settings.uiLocale（"auto"|"zh"|"en"，默认 auto）。TS 侧与 Rust 侧
//! 各自维护「现行语言」：TS 在各 webview 的模块级 store（订阅者重渲染），Rust 在
//! 本模块的全局量（托盘/toast/错误文案取词时读）。切换经 set_ui_locale：落盘 →
//! 广播 locale://changed（payload = 偏好值，auto 由各端按系统语言自行解析）→
//! 两侧各自更新。
//!
//! t(key) 缺键回退键名本身（开发期可见，不静默吞）——与 TS 侧行为一致。

use std::sync::atomic::{AtomicU8, Ordering};

use sys_locale::get_locale;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Locale {
    Zh,
    En,
}

/// auto 解析：系统语言 zh*→中文，其余（含英文与非中英语言）→英文。
/// 与 src/shared/i18n/index.ts::resolveAuto 同规则
pub fn resolve_auto(lang: &str) -> Locale {
    let l = lang.to_ascii_lowercase();
    if l.starts_with("zh") {
        Locale::Zh
    } else {
        Locale::En
    }
}

/// 偏好值（Settings.uiLocale）→ 生效语言；auto 查系统语言
pub fn effective_from_pref(pref: &str) -> Locale {
    match pref {
        "zh" => Locale::Zh,
        "en" => Locale::En,
        _ => resolve_auto(&get_locale().unwrap_or_default()),
    }
}

// ---- 现行语言（Rust 侧全局，等价 TS 侧 store）----

/// 0 = Zh、1 = En（AtomicU8 存枚举：语言切换是全应用单点动作，Relaxed 足够）
static LOCALE: AtomicU8 = AtomicU8::new(0);

/// 设置现行语言：启动（setup 里按 settings 初始化）与 set_ui_locale 切换时调用
pub fn set_active(l: Locale) {
    LOCALE.store(l as u8, Ordering::Relaxed);
}

fn active() -> Locale {
    if LOCALE.load(Ordering::Relaxed) == 1 {
        Locale::En
    } else {
        Locale::Zh
    }
}

/// 取文案；缺键回退键名本身。键名与 TS 词典同域概念尽量同名（如 tray.*），
/// Rust 专属文案（toast/错误）也走这里
pub fn t(key: &str) -> &'static str {
    let table: &[(&str, &str)] = match active() {
        Locale::Zh => &ZH,
        Locale::En => &EN,
    };
    table
        .iter()
        .find(|(k, _)| *k == key)
        .map(|(_, v)| *v)
        // 缺键回退键名本身：t() 返回 &'static str 不能借用入参，泄漏一份
        // （仅开发期缺键可见，词典补齐后不触发）
        .unwrap_or_else(|| Box::leak(key.to_string().into_boxed_str()))
}

// ---- 词典（扁平键值，线性查找——文案量小，托盘/toast 调用频率低）----

static ZH: &[(&str, &str)] = &[
    // 托盘菜单
    ("tray.ocr", "识图取字"),
    ("tray.ocrTranslate", "识图翻译"),
    ("tray.ocrExplain", "识图解释"),
    ("tray.ocrSummarize", "识图总结"),
    ("tray.fileOcr", "访达选图取字"),
    ("tray.home", "主页面"),
    ("tray.settings", "功能设置"),
    ("tray.github", "GitHub 仓库"),
    ("tray.feedback", "反馈问题"),
    ("tray.quit", "退出应用"),
    ("tray.tooltip", "拾趣"),
    // toast 提示
    ("toast.screenPermission", "需要屏幕录制权限\n已打开系统设置，授权后重试"),
    ("toast.noMonitor", "无法定位光标所在显示器"),
    ("toast.snipStartFailed", "截图组件启动失败\n请重新触发识图取字"),
    ("toast.snapFailed", "截图失败\n请重新触发识图取字"),
    ("toast.resnapFailed", "选区更新失败，请重新截图"),
    ("toast.recognizing", "正在识别…"),
    ("toast.noTextHint", "未检测到文字\n重新框选，确认区域内有清晰的文字"),
    ("toast.noTextHintImage", "未检测到文字\n换一张清晰的图片试试"),
    ("toast.imageReadFailed", "图片读取失败\n文件可能已被移动或删除"),
    ("toast.updateAvailable", "发现新版本 "),
    ("toast.updateAvailableHint", "，可到「设置 › 关于」下载"),
    ("toast.vscodeAxGuidance", "VS Code 需开启辅助功能支持才能划词：在 VS Code 设置中把 accessibilitySupport 设为 on（VS Code 将进入读屏优化模式）"),
    // 通用错误（返回前端 toast / 结果面板展示）
    ("err.ocrHelperLaunch", "无法启动 OCR 助手"),
    ("err.recognizeFailed", "文本识别失败"),
    ("ocr.noText", "未识别到文字"),
    ("err.appDirLocate", "无法定位应用目录"),
    ("err.snapProcLaunch", "无法启动截屏进程"),
    ("err.devAutostart", "开发版不能设置自启动，请使用打包安装版"),
    ("err.logUnavailable", "日志不可用"),
    ("err.clipboardOpen", "打开剪贴板失败"),
    ("err.clipboardWrite", "写入剪贴板失败"),
    ("err.taskFailed", "任务执行失败"),
    ("err.netFailed", "网络请求失败"),
    ("err.modelError", "模型返回错误"),
    ("err.streamInterrupted", "流中断"),
    ("err.pinNotFromPanel", "仅识别面板可钉图"),
    ("err.pinImageMissing", "截图原图已不存在，请重新识别"),
    ("err.snapRead", "读取截图失败"),
    ("err.pinLimit", "钉图数量已达上限（8），请先关闭部分钉图"),
    ("err.pinWrite", "写入钉图文件失败"),
    ("err.pinDataMissing", "钉图数据不存在"),
    ("err.snapDecode", "解码截图失败"),
    ("err.noModelService", "未配置模型服务，请到「设置」页添加"),
    ("err.apiKeyEmpty", "API Key 为空，请到「设置」页填写"),
    ("err.parseFailed", "响应解析失败"),
    ("err.responseMissingField", "响应缺少 Response 字段"),
    ("err.translateEmpty", "翻译结果为空"),
    ("err.invalidPath", "路径不合法"),
    ("err.vaultNotConfigured", "未配置 Obsidian vault 目录"),
    ("err.mkdirFailed", "无法创建目录"),
    ("err.fileOpenFailed", "无法打开文件"),
    ("err.writeFailed", "写入失败"),
    // 系统选择面板
    ("picker.blacklistAppTitle", "选择要加入黑名单的应用"),
    ("picker.appFilter", "应用程序"),
    ("picker.vaultTitle", "选择 Obsidian Vault 目录"),
    ("picker.imageTitle", "选择要识别的图片"),
    ("picker.imageFilter", "图片"),
    // 翻译服务（按服务商）
    ("err.translate.baiduDisabled", "未启用百度翻译服务"),
    ("err.translate.baiduSetup", "请到「翻译」页填写百度翻译 APPID 与密钥"),
    ("err.translate.baiduError", "百度翻译错误"),
    ("err.translate.deeplDisabled", "未启用 DeepL 翻译服务"),
    ("err.translate.deeplSetup", "请到「翻译」页填写 DeepL Authentication Key"),
    ("err.translate.deeplError", "DeepL 错误"),
    ("err.translate.googleDisabled", "未启用谷歌翻译服务"),
    ("err.translate.googleSetup", "请到「翻译」页填写谷歌翻译 API 密钥"),
    ("err.translate.googleError", "谷歌翻译错误"),
    ("err.translate.microsoftDisabled", "未启用微软翻译服务"),
    ("err.translate.microsoftSetup", "请到「翻译」页填写微软翻译 API 密钥"),
    ("err.translate.microsoftError", "微软翻译错误"),
    ("err.translate.youdaoDisabled", "未启用有道翻译服务"),
    ("err.translate.youdaoSetup", "请到「翻译」页填写有道翻译的应用 ID 与密钥"),
    ("err.translate.youdaoError", "有道翻译错误"),
    ("err.translate.tencentDisabled", "未启用腾讯翻译服务"),
    ("err.translate.tencentSetup", "请到「翻译」页填写腾讯翻译的密钥与地域"),
    ("err.translate.tencentError", "腾讯翻译错误"),
    ("err.translate.aliyunDisabled", "未启用阿里翻译服务"),
    ("err.translate.aliyunSetup", "请到「翻译」页填写阿里翻译的 AccessKey"),
    ("err.translate.aliyunError", "阿里翻译错误"),
    ("err.translate.volcDisabled", "未启用火山翻译服务"),
    ("err.translate.volcSetup", "请到「翻译」页填写火山翻译的访问密钥"),
    ("err.translate.volcError", "火山翻译错误"),
    ("err.translate.caiyunDisabled", "未启用彩云小译服务"),
    ("err.translate.caiyunSetup", "请到「翻译」页填写彩云小译的 API 令牌"),
    ("err.translate.caiyunError", "彩云小译错误"),
];

static EN: &[(&str, &str)] = &[
    // Tray menu
    ("tray.ocr", "Capture Text"),
    ("tray.ocrTranslate", "Capture & Translate"),
    ("tray.ocrExplain", "Capture & Explain"),
    ("tray.ocrSummarize", "Capture & Summarize"),
    ("tray.fileOcr", "Capture from Finder Image"),
    ("tray.home", "Home"),
    ("tray.settings", "Settings"),
    ("tray.github", "GitHub Repository"),
    ("tray.feedback", "Feedback"),
    ("tray.quit", "Quit"),
    ("tray.tooltip", "Magpie"),
    // Toasts
    ("toast.screenPermission", "Screen recording permission is required\nSystem Settings has been opened — grant it and try again"),
    ("toast.noMonitor", "Couldn't detect the display under the cursor"),
    ("toast.snipStartFailed", "The capture component failed to start\nPlease try again"),
    ("toast.snapFailed", "Capture failed\nPlease try again"),
    ("toast.resnapFailed", "Couldn't update the selection — please capture again"),
    ("toast.recognizing", "Recognizing…"),
    ("toast.noTextHint", "No text detected\nTry again and make sure the selection contains clear text"),
    ("toast.noTextHintImage", "No text detected\nTry a sharper image"),
    ("toast.imageReadFailed", "Couldn't read the image\nThe file may have been moved or deleted"),
    ("toast.updateAvailable", "New version "),
    ("toast.updateAvailableHint", " is available — download it from Settings › About"),
    ("toast.vscodeAxGuidance", "VS Code needs Accessibility Support enabled to capture text: set accessibilitySupport to on in VS Code settings (VS Code will switch to its screen-reader optimized mode)"),
    // Errors (shown to the user as toasts / in the result panel)
    ("err.ocrHelperLaunch", "Couldn't launch the text-recognition helper"),
    ("err.recognizeFailed", "Text recognition failed"),
    ("ocr.noText", "No text recognized"),
    ("err.appDirLocate", "Couldn't locate the app directory"),
    ("err.snapProcLaunch", "Couldn't launch the capture process"),
    ("err.devAutostart", "Launch at login is only available in the installed app, not the dev build"),
    ("err.logUnavailable", "Log unavailable"),
    ("err.clipboardOpen", "Couldn't open the clipboard"),
    ("err.clipboardWrite", "Couldn't write to the clipboard"),
    ("err.taskFailed", "The operation failed"),
    ("err.netFailed", "Network request failed"),
    ("err.modelError", "The model returned an error"),
    ("err.streamInterrupted", "The stream was interrupted"),
    ("err.pinNotFromPanel", "Only results from the recognition panel can be pinned"),
    ("err.pinImageMissing", "The original screenshot no longer exists — please capture again"),
    ("err.snapRead", "Couldn't read the screenshot"),
    ("err.pinLimit", "Pin limit reached (8) — close some pins first"),
    ("err.pinWrite", "Couldn't write the pin file"),
    ("err.pinDataMissing", "Pin data not found"),
    ("err.snapDecode", "Couldn't decode the screenshot"),
    ("err.noModelService", "No AI provider configured — add one on the Settings page"),
    ("err.apiKeyEmpty", "The API key is empty — fill it in on the Settings page"),
    ("err.parseFailed", "Couldn't parse the response"),
    ("err.responseMissingField", "The response is missing an expected field"),
    ("err.translateEmpty", "The translation result is empty"),
    ("err.invalidPath", "Invalid path"),
    ("err.vaultNotConfigured", "No Obsidian vault folder configured"),
    ("err.mkdirFailed", "Couldn't create the folder"),
    ("err.fileOpenFailed", "Couldn't open the file"),
    ("err.writeFailed", "Couldn't write the file"),
    // System picker panels
    ("picker.blacklistAppTitle", "Choose an app to block"),
    ("picker.appFilter", "Applications"),
    ("picker.vaultTitle", "Choose your Obsidian vault folder"),
    ("picker.imageTitle", "Choose an image to capture text from"),
    ("picker.imageFilter", "Images"),
    // Translation services (per provider)
    ("err.translate.baiduDisabled", "Baidu Translate is not enabled"),
    ("err.translate.baiduSetup", "Fill in your Baidu Translate APP ID and secret on the Translate settings page"),
    ("err.translate.baiduError", "Baidu Translate error"),
    ("err.translate.deeplDisabled", "DeepL is not enabled"),
    ("err.translate.deeplSetup", "Fill in your DeepL Authentication Key on the Translate settings page"),
    ("err.translate.deeplError", "DeepL error"),
    ("err.translate.googleDisabled", "Google Translate is not enabled"),
    ("err.translate.googleSetup", "Fill in your Google Translate API key on the Translate settings page"),
    ("err.translate.googleError", "Google Translate error"),
    ("err.translate.microsoftDisabled", "Microsoft Translator is not enabled"),
    ("err.translate.microsoftSetup", "Fill in your Microsoft Translator API key on the Translate settings page"),
    ("err.translate.microsoftError", "Microsoft Translator error"),
    ("err.translate.youdaoDisabled", "Youdao Translate is not enabled"),
    ("err.translate.youdaoSetup", "Fill in your Youdao Translate app ID and secret on the Translate settings page"),
    ("err.translate.youdaoError", "Youdao Translate error"),
    ("err.translate.tencentDisabled", "Tencent Translate is not enabled"),
    ("err.translate.tencentSetup", "Fill in your Tencent Translate secret and region on the Translate settings page"),
    ("err.translate.tencentError", "Tencent Translate error"),
    ("err.translate.aliyunDisabled", "Alibaba Translate is not enabled"),
    ("err.translate.aliyunSetup", "Fill in your Alibaba Translate AccessKey on the Translate settings page"),
    ("err.translate.aliyunError", "Alibaba Translate error"),
    ("err.translate.volcDisabled", "Volcengine Translate is not enabled"),
    ("err.translate.volcSetup", "Fill in your Volcengine Translate access key on the Translate settings page"),
    ("err.translate.volcError", "Volcengine Translate error"),
    ("err.translate.caiyunDisabled", "Caiyun Translate is not enabled"),
    ("err.translate.caiyunSetup", "Fill in your Caiyun Translate API token on the Translate settings page"),
    ("err.translate.caiyunError", "Caiyun Translate error"),
];
