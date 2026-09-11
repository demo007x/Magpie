//! AI 传输管道（ADR-03）：OpenAI 兼容协议 SSE → Tauri Channel。
//! 刻意保持"哑"——无任何 AI 逻辑；prompt/动作全部在 TS 层（docs/05）。

use futures_util::StreamExt;
use md5::{Digest, Md5};
use serde::Serialize;
use serde_json::{json, Value};
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::AppHandle;

use crate::settings;

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AiEvent {
    Delta { content: String },
    Done,
    Error { message: String },
}

fn pick_provider<'a>(
    s: &'a settings::Settings,
    id: Option<&str>,
) -> Option<&'a settings::Provider> {
    id.and_then(|i| s.providers.iter().find(|p| p.id == i))
        .or_else(|| s.providers.iter().find(|p| p.id == s.default_provider_id))
        .or_else(|| s.providers.first())
}

// ---------- 百度翻译开放平台（通用翻译 API） ----------

#[derive(serde::Deserialize)]
struct BaiduTransItem {
    dst: String,
}

#[derive(serde::Deserialize)]
struct BaiduTransResp {
    #[serde(default)]
    trans_result: Vec<BaiduTransItem>,
    #[serde(default)]
    error_code: Option<String>,
    #[serde(default)]
    error_msg: Option<String>,
}

/// 百度翻译：appid + q + salt + key 的 MD5 签名鉴权，方向自动识别（中↔英由调用方给 to）
#[tauri::command]
pub async fn baidu_translate(app: AppHandle, text: String, to: String) -> Result<String, String> {
    let s = settings::current(&app);
    let tc = &s.translate;
    if !tc.enabled.iter().any(|s| s == "baidu") {
        return Err("未启用百度翻译服务".into());
    }
    if tc.app_id.trim().is_empty() || tc.app_key.trim().is_empty() {
        return Err("请到「翻译」页填写百度翻译 APPID 与密钥".into());
    }

    let salt = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .to_string();
    let sign_src = format!("{}{}{}{}", tc.app_id.trim(), text, salt, tc.app_key.trim());
    let mut hasher = Md5::new();
    hasher.update(sign_src.as_bytes());
    let sign = format!("{:x}", hasher.finalize());

    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .post("https://fanyi-api.baidu.com/api/trans/vip/translate")
        .form(&[
            ("q", text.as_str()),
            ("from", "auto"),
            ("to", to.as_str()),
            ("appid", tc.app_id.trim()),
            ("salt", salt.as_str()),
            ("sign", sign.as_str()),
        ])
        .send()
        .await
        .map_err(|e| format!("网络请求失败：{e}"))?;

    let v: BaiduTransResp = resp
        .json()
        .await
        .map_err(|e| format!("响应解析失败：{e}"))?;
    if let Some(code) = v.error_code {
        return Err(format!(
            "百度翻译错误 {}：{}",
            code,
            v.error_msg.unwrap_or_default()
        ));
    }

    // 只输出译文：原文用户屏幕上就有，对照与语言识别属冗余
    if v.trans_result.is_empty() {
        return Err("翻译结果为空".into());
    }
    let out = v
        .trans_result
        .into_iter()
        .map(|r| r.dst)
        .collect::<Vec<_>>()
        .join("\n");
    Ok(out)
}

// ---------- DeepL 翻译 API ----------

#[derive(serde::Deserialize)]
struct DeeplTranslation {
    text: String,
}

#[derive(serde::Deserialize)]
struct DeeplTransResp {
    #[serde(default)]
    translations: Vec<DeeplTranslation>,
    #[serde(default)]
    message: Option<String>,
}

