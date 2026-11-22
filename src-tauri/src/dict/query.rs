//! 取词查询（ADR-12 的读侧）：把选中文本映射成一条词条数据，渲染在 TS 层。
//!
//! 两条硬性约定，改动前必读：
//! 1. **每条查词条目的 SQL 都必须带 `headword_language_code` 谓词**——主索引是
//!    `(headword_language_code, normalized_headword)` 复合索引，漏掉语言码即退化为
//!    全表扫描（同一台机器实测：带谓词单次 32µs，漏掉 222ms，三个数量级）。
//! 2. **永不读 `entries.document_json`**——它是下列规范化子表的冗余全量转储
//!    （单条最大 35KB），读它既慢又白占内存。
//!
//! 变形词（perceived / perceiving / running / better）在库里各自独立成条，
//! 所以这里不做词形还原——还原反而会绕过库里已有的那条现成释义。

use rusqlite::{params, Connection};
use serde::Serialize;

/// 该词库只收英文词条（实测 84212 条的 headword_language_code 全为 en）
const HEADWORD_LANG: &str = "en";
/// 义项/例句/音标上限：run、book 这类多义词有上百义项，面板放不下也不该白读
const SENSE_CAP: i64 = 4;
const EXAMPLE_CAP: i64 = 1;
const IPA_CAP: usize = 3;
/// 词头长度上限：库内最长的是谚语条目（约 80 字符），再长的选区不可能是词条
const HEADWORD_MAX_CHARS: usize = 160;
/// 汉→英库同词头不同读音可能有多条（行/重/长），前几条就够结果窗展示
const ZH_SENSE_CAP: i64 = 8;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictExample {
    pub text: String,
    pub translation: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictSense {
    /// 词性原文（`verb` / `noun` …）——显示名属文案，由 TS 映射（随界面语言）
    pub pos: String,
    /// 简明释义（`察觉；感知到`），库里可空，空串 = 无
    pub gloss: String,
    /// 学习者向解释（本库的主菜）
    pub explanation: String,
    /// 用法辨析（含「不要和 receive 混淆」这类），空串 = 无
    pub usage_note: String,
    pub examples: Vec<DictExample>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictEntry {
    pub headword: String,
    /// 音标（IPA），按词性组顺序去重后取前几条；汉→英库为空
    pub ipa: Vec<String>,
    /// 拼音（汉→英库）；英→汉库为空。TS 渲染时不用 `/…/` 包它
    pub reading: String,
    pub senses: Vec<DictSense>,
    /// 记忆锚点（一句话帮用户记住这个词），空串 = 无
    pub memory_hook: String,
    /// 词源说明（中文），空串 = 无
    pub etymology: String,
}

/// 选中文本 → 库里 `normalized_headword` 的取值：压空白、切首尾非字词字符、转小写。
/// 返回 None = 这段文本不可能是词条（空白/超长），连查询都省了
pub fn normalize(raw: &str) -> Option<String> {
    let collapsed = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    // 首尾的引号/括号/句号（中英标点都算）不算词的一部分；词内部的连字符要留
    let trimmed = collapsed.trim_matches(|c: char| !c.is_alphanumeric());
    if trimmed.is_empty() || trimmed.chars().count() > HEADWORD_MAX_CHARS {
        return None;
    }
    Some(trimmed.to_lowercase())
}

/// 选区是否含汉字：用来在两本词库之间路由，而不是让一本库假装支持双向。
/// 覆盖基本区、扩展 A 与兼容表意文字；日文假名/韩文按英文路径走（未收录即未命中）。
pub fn contains_cjk(raw: &str) -> bool {
    raw.chars().any(|c| {
        matches!(c, '\u{3400}'..='\u{9FFF}' | '\u{F900}'..='\u{FAFF}' | '\u{20000}'..='\u{2FFFF}')
    })
}

/// 汉→英词头的取值：不做小写化（阿 Q 这类混合词头大小写有语义），其余同 normalize。
fn normalize_cjk(raw: &str) -> Option<String> {
    let collapsed = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed = collapsed.trim_matches(|c: char| !c.is_alphanumeric());
    if trimmed.is_empty() || trimmed.chars().count() > HEADWORD_MAX_CHARS {
        return None;
    }
    Some(trimmed.to_string())
}

/// 汉→英查词：CC-CEDICT 同名不同音会占多行，全部并成一条词条；拼音放 reading，
/// 每行定义并成一条 sense（词库本身没有词性/例句维度，不伪造）。
pub fn lookup_zh(conn: &Connection, raw: &str) -> Option<DictEntry> {
    let key = normalize_cjk(raw)?;
    let mut st = conn
        .prepare(
            "select traditional, simplified, pinyin, definitions
               from cedict
              where simplified = ?1 or traditional = ?1
              order by id
              limit ?2",
        )
        .ok()?;
    let rows = st
        .query_map(params![key, ZH_SENSE_CAP], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
            ))
        })
        .ok()?
        .flatten()
        .collect::<Vec<_>>();
    if rows.is_empty() {
        return None;
    }
    let headword = rows[0].1.clone();
    let reading = rows
        .iter()
        .map(|r| r.2.clone())
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join(" · ");
    let senses = rows
        .into_iter()
        .map(|(_, _, _, definitions)| DictSense {
            pos: String::new(),
            gloss: definitions,
            explanation: String::new(),
            usage_note: String::new(),
            examples: Vec::new(),
        })
        .collect();
    Some(DictEntry {
        headword,
        ipa: Vec::new(),
        reading,
        senses,
        memory_hook: String::new(),
        etymology: String::new(),
    })
}

