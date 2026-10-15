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

/// 思考模式参数的厂商注册表：OpenAI 格式下各厂商的思考开关参数并不相同，
/// 且 OpenAI 等严格端点对未知参数直接报 400——因此按 baseUrl 匹配已知厂商
/// 才注入，未知厂商一律返回 None（不传参 = 厂商默认行为，绝不破坏可用性）。
/// 新厂商支持 = 在此函数加一个分支。开关参数的三种流派（均在 OpenAI 格式内）：
/// - `thinking.type`：DeepSeek / 智谱 / 豆包（火山方舟，含 auto 档）
/// - `enable_thinking`：通义百炼 / 硅基流动（仅流式调用可关——本管道恒流式 ✓；
///   纯思考模型如 QwQ/QVQ 不收此参数）
/// - `reasoning_effort`：OpenAI / xAI（只能调思考深浅，没有关闭档）
/// 另 OpenRouter 聚合层用 `reasoning.effort` 归一化。
///
/// 「关闭」的行为按厂商区分（这是按厂商匹配而非无脑发参的核心原因）：
/// 参数支持显式关闭且关闭有收益的（DeepSeek、豆包——推理模型默认开思考）
/// OFF 时注入 disabled；只能调深浅或对不支持模型会报错的（OpenAI/xAI/
/// 通义/硅基流动/智谱——GLM-5.3 系强制思考、不支持 disabled）OFF 不发参。
///
/// 厂商注册表只到「厂商」粒度；**同厂商不同模型**的支持差异（GLM-5.3 拒收
/// disabled、gpt-4o 拒收 reasoning_effort、QwQ 不收 enable_thinking…）由
/// should_retry_without_thinking 的自动降级兜底：参数被拒就去掉重试一次，
/// 不维护易碎的模型名单。
/// 同厂商不同模型的支持差异由 should_retry_without_thinking 的自动降级兜底；
/// 智谱 GLM-5.3 系的强制思考例外按模型名识别（见函数内注释）。
///
/// 强度统一压在 low 档：划词场景延迟敏感，本产品不需要重度思考——
/// 「关」能关的（DeepSeek/豆包/智谱非 5.3）显式关闭，「关不掉」的
/// （智谱 5.3、OpenAI 推理系）压到最轻档。
fn thinking_patch(base_url: &str, model: &str, on: bool) -> Option<Value> {
    let host = base_url.to_ascii_lowercase();
    let model_l = model.to_ascii_lowercase();
    if host.contains("api.deepseek.com") || host.contains("volces.com") {
        // DeepSeek / 豆包：开/关都注入（推理模型默认开思考，关闭须显式）
        return Some(if on {
            json!({ "thinking": { "type": "enabled" }, "reasoning_effort": "low" })
        } else {
            json!({ "thinking": { "type": "disabled" } })
        });
    }
    if host.contains("bigmodel.cn") {
        // 智谱：GLM-5.3 系强制思考且拒收 disabled，默认 effort 还是 high——
        // 无论开关都压到 low 档轻思考；其余型号（5.2-）支持 disabled：
        // 开 = enabled（自动判断深度），关 = disabled
        if model_l.contains("5.3") {
            return Some(
                json!({ "thinking": { "type": "enabled" }, "reasoning_effort": "low" }),
            );
        }
        return Some(if on {
            json!({ "thinking": { "type": "enabled" } })
        } else {
            json!({ "thinking": { "type": "disabled" } })
        });
    }
    if host.contains("dashscope.aliyuncs.com")
        || host.contains("siliconflow.cn")
        || host.contains("siliconflow.com")
    {
        // 通义百炼 / 硅基流动：enable_thinking 仅流式可关（本管道恒流式），
        // 纯思考模型不收此参数 → 仅开启时注入
        return on.then(|| json!({ "enable_thinking": true }));
    }
    if host.contains("api.openai.com") || host.contains("api.x.ai") {
        // OpenAI / xAI：ON = low 档轻思考。OFF：推理系模型（o1/o3/o4/gpt-5）
        // 没有关闭档 → 压到 low；非推理模型（gpt-4o 等）不收此参数 → 不传
        if on {
            return Some(json!({ "reasoning_effort": "low" }));
        }
        let reasoning_model = model_l.starts_with("o1")
            || model_l.starts_with("o3")
            || model_l.starts_with("o4")
            || model_l.starts_with("gpt-5");
        return reasoning_model.then(|| json!({ "reasoning_effort": "low" }));
    }
    if host.contains("openrouter.ai") {
        // OpenRouter 聚合层：reasoning.effort 归一化参数，不支持的模型自动忽略
        return on.then(|| json!({ "reasoning": { "effort": "low" } }));
    }
    None
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

/// 思考参数被拒时的自动降级判定：仅参数类 4xx（400/404/415/422）且确实注入过
/// 才值得重试；401/429 等与参数无关的状态重试也不会成功，不浪费请求
fn should_retry_without_thinking(status: u16, injected: bool) -> bool {
    injected && matches!(status, 400 | 404 | 415 | 422)
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
    let mut body = json!({ "model": provider.model, "messages": messages, "stream": true });
    // 思考模式开关（仅已知厂商注入，见 thinking_patch）；思考型模型会先流出
    // reasoning_content 增量，本管道只转发 content——思维链阶段表现为静默等待
    let patch = thinking_patch(&provider.base_url, &provider.model, provider.thinking);
    if let Some(p) = &patch {
        if let (Some(obj), Some(po)) = (body.as_object_mut(), p.as_object()) {
            obj.extend(po.clone());
        }
    }

    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;

    let mut resp = client
        .post(&url)
        .bearer_auth(provider.api_key.trim())
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("网络请求失败：{e}"))?;

    // 同厂商的不同模型对思考参数的支持并不一致（GLM-5.3 拒收 disabled、
    // gpt-4o 拒收 reasoning_effort、QwQ 不收 enable_thinking…）——参数类
    // 4xx 时去掉思考参数重试一次，靠降级自愈而不是维护易碎的模型名单
    if !resp.status().is_success()
        && should_retry_without_thinking(resp.status().as_u16(), patch.is_some())
    {
        eprintln!("[ai] HTTP {}：思考参数被模型拒绝，去除后自动重试", resp.status());
        let mut plain = body.clone();
        if let (Some(obj), Some(po)) = (plain.as_object_mut(), patch.as_ref().and_then(|p| p.as_object()))
        {
            for k in po.keys() {
                obj.remove(k);
            }
        }
        resp = client
            .post(&url)
            .bearer_auth(provider.api_key.trim())
            .json(&plain)
            .send()
            .await
            .map_err(|e| format!("网络请求失败：{e}"))?;
    }

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thinking_patch_known_vendors() {
        // DeepSeek / 豆包：开/关都注入（推理模型默认开思考，关闭须显式）；
        // 开启压在 low 档轻思考
        for url in [
            "https://api.deepseek.com",
            "https://api.deepseek.com/v1",
            "https://ark.cn-beijing.volces.com/api/v3",
        ] {
            let on = thinking_patch(url, "deepseek-chat", true).unwrap();
            assert_eq!(on.pointer("/thinking/type").unwrap(), "enabled");
            assert_eq!(on.get("reasoning_effort"), Some(&serde_json::json!("low")));
            let off = thinking_patch(url, "deepseek-chat", false).unwrap();
            assert_eq!(off.pointer("/thinking/type").unwrap(), "disabled");
        }
        // 智谱：5.3 系强制思考（拒收 disabled）→ 开关都压 low 档轻思考；
        // 5.2 及以下：开 = enabled，关 = disabled
        let on53 = thinking_patch(
            "https://open.bigmodel.cn/api/paas/v4",
            "glm-5.3-flash",
            true,
        )
        .unwrap();
        assert_eq!(on53.pointer("/thinking/type").unwrap(), "enabled");
        assert_eq!(on53.get("reasoning_effort"), Some(&serde_json::json!("low")));
        let off53 = thinking_patch(
            "https://open.bigmodel.cn/api/paas/v4",
            "glm-5.3-flash",
            false,
        )
        .unwrap();
        assert_eq!(off53.pointer("/thinking/type").unwrap(), "enabled");
        assert_eq!(
            off53.get("reasoning_effort"),
            Some(&serde_json::json!("low"))
        );
        let off52 = thinking_patch(
            "https://open.bigmodel.cn/api/paas/v4",
            "glm-5.2",
            false,
        )
        .unwrap();
        assert_eq!(off52.pointer("/thinking/type").unwrap(), "disabled");
        // 通义 / 硅基流动：仅开启注入（关闭不发参——纯思考模型不收此参数）
        for url in [
            "https://dashscope.aliyuncs.com/compatible-mode/v1",
            "https://api.siliconflow.cn/v1",
        ] {
            let on = thinking_patch(url, "qwen3-max", true).unwrap();
            assert_eq!(on.get("enable_thinking"), Some(&serde_json::json!(true)));
            assert!(thinking_patch(url, "qwen3-max", false).is_none());
        }
        // OpenAI / xAI：开启注入 low；关闭仅推理系模型（o1/o3/o4/gpt-5）压 low，
        // 非推理模型（gpt-4o）不发参
        for url in ["https://api.openai.com/v1", "https://api.x.ai/v1"] {
            let on = thinking_patch(url, "o3-mini", true).unwrap();
            assert_eq!(on.get("reasoning_effort"), Some(&serde_json::json!("low")));
            let off = thinking_patch(url, "o3-mini", false).unwrap();
            assert_eq!(off.get("reasoning_effort"), Some(&serde_json::json!("low")));
            assert!(thinking_patch(url, "gpt-4o", false).is_none());
        }
        // OpenRouter：reasoning.effort 归一化参数
        let on = thinking_patch("https://openrouter.ai/api/v1", "any-model", true).unwrap();
        assert_eq!(on.pointer("/reasoning/effort").unwrap(), "low");
        assert!(thinking_patch("https://openrouter.ai/api/v1", "any-model", false).is_none());
    }

    #[test]
    fn thinking_patch_unknown_vendor_sends_nothing() {
        // 未知/自建网关不传参：严格端点对未知参数报 400，宁可不注入
        assert!(thinking_patch("https://my-proxy.example.com", "any", true).is_none());
        assert!(thinking_patch("https://my-proxy.example.com", "any", false).is_none());
    }

    #[test]
    fn thinking_patch_is_case_insensitive() {
        assert!(thinking_patch("https://API.DEEPSEEK.COM", "deepseek-chat", true).is_some());
        assert!(thinking_patch("https://Ark.CN-BEIJING.VOLCES.COM/api/v3", "doubao-seed-1.6", true)
            .is_some());
    }

    #[test]
    fn retry_only_for_param_rejections_with_injection() {
        // 参数类 4xx 且注入过 → 降级重试
        assert!(should_retry_without_thinking(400, true));
        assert!(should_retry_without_thinking(422, true));
        // 未注入过思考参数 → 没什么可去除，不重试
        assert!(!should_retry_without_thinking(400, false));
        // 401/429 与参数无关 → 重试也不会成功，不浪费请求
        assert!(!should_retry_without_thinking(401, true));
        assert!(!should_retry_without_thinking(429, true));
        // 5xx 是服务端问题，与参数无关
        assert!(!should_retry_without_thinking(500, true));
    }
}
