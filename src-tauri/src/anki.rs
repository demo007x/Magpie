//! Anki 接入（docs/08）：经 AnkiConnect 本地 HTTP 一键建卡——划词/结果进牌组。
//! 无状态一次性送达：写入本地集合即完，不建队列、不做同步（多端同步归 Anki 自身）。
//! 安全边界：connect_url 仅允许回环地址（AnkiConnect 是本地明文 HTTP，默认
//! 127.0.0.1:8765），防配置误填把划词内容发往外部；卡片字段由 TS 渲染后传入，
//! Rust 只负责协议转发与错误分类——与 obsidian.rs 的「TS 渲染、Rust 执行」分工一致。

use std::collections::HashMap;
use std::time::Duration;

use serde_json::{json, Value};

use crate::i18n::t;

/// 本地服务 2s 足够：Anki 无响应即视为不可达（给用户「请启动 Anki」的明确提示）
const ANKI_TIMEOUT: Duration = Duration::from_secs(2);
const ANKI_PROTOCOL_VERSION: i32 = 6;

/// 校验地址为回环地址并归一（剥尾部斜杠）。IPv4 回环 / localhost / IPv6 [::1]
fn validate_loopback(raw: &str) -> Result<String, String> {
    let url = raw.trim().trim_end_matches('/');
    let rest = url
        .strip_prefix("http://")
        .or_else(|| url.strip_prefix("https://"))
        .ok_or_else(|| t("err.ankiInvalidUrl").to_string())?;
    let authority = rest.split('/').next().unwrap_or_default();
    // IPv6 字面量形如 [::1]:8765，先剥方括号
    let host = if let Some(stripped) = authority.strip_prefix('[') {
        stripped.split(']').next().unwrap_or_default()
    } else {
        authority.split(':').next().unwrap_or_default()
    };
    let loopback = host == "localhost"
        || host == "::1"
        || host
            .parse::<std::net::Ipv4Addr>()
            .map(|ip| ip.is_loopback())
            .unwrap_or(false);
    if !loopback {
        return Err(t("err.ankiInvalidUrl").into());
    }
    Ok(url.to_string())
}

/// AnkiConnect 协议请求：POST {action, version, params}，解析 {result, error} 信封。
/// 错误已本地化（重复卡 / 不可达 / 其他），前端可直接 toast 展示；网络层失败细节
/// （拒绝/超时等）随本地化文案一起记入 magpie.log——本地化文案面向用户必须笼统，
/// 排查「设置页已连接、建卡却无法连接」这类状态漂移问题靠日志里的真实原因
async fn anki_request(url: &str, action: &str, params: Value) -> Result<Value, String> {
    let url = validate_loopback(url)?;
    let client = reqwest::Client::builder()
        .timeout(ANKI_TIMEOUT)
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .post(&url)
        .json(&json!({ "action": action, "version": ANKI_PROTOCOL_VERSION, "params": params }))
        .send()
        .await
        .map_err(|e| {
            crate::user_log(&format!("[anki] {action} 请求失败: {e}（url={url}）"));
            t("err.ankiUnreachable").to_string()
        })?;
    if !resp.status().is_success() {
        let status = resp.status();
        crate::user_log(&format!("[anki] {action} HTTP {status}（url={url}）"));
        return Err(format!("{} (HTTP {status})", t("err.ankiUnreachable")));
    }
    let v: Value = resp
        .json()
        .await
        .map_err(|_| t("err.ankiParseFailed").to_string())?;
    if let Some(err) = v.get("error").and_then(|e| e.as_str()) {
        if !err.is_empty() {
            // 重复卡单独分类：allowDuplicate=false 时 AnkiConnect 的报错文案含 duplicate
            if err.to_lowercase().contains("duplicate") {
                return Err(t("err.ankiDuplicate").into());
            }
            return Err(format!("{}: {err}", t("err.ankiError")));
        }
    }
    Ok(v.get("result").cloned().unwrap_or(Value::Null))
}

