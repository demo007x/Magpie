//! 词库文件访问（ADR-12）：只读打开用户本机已有的兼容词库，连接按
//! 「路径 + 修改时间」缓存——词典应用更新词库后自动重开。
//!
//! 硬性约定（这份库是**另一个应用的运行数据**，不是我们的资产）：
//! - 一律只读打开 + `busy_timeout`：它的日志模式不是 WAL，对方写库的窗口内我们
//!   可能读不到，那种情况一律按「未命中」处理，绝不把 SQLite 错误抛给用户；
//! - **绝不写这个文件**：不建索引、不 VACUUM、不开 mmap（864MB 级文件的地址空间
//!   占用对这个常驻工具不划算），依赖 OS page cache 就够——实测常驻连接热查询
//!   是几十微秒量级，无需预热；
//! - 结构探针而非版本串匹配：版本字符串只作展示与诊断，真正决定可用性的是
//!   「我们依赖的表在不在」。上游 bump 版本号而表结构没变时不该把用户挡在外面。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime};

use rusqlite::{Connection, OpenFlags};

/// 读不到时的等待上限：对方写库通常是秒级，等一轮比直接判失败更不打扰用户
const BUSY_TIMEOUT: Duration = Duration::from_millis(800);

/// 两本词库结构完全不同，连接缓存必须分开：同路径换探针 = 静默取不到词
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum DictKind {
    /// open-dictionary 的开放式词库（英文词头 → 中文释义）
    EnZh,
    /// CC-CEDICT 转换而来的词库（中文词头 → 英文释义）
    ZhEn,
}

/// 取词与状态探测依赖的表（缺任何一张就不认识这份库 → 降级为不可用）
const REQUIRED_TABLES: [&str; 5] = [
    "entries",
    "meanings",
    "meaning_examples",
    "pos_groups",
    "pos_group_pronunciations",
];

/// 库内 `metadata` 表的版本标记（展示用，不参与可用性判定）
#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Versions {
    /// `sqlite_schema_version`，如 `distribution_sqlite_v1`（表布局）
    pub sqlite: String,
    /// `distribution_schema_version`，如 `distribution_entry_v5`（词条内容形状）
    pub entry: String,
}

/// CC-CEDICT 转换库的元数据（纯文本，读取失败按空串处理）
fn cedict_meta_str(conn: &Connection, key: &str) -> String {
    conn.query_row("select value from cedict_meta where key = ?1", [key], |r| r.get::<_, String>(0))
        .unwrap_or_default()
}

/// 词库体检结果：`ok` = 结构可用（可取词）
#[derive(Debug, Clone)]
pub struct Probe {
    pub ok: bool,
    pub entry_count: i64,
    pub versions: Versions,
    /// 不可用时的人读原因（进日志与设置页诊断，不作为界面文案）
    pub reason: String,
}

fn open_read_only(path: &Path) -> Result<Connection, String> {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| e.to_string())?;
    // 失败（库被独占等）不致命：后面每次查询都会因读不到而降级
    let _ = conn.busy_timeout(BUSY_TIMEOUT);
    Ok(conn)
}

/// metadata 的值是 JSON 字面量（`"distribution_sqlite_v1"` 带引号），取字符串内容
fn meta_str(conn: &Connection, key: &str) -> String {
    conn.query_row(
        "select value_json from metadata where key = ?1",
        [key],
        |r| r.get::<_, String>(0),
    )
    .ok()
    .and_then(|raw| serde_json::from_str::<String>(&raw).ok())
    .unwrap_or_default()
}

