//! 应用内更新（docs/04 ADR-11）：检测与下载安装走 tauri-plugin-updater，
//! 更新清单 `latest.json` 由 CI 发版时产出并挂到 Release 静态地址
//!（releases/latest/download/latest.json，不走匿名 API，无限流），
//! 更新包经 minisign 验签后替换应用并重启。
//!
//! 两条硬约束沿袭检测时代：
//! 1. 后台自动检查按 24h 节流，结果落盘复用；用户在关于页主动点「检查更新」
//!    不受节流限制（那是明确意图，且手点远触不到限额）。
//! 2. 网络失败一律静默（除关于页主动查），绝不为「检查更新」这件事弹错误——
//!    离线/被墙是常态，报错误人又无信息量。
//!
//! 安装从不静默：检测到新版本 → 事件 + toast 各提示一次 → 用户在主窗口
//! 弹窗点「立即更新」才下载（update://progress 播进度）→ 完成即重启替换。
//! 通用页「自动检查更新」开关只关后台检查，手动检查与安装不受影响。

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Updater, UpdaterExt};

/// Release 页地址：作为 UpdateInfo.url 回给前端（「查看更新内容」入口）
const RELEASES_URL: &str = "https://github.com/demo007x/Magpie/releases/latest";

/// 后台自动检查的最小间隔（网络检查频率，update.json 落盘约束）
const INTERVAL_SECS: u64 = 24 * 3600;

/// 巡检线程的 tick 间隔：廉价轮询（无网络请求，仅比对节流时间戳），
/// 保证后台常驻不关的应用也能当天发现新版本，而不是只在启动时查一次
pub(crate) const CHECK_TICK_SECS: u64 = 3600;

/// 已检测待安装的更新对象：check_update 存入，update_install 取用。
/// Update 非 Send 生命的顾虑不存在（reqwest 句柄可跨 await），Clone 存取即可
pub struct PendingUpdate(pub Mutex<Option<tauri_plugin_updater::Update>>);

/// 落盘的最近一次成功检查结果（update.json，与 settings.json 同目录）
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct CheckRecord {
    /// 成功检查的 unix 秒；0 = 从未成功检查过
    checked_at: u64,
    /// 比本机新的版本号；None = 已是最新
    #[serde(default)]
    latest: Option<String>,
    #[serde(default)]
    url: Option<String>,
    /// 该版本的更新说明（清单 notes，来自发版 Release body）；节流回放时一并复用
    #[serde(default)]
    notes: Option<String>,
    /// 已经用 toast 提示过的版本：同一版本只打扰一次，用户无视后不再重复弹
    #[serde(default)]
    notified: Option<String>,
}

/// 返回给前端的检测结果（关于页与事件广播共用）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    /// available | upToDate | cooldown | failed
    pub status: String,
    pub current: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// 更新说明 markdown（清单 notes，弹窗内嵌展示，用户不必跳发布页）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    /// 上次成功检查的 unix 秒（cooldown 时供关于页显示「上次检查于…」）
    pub checked_at: u64,
}

/// update://progress 事件载荷（主窗口更新弹窗播下载进度）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressInfo {
    pub transferred: usize,
    pub total: Option<u64>,
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn state_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join("update.json"))
}