pub fn lookup(conn: &Connection, raw: &str) -> Option<DictEntry> {
    let key = normalize(raw)?;
    let (entry_id, headword, memory_hook, etymology) = conn
        .query_row(
            "select entry_id, headword, memory_hook, etymology_note
               from entries
              where headword_language_code = ?1 and normalized_headword = ?2",
            params![HEADWORD_LANG, key],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, Option<String>>(3)?.unwrap_or_default(),
                ))
            },
        )
        .ok()?;

    let senses = fetch_senses(conn, &entry_id);
    // 有条目却取不到义项 = 这条数据不可用（上游确实存在「无释义被跳过」的残留条目），
    // 按未命中处理，让用户看到「词库没有」而不是一个空面板
    if senses.is_empty() {
        return None;
    }
    Some(DictEntry {
        headword,
        ipa: fetch_ipa(conn, &entry_id),
        reading: String::new(),
        senses,
        memory_hook,
        etymology,
    })
}

fn fetch_senses(conn: &Connection, entry_id: &str) -> Vec<DictSense> {
    // 先收齐再逐条取例句：一次 prepare 反复 query_map 会因语句未 reset 而互相打架
    let mut pending: Vec<(i64, String, DictSense)> = Vec::new();
    if let Ok(mut st) = conn.prepare(
        "select g.pos_group_index, m.sense_id, g.pos, m.short_gloss,
                m.learner_explanation, m.usage_note
           from meanings m
           join pos_groups g on g.entry_id = m.entry_id
                            and g.pos_group_index = m.pos_group_index
          where m.entry_id = ?1
          order by m.pos_group_index, m.meaning_index
          limit ?2",
    ) {
        if let Ok(it) = st.query_map(params![entry_id, SENSE_CAP], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                DictSense {
                    pos: r.get::<_, String>(2)?,
                    gloss: r.get::<_, Option<String>>(3)?.unwrap_or_default(),
                    explanation: r.get::<_, String>(4)?,
                    usage_note: r.get::<_, Option<String>>(5)?.unwrap_or_default(),
                    examples: Vec::new(),
                },
            ))
        }) {
            pending = it.flatten().collect();
        }
    }
    let mut out = Vec::with_capacity(pending.len());
    for (pos_group_index, sense_id, mut sense) in pending.drain(..) {
        sense.examples = fetch_examples(conn, entry_id, pos_group_index, &sense_id);
        out.push(sense);
    }
    out
}

/// 该义项的例句：库里每义项可能挂多条，面板只放第一条（够用且总量可控）
fn fetch_examples(
    conn: &Connection,
    entry_id: &str,
    pos_group_index: i64,
    sense_id: &str,
) -> Vec<DictExample> {
    let mut out = Vec::new();
    if let Ok(mut st) = conn.prepare(
        "select text, translation from meaning_examples
          where entry_id = ?1 and pos_group_index = ?2 and sense_id = ?3
          order by example_index limit ?4",
    ) {
        if let Ok(it) = st.query_map(params![entry_id, pos_group_index, sense_id, EXAMPLE_CAP], |r| {
            Ok(DictExample { text: r.get(0)?, translation: r.get(1)? })
        }) {
            out = it.flatten().collect();
        }
    }
    out
}