pub fn probe(conn: &Connection) -> Probe {
    for table in REQUIRED_TABLES {
        let exists: i64 = conn
            .query_row(
                "select count(*) from sqlite_master where type = 'table' and name = ?1",
                [table],
                |r| r.get(0),
            )
            .unwrap_or(0);
        if exists == 0 {
            return Probe {
                ok: false,
                entry_count: 0,
                versions: Versions::default(),
                reason: format!("缺少表 {table}"),
            };
        }
    }
    let entry_count = conn
        .query_row("select count(*) from entries", [], |r| r.get(0))
        .unwrap_or(0);
    let versions = Versions {
        sqlite: meta_str(conn, "sqlite_schema_version"),
        entry: meta_str(conn, "distribution_schema_version"),
    };
    if entry_count == 0 {
        // 表齐但一条词都没有：多半是下载中断的半成品库，当可用只会让用户对着
        // 「什么也查不到」发呆，不如直接判不可用
        return Probe {
            ok: false,
            entry_count: 0,
            versions,
            reason: "词条表为空（词库可能未下载完整）".into(),
        };
    }
    Probe { ok: true, entry_count, versions, reason: String::new() }
}

/// CC-CEDICT 转换库的结构探针：不认版本串，只认我们依赖的表与列都在、且有词条。
/// `cedict_meta` 用来展示来源版本，缺了也不影响查询。
pub fn probe_cedict(conn: &Connection) -> Probe {
    let exists: i64 = conn
        .query_row(
            "select count(*) from sqlite_master where type = 'table' and name = 'cedict'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    if exists == 0 {
        return Probe {
            ok: false,
            entry_count: 0,
            versions: Versions::default(),
            reason: "缺少表 cedict".into(),
        };
    }
    let entry_count = conn.query_row("select count(*) from cedict", [], |r| r.get(0)).unwrap_or(0);
    let version = cedict_meta_str(conn, "sourceRelease");
    if entry_count == 0 {
        return Probe {
            ok: false,
            entry_count: 0,
            versions: Versions { sqlite: "cedict_sqlite_v1".into(), entry: version },
            reason: "词条表为空（词库可能未转换完整）".into(),
        };
    }
    // 列探针：文件存在但来自别的可执行文件（同名 cedict 表、列不同）也不能当可用
    let readable = conn.query_row(
        "select simplified, traditional, pinyin, definitions from cedict limit 1",
        [],
        |r| {
            let _: String = r.get(0)?;
            let _: String = r.get(1)?;
            let _: String = r.get(2)?;
            let _: String = r.get(3)?;
            Ok(())
        },
    );
    if let Err(e) = readable {
        return Probe {
            ok: false,
            entry_count: 0,
            versions: Versions::default(),
            reason: format!("cedict 列结构不符：{e}"),
        };
    }
    Probe {
        ok: true,
        entry_count,
        versions: Versions { sqlite: "cedict_sqlite_v1".into(), entry: version },
        reason: String::new(),
    }
}

/// 按词库种类分派探针，避免查询侧把两本库混用。
pub fn probe_by_kind(conn: &Connection, kind: DictKind) -> Probe {
    match kind {
        DictKind::EnZh => probe(conn),
        DictKind::ZhEn => probe_cedict(conn),
    }
}

/// 默认词库位置：兼容词典应用（Aictionary）自己的数据目录。
/// 平台差异只在"应用支持目录在哪"，文件名一致。
pub fn auto_detected_path() -> Option<PathBuf> {
    const REL: &str = "com.ahpx.aictionary-re/dictionary/distribution.sqlite";
    #[cfg(windows)]
    let root = std::env::var_os("APPDATA").map(PathBuf::from);
    #[cfg(target_os = "macos")]
    let root = std::env::var_os("HOME")
        .map(|h| PathBuf::from(h).join("Library").join("Application Support"));
    #[cfg(not(any(windows, target_os = "macos")))]
    let root = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")));
    root.map(|r| r.join(REL.replace('/', std::path::MAIN_SEPARATOR_STR).as_str()))
}

/// 设置页存的 `db_path` 为空时用它兜底；返回最终生效路径（可能不存在）
pub fn effective_path(configured: &str) -> Option<PathBuf> {
    let p = configured.trim();
    if !p.is_empty() {
        return Some(PathBuf::from(p));
    }
    auto_detected_path().filter(|c| c.exists())
}