fn load_record(app: &AppHandle) -> CheckRecord {
    state_path(app)
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_record(app: &AppHandle, rec: &CheckRecord) {
    if let Some(p) = state_path(app) {
        if let Ok(json) = serde_json::to_string_pretty(rec) {
            let _ = fs::write(p, json);
        }
    }
}

/// 构建本进程的 Updater：release 按配置清单；dev 可用 MAGPIE_UPDATE_ENDPOINT
/// 指向本地假清单服务做端到端联调（MAGPIE_UPDATE_ENDPOINT 仅 debug 构建生效）
fn updater_for(app: &AppHandle) -> Result<Updater, String> {
    #[cfg(debug_assertions)]
    if let Ok(raw) = std::env::var("MAGPIE_UPDATE_ENDPOINT") {
        let url = raw
            .parse()
            .map_err(|_| format!("bad MAGPIE_UPDATE_ENDPOINT: {raw}"))?;
        // 本地假清单服务走回环地址，禁代理直连（系统代理会截胡 127.0.0.1，
        // 与 AnkiConnect 回环请求的既有处理同理）；真实 endpoint 保持系统代理
        return app
            .updater_builder()
            .endpoints(vec![url])
            .map_err(|e| e.to_string())?
            .no_proxy()
            .build()
            .map_err(|e| e.to_string());
    }
    #[cfg(not(debug_assertions))]
    let _ = app;
    app.updater().map_err(|e| e.to_string())
}

/// 解析 "v0.1.5" / "0.1.10-beta.1" → [0,1,10]；解析不出来返回 None
fn parse_version(s: &str) -> Option<Vec<u64>> {
    let s = s.trim().trim_start_matches('v');
    let core = s.split(['-', '+']).next().unwrap_or(s);
    let parts: Vec<u64> = core
        .split('.')
        .map(|p| p.parse::<u64>().ok())
        .collect::<Option<Vec<_>>>()?;
    (!parts.is_empty()).then_some(parts)
}

/// latest 是否比 current 新。任一边解析失败都当作「不更新」——
/// 宁可不提醒，也不要因为版本号格式变化弹出假提示
fn is_newer(latest: &str, current: &str) -> bool {
    let (Some(a), Some(b)) = (parse_version(latest), parse_version(current)) else {
        return false;
    };
    for i in 0..a.len().max(b.len()) {
        let (x, y) = (a.get(i).copied().unwrap_or(0), b.get(i).copied().unwrap_or(0));
        if x != y {
            return x > y;
        }
    }
    false
}

/// 检查是否有新版本。`force=false` 时先吃 24h 节流与缓存结果。
/// 永不返回 Err：失败以 status="failed" 回给前端，由界面决定怎么显示。
/// 查到的新版本对象存入 PendingUpdate，供 update_install 直接下载安装
#[tauri::command]
pub async fn check_update(app: AppHandle, force: bool) -> UpdateInfo {
    let current = app.package_info().version.to_string();
    let rec = load_record(&app);
    let cached = UpdateInfo {
        status: "upToDate".into(),
        current: current.clone(),
        latest: rec.latest.clone(),
        url: rec.url.clone(),
        notes: rec.notes.clone(),
        checked_at: rec.checked_at,
    };
    if !force && rec.checked_at > 0 && now_secs().saturating_sub(rec.checked_at) < INTERVAL_SECS {
        // 缓存的「有新版本」要重新对一遍当前版本：用户可能已经在这 24h 里升级过，
        // 直接回放缓存会一直提示一个已经装上的版本
        let still_new = rec
            .latest
            .as_deref()
            .is_some_and(|l| is_newer(l, &current));
        return UpdateInfo {
            status: if still_new {
                "available".to_string()
            } else {
                "cooldown".to_string()
            },
            latest: still_new.then_some(rec.latest).flatten(),
            url: still_new.then_some(rec.url).flatten(),
            ..cached
        };
    }

    // 清单检测（minisign 验签在下载后才真正校验安装包，此处只取清单头）
    let update = match updater_for(&app) {
        Ok(u) => match u.check().await {
            Ok(u) => u,
            Err(e) => {
                crate::user_log(&format!("update check failed: {e}"));
                return UpdateInfo { status: "failed".into(), ..cached };
            }
        },
        Err(e) => {
            crate::user_log(&format!("update builder failed: {e}"));
            return UpdateInfo { status: "failed".into(), ..cached };
        }
    };
    // 插件按 semver 比对过新旧，这里再用自家 is_newer 复核一遍：
    // 双保险挡住清单版本号异常（如 9.9.9-canary）触发的假提示
    let update = update.filter(|u| is_newer(&u.version, &current));
    let Some(update) = update else {
        let rec = CheckRecord {
            checked_at: now_secs(),
            latest: None,
            url: None,
            notes: None,
            notified: rec.notified,
        };
        save_record(&app, &rec);
        return UpdateInfo {
            status: "upToDate".into(),
            current,
            latest: None,
            url: None,
            notes: None,
            checked_at: rec.checked_at,
        };
    };

    let latest = update.version.clone();
    let notes = update.body.clone();
    if let Some(state) = app.try_state::<PendingUpdate>() {
        *state.0.lock().unwrap() = Some(update);
    }
    let rec = CheckRecord {
        checked_at: now_secs(),
        latest: Some(latest),
        url: Some(RELEASES_URL.into()),
        notes: notes.clone(),
        notified: rec.notified,
    };
    save_record(&app, &rec);
    UpdateInfo {
        status: "available".into(),
        current,
        latest: rec.latest,
        url: rec.url,
        notes,
        checked_at: rec.checked_at,
    }
}

/// 下载并安装已检测到的更新，完成后重启应用（本命令从此不返回）。
/// 下载进度经 update://progress 播给主窗口；失败以 Err 回给前端 toast。
/// PendingUpdate 为空（如重启后直接点安装）则先重新检测一次
#[tauri::command]
pub async fn update_install(app: AppHandle) -> Result<(), String> {
    let current = app.package_info().version.to_string();
    let pending: Option<tauri_plugin_updater::Update> =
        app.try_state::<PendingUpdate>().and_then(|s| {
            let mut g = s.0.lock().ok()?;
            g.take()
        });
    let update = match pending {
        Some(u) => u,
        None => updater_for(&app)?
            .check()
            .await
            .map_err(|e| e.to_string())?
            .filter(|u| is_newer(&u.version, &current))
            .ok_or("no pending update")?,
    };
    let emitter = app.clone();
    // on_chunk 给的是单块大小，累计后再播进度
    let mut transferred: usize = 0;
    update
        .download_and_install(
            move |chunk, total| {
                transferred = transferred.saturating_add(chunk);
                let _ = emitter.emit_to(
                    "main",
                    "update://progress",
                    ProgressInfo { transferred, total },
                );
            },
            || {},
        )
        .await
        .map_err(|e| {
            crate::user_log(&format!("update install failed: {e}"));
            e.to_string()
        })?;
    // 安装完成即重启替换：macOS 重建 .app 后重拉进程，Windows 走 NSIS passive
    app.restart();
}

/// dev 联调专用（仅 debug 构建）：`MAGPIE_UPDATE_AUTOINSTALL=1` 时检测到新版
/// 直接走完整安装链（验签下载 → 替换 → 重启），供本地端到端验证更新管线，
/// 免去手工点弹窗。release 构建无此分支，用户安装路径仍只经弹窗确认。
/// 注意：e2e 会把假版本写入共享的 update.json（与正式安装同目录），测完须删除，
/// 否则正式应用会在 24h 节流内回放出无法安装的幻影更新（正式 endpoint 没有该版本）
#[cfg(debug_assertions)]
pub fn dev_autoinstall_if_enabled(app: &AppHandle, info: &UpdateInfo) {
    if info.status != "available" || std::env::var("MAGPIE_UPDATE_AUTOINSTALL").as_deref() != Ok("1")
    {
        return;
    }
    if let Err(e) = tauri::async_runtime::block_on(update_install(app.clone())) {
        crate::user_log(&format!("dev autoinstall failed: {e}"));
    }
}

/// 启动后台检查的收尾：只有首次见到某个新版本时才弹一次 toast + 事件。
/// 静默条件：不是 available、或该版本已经提示过
pub fn announce(app: &AppHandle, info: &UpdateInfo) {
    if info.status != "available" {
        return;
    }
    let Some(latest) = info.latest.as_deref() else {
        return;
    };
    let mut rec = load_record(app);
    if rec.notified.as_deref() == Some(latest) {
        return;
    }
    rec.notified = Some(latest.to_string());
    save_record(app, &rec);
    let _ = app.emit("update://available", info.clone());
    crate::toast::show_toast(
        app,
        &format!(
            "{}v{latest}{}",
            crate::i18n::t("toast.updateAvailable"),
            crate::i18n::t("toast.updateAvailableHint")
        ),
        "info",
    );
}

#[cfg(test)]
mod tests {
    use super::{is_newer, parse_version};

    #[test]
    fn parses_v_prefix_and_prerelease_suffix() {
        assert_eq!(parse_version("v0.1.5").unwrap(), vec![0, 1, 5]);
        assert_eq!(parse_version("0.2.0-beta.1").unwrap(), vec![0, 2, 0]);
        assert!(parse_version("nightly").is_none());
    }

    #[test]
    fn compares_numeric_not_lexicographic() {
        // 字符串比较会把 0.1.10 判成比 0.1.5 旧、0.10.0 判成比 0.2.0 旧
        assert!(is_newer("0.1.10", "0.1.5"));
        assert!(is_newer("v0.10.0", "0.2.0"));
        assert!(!is_newer("0.1.5", "0.1.5"));
        assert!(!is_newer("0.1.4", "0.1.5"));
        // 解析失败一律当作「不更新」：宁可不提醒也不误报
        assert!(!is_newer("latest", "0.1.5"));
    }
}
