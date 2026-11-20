//! 离线词典（ADR-12）：读用户本机已有的词库做零网络取词——不联网、不要
//! API Key、不随安装包分发（两本库的数据许可均为 CC BY-SA 4.0，见 ADR-12）。
//!
//! 两本库各管一个方向，互不覆盖：
//! - 英→汉：open-dictionary 的 distribution.sqlite（兼容词典应用的数据文件）
//! - 汉→英：CC-CEDICT 官方文本转换出的 cedict.sqlite（用户自己选择文件）
//!
//! `#[tauri::command]` 包装器集中在本模块：`generate_handler!(dict::xxx)` 在此路径
//! 解析宏生成项，子模块 re-export 不可靠（与 entities/mod.rs 同一教训）。
//!
//! 契约（docs/02 §3.2）：
//! - `dict_status` → `{enZh: {...}, zhEn: {...}}`，每份状态为
//!   `{state, path, entryCount, version}`；`state` =
//!   `ready`（可取词）/ `unset`（未选且自动探测不到）/ `missing`（路径上的文件不在）/
//!   `unknown`（读不动或结构不认识——**不猜结构**，整体降级为不可用）
//! - `dict_lookup(text)` → 词条数据 | `null`（null = 未收录或词库此刻不可用）；
//!   选区含汉字自动走汉→英库，否则走英→汉库，调用方不感知方向
//!
//! **渲染与文案全部在 TS 层**（Rust 只给数据，词性原文由 TS 映射成显示名），
//! 与「Rust 管不变的、TS 管多变的」一致。
//!
//! 两个命令都 `async` + `spawn_blocking`：读文件不能占主线程——Windows 上同步
//! command 跑在主线程的 IPC 派发里（见 AGENTS.md 钉图死锁那条教训），而冷盘首查
//! 可能上百毫秒；占用词库文件的也可能是词典应用自己（其日志模式非 WAL），
//! 读不到一律按未命中/不可用处理，绝不把 SQLite 错误直出给用户。

mod query;
mod store;

use std::path::PathBuf;

use serde::Serialize;
use tauri::AppHandle;

use crate::settings;

use store::DictKind;

/// 词库状态（设置页与胶囊渲染判定共用一份）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictStatus {
    /// `ready` / `unset` / `missing` / `unknown`
    pub state: &'static str,
    /// 实际生效的路径（自动探测命中时也会回填，让用户看得见「用的是哪个文件」）
    pub path: String,
    pub entry_count: i64,
    /// 库内声明的词库版本（仅展示与诊断，不参与可用性判定）
    pub version: String,
}

/// 两本词库各自体检；前端显示两行、胶囊只要任一 ready 就出现「词典」
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictStatusBundle {
    pub en_zh: DictStatus,
    pub zh_en: DictStatus,
}

fn unreadable(path: &str, version: &str) -> DictStatus {
    DictStatus { state: "unknown", path: path.to_string(), entry_count: 0, version: version.to_string() }
}

fn unset() -> DictStatus {
    DictStatus { state: "unset", path: String::new(), entry_count: 0, version: String::new() }
}

fn status_for(path: Option<PathBuf>, kind: DictKind) -> DictStatus {
    let Some(path) = path else { return unset() };
    let shown = path.to_string_lossy().into_owned();
    if !path.exists() {
        return DictStatus { state: "missing", path: shown, entry_count: 0, version: String::new() };
    }
    let label = match kind {
        DictKind::EnZh => "英汉",
        DictKind::ZhEn => "汉英",
    };
    match store::inspect(&path, kind) {
        Some(p) if p.ok => DictStatus {
            state: "ready",
            path: shown,
            entry_count: p.entry_count,
            version: p.versions.entry,
        },
        // 不可用的原因进 magpie.log（「关于 › 复制日志」的数据源）而不进界面：
        // 表名/版本串是诊断信息，用户看不懂也不该看
        Some(p) => {
            crate::user_log(&format!(
                "dict: {label}词库结构不认识 path={shown} reason={} sqliteSchema={} entrySchema={}",
                p.reason, p.versions.sqlite, p.versions.entry
            ));
            unreadable(&shown, &p.versions.entry)
        }
        // 打不开：可能被词典应用独占写、也可能权限/磁盘问题——都归入不可用
        None => {
            crate::user_log(&format!("dict: {label}词库读不到（占用或权限）path={shown}"));
            unreadable(&shown, "")
        }
    }
}

#[tauri::command]
pub async fn dict_status(app: AppHandle) -> DictStatusBundle {
    let s = settings::current(&app);
    let en = store::effective_path(&s.dict.db_path);
    let zh = store::effective_zh_path(&s.dict.zh_en_path);
    let job = tauri::async_runtime::spawn_blocking(move || DictStatusBundle {
        en_zh: status_for(en, DictKind::EnZh),
        zh_en: status_for(zh, DictKind::ZhEn),
    });
    match job.await {
        Ok(s) => s,
        Err(_) => DictStatusBundle { en_zh: unreadable("", ""), zh_en: unreadable("", "") },
    }
}

#[tauri::command]
pub async fn dict_lookup(app: AppHandle, text: String) -> Option<query::DictEntry> {
    let s = settings::current(&app);
    // 最后一道校验：动作开关关掉后即便前端漏过滤也不会真的去读库
    if !s.actions.dict {
        return None;
    }
    // 含汉字走汉→英库，其余走英→汉库；两库独立配置，缺哪本只影响那个方向
    let zh = query::contains_cjk(&text);
    let path = if zh {
        store::effective_zh_path(&s.dict.zh_en_path)
    } else {
        store::effective_path(&s.dict.db_path)
    };
    let Some(path) = path else { return None };
    let job = tauri::async_runtime::spawn_blocking(move || {
        if zh {
            store::with_cedict_conn(&path, |conn| query::lookup_zh(conn, &text))
        } else {
            store::with_conn(&path, |conn| query::lookup(conn, &text))
        }
    });
    job.await.ok().flatten()
}

#[cfg(test)]
mod tests {
    use super::store::with_conn;
    use crate::settings;

    #[test]
    fn missing_library_reads_as_miss_not_error() {
        // 路径不存在时必须安静给 None（用户侧表现为「词库没有这个词」），
        // 这条锁死「捕获失败静默」在词典读侧的落地
        let path = std::env::temp_dir().join("magpie-dict-no-such-library.sqlite");
        let _ = std::fs::remove_file(&path);
        assert!(with_conn(&path, |_| Some(())).is_none());
    }

    #[test]
    fn old_config_without_dict_fields_still_parses() {
        // 已发布机器上的 settings.json 里没有 dict / actions.dict：两层 default 属性
        // 必须让它照常解析出默认值。解析失败在 settings::init 里会
        // unwrap_or_default() 静默重置用户全部设置，是比「词典不可用」严重得多的回归
        let s: settings::Settings =
            serde_json::from_str(r#"{"actions":{"copy":false,"anki":false}}"#).unwrap();
        assert!(s.actions.dict, "词典动作默认开");
        assert!(!s.actions.copy, "旧配置里已写的值不受影响");
        assert!(s.dict.db_path.is_empty(), "未指定路径 = 走自动探测");
        assert!(s.dict.zh_en_path.is_empty(), "新增的汉英词库字段缺省为空 = 未接入");
    }
}