/// 字符串数组结果收敛（AnkiConnect 的 deckNames / modelNames / modelFieldNames）
fn string_list(v: Value) -> Vec<String> {
    v.as_array()
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

/// 连接探测：返回 AnkiConnect 的 API 版本（设置页「连接测试」的数据源）。
/// 旧版协议版本是数字（如 6），按任意标量收敛为展示串
#[tauri::command]
pub async fn anki_version(url: String) -> Result<String, String> {
    let v = anki_request(&url, "version", json!({})).await?;
    Ok(match v {
        Value::String(s) => s,
        Value::Number(n) => n.to_string(),
        Value::Null => String::new(),
        _ => v.to_string(),
    })
}

/// 牌组列表（设置页下拉缓存）
#[tauri::command]
pub async fn anki_deck_names(url: String) -> Result<Vec<String>, String> {
    let v = anki_request(&url, "deckNames", json!({})).await?;
    Ok(string_list(v))
}

/// 建牌组（一键接入的「拾趣」配套牌组）：createDeck 幂等，牌组已存在时
/// 返回 Null 结果不报错，可无条件调用
#[tauri::command]
pub async fn anki_create_deck(url: String, deck: String) -> Result<(), String> {
    anki_request(&url, "createDeck", json!({ "deck": deck })).await?;
    Ok(())
}

/// 笔记类型列表（设置页下拉）
#[tauri::command]
pub async fn anki_model_names(url: String) -> Result<Vec<String>, String> {
    let v = anki_request(&url, "modelNames", json!({})).await?;
    Ok(string_list(v))
}

/// 指定笔记类型的字段名列表（高级字段映射区的动态渲染）
#[tauri::command]
pub async fn anki_model_fields(url: String, model: String) -> Result<Vec<String>, String> {
    let v = anki_request(&url, "modelFieldNames", json!({ "modelName": model })).await?;
    Ok(string_list(v))
}

/// 创建笔记类型（配套「拾趣划词卡」）：model 为 TS 侧组装好的 createModel
/// 参数（类型名/字段/CSS/卡片模板，均为静态出厂定义，非用户内容）。
/// 注意 AnkiConnect 的 createModel 参数是平铺的（modelName/inOrderFields/
/// cardTemplates 直接作顶层键，经 api 装饰器转发给同名 Python 函数），
/// 不嵌套 "model" 包装层。同名类型已存在时由 AnkiConnect 报错，前端先查
/// modelNames 做幂等
#[tauri::command]
pub async fn anki_create_model(url: String, model: Value) -> Result<(), String> {
    anki_request(&url, "createModel", model).await?;
    Ok(())
}

/// 建卡：fields 为 TS 渲染好的完整字段 map（用户显式映射 + 未配置字段的智能
/// 默认，见 floating App.tsx 的组装处；零配置时第 1 字段 = 选中文本、
/// 两字段类型第 2 字段 = AI 释义）。
/// Rust 只做过滤与转发：陈旧字段名（不属于该笔记类型）与空模板剔除，
/// 防 addNote 报未知字段/空卡。allowDuplicate=false，重复时分类为已存在提示
#[tauri::command]
pub async fn anki_add_note(
    url: String,
    deck: String,
    model: String,
    fields: HashMap<String, String>,
    tags: Vec<String>,
) -> Result<(), String> {
    let field_names = string_list(
        anki_request(&url, "modelFieldNames", json!({ "modelName": model })).await?,
    );
    let fields: HashMap<String, String> = fields
        .into_iter()
        .filter(|(name, value)| {
            !value.trim().is_empty() && field_names.iter().any(|n| n == name)
        })
        .collect();
    anki_request(
        &url,
        "addNote",
        json!({
            "note": {
                "deckName": deck,
                "modelName": model,
                "fields": fields,
                "tags": tags,
                "options": { "allowDuplicate": false },
            }
        }),
    )
    .await
    .map(|_| ())
}
