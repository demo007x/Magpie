//! 设置：JSON 配置（默认 DeepSeek 预设），内存 Mutex 缓存。
//! 安全注记：API Key 明文本机存储（ADR-07），M2 迁移系统钥匙串。

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Provider {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub api_key: String,
    pub model: String,
}

impl Default for Provider {
    fn default() -> Self {
        Self {
            id: "p1".into(),
            name: "DeepSeek".into(),
            base_url: "https://api.deepseek.com".into(),
            api_key: String::new(),
            model: "deepseek-chat".into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Actions {
    pub translate: bool,
    pub explain: bool,
    pub summarize: bool,
    pub copy: bool,
    pub search: bool,
    /// 上下文动作：选中文本为 URL 时「打开链接」
    pub link: bool,
    /// 上下文动作：选中文本为邮箱时「写邮件」
    pub email: bool,
    /// 上下文动作：选中文本含验证码时「复制验证码」
    pub code: bool,
    /// 上下文动作：选中文本含电话号码时「复制号码」
    pub tel: bool,
}

impl Default for Actions {
    fn default() -> Self {
        Self {
            translate: true,
            explain: true,
            summarize: true,
            copy: true,
            search: true,
            link: true,
            email: true,
            code: true,
            tel: true,
        }
    }
}

/// 搜索引擎（自定义引擎列表项）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SearchEngine {
    pub name: String,
    /// 链接模板，{q} 为选中文本
    pub url: String,
    pub enabled: bool,
}

impl Default for SearchEngine {
    fn default() -> Self {
        Self { name: String::new(), url: String::new(), enabled: true }
    }
}

fn engine(name: &str, url: &str) -> SearchEngine {
    SearchEngine { name: name.into(), url: url.into(), enabled: true }
}

fn default_engines() -> Vec<SearchEngine> {
    vec![
        engine("百度AI", "https://wenxin.baidu.com/search?word={q}"),
        engine("百度", "https://www.baidu.com/s?wd={q}"),
        engine("GoogleAI", "https://www.google.com/search?q={q}&udm=50"),
        engine("Google", "https://www.google.com/search?q={q}"),
        engine("必应", "https://www.bing.com/search?q={q}"),
        engine("GitHub", "https://github.com/search?q={q}"),
    ]
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TranslateConfig {
    /// 启用的翻译服务（多选，浮动条「翻译」展开列表）：["ai", "baidu", "deepl"]
    pub enabled: Vec<String>,
    /// 默认服务（浮动条「翻译」单击直达）；alias 兼容旧配置的单选 service 字段
    #[serde(alias = "service")]
    pub default: String,
    /// 服务展示顺序（设置页行序与浮动条展开顺序）；缺省 id 按注册表顺序追加
    pub order: Vec<String>,
    /// 百度翻译开放平台凭据
    pub app_id: String,
    pub app_key: String,
    /// DeepL Authentication Key（Free 密钥以 :fx 结尾，据此选 api-free 域名）
    pub deepl_key: String,
}

impl Default for TranslateConfig {
    fn default() -> Self {
        Self {
            enabled: vec!["ai".into(), "baidu".into()],
            default: "ai".into(),
            order: Vec::new(),
            app_id: String::new(),
            app_key: String::new(),
            deepl_key: String::new(),
        }
    }
}

/// 用户自定义 AI 动作。默认提示词文本只活在 TS 层（src/shared/actions.ts），
/// Rust 侧只搬运用户自己写的那份——所以这里没有"内置默认"的影子，
/// 新增动作类型无需改 Rust（符合「Rust 管不变的，TS 管多变的」）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CustomAction {
    /// 前缀 "c:" 与内置动作 id 隔离
    pub id: String,
    /// 胶囊显示名（建议 ≤6 字）
    pub name: String,
    /// system 提示词；空 = 未配置，前端拒绝执行
    pub prompt: String,
    pub enabled: bool,
    /// 预留：挂到某内置动作的二级展开列表（变体挂载），当前未使用
    pub under: Option<String>,
}

impl Default for CustomAction {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            prompt: String::new(),
            enabled: true,
            under: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub providers: Vec<Provider>,
    pub default_provider_id: String,
    pub actions: Actions,
    pub action_order: Vec<String>,
    /// 用户自定义 AI 动作（id 混排在 action_order 中）
    #[serde(default)]
    pub custom_actions: Vec<CustomAction>,
    /// 浮动胶囊固定显示的动作数（超出部分收进右侧「⌄N」面板）
    pub capsule_show_count: usize,
    pub search_engines: Vec<SearchEngine>,
    /// 默认引擎（浮动条「搜索」单击直达），值为 SearchEngine.name
    pub default_search: String,
    /// 翻译动作的服务配置
    pub translate: TranslateConfig,
    /// AI 动作提示词覆盖表（key = 动作 id）。只存用户自定义值：缺省即跟随内置默认，
    /// 「恢复默认」= 删除该 key，而不是把当时的默认文本写回去（内置默认升级后仍能取到新版）。
    /// 默认文本本身只在 TS 层维护（src/shared/actions.ts DEFAULT_PROMPTS）。
    #[serde(default)]
    pub action_prompts: HashMap<String, String>,
    /// 是否在 macOS Dock 显示图标（关 = 纯菜单栏常驻模式）
    pub show_dock_icon: bool,
    /// 识图取字全局快捷键（如 "Alt+O"、"CmdOrCtrl+Shift+O"）；空串 = 禁用
    pub ocr_shortcut: String,
    /// 识图翻译全局快捷键（截图→识别→默认翻译服务）；空串 = 禁用
    #[serde(default = "default_ocr_translate_shortcut")]
    pub ocr_translate_shortcut: String,
    /// 识图解释全局快捷键（截图→识别→AI 解释）；空串 = 禁用
    #[serde(default = "default_ocr_explain_shortcut")]
    pub ocr_explain_shortcut: String,
    /// 识图总结全局快捷键（截图→识别→AI 总结）；空串 = 禁用
    #[serde(default = "default_ocr_summarize_shortcut")]
    pub ocr_summarize_shortcut: String,
    pub app_blacklist: Vec<String>,
    pub debounce_ms: u64,
    /// 结果窗口上次位置（逻辑坐标）：关闭后下次（含重启）在同位置出现
    #[serde(default)]
    pub result_window_pos: Option<[f64; 2]>,
    /// 结果窗口用户自定义尺寸：宽度即内容宽度，高度为内容自适应上限
    #[serde(default)]
    pub result_window_size: Option<[f64; 2]>,
    /// 结果窗口「钉住」偏好：用户在面板上最后一次点钉/取消钉的选择，跨重启保留。
    /// 默认钉住——识图与划词导流的结果是多步操作（看原文/跑动作/复制），
    /// 点空即消失会打断流程
    #[serde(default = "default_true")]
    pub result_window_pinned: bool,
    /// 应用外观："auto"（跟随系统，默认）| "light" | "dark"
    #[serde(default)]
    pub appearance: String,
}

fn default_true() -> bool {
    true
}

fn default_ocr_translate_shortcut() -> String {
    "Alt+T".into()
}

fn default_ocr_explain_shortcut() -> String {
    "Alt+E".into()
}

fn default_ocr_summarize_shortcut() -> String {
    "Alt+D".into()
}

fn default_appearance() -> String {
    "auto".into()
}

impl Default for Settings {
    fn default() -> Self {
        let p = Provider::default();
        Self {
            providers: vec![p.clone()],
            default_provider_id: p.id,
            actions: Actions::default(),
            action_order: vec![
                "translate".into(),
                "explain".into(),
                "summarize".into(),
                "copy".into(),
                "search".into(),
            ],
            custom_actions: Vec::new(),
            capsule_show_count: 4,
            search_engines: default_engines(),
            default_search: "百度".into(),
            translate: TranslateConfig::default(),
            action_prompts: HashMap::new(),
            show_dock_icon: false,
            ocr_shortcut: "Alt+S".into(),
            ocr_translate_shortcut: default_ocr_translate_shortcut(),
            ocr_explain_shortcut: default_ocr_explain_shortcut(),
            ocr_summarize_shortcut: default_ocr_summarize_shortcut(),
            app_blacklist: vec![
                "Terminal".into(),
                "iTerm".into(),
                "1Password".into(),
                "Passwords".into(),
            ],
            debounce_ms: 200,
            result_window_pos: None,
            result_window_size: None,
            result_window_pinned: true,
            appearance: default_appearance(),
        }
    }
}

pub struct SettingsPath(pub PathBuf);

fn config_path(app: &AppHandle) -> PathBuf {
    let dir = app
        .path()
        .app_config_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    let _ = fs::create_dir_all(&dir);
    dir.join("settings.json")
}

/// 一次性迁移：identifier 由 app.shici.desktop 改为 app.magpie.desktop 后，
/// 首次启动把旧目录的 settings.json 复制到新目录，用户已配置的密钥/引擎无缝衔接。
fn migrate_legacy_config(app: &AppHandle, path: &std::path::Path) {
    if path.exists() {
        return;
    }
    let Ok(dir) = app.path().app_config_dir() else {
        return;
    };
    let Some(legacy_dir) = dir.parent() else {
        return;
    };
    let legacy = legacy_dir.join("app.shici.desktop/settings.json");
    if legacy.exists() {
        if fs::copy(&legacy, path).is_ok() {
            crate::capture::debug_log("已从旧目录迁移 settings.json（app.shici.desktop → app.magpie.desktop）");
        }
    }
}

pub fn init(app: &AppHandle) {
    let path = config_path(app);
    migrate_legacy_config(app, &path);
    let settings = fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str::<Settings>(&s).ok())
        .unwrap_or_default();
    app.manage(Mutex::new(settings));
    app.manage(SettingsPath(path));
}

pub fn current(app: &AppHandle) -> Settings {
    app.state::<Mutex<Settings>>().lock().unwrap().clone()
}

/// 黑名单命中：bundle id 精确匹配（大小写不敏感）或进程路径 contains（兼容手动进程名/旧 .app 条目）
pub fn is_blacklisted(app: &AppHandle, proc_path: &str, bundle_id: Option<&str>) -> bool {
    let s = current(app);
    let p = proc_path.to_lowercase();
    let bid = bundle_id.map(|b| b.to_lowercase());
    s.app_blacklist.iter().any(|b| {
        let b = b.trim().to_lowercase();
        if b.is_empty() {
            return false;
        }
        if let Some(bid) = &bid {
            if *bid == b {
                return true;
            }
        }
        p.contains(&b)
    })
}

#[tauri::command]
pub fn get_settings(state: tauri::State<'_, Mutex<Settings>>) -> Settings {
    state.lock().unwrap().clone()
}

/// 更新单个设置并落盘（低频调用，如结果窗口位置记忆）
pub fn patch<F: FnOnce(&mut Settings)>(app: &AppHandle, f: F) {
    let state = app.state::<Mutex<Settings>>();
    let mut settings = state.lock().unwrap();
    f(&mut settings);
    if let Ok(json) = serde_json::to_string_pretty(&*settings) {
        let path = app.state::<SettingsPath>().0.clone();
        let _ = fs::write(&path, json);
    }
}

#[tauri::command]
pub fn save_settings(
    app: AppHandle,
    state: tauri::State<'_, Mutex<Settings>>,
    mut settings: Settings,
) -> Result<(), String> {
    // 「钉住」偏好只由结果面板的钉按钮写入（见 floating::set_ocr_pinned）：
    // 设置页持有的快照可能早于用户最后一次点钉，直接落盘会把选择冲掉
    settings.result_window_pinned = state.lock().unwrap().result_window_pinned;
    let path = app.state::<SettingsPath>().0.clone();
    let json = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())?;
    *state.lock().unwrap() = settings;
    // Dock 图标显隐即时生效（完整闭环：改 → 存 → 所有消费端联动）
    #[cfg(target_os = "macos")]
    {
        let show = app.state::<Mutex<Settings>>().lock().unwrap().show_dock_icon;
        let policy = if show {
            tauri::ActivationPolicy::Regular
        } else {
            tauri::ActivationPolicy::Accessory
        };
        let _ = app.set_activation_policy(policy);
    }
    let _ = app.emit("settings://changed", ());
    // 识图类全局快捷键即时生效（改键/清空禁用都会重新注册）
    crate::apply_ocr_shortcuts(&app);
    Ok(())
}

/// 应用外观到原生窗口层（NSAppearance，影响原生材质）并广播给所有 webview
/// （前端挂/摘 html class 切换 CSS 变量）。
/// "auto" = 撤销强制：原生跟随系统，CSS 走 prefers-color-scheme 媒体查询
pub fn apply_appearance(app: &AppHandle) {
    let theme = current(app).appearance;
    let native = match theme.as_str() {
        "light" => Some(tauri::Theme::Light),
        "dark" => Some(tauri::Theme::Dark),
        _ => None,
    };
    for (_, win) in app.webview_windows() {
        let _ = win.set_theme(native);
    }
    let _ = app.emit("theme://appearance", theme);
}

#[tauri::command]
pub fn set_appearance(app: AppHandle, theme: String) {
    if !matches!(theme.as_str(), "auto" | "light" | "dark") {
        return;
    }
    patch(&app, |s| s.appearance = theme);
    apply_appearance(&app);
}