/// DeepL 翻译：`Authorization: DeepL-Auth-Key` 头鉴权（query 鉴权已弃用）；
/// Free 密钥以 :fx 结尾 → api-free.deepl.com，其余 → api.deepl.com。
/// 方向由调用方给 target_lang（"EN" | "ZH"），源语言省略走官方自动检测。
#[tauri::command]
pub async fn deepl_translate(app: AppHandle, text: String, to: String) -> Result<String, String> {
    let s = settings::current(&app);
    let tc = &s.translate;
    if !tc.enabled.iter().any(|x| x == "deepl") {
        return Err("未启用 DeepL 翻译服务".into());
    }
    let key = tc.deepl_key.trim();
    if key.is_empty() {
        return Err("请到「翻译」页填写 DeepL Authentication Key".into());
    }

    let host = if key.ends_with(":fx") {
        "https://api-free.deepl.com"
    } else {
        "https://api.deepl.com"
    };
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .post(format!("{host}/v2/translate"))
        .header("Authorization", format!("DeepL-Auth-Key {key}"))
        .json(&json!({
            "text": [text],
            "target_lang": to,
        }))
        .send()
        .await
        .map_err(|e| format!("网络请求失败：{e}"))?;

    let status = resp.status();
    let v: DeeplTransResp = resp
        .json()
        .await
        .map_err(|e| format!("响应解析失败（HTTP {status}）：{e}"))?;
    if !status.is_success() {
        return Err(format!(
            "DeepL 错误 HTTP {status}：{}",
            v.message.unwrap_or_default()
        ));
    }

    // 只输出译文：原文用户屏幕上就有，语言检测结果属冗余
    if v.translations.is_empty() {
        return Err("翻译结果为空".into());
    }
    Ok(v.translations
        .into_iter()
        .map(|t| t.text)
        .collect::<Vec<_>>()
        .join("\n"))
}

#[tauri::command]
pub async fn ai_chat(
    app: AppHandle,
    messages: Vec<Value>,
    provider_id: Option<String>,
    channel: Channel<AiEvent>,
) -> Result<(), String> {
    let s = settings::current(&app);
    let provider = pick_provider(&s, provider_id.as_deref())
        .ok_or_else(|| "未配置模型服务，请到「设置」页添加".to_string())?;
    if provider.api_key.trim().is_empty() {
        return Err("API Key 为空，请到「设置」页填写".to_string());
    }

    let url = format!(
        "{}/chat/completions",
        provider.base_url.trim_end_matches('/')
    );
    let body = json!({ "model": provider.model, "messages": messages, "stream": true });

    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client
        .post(&url)
        .bearer_auth(provider.api_key.trim())
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("网络请求失败：{e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        let text = if text.chars().count() > 400 {
            let t: String = text.chars().take(400).collect();
            format!("{t}…")
        } else {
            text
        };
        let _ = channel.send(AiEvent::Error {
            message: format!("HTTP {status}：{text}"),
        });
        return Ok(());
    }

    // SSE 分帧（\n\n）解析：data: {...} / data: [DONE]
    let mut stream = resp.bytes_stream();
    let mut buf = String::new();

    while let Some(item) = stream.next().await {
        match item {
            Ok(bytes) => {
                buf.push_str(&String::from_utf8_lossy(&bytes));
                while let Some(pos) = buf.find("\n\n") {
                    let frame: String = buf.drain(..pos + 2).collect();
                    for line in frame.lines() {
                        let Some(data) = line.strip_prefix("data:") else {
                            continue;
                        };
                        let data = data.trim();
                        if data == "[DONE]" {
                            let _ = channel.send(AiEvent::Done);
                            return Ok(());
                        }
                        let Ok(v) = serde_json::from_str::<Value>(data) else {
                            continue;
                        };
                        let content = v
                            .pointer("/choices/0/delta/content")
                            .and_then(Value::as_str);
                        if let Some(c) = content {
                            if !c.is_empty() {
                                let _ = channel.send(AiEvent::Delta {
                                    content: c.to_string(),
                                });
                            }
                        }
                    }
                }
            }
            Err(e) => {
                let _ = channel.send(AiEvent::Error {
                    message: format!("流中断：{e}"),
                });
                return Ok(());
            }
        }
    }

    let _ = channel.send(AiEvent::Done);
    Ok(())
}
