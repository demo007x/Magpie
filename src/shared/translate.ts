// 翻译服务注册表与配置完备性判据（设置页与浮动条共用）：
// 服务身份（名称/描述/凭据字段/语言码/后端命令）只在这里声明一份，设置页
// 凭据表单、未配置提示、浮动条菜单与结果窗 chips 全部由它驱动——新增厂商
// = 一条声明 + Rust 侧同名命令，其余零改动。
// 硬性约定：签名式厂商（appId+密钥）的签名算法必须对照官网文档核实实现，
// 不得凭记忆（协议细节错值不报编译错，只会在运行时静默失败）。
import type { Provider, TranslateConfig } from "./types";

/** 凭据字段声明：field 对应 credentials[id] 里的取值键 */
export interface TranslateField {
  field: "appId" | "key" | "region";
  label: string;
  placeholder: string;
  /** password 输入（密钥类字段） */
  secret?: boolean;
  /** 可空字段（如微软的全球资源免填区域）：不参与未配置判定 */
  optional?: boolean;
}

export interface TranslateService {
  id: string;
  label: string;
  /** 设置页一句话描述（面向普通用户，不写协议/参数词汇） */
  blurb: string;
  /** "ai" = BYOK 模型服务（凭据在「模型服务」页统一管理，无独立字段）；
   *  其余为凭据形态：单密钥 / appId+密钥签名式 */
  auth: "ai" | "key" | "appIdKey";
  fields: TranslateField[];
  docsLabel: string;
  docsUrl: string;
  /** 翻译方向 → 厂商语言码（方向由文本内容判定：中↔英，auth="ai" 无需） */
  langOf?: (to: "zh" | "en") => string;
  /** Rust 侧翻译命令（auth="ai" 走 ai_chat 流式管道，无此字段） */
  rustCmd?: string;
}

