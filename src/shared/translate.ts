// 翻译服务注册表与配置完备性判据（设置页与浮动条共用）：
// 服务身份（名称/描述/凭据字段/语言码/后端命令）只在这里声明一份，设置页
// 凭据表单、未配置提示、浮动条菜单与结果窗 chips 全部由它驱动——新增厂商
// = 一条声明 + Rust 侧同名命令，其余零改动。
// 硬性约定：签名式厂商（appId+密钥）的签名算法必须对照官网文档核实实现，
// 不得凭记忆（协议细节错值不报编译错，只会在运行时静默失败）。
// 文案随界面语言：label/blurb/docsLabel/字段 label 与 placeholder 存 i18n 键
// （词典 tsvc.*），消费端展示时经 t() 解析——勿把键直出给用户。
import type { Provider, TranslateConfig } from "./types";
import { t as ti } from "./i18n";

/** 凭据字段声明：field 对应 credentials[id] 里的取值键 */
export interface TranslateField {
  field: "appId" | "key" | "region";
  /** 显示名（i18n 键） */
  label: string;
  /** 占位指引（i18n 键） */
  placeholder: string;
  /** password 输入（密钥类字段） */
  secret?: boolean;
  /** 可空字段（如微软的全球资源免填区域）：不参与未配置判定 */
  optional?: boolean;
}

export interface TranslateService {
  id: string;
  /** 显示名（i18n 键） */
  label: string;
  /** 设置页一句话描述，面向普通用户，不写协议/参数词汇（i18n 键） */
  blurb: string;
  /** "ai" = BYOK 模型服务（凭据在「模型服务」页统一管理，无独立字段）；
   *  其余为凭据形态：单密钥 / appId+密钥签名式 */
  auth: "ai" | "key" | "appIdKey";
  fields: TranslateField[];
  /** 文档入口的显示名（i18n 键） */
  docsLabel: string;
  docsUrl: string;
  /** 翻译方向 → 厂商语言码（方向跟随界面语言：目标=界面语言，原文已是界面语言时取另一种，见 floating runAction；auth="ai" 无需） */
  langOf?: (to: "zh" | "en") => string;
  /** Rust 侧翻译命令（auth="ai" 走 ai_chat 流式管道，无此字段） */
  rustCmd?: string;
}

const K = (id: string, kind: string) => `tsvc.${id}.${kind}`;
const F = (id: string, field: string, kind: "label" | "ph") =>
  `tsvc.${id}.f.${field}.${kind === "label" ? "label" : "ph"}`;