/// 汉→英库没有"通用默认位置"：本机路径完全由用户选择，空 = 未接入
pub fn effective_zh_path(configured: &str) -> Option<PathBuf> {
    let p = configured.trim();
    (!p.is_empty()).then(|| PathBuf::from(p))
}

struct Cached {
    mtime: Option<SystemTime>,
    conn: Connection,
}

type CacheKey = (DictKind, PathBuf);

static POOL: OnceLock<Mutex<HashMap<CacheKey, Cached>>> = OnceLock::new();

fn pool() -> &'static Mutex<HashMap<CacheKey, Cached>> {
    POOL.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 取一个可用连接跑 `f`；打不开/结构不认识 → `None`（调用方按未命中处理）。
/// 全程持锁：单机单用户的查词量下，串行化换来的简单更值。
/// 缓存键含词库种类：同一路径换探针等于静默查不到词，必须分开。
pub fn with_conn_kind<T>(
    path: &Path,
    kind: DictKind,
    f: impl FnOnce(&Connection) -> Option<T>,
) -> Option<T> {
    let mtime = std::fs::metadata(path).and_then(|m| m.modified()).ok();
    let key: CacheKey = (kind, path.to_path_buf());
    let mut guard = pool().lock().unwrap_or_else(|e| e.into_inner());
    let reusable = guard.get(&key).is_some_and(|c| c.mtime == mtime);
    if !reusable {
        let conn = open_read_only(path).ok()?;
        if !probe_by_kind(&conn, kind).ok {
            return None;
        }
        guard.insert(key.clone(), Cached { mtime, conn });
    }
    guard.get(&key).and_then(|c| f(&c.conn))
}

/// 英→汉库取连接（保留原名，既有调用点与测试不用改）
pub fn with_conn<T>(path: &Path, f: impl FnOnce(&Connection) -> Option<T>) -> Option<T> {
    with_conn_kind(path, DictKind::EnZh, f)
}

/// 汉→英库取连接
pub fn with_cedict_conn<T>(path: &Path, f: impl FnOnce(&Connection) -> Option<T>) -> Option<T> {
    with_conn_kind(path, DictKind::ZhEn, f)
}