export const TRANSLATE_SERVICES: TranslateService[] = [
  {
    id: "ai",
    label: "AI 翻译",
    blurb: "用「模型服务」页的默认模型翻译，措辞灵活。",
    auth: "ai",
    fields: [],
    docsLabel: "前往模型服务",
    docsUrl: "",
  },
  {
    id: "baidu",
    label: "百度翻译",
    blurb: "响应快，有每月免费额度，适合日常快速理解。",
    auth: "appIdKey",
    fields: [
      { field: "appId", label: "APPID", placeholder: "注册后登录官网获取" },
      { field: "key", label: "API 密钥", placeholder: "与 APPID 在同一页面", secret: true },
    ],
    docsLabel: "打开官网文档",
    docsUrl: "https://fanyi-api.baidu.com/product/11",
    langOf: (to) => (to === "en" ? "en" : "zh"),
    rustCmd: "baidu_translate",
  },
  {
    id: "deepl",
    label: "DeepL",
    blurb: "译文自然，适合正式文档等重质量场景。",
    auth: "key",
    fields: [
      {
        field: "key",
        label: "Authentication Key",
        placeholder: "免费密钥以 :fx 结尾",
        secret: true,
      },
    ],
    docsLabel: "打开 DeepL API",
    docsUrl: "https://www.deepl.com/pro-api",
    langOf: (to) => (to === "en" ? "EN" : "ZH"),
    rustCmd: "deepl_translate",
  },
  {
    id: "google",
    label: "谷歌翻译",
    blurb: "译文质量稳定，有每月免费额度。",
    auth: "key",
    fields: [
      { field: "key", label: "API 密钥", placeholder: "Google Cloud 控制台获取", secret: true },
    ],
    docsLabel: "打开 Google Cloud 控制台",
    docsUrl: "https://console.cloud.google.com/apis/library/translate.googleapis.com",
    langOf: (to) => (to === "en" ? "en" : "zh-CN"),
    rustCmd: "google_translate",
  },
  {
    id: "microsoft",
    label: "微软翻译",
    blurb: "国内可直连，每月有免费额度。",
    auth: "key",
    fields: [
      { field: "key", label: "API 密钥", placeholder: "Azure 门户的密钥和终结点页", secret: true },
      {
        field: "region",
        label: "数据区域",
        placeholder: "如 japaneast；全球资源可留空",
        optional: true,
      },
    ],
    docsLabel: "打开 Azure 翻译文档",
    docsUrl: "https://learn.microsoft.com/zh-cn/azure/ai-services/translator/text-translation/overview",
    langOf: (to) => (to === "en" ? "en" : "zh-Hans"),
    rustCmd: "azure_translate",
  },
  {
    id: "youdao",
    label: "有道翻译",
    blurb: "网易有道出品，中英翻译质量好。",
    auth: "appIdKey",
    fields: [
      { field: "appId", label: "应用 ID", placeholder: "有道智云控制台创建应用获取" },
      { field: "key", label: "应用密钥", placeholder: "与应用 ID 同页获取", secret: true },
    ],
    docsLabel: "打开有道智云",
    docsUrl: "https://ai.youdao.com/console",
    langOf: (to) => (to === "en" ? "en" : "zh-CHS"),
    rustCmd: "youdao_translate",
  },
  {
    id: "tencent",
    label: "腾讯翻译",
    blurb: "腾讯云机器翻译，每月有免费额度。",
    auth: "appIdKey",
    fields: [
      { field: "appId", label: "Secret ID", placeholder: "访问管理控制台的 API 密钥" },
      { field: "key", label: "Secret Key", placeholder: "与 Secret ID 同页获取", secret: true },
      { field: "region", label: "地域", placeholder: "如 ap-guangzhou" },
    ],
    docsLabel: "打开腾讯云文档",
    docsUrl: "https://cloud.tencent.com/document/product/551/104415",
    langOf: (to) => (to === "en" ? "en" : "zh"),
    rustCmd: "tencent_translate",
  },
  {
    id: "aliyun",
    label: "阿里翻译",
    blurb: "阿里云机器翻译通用版，每月有免费额度。",
    auth: "appIdKey",
    fields: [
      { field: "appId", label: "AccessKey ID", placeholder: "访问控制 RAM 的 AccessKey" },
      { field: "key", label: "AccessKey Secret", placeholder: "与 AccessKey ID 同页", secret: true },
    ],
    docsLabel: "打开阿里云文档",
    docsUrl: "https://help.aliyun.com/zh/machine-translation/developer-reference/api-alimt-2018-10-12-translategeneral",
    langOf: (to) => (to === "en" ? "en" : "zh"),
    rustCmd: "aliyun_translate",
  },
  {
    id: "volcano",
    label: "火山翻译",
    blurb: "火山引擎机器翻译，每月有免费额度。",
    auth: "appIdKey",
    fields: [
      { field: "appId", label: "AccessKey ID", placeholder: "访问控制中创建的 API 密钥" },
      { field: "key", label: "Secret AccessKey", placeholder: "与 AccessKey ID 同页", secret: true },
    ],
    docsLabel: "打开火山引擎控制台",
    docsUrl: "https://console.volcengine.com/iam/keymanage/",
    langOf: (to) => (to === "en" ? "en" : "zh"),
    rustCmd: "volcano_translate",
  },
  {
    id: "caiyun",
    label: "彩云小译",
    blurb: "译文自然流畅，适合日常网页与文章阅读。",
    auth: "key",
    fields: [
      { field: "key", label: "API 令牌", placeholder: "彩云科技开放平台获取", secret: true },
    ],
    docsLabel: "打开彩云开放平台",
    docsUrl: "https://docs.caiyunapp.com/lingocloud-api/index.html",
    langOf: (to) => (to === "en" ? "zh2en" : "auto2zh"),
    rustCmd: "caiyun_translate",
  },
];

export const translateService = (id: string): TranslateService | undefined =>
  TRANSLATE_SERVICES.find((s) => s.id === id);

/** 服务未配置时返回提示文案（一行直给用户该做什么），由凭据字段声明推导；
 *  ai 服务看「模型服务」页的默认模型（默认模型不存在或密钥/模型名缺失 = 未配置）。
 *  设置页在开启/设默认时不拦截，浮动条在真正使用时兜底提醒——文案与判据两处共用 */
export function translateMissingReason(
  t: TranslateConfig,
  providers: Provider[],
  defaultProviderId: string,
  id: string,
): string | null {
  const svc = translateService(id);
  if (!svc) return null;
  if (svc.auth === "ai") {
    const p = providers.find((x) => x.id === defaultProviderId);
    if (!p || !p.apiKey.trim() || !p.model.trim()) {
      return "请先在模型服务页配置默认模型";
    }
    return null;
  }
  const cred = t.credentials[id] ?? {};
  const missing = svc.fields.filter(
    (f) => !f.optional && !((cred[f.field] as string) ?? "").trim(),
  );
  if (missing.length > 0) {
    return `请先填写${svc.label}的${missing.map((f) => f.label).join(" 和 ")}`;
  }
  return null;
}