export const TRANSLATE_SERVICES: TranslateService[] = [
  {
    id: "ai",
    label: K("ai", "label"),
    blurb: K("ai", "blurb"),
    auth: "ai",
    fields: [],
    docsLabel: K("ai", "docs"),
    docsUrl: "",
  },
  {
    id: "baidu",
    label: K("baidu", "label"),
    blurb: K("baidu", "blurb"),
    auth: "appIdKey",
    fields: [
      { field: "appId", label: F("baidu", "appId", "label"), placeholder: F("baidu", "appId", "ph") },
      { field: "key", label: F("baidu", "key", "label"), placeholder: F("baidu", "key", "ph"), secret: true },
    ],
    docsLabel: K("baidu", "docs"),
    docsUrl: "https://fanyi-api.baidu.com/product/11",
    langOf: (to) => (to === "en" ? "en" : "zh"),
    rustCmd: "baidu_translate",
  },
  {
    id: "deepl",
    label: K("deepl", "label"),
    blurb: K("deepl", "blurb"),
    auth: "key",
    fields: [
      {
        field: "key",
        label: F("deepl", "key", "label"),
        placeholder: F("deepl", "key", "ph"),
        secret: true,
      },
    ],
    docsLabel: K("deepl", "docs"),
    docsUrl: "https://www.deepl.com/pro-api",
    langOf: (to) => (to === "en" ? "EN" : "ZH"),
    rustCmd: "deepl_translate",
  },
  {
    id: "google",
    label: K("google", "label"),
    blurb: K("google", "blurb"),
    auth: "key",
    fields: [
      { field: "key", label: F("google", "key", "label"), placeholder: F("google", "key", "ph"), secret: true },
    ],
    docsLabel: K("google", "docs"),
    docsUrl: "https://console.cloud.google.com/apis/library/translate.googleapis.com",
    langOf: (to) => (to === "en" ? "en" : "zh-CN"),
    rustCmd: "google_translate",
  },
  {
    id: "microsoft",
    label: K("microsoft", "label"),
    blurb: K("microsoft", "blurb"),
    auth: "key",
    fields: [
      { field: "key", label: F("microsoft", "key", "label"), placeholder: F("microsoft", "key", "ph"), secret: true },
      {
        field: "region",
        label: F("microsoft", "region", "label"),
        placeholder: F("microsoft", "region", "ph"),
        optional: true,
      },
    ],
    docsLabel: K("microsoft", "docs"),
    docsUrl: "https://learn.microsoft.com/zh-cn/azure/ai-services/translator/text-translation/overview",
    langOf: (to) => (to === "en" ? "en" : "zh-Hans"),
    rustCmd: "azure_translate",
  },
  {
    id: "youdao",
    label: K("youdao", "label"),
    blurb: K("youdao", "blurb"),
    auth: "appIdKey",
    fields: [
      { field: "appId", label: F("youdao", "appId", "label"), placeholder: F("youdao", "appId", "ph") },
      { field: "key", label: F("youdao", "key", "label"), placeholder: F("youdao", "key", "ph"), secret: true },
    ],
    docsLabel: K("youdao", "docs"),
    docsUrl: "https://ai.youdao.com/console",
    langOf: (to) => (to === "en" ? "en" : "zh-CHS"),
    rustCmd: "youdao_translate",
  },
  {
    id: "tencent",
    label: K("tencent", "label"),
    blurb: K("tencent", "blurb"),
    auth: "appIdKey",
    fields: [
      { field: "appId", label: F("tencent", "appId", "label"), placeholder: F("tencent", "appId", "ph") },
      { field: "key", label: F("tencent", "key", "label"), placeholder: F("tencent", "key", "ph"), secret: true },
      { field: "region", label: F("tencent", "region", "label"), placeholder: F("tencent", "region", "ph") },
    ],
    docsLabel: K("tencent", "docs"),
    docsUrl: "https://cloud.tencent.com/document/product/551/104415",
    langOf: (to) => (to === "en" ? "en" : "zh"),
    rustCmd: "tencent_translate",
  },
  {
    id: "aliyun",
    label: K("aliyun", "label"),
    blurb: K("aliyun", "blurb"),
    auth: "appIdKey",
    fields: [
      { field: "appId", label: F("aliyun", "appId", "label"), placeholder: F("aliyun", "appId", "ph") },
      { field: "key", label: F("aliyun", "key", "label"), placeholder: F("aliyun", "key", "ph"), secret: true },
    ],
    docsLabel: K("aliyun", "docs"),
    docsUrl: "https://help.aliyun.com/zh/machine-translation/developer-reference/api-alimt-2018-10-12-translategeneral",
    langOf: (to) => (to === "en" ? "en" : "zh"),
    rustCmd: "aliyun_translate",
  },
  {
    id: "volcano",
    label: K("volcano", "label"),
    blurb: K("volcano", "blurb"),
    auth: "appIdKey",
    fields: [
      { field: "appId", label: F("volcano", "appId", "label"), placeholder: F("volcano", "appId", "ph") },
      { field: "key", label: F("volcano", "key", "label"), placeholder: F("volcano", "key", "ph"), secret: true },
    ],
    docsLabel: K("volcano", "docs"),
    docsUrl: "https://console.volcengine.com/iam/keymanage/",
    langOf: (to) => (to === "en" ? "en" : "zh"),
    rustCmd: "volcano_translate",
  },
  {
    id: "caiyun",
    label: K("caiyun", "label"),
    blurb: K("caiyun", "blurb"),
    auth: "key",
    fields: [
      { field: "key", label: F("caiyun", "key", "label"), placeholder: F("caiyun", "key", "ph"), secret: true },
    ],
    docsLabel: K("caiyun", "docs"),
    docsUrl: "https://docs.caiyunapp.com/lingocloud-api/index.html",
    langOf: (to) => (to === "en" ? "zh2en" : "auto2zh"),
    rustCmd: "caiyun_translate",
  },
];

export const translateService = (id: string): TranslateService | undefined =>
  TRANSLATE_SERVICES.find((s) => s.id === id);

/** 服务未配置时返回提示文案（一行直给用户该做什么），由凭据字段声明推导；
 *  ai 服务看「模型服务」页的默认模型（默认模型不存在或密钥/模型名缺失 = 未配置）。
 *  设置页在开启/设默认时不拦截，浮动条在真正使用时兜底提醒——文案与判据两处共用。
 *  服务名/字段名经 t() 随界面语言解析 */
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
      return ti("tsvc.missingModel");
    }
    return null;
  }
  const cred = t.credentials[id] ?? {};
  const missing = svc.fields.filter(
    (f) => !f.optional && !((cred[f.field] as string) ?? "").trim(),
  );
  if (missing.length > 0) {
    const fields = missing.map((f) => ti(f.label)).join(ti("common.and"));
    return ti("tsvc.missingFields", { service: ti(svc.label), fields });
  }
  return null;
}