/// 状态探测单独走一次性连接：只读 count，不污染查询连接池
pub fn inspect(path: &Path, kind: DictKind) -> Option<Probe> {
    let conn = open_read_only(path).ok()?;
    Some(probe_by_kind(&conn, kind))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    #[test]
    fn probe_rejects_library_missing_tables() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("create table entries (entry_id text);").unwrap();
        let p = probe(&conn);
        assert!(!p.ok, "只有 entries 一张表时必须判为不认识");
        assert!(p.reason.contains("meanings"), "原因要指到缺的那张表：{}", p.reason);
    }

    #[test]
    fn probe_needs_entries_and_strips_json_quotes() {
        let conn = fixture();
        conn.execute(
            "insert into metadata values ('sqlite_schema_version', '\"distribution_sqlite_v1\"')",
            [],
        )
        .unwrap();
        // 表齐但零词条 = 半成品下载，判不可用（给得出原因）
        let empty = probe(&conn);
        assert!(!empty.ok, "空词条表不能当可用词库");
        assert!(empty.reason.contains("为空"), "原因要能进日志指到问题：{}", empty.reason);
        assert_eq!(empty.versions.sqlite, "distribution_sqlite_v1", "metadata 的 JSON 引号要剥掉");

        insert_entry(&conn, "en", "perceive", "perceive", None);
        let p = probe(&conn);
        assert!(p.ok, "有词条即可用");
        assert_eq!(p.entry_count, 1);
    }

    #[test]
    fn probe_cedict_accepts_valid_library_and_rejects_empty() {
        let conn = cedict_fixture();
        let empty = probe_cedict(&conn);
        assert!(!empty.ok, "空表不能算可用");
        assert!(empty.reason.contains("为空"), "原因要能进日志：{}", empty.reason);

        insert_cedict(&conn, "你好", "你好", "ni3 hao3", "hello; hi");
        let p = probe_cedict(&conn);
        assert!(p.ok, "有词条即可用");
        assert_eq!(p.entry_count, 1);
        assert_eq!(p.versions.entry, "2026-11-20 06:49:19 GMT", "来源版本只作展示");
    }

    #[test]
    fn probes_are_kind_specific() {
        let en = fixture();
        assert!(!probe_cedict(&en).ok, "英文库不能被当成汉英库");
        let zh = cedict_fixture();
        assert!(!probe(&zh).ok, "汉英库不能被当成英文库");
    }

    /// 与 CC-CEDICT 转换库同构的最小夹具
    pub(crate) fn cedict_fixture() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "create table cedict_meta (key text primary key, value text not null);
             insert into cedict_meta values ('sourceRelease', '2026-11-20 06:49:19 GMT');
             create table cedict (
               id integer primary key, traditional text not null, simplified text not null,
               pinyin text not null, definitions text not null);
             create index cedict_simplified_idx on cedict (simplified);
             create index cedict_traditional_idx on cedict (traditional);",
        )
        .unwrap();
        conn
    }

    pub(crate) fn insert_cedict(
        conn: &Connection,
        traditional: &str,
        simplified: &str,
        pinyin: &str,
        definitions: &str,
    ) {
        conn.execute(
            "insert into cedict (traditional, simplified, pinyin, definitions)
             values (?1, ?2, ?3, ?4)",
            rusqlite::params![traditional, simplified, pinyin, definitions],
        )
        .unwrap();
    }

    /// 与真实词库同构的最小夹具（只建我们依赖的列）
    pub(crate) fn fixture() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "create table metadata (key text primary key, value_json text not null);
             create table entries (
               entry_id text primary key, schema_version text not null default '',
               headword text not null, normalized_headword text not null,
               headword_language_code text not null, headword_language_name text not null default '',
               definition_language_code text not null default '', definition_language_name text not null default '',
               entry_type text not null default 'standard', headword_summary text not null default '',
               memory_hook text not null default '', etymology_note text,
               study_notes_json text not null default '{}', document_json text not null default '{}');
             create index entries_lookup_idx on entries (headword_language_code, normalized_headword);
             create table pos_groups (
               entry_id text not null, pos_group_index integer not null, pos text not null,
               etymology_id text, proper_name integer not null default 0, summary text not null default '',
               usage_note text, primary key (entry_id, pos_group_index));
             create table meanings (
               entry_id text not null, pos_group_index integer not null, sense_id text not null,
               meaning_index integer not null, priority text not null default 'core',
               short_gloss text, learner_explanation text not null, usage_note text,
               labels_json text not null default '[]', topics_json text not null default '[]',
               primary key (entry_id, pos_group_index, sense_id));
             create table meaning_examples (
               entry_id text not null, pos_group_index integer not null, sense_id text not null,
               example_index integer not null, text text not null, translation text not null,
               primary key (entry_id, pos_group_index, sense_id, example_index));
             create table pos_group_pronunciations (
               entry_id text not null, pos_group_index integer not null, pronunciation_index integer not null,
               ipa text, text text, tags_json text not null default '[]',
               primary key (entry_id, pos_group_index, pronunciation_index));",
        )
        .unwrap();
        conn
    }

    pub(crate) fn insert_entry(
        conn: &Connection,
        lang: &str,
        headword: &str,
        normalized: &str,
        etymology: Option<&str>,
    ) {
        conn.execute(
            "insert into entries (entry_id, headword, normalized_headword, headword_language_code, memory_hook, etymology_note)
             values (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![
                format!("id-{normalized}"),
                headword,
                normalized,
                lang,
                "",
                etymology
            ],
        )
        .unwrap();
    }
}