fn fetch_ipa(conn: &Connection, entry_id: &str) -> Vec<String> {
    let mut seen: Vec<String> = Vec::new();
    if let Ok(mut st) = conn.prepare(
        "select ipa from pos_group_pronunciations
          where entry_id = ?1 and ipa is not null and ipa <> ''
          order by pos_group_index, pronunciation_index",
    ) {
        if let Ok(it) = st.query_map(params![entry_id], |r| r.get::<_, String>(0)) {
            for v in it.flatten() {
                if !seen.iter().any(|s| *s == v) {
                    seen.push(v);
                }
                if seen.len() >= IPA_CAP {
                    break;
                }
            }
        }
    }
    seen
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dict::store::tests::{cedict_fixture, fixture, insert_cedict, insert_entry};

    fn add_sense(
        conn: &Connection,
        entry_id: &str,
        pg: i64,
        mi: i64,
        pos: &str,
        sense_id: &str,
        gloss: &str,
    ) {
        conn.execute(
            "insert into pos_groups (entry_id, pos_group_index, pos) values (?1, ?2, ?3)",
            params![entry_id, pg, pos],
        )
        .unwrap();
        conn.execute(
            "insert into meanings (entry_id, pos_group_index, sense_id, meaning_index,
                                    short_gloss, learner_explanation)
             values (?1, ?2, ?3, ?4, ?5, ?6)",
            params![entry_id, pg, sense_id, mi, gloss, format!("{gloss} 的学习者向解释")],
        )
        .unwrap();
    }

    #[test]
    fn normalize_handles_punctuation_and_case() {
        assert_eq!(normalize("  Perceive. "), Some("perceive".into()));
        assert_eq!(normalize("“word”"), Some("word".into()));
        assert_eq!(normalize("（well-known）,"), Some("well-known".into()), "词内连字符要留");
        assert_eq!(normalize("by and by"), Some("by and by".into()), "词组内部空格保留");
        assert_eq!(normalize("   "), None, "空白不该发起查询");
        assert_eq!(normalize(&"x".repeat(200)), None, "超长选区不可能是词条");
    }

    #[test]
    fn cjk_routing_recognizes_han_but_not_latin() {
        assert!(contains_cjk("你好"), "汉字选区走汉英库");
        assert!(contains_cjk("苹果电脑"), "繁简都算汉字");
        assert!(!contains_cjk("perceive"), "英文选区仍走英汉库");
        assert!(contains_cjk("hello 世界"), "混入汉字也按汉英库路由");
    }

    #[test]
    fn lookup_zh_merges_pinyin_variants_and_matches_traditional() {
        let conn = cedict_fixture();
        insert_cedict(&conn, "蘋果", "苹果", "Ping2 guo3", "Apple (company)");
        insert_cedict(&conn, "苹果", "苹果", "ping2 guo3", "apple");
        insert_cedict(&conn, "你好", "你好", "ni3 hao3", "hello; hi");

        let e = lookup_zh(&conn, " 苹果 ").expect("简体命中");
        assert_eq!(e.headword, "苹果");
        assert!(e.ipa.is_empty(), "汉英库没有 IPA");
        assert_eq!(e.reading, "Ping2 guo3 · ping2 guo3", "同名不同音合并展示");
        assert_eq!(e.senses.len(), 2);
        assert!(e.senses[0].gloss.contains("Apple"));
        assert!(e.senses[1].gloss.contains("apple"));

        let trad = lookup_zh(&conn, "蘋果").expect("繁体也能命中");
        assert_eq!(trad.headword, "苹果", "回包统一用简体词头");
        assert!(lookup_zh(&conn, "草莓").is_none(), "未收录按未命中");
    }

    #[test]
    fn lookup_hit_returns_senses_examples_and_ipa() {
        let conn = fixture();
        insert_entry(&conn, "en", "perceive", "perceive", Some("源自拉丁语 percipere。"));
        add_sense(&conn, "id-perceive", 1, 1, "verb", "s1", "察觉；感知到");
        conn.execute(
            "insert into meaning_examples values ('id-perceive', 1, 's1', 1, 'She perceived a change.', '她察觉到了变化。')",
            [],
        )
        .unwrap();
        conn.execute(
            "insert into pos_group_pronunciations values ('id-perceive', 1, 1, '/pəˈsiːv/', null, '[]')",
            [],
        )
        .unwrap();

        let e = lookup(&conn, "Perceive!").expect("命中");
        assert_eq!(e.headword, "perceive");
        assert_eq!(e.ipa, vec!["/pəˈsiːv/"]);
        assert_eq!(e.senses.len(), 1);
        assert_eq!(e.senses[0].pos, "verb", "词性回原文，显示名由 TS 映射");
        assert_eq!(e.senses[0].gloss, "察觉；感知到");
        assert_eq!(e.senses[0].examples[0].translation, "她察觉到了变化。");
        assert_eq!(e.etymology, "源自拉丁语 percipere。");
    }

    #[test]
    fn lookup_requires_language_predicate() {
        // 同词头、不同语言码：只有 en 那条算命中。这条测试锁死「必须带语言码谓词」
        // ——谓词一旦漏掉，语义（走错语言的释义）和性能（全表扫）会同时坏
        let conn = fixture();
        insert_entry(&conn, "zh", "perceive", "perceive", None);
        assert!(lookup(&conn, "perceive").is_none(), "非英文码条目不得被当成命中");
    }

    #[test]
    fn lookup_miss_and_empty_sense_entry() {
        let conn = fixture();
        assert!(lookup(&conn, "serendipity").is_none(), "未收录 → None");
        // 有条目无义项（库里确有此类残留）同样按未命中处理，不给空面板
        insert_entry(&conn, "en", "zombie", "zombie", None);
        assert!(lookup(&conn, "zombie").is_none());
    }

    #[test]
    fn lookup_caps_senses_and_examples() {
        let conn = fixture();
        insert_entry(&conn, "en", "run", "run", None);
        for i in 1i64..=12 {
            add_sense(&conn, "id-run", i, i, "verb", &format!("s{i}"), &format!("义项{i}"));
            for j in 1i64..=3 {
                conn.execute(
                    "insert into meaning_examples values ('id-run', ?1, ?2, ?3, 'text', '译文')",
                    params![i, format!("s{i}"), j],
                )
                .unwrap();
            }
        }
        let e = lookup(&conn, "run").expect("命中");
        assert_eq!(e.senses.len(), SENSE_CAP as usize, "多义词义项必须截断");
        assert!(e.senses.iter().all(|s| s.examples.len() as i64 <= EXAMPLE_CAP));
        // 截断后仍要按库里顺序取前几条，不能随机
        assert_eq!(e.senses[0].gloss, "义项1");
        assert_eq!(e.senses[3].gloss, "义项4");
    }

    /// 真机词库冒烟：本机存在兼容词库时才跑（CI 没有词库 → 直接返回跳过）。
    /// 价值在于上游库结构或取词前提一旦变化，先在开发机上红，而不是等用户报
    /// 「词典查不到」。断言刻意只放形状性的——释义内容会随词库版本更新，
    /// 写死内容断言只会变成假红
    #[test]
    fn real_library_smoke_when_present() {
        let Some(path) = crate::dict::store::auto_detected_path().filter(|p| p.exists()) else {
            return;
        };
        let got = crate::dict::store::with_conn(&path, |conn| {
            Some((
                crate::dict::store::probe(conn).entry_count,
                lookup(conn, "perceive"),
                lookup(conn, "perceived"),
                lookup(conn, "这是一段中文"),
            ))
        });
        let Some((count, base, inflected, cjk)) = got else {
            panic!("本机词库读不到：{}", path.display());
        };
        assert!(count > 0, "结构探针应认得本机词库");
        let base = base.expect("常见词必须命中");
        assert!(!base.senses.is_empty() && !base.senses[0].explanation.is_empty());
        assert!(
            inflected.is_some(),
            "变形词各自独立成条是本功能免做词形还原的前提，若不再成立要回头改设计"
        );
        assert!(cjk.is_none(), "词库只收英文词条：中文选区不该命中，回落由前端负责");
    }
}
