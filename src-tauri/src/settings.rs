//! 设置：JSON 配置（默认 DeepSeek 预设），内存 Mutex 缓存。
//! 安全注记：API Key 明文本机存储（ADR-07），M2 迁移系统钥匙串。

use serde::{Deserialize, Serialize};
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
}

impl Default for Actions {
    fn default() -> Self {
        Self {
            translate: true,
            explain: true,
            summarize: true,
            copy: true,
            search: true,
        }
    }
}

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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub providers: Vec<Provider>,
    pub default_provider_id: String,
    pub actions: Actions,
    pub action_order: Vec<String>,
    pub search_engines: Vec<SearchEngine>,
    /// 默认引擎（浮动条「搜索」单击直达），值为 SearchEngine.name
    pub default_search: String,
    /// 翻译动作的服务配置
    pub translate: TranslateConfig,
    /// 是否在 macOS Dock 显示图标（关 = 纯菜单栏常驻模式）
    pub show_dock_icon: bool,
    pub app_blacklist: Vec<String>,
    pub debounce_ms: u64,
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
            search_engines: default_engines(),
            default_search: "百度".into(),
            translate: TranslateConfig::default(),
            show_dock_icon: false,
            app_blacklist: vec![
                "Terminal".into(),
                "iTerm".into(),
                "1Password".into(),
                "Passwords".into(),
            ],
            debounce_ms: 200,
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

/// 进程路径包含黑名单关键词即命中（大小写不敏感）
pub fn is_blacklisted(app: &AppHandle, proc_path: &str) -> bool {
    let s = current(app);
    let p = proc_path.to_lowercase();
    s.app_blacklist
        .iter()
        .any(|b| !b.is_empty() && p.contains(&b.to_lowercase()))
}

#[tauri::command]
pub fn get_settings(state: tauri::State<'_, Mutex<Settings>>) -> Settings {
    state.lock().unwrap().clone()
}

#[tauri::command]
pub fn save_settings(
    app: AppHandle,
    state: tauri::State<'_, Mutex<Settings>>,
    settings: Settings,
) -> Result<(), String> {
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
    Ok(())
}
