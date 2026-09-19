//! 版本更新检测：不自建服务器，直接查 GitHub Releases API（仓库公开，无需 token）。
//!
//! 只做「发现新版本 → 轻提示 + 跳转下载页」，不做应用内自动更新：后者要求
//! minisign 签名密钥与 `latest.json` 更新清单进 CI，属于发布工程那一批（同签名）。
//!
//! 两条硬约束：
//! 1. GitHub 匿名 API 限 60 次/小时/IP，因此后台检查按 24h 节流，结果落盘复用；
//!    用户在关于页主动点「检查更新」不受节流限制（那是明确意图，且手点远触不到限额）。
//! 2. 网络失败一律静默（除关于页主动查），绝不为「检查更新」这件事弹错误——
//!    离线/被墙是常态，报错误人又无信息量。

use std::fs;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Emitter, Manager};
use serde::{Deserialize, Serialize};

const API: &str = "https://api.github.com/repos/demo007x/Magpie/releases/latest";

/// 后台自动检查的最小间隔
const INTERVAL_SECS: u64 = 24 * 3600;

/// 落盘的最近一次成功检查结果（update.json，与 settings.json 同目录）
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct CheckRecord {
    /// 成功检查的 unix 秒；0 = 从未成功检查过
    checked_at: u64,
    /// 比本机新的版本号（去掉 tag 的 v 前缀）；None = 已是最新
    #[serde(default)]
    latest: Option<String>,
    #[serde(default)]
    url: Option<String>,
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
    /// 上次成功检查的 unix 秒（cooldown 时供关于页显示「上次检查于…」）
    pub checked_at: u64,
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

/// 解析 "v0.1.5" / "0.1.10-beta.1" → [0,1,10]；解析不出来返回 None
fn parse_version(s: &str) -> Option<Vec<u64>> {
    let s = s.trim().trim_start_matches('v');
    let core = s.split(['-', '+']).next().unwrap_or(s);
    let parts: Vec<u64> = core
        .split('.')
        .map(|p| p.parse::<u64>().ok())
        .collect::<Option<_>>()?;
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
/// 永不返回 Err：失败以 status="failed" 回给前端，由界面决定怎么显示
#[tauri::command]
pub async fn check_update(app: AppHandle, force: bool) -> UpdateInfo {
    let current = app.package_info().version.to_string();
    let rec = load_record(&app);
    let cached = UpdateInfo {
        status: "upToDate".into(),
        current: current.clone(),
        latest: rec.latest.clone(),
        url: rec.url.clone(),
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

    let client = match reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(12))
        .user_agent("magpie-update-check")
        .build()
    {
        Ok(c) => c,
        Err(_) => return UpdateInfo { status: "failed".into(), ..cached },
    };
    // GitHub API 强制要求 User-Agent，缺了就 403
    let resp = match client
        .get(API)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => r,
        _ => return UpdateInfo { status: "failed".into(), ..cached },
    };
    let body = match resp.json::<serde_json::Value>().await {
        Ok(b) => b,
        Err(_) => return UpdateInfo { status: "failed".into(), ..cached },
    };
    let tag = body
        .get("tag_name")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let url = body
        .get("html_url")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let latest = parse_version(&tag).map(|_| tag.trim_start_matches('v').to_string());

    let newer = latest
        .as_deref()
        .is_some_and(|l| is_newer(l, &current));
    let rec = CheckRecord {
        checked_at: now_secs(),
        latest: newer.then_some(latest.clone()).flatten(),
        url: url.clone(),
        notified: rec.notified,
    };
    save_record(&app, &rec);
    UpdateInfo {
        status: if newer { "available" } else { "upToDate" }.to_string(),
        current,
        latest: rec.latest,
        url: rec.url,
        checked_at: rec.checked_at,
    }
}

/// 启动后台检查的收尾：只有首次见到某个新版本时才弹一次 toast。
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
        &format!("发现新版本 v{latest}，可到「设置 › 关于」下载"),
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
