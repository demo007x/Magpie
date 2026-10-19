//! 机器翻译命令集（ADR-03 哑管道的同源延伸）：每厂商一个命令，鉴权/协议差异
//! 全部隔离在 Rust，TS 只传文本与方向（注册表已把方向映射成各厂商语言码）。
//!
//! 硬性约定：**签名/鉴权算法一律以厂商官网文档为准实现，禁止凭记忆**——
//! 协议细节错值不报编译错，只会在运行时静默失败。各命令头注释标注了核实
//! 来源（官方文档页，本轮 2026-10 核实）。小牛官网文档站为 JS 渲染无法
//! 抓取正文，按约定挂起未做，待拿到可靠文档后补。
//!
//! 凭据从 settings 的 credentials map 读取（key = 服务 id），服务启停检查在
//! 命令内做（浮动条使用时兜底提醒在前端，这里是最后一道校验）。

use base64::Engine as _;
use hmac::{Hmac, Mac};
use md5::Md5;
use serde_json::{json, Value};
use sha1::Sha1;
use sha2::{Digest, Sha256};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::AppHandle;

use crate::settings;

type HmacSha256 = Hmac<Sha256>;
type HmacSha1 = Hmac<Sha1>;

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

fn sha256_hex(data: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(data);
    to_hex(&h.finalize())
}

fn hmac_sha256(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC 接受任意长度 key");
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}

fn hmac_sha1(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut mac = HmacSha1::new_from_slice(key).expect("HMAC 接受任意长度 key");
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}

/// Unix 秒 → (年, 月, 日, 时, 分, 秒) UTC（civil-from-days，Howard Hinnant 公版
/// 算法）。腾讯签名要 UTC 日期、阿里签名要完整 ISO8601——不为此引入 chrono
fn utc_parts(secs: u64) -> (i64, u32, u32, u32, u32, u32) {
    fn civil_from_days(z: i64) -> (i64, u32, u32) {
        let z = z + 719_468;
        let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
        let doe = (z - era * 146_097) as u64;
        let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
        let y = yoe as i64 + era * 400;
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        let mp = (5 * doy + 2) / 153;
        let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
        let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
        (if m <= 2 { y + 1 } else { y }, m, d)
    }
    let (y, m, d) = civil_from_days((secs / 86_400) as i64);
    let rem = secs % 86_400;
    (y, m, d, (rem / 3600) as u32, ((rem % 3600) / 60) as u32, (rem % 60) as u32)
}

// ---------- 百度翻译开放平台（通用翻译 API） ----------
// 核实来源：fanyi-api.baidu.com 官方文档（通用翻译 API 技术文档），
// sign = MD5(appid + q + salt + key)

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

/// 百度翻译：appid + q + salt + key 的 MD5 签名鉴权（算法见百度开放平台官方
/// 文档），方向自动识别（中↔英由调用方给 to）
#[tauri::command]
pub async fn baidu_translate(app: AppHandle, text: String, to: String) -> Result<String, String> {
    let s = settings::current(&app);
    let tc = &s.translate;
    if !tc.enabled.iter().any(|s| s == "baidu") {
        return Err("未启用百度翻译服务".into());
    }
    let cred = tc.credentials.get("baidu");
    let app_id = cred.map(|c| c.app_id.trim()).unwrap_or_default();
    let app_key = cred.map(|c| c.key.trim()).unwrap_or_default();
    if app_id.is_empty() || app_key.is_empty() {
        return Err("请到「翻译」页填写百度翻译 APPID 与密钥".into());
    }

    let salt = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .to_string();
    let sign_src = format!("{}{}{}{}", app_id, text, salt, app_key);
    let mut hasher = Md5::new();
    hasher.update(sign_src.as_bytes());
    let sign = format!("{:x}", hasher.finalize());

    let client = http_client()?;
    let resp = client
        .post("https://fanyi-api.baidu.com/api/trans/vip/translate")
        .form(&[
            ("q", text.as_str()),
            ("from", "auto"),
            ("to", to.as_str()),
            ("appid", app_id),
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
// 核实来源：deepl.com 官方 API 文档（Authentication Key 头鉴权，:fx 后缀选 api-free 域名）

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
    let key = tc
        .credentials
        .get("deepl")
        .map(|c| c.key.trim())
        .unwrap_or_default();
    if key.is_empty() {
        return Err("请到「翻译」页填写 DeepL Authentication Key".into());
    }

    let host = if key.ends_with(":fx") {
        "https://api-free.deepl.com"
    } else {
        "https://api.deepl.com"
    };
    let client = http_client()?;
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

// ---------- 谷歌翻译 API ----------
// 核实来源：cloud.google.com 官方文档（Cloud Translation API v2 translate 方法，
// query key 鉴权，响应 data.translations[].translatedText）

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoogleTranslation {
    #[serde(default)]
    translated_text: String,
}

#[derive(serde::Deserialize)]
struct GoogleTransData {
    #[serde(default)]
    translations: Vec<GoogleTranslation>,
}

#[derive(serde::Deserialize)]
struct GoogleApiError {
    #[serde(default)]
    message: Option<String>,
}

#[derive(serde::Deserialize)]
struct GoogleTransResp {
    #[serde(default)]
    data: Option<GoogleTransData>,
    #[serde(default)]
    error: Option<GoogleApiError>,
}

/// 谷歌翻译：Cloud Translation API v2，query key 鉴权（form 传 q/target/format，
/// 源语言省略走官方自动检测）；中文目标用 zh-CN，方向由调用方给 to。
/// 密钥申请：Google Cloud 控制台启用 Cloud Translation API 后建 API 密钥
#[tauri::command]
pub async fn google_translate(app: AppHandle, text: String, to: String) -> Result<String, String> {
    let s = settings::current(&app);
    let tc = &s.translate;
    if !tc.enabled.iter().any(|x| x == "google") {
        return Err("未启用谷歌翻译服务".into());
    }
    let key = tc
        .credentials
        .get("google")
        .map(|c| c.key.trim())
        .unwrap_or_default();
    if key.is_empty() {
        return Err("请到「翻译」页填写谷歌翻译 API 密钥".into());
    }

    let client = http_client()?;
    let resp = client
        .post("https://translation.googleapis.com/language/translate/v2")
        .query(&[("key", key)])
        .form(&[("q", text.as_str()), ("target", to.as_str()), ("format", "text")])
        .send()
        .await
        .map_err(|e| format!("网络请求失败：{e}"))?;

    let status = resp.status();
    let v: GoogleTransResp = resp
        .json()
        .await
        .map_err(|e| format!("响应解析失败（HTTP {status}）：{e}"))?;
    if !status.is_success() {
        return Err(format!(
            "谷歌翻译错误 HTTP {status}：{}",
            v.error.and_then(|e| e.message).unwrap_or_default()
        ));
    }

    // 只输出译文：原文用户屏幕上就有，语言检测结果属冗余
    let out = v
        .data
        .and_then(|d| d.translations.into_iter().next())
        .map(|t| t.translated_text)
        .unwrap_or_default();
    if out.is_empty() {
        return Err("翻译结果为空".into());
    }
    Ok(out)
}

// ---------- 微软翻译（Azure Translator v3） ----------
// 核实来源：learn.microsoft.com 官方参考「Translator Translate Method v3-0」：
// POST /translate?api-version=3.0&to=…，Ocp-Apim-Subscription-Key 头，
// 区域资源另需 Ocp-Apim-Subscription-Region（全球资源不需要）；语言码 zh-Hans/en

/// 微软翻译：Azure Translator v3。密钥必填；「数据区域」仅区域资源需要
/// （全球资源留空即不带该头）。源语言省略走自动检测，中文目标 zh-Hans
#[tauri::command]
pub async fn azure_translate(app: AppHandle, text: String, to: String) -> Result<String, String> {
    let s = settings::current(&app);
    let tc = &s.translate;
    if !tc.enabled.iter().any(|x| x == "microsoft") {
        return Err("未启用微软翻译服务".into());
    }
    let cred = tc.credentials.get("microsoft");
    let key = cred.map(|c| c.key.trim()).unwrap_or_default();
    let region = cred.map(|c| c.region.trim()).unwrap_or_default();
    if key.is_empty() {
        return Err("请到「翻译」页填写微软翻译 API 密钥".into());
    }

    let client = http_client()?;
    let mut req = client
        .post("https://api.cognitive.microsofttranslator.com/translate")
        .query(&[("api-version", "3.0"), ("to", to.as_str())])
        .header("Ocp-Apim-Subscription-Key", key)
        .header("Content-Type", "application/json; charset=UTF-8");
    if !region.is_empty() {
        req = req.header("Ocp-Apim-Subscription-Region", region);
    }
    let resp = req
        .body(json!([{ "Text": text }]).to_string())
        .send()
        .await
        .map_err(|e| format!("网络请求失败：{e}"))?;

    let status = resp.status();
    let body: Value = resp
        .json()
        .await
        .map_err(|e| format!("响应解析失败（HTTP {status}）：{e}"))?;
    if !status.is_success() {
        // 错误体：{ "error": { "code": 401000, "message": "…" } }
        let msg = body
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(|m| m.as_str())
            .unwrap_or_default();
        return Err(format!("微软翻译错误 HTTP {status}：{msg}"));
    }
    let out = body
        .as_array()
        .and_then(|a| a.first())
        .and_then(|i| i.get("translations"))
        .and_then(|t| t.as_array())
        .and_then(|t| t.first())
        .and_then(|t| t.get("text"))
        .and_then(|t| t.as_str())
        .unwrap_or_default()
        .to_string();
    if out.is_empty() {
        return Err("翻译结果为空".into());
    }
    Ok(out)
}

// ---------- 有道智云文本翻译 API ----------
// 核实来源：ai.youdao.com 官方文档「文本翻译 API」：
// sign = sha256(应用ID + input + salt + curtime + 应用密钥)，signType=v3；
// input = q 长度 > 20 时取「前 10 字符 + q 长度 + 后 10 字符」，否则为 q 本身；
// 语言码 zh-CHS / en，from 可传 auto；errorCode=="0" 为成功

#[derive(serde::Deserialize)]
struct YoudaoResp {
    #[serde(default)]
    error_code: String,
    #[serde(default)]
    translation: Option<Vec<String>>,
}

/// 有道翻译：v3 签名（sha256(appKey + input + salt + curtime + appSecret)）。
/// input 截断按官方规则（q 超 20 字符取前后 10 字符夹长度）；
/// 源语言 from=auto 走官方自动检测，中文目标 zh-CHS
#[tauri::command]
pub async fn youdao_translate(app: AppHandle, text: String, to: String) -> Result<String, String> {
    let s = settings::current(&app);
    let tc = &s.translate;
    if !tc.enabled.iter().any(|x| x == "youdao") {
        return Err("未启用有道翻译服务".into());
    }
    let cred = tc.credentials.get("youdao");
    let app_key = cred.map(|c| c.app_id.trim()).unwrap_or_default();
    let app_secret = cred.map(|c| c.key.trim()).unwrap_or_default();
    if app_key.is_empty() || app_secret.is_empty() {
        return Err("请到「翻译」页填写有道翻译的应用 ID 与密钥".into());
    }

    let curtime = now_secs().to_string();
    let salt = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
        .to_string();
    // input 截断按「字符」计（文档：q 前 10 个字符 + q 长度 + 后 10 个字符）
    let chars: Vec<char> = text.chars().collect();
    let input = if chars.len() > 20 {
        let head: String = chars[..10].iter().collect();
        let tail: String = chars[chars.len() - 10..].iter().collect();
        format!("{head}{}{tail}", chars.len())
    } else {
        text.clone()
    };
    let sign = sha256_hex(format!("{app_key}{input}{salt}{curtime}{app_secret}").as_bytes());

    let client = http_client()?;
    let resp = client
        .post("https://openapi.youdao.com/api")
        .form(&[
            ("q", text.as_str()),
            ("from", "auto"),
            ("to", to.as_str()),
            ("appKey", app_key),
            ("salt", salt.as_str()),
            ("sign", sign.as_str()),
            ("signType", "v3"),
            ("curtime", curtime.as_str()),
        ])
        .send()
        .await
        .map_err(|e| format!("网络请求失败：{e}"))?;

    let v: YoudaoResp = resp
        .json()
        .await
        .map_err(|e| format!("响应解析失败：{e}"))?;
    if v.error_code != "0" {
        return Err(format!("有道翻译错误 {}", v.error_code));
    }
    let out = v
        .translation
        .unwrap_or_default()
        .join("\n");
    if out.is_empty() {
        return Err("翻译结果为空".into());
    }
    Ok(out)
}

// ---------- 腾讯云机器翻译（TMT TextTranslate） ----------
// 核实来源：cloud.tencent.com 官方「签名方法 v3」文档（CanonicalRequest /
// StringToSign / kDate→kService→kSigning 派生链 / Authorization 拼接，均按原文）+
// TextTranslate 接口文档（Action=TextTranslate、Version=2018-03-21、Region 必填、
// Source 支持 auto）

/// 腾讯云翻译：TC3-HMAC-SHA256 签名。凭据 = SecretID（appId）+ SecretKey（key），
/// 地域（region）必填（如 ap-guangzhou）。源语言传 auto 走自动检测，中文目标 zh
#[tauri::command]
pub async fn tencent_translate(app: AppHandle, text: String, to: String) -> Result<String, String> {
    let s = settings::current(&app);
    let tc = &s.translate;
    if !tc.enabled.iter().any(|x| x == "tencent") {
        return Err("未启用腾讯翻译服务".into());
    }
    let cred = tc.credentials.get("tencent");
    let secret_id = cred.map(|c| c.app_id.trim()).unwrap_or_default();
    let secret_key = cred.map(|c| c.key.trim()).unwrap_or_default();
    let region = cred.map(|c| c.region.trim()).unwrap_or_default();
    if secret_id.is_empty() || secret_key.is_empty() || region.is_empty() {
        return Err("请到「翻译」页填写腾讯翻译的密钥与地域".into());
    }

    let ts = now_secs();
    let (y, m, d, _, _, _) = utc_parts(ts);
    let date = format!("{y:04}-{m:02}-{d:02}");
    let host = "tmt.tencentcloudapi.com";
    let action = "TextTranslate";

    // 请求体序列化后必须以同一字节串参与签名与发送（腾讯文档明确要求一致）
    let payload = json!({
        "SourceText": text,
        "Source": "auto",
        "Target": to,
        "ProjectId": 0,
    })
    .to_string();

    // CanonicalRequest：POST / 空 query / 规范头（小写、各以 \n 结尾）/
    // SignedHeaders / payload 哈希（各段间以 \n 分隔）
    let canonical_headers = format!(
        "content-type:application/json; charset=utf-8\nhost:{host}\nx-tc-action:{}\n",
        action.to_lowercase()
    );
    let canonical_request = format!(
        "POST\n/\n\n{canonical_headers}\ncontent-type;host;x-tc-action\n{}",
        sha256_hex(payload.as_bytes())
    );

    // StringToSign：算法 + 时间戳 + CredentialScope(date/service/tc3_request) + 规范请求哈希
    let string_to_sign = format!(
        "TC3-HMAC-SHA256\n{ts}\n{date}/tmt/tc3_request\n{}",
        sha256_hex(canonical_request.as_bytes())
    );

    // 密钥派生链（文档原文伪代码，key 在前 data 在后）：
    // SecretDate = HMAC("TC3"+SecretKey, Date) → SecretService = HMAC(·, "tmt")
    // → SecretSigning = HMAC(·, "tc3_request") → Signature = Hex(HMAC(·, StringToSign))
    let k_date = hmac_sha256(format!("TC3{secret_key}").as_bytes(), date.as_bytes());
    let k_service = hmac_sha256(&k_date, b"tmt");
    let k_signing = hmac_sha256(&k_service, b"tc3_request");
    let signature = to_hex(&hmac_sha256(&k_signing, string_to_sign.as_bytes()));

    let authorization = format!(
        "TC3-HMAC-SHA256 Credential={secret_id}/{date}/tmt/tc3_request, \
         SignedHeaders=content-type;host;x-tc-action, Signature={signature}"
    );

    let client = http_client()?;
    let resp = client
        .post(format!("https://{host}"))
        .header("X-TC-Action", action)
        .header("X-TC-Version", "2018-03-21")
        .header("X-TC-Timestamp", ts.to_string())
        .header("X-TC-Region", region)
        .header("Content-Type", "application/json; charset=utf-8")
        .header("Authorization", authorization)
        .body(payload)
        .send()
        .await
        .map_err(|e| format!("网络请求失败：{e}"))?;

    // 响应：{ "Response": { "TargetText": "…" } }；错误在 Response.Error
    let v: Value = resp
        .json()
        .await
        .map_err(|e| format!("响应解析失败：{e}"))?;
    let inner = v.get("Response").ok_or("响应缺少 Response 字段")?;
    if let Some(err) = inner.get("Error") {
        let code = err.get("Code").and_then(|c| c.as_str()).unwrap_or_default();
        let msg = err
            .get("Message")
            .and_then(|m| m.as_str())
            .unwrap_or_default();
        return Err(format!("腾讯翻译错误 {code}：{msg}"));
    }
    let out = inner
        .get("TargetText")
        .and_then(|t| t.as_str())
        .unwrap_or_default()
        .to_string();
    if out.is_empty() {
        return Err("翻译结果为空".into());
    }
    Ok(out)
}

// ---------- 阿里云机器翻译（alimt TranslateGeneral） ----------
// 核实来源：help.aliyun.com 官方「RPC API 调用的签名机制」（HMAC-SHA1、
// StringToSign = GET&%2F&percentEncode(排序参数串)、percentEncode 的 RFC3986
// 规则、key = AccessKeySecret+"&"）+ TranslateGeneral 接口文档（Version=
// 2018-10-12、FormatType/SourceLanguage/TargetLanguage/SourceText/Scene 必填、
// SourceLanguage 支持 auto、端点 mt.aliyuncs.com、5000 字符上限）

/// 阿里云 RPC 签名的 percentEncode：RFC3986（字母数字与 -_.~ 不编码，
/// 其余 %XX 大写；即标准编码后 +→%20、*→%2A、%7E→~）
fn aliyun_percent_encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*b as char)
            }
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

/// 阿里云翻译：RPC V1 签名（HMAC-SHA1 + Base64）。凭据 = AccessKey ID（appId）
/// + AccessKey Secret（key）。源语言 auto 自动检测，中文目标 zh
#[tauri::command]
pub async fn aliyun_translate(app: AppHandle, text: String, to: String) -> Result<String, String> {
    let s = settings::current(&app);
    let tc = &s.translate;
    if !tc.enabled.iter().any(|x| x == "aliyun") {
        return Err("未启用阿里翻译服务".into());
    }
    let cred = tc.credentials.get("aliyun");
    let access_key_id = cred.map(|c| c.app_id.trim()).unwrap_or_default();
    let access_key_secret = cred.map(|c| c.key.trim()).unwrap_or_default();
    if access_key_id.is_empty() || access_key_secret.is_empty() {
        return Err("请到「翻译」页填写阿里翻译的 AccessKey".into());
    }

    let ts = now_secs();
    let (y, mo, d, h, mi, se) = utc_parts(ts);
    // Timestamp：ISO8601 UTC（文档示例 2020-08-25T01:11:01Z），SignatureNonce 唯一
    let timestamp = format!("{y:04}-{mo:02}-{d:02}T{h:02}:{mi:02}:{se:02}Z");
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
        .to_string();

    // 公共参数 + 接口参数（不含 Signature），按参数名字典序排序（BTreeMap 即序）
    let mut params = std::collections::BTreeMap::new();
    params.insert("AccessKeyId", access_key_id.to_string());
    params.insert("Action", "TranslateGeneral".to_string());
    params.insert("FormatType", "text".to_string());
    params.insert("Scene", "general".to_string());
    params.insert("SignatureMethod", "HMAC-SHA1".to_string());
    params.insert("SignatureNonce", nonce);
    params.insert("SignatureVersion", "1.0".to_string());
    params.insert("SourceLanguage", "auto".to_string());
    params.insert("SourceText", text);
    params.insert("TargetLanguage", to);
    params.insert("Timestamp", timestamp);
    params.insert("Version", "2018-10-12".to_string());

    // 规范化查询串：名=值 percentEncode 后按序以 & 连接
    let canonical: String = params
        .iter()
        .map(|(k, v)| {
            format!(
                "{}={}",
                aliyun_percent_encode(k),
                aliyun_percent_encode(v)
            )
        })
        .collect::<Vec<_>>()
        .join("&");

    // StringToSign = GET&%2F&percentEncode(规范化查询串)；key = Secret + "&"
    let string_to_sign = format!("GET&{}", aliyun_percent_encode("/"));
    let string_to_sign = format!(
        "{string_to_sign}&{}",
        aliyun_percent_encode(&canonical)
    );
    let signature = base64::engine::general_purpose::STANDARD
        .encode(hmac_sha1(
            format!("{access_key_secret}&").as_bytes(),
            string_to_sign.as_bytes(),
        ));

    let url = format!(
        "https://mt.aliyuncs.com/?{canonical}&Signature={}",
        aliyun_percent_encode(&signature)
    );
    let client = http_client()?;
    let resp = client.get(&url).send().await.map_err(|e| format!("网络请求失败：{e}"))?;

    // 响应：{ Code: 200, Data: { Translated: "…" } }；异常时 Code 非 200 带 Message
    let v: Value = resp
        .json()
        .await
        .map_err(|e| format!("响应解析失败：{e}"))?;
    let code = v.get("Code").and_then(|c| c.as_i64()).unwrap_or(0);
    if code != 200 {
        let msg = v
            .get("Message")
            .and_then(|m| m.as_str())
            .unwrap_or_default();
        return Err(format!("阿里翻译错误 {code}：{msg}"));
    }
    let out = v
        .get("Data")
        .and_then(|d| d.get("Translated"))
        .and_then(|t| t.as_str())
        .unwrap_or_default()
        .to_string();
    if out.is_empty() {
        return Err("翻译结果为空".into());
    }
    Ok(out)
}

// ---------- 火山引擎机器翻译（Translate） ----------
// 核实来源：docs.volcengine.com「文本翻译API」（端点 translate.volcengineapi.com、
// Action=Translate、Version=2020-06-01、Region=cn-north-1、Service=translate、
// 请求 TargetLanguage/SourceLanguage/Text、响应 Result.Translation）+
// 「签名方法 V4」文档与官方 Go SDK base/sign.go 双重核对（CanonicalRequest /
// StringToSign / kDate→kRegion→kService→kSigning("request") 派生链、签名头
// 集合 content-type;host;x-content-sha256;x-date、X-Date 格式 YYYYMMDD'T'HHMMSS'Z）

/// 火山翻译：V4 签名（HMAC-SHA256，与 AWS SigV4 同构）。凭据 = AccessKey ID
/// （appId）+ Secret AccessKey（key）；源语言省略走服务端自动检测，中文目标 zh
#[tauri::command]
pub async fn volcano_translate(app: AppHandle, text: String, to: String) -> Result<String, String> {
    let s = settings::current(&app);
    let tc = &s.translate;
    if !tc.enabled.iter().any(|x| x == "volcano") {
        return Err("未启用火山翻译服务".into());
    }
    let cred = tc.credentials.get("volcano");
    let access_key_id = cred.map(|c| c.app_id.trim()).unwrap_or_default();
    let secret_key = cred.map(|c| c.key.trim()).unwrap_or_default();
    if access_key_id.is_empty() || secret_key.is_empty() {
        return Err("请到「翻译」页填写火山翻译的访问密钥".into());
    }

    let (y, mo, d, h, mi, se) = utc_parts(now_secs());
    let date = format!("{y:04}{mo:02}{d:02}");
    let x_date = format!("{date}T{h:02}{mi:02}{se:02}Z");
    let host = "translate.volcengineapi.com";
    let (region, service) = ("cn-north-1", "translate");
    // Action/Version 值均为非保留字符，编码前后一致，规范串可直接写死
    let query = "Action=Translate&Version=2020-06-01";

    // 请求体序列化后必须以同一字节串参与签名与发送
    let payload = json!({ "TargetLanguage": to, "Text": text }).to_string();
    let body_hash = sha256_hex(payload.as_bytes());

    // CanonicalRequest：POST / 路径 / query / 规范头（小写、各以 \n 结尾）/
    // SignedHeaders / payload 哈希。官方 SDK sortHeaders 只签 Content-Type/
    // Content-Md5/Host/X-* 前缀头，这里四个头全在其中
    let canonical_headers = format!(
        "content-type:application/json\nhost:{host}\nx-content-sha256:{body_hash}\nx-date:{x_date}\n"
    );
    let canonical_request = format!(
        "POST\n/\n{query}\n{canonical_headers}\ncontent-type;host;x-content-sha256;x-date\n{body_hash}"
    );

    // StringToSign：算法 + X-Date + CredentialScope(date/region/service/request) + 规范请求哈希
    let scope = format!("{date}/{region}/{service}/request");
    let string_to_sign = format!(
        "HMAC-SHA256\n{x_date}\n{scope}\n{}",
        sha256_hex(canonical_request.as_bytes())
    );

    // 密钥派生链（文档原文，key 在前 data 在后）：
    // kDate = HMAC(SK, Date) → kRegion → kService → kSigning = HMAC(·, "request")
    let k_date = hmac_sha256(secret_key.as_bytes(), date.as_bytes());
    let k_region = hmac_sha256(&k_date, region.as_bytes());
    let k_service = hmac_sha256(&k_region, service.as_bytes());
    let k_signing = hmac_sha256(&k_service, b"request");
    let signature = to_hex(&hmac_sha256(&k_signing, string_to_sign.as_bytes()));

    let authorization = format!(
        "HMAC-SHA256 Credential={access_key_id}/{scope}, \
         SignedHeaders=content-type;host;x-content-sha256;x-date, Signature={signature}"
    );

    let client = http_client()?;
    let resp = client
        .post(format!("https://{host}/?{query}"))
        .header("X-Date", &x_date)
        .header("X-Content-Sha256", &body_hash)
        .header("Content-Type", "application/json")
        .header("Authorization", authorization)
        .body(payload)
        .send()
        .await
        .map_err(|e| format!("网络请求失败：{e}"))?;

    // 响应：{ ResponseMetadata: { Error: null | { Code, Message } }, Result: { Translation } }
    let v: Value = resp
        .json()
        .await
        .map_err(|e| format!("响应解析失败：{e}"))?;
    if let Some(err) = v.pointer("/ResponseMetadata/Error") {
        if !err.is_null() {
            let code = err.get("Code").and_then(|c| c.as_str()).unwrap_or_default();
            let msg = err
                .get("Message")
                .and_then(|m| m.as_str())
                .unwrap_or_default();
            return Err(format!("火山翻译错误 {code}：{msg}"));
        }
    }
    let out = v
        .pointer("/Result/Translation")
        .and_then(|t| t.as_str())
        .unwrap_or_default()
        .to_string();
    if out.is_empty() {
        return Err("翻译结果为空".into());
    }
    Ok(out)
}

// ---------- 彩云小译 API ----------
// 核实来源：docs.caiyunapp.com 官方文档「五分钟学会彩云小译 API」：
// POST /v1/translator，X-Authorization: token $TOKEN，请求 { source, trans_type,
// detect, media }，响应取 target

#[derive(serde::Deserialize)]
struct CaiyunResp {
    #[serde(default)]
    target: Value,
}

/// 彩云小译：token 头鉴权。to 参数即 trans_type（注册表映射：中→en 为 zh2en，
/// 反向为 auto2zh 自动识别源语言）。响应 target：字符串或数组（按 source 形态）
#[tauri::command]
pub async fn caiyun_translate(app: AppHandle, text: String, to: String) -> Result<String, String> {
    let s = settings::current(&app);
    let tc = &s.translate;
    if !tc.enabled.iter().any(|x| x == "caiyun") {
        return Err("未启用彩云小译服务".into());
    }
    let token = tc
        .credentials
        .get("caiyun")
        .map(|c| c.key.trim())
        .unwrap_or_default();
    if token.is_empty() {
        return Err("请到「翻译」页填写彩云小译的 API 令牌".into());
    }

    let client = http_client()?;
    let resp = client
        .post("https://api.interpreter.caiyunai.com/v1/translator")
        .header("X-Authorization", format!("token {token}"))
        .header("Content-Type", "application/json")
        .json(&json!({
            "source": [text],
            "trans_type": to,
            "detect": true,
            "media": "text",
            "request_id": "magpie",
        }))
        .send()
        .await
        .map_err(|e| format!("网络请求失败：{e}"))?;

    let status = resp.status();
    let v: CaiyunResp = resp
        .json()
        .await
        .map_err(|e| format!("响应解析失败（HTTP {status}）：{e}"))?;
    if !status.is_success() {
        return Err(format!("彩云小译错误 HTTP {status}"));
    }
    // source 传数组时 target 为数组：取首段（本应用单次只送一条）
    let out = match &v.target {
        Value::String(s) => s.clone(),
        Value::Array(a) => a
            .first()
            .and_then(|t| t.as_str())
            .unwrap_or_default()
            .to_string(),
        _ => String::new(),
    };
    if out.is_empty() {
        return Err("翻译结果为空".into());
    }
    Ok(out)
}
