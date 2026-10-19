// 模型服务预设注册表（与 translate.ts 同范式）：添加服务 = 选预设，名称/地址/形态
// 自动带出，用户填密钥与模型名；「自定义」保留手填全项的兜底路径。
// 刻意不预设模型名：厂商迭代太快，写死必过时——hint 只指引去哪查。
// 形态（form）：不同形态的端点 URL 可能完全不同（智谱 chat=/api/paas/v4、
// responses=/api/v1），因此每个形态各带各的 baseUrl；切形态时连同地址一起切换。
export interface ProviderFormEntry {
  form: "chat" | "responses";
  baseUrl: string;
}

export interface ProviderPreset {
  id: string;
  label: string;
  /** 支持的形态与对应端点前缀；首项 = 新建卡的默认形态。
   *  形态来源（2026-10 官方文档核实）：OpenAI/方舟/百炼/OpenRouter 同 base 拼
   *  路径后缀；智谱 Responses 独立基址 /api/v1；其余厂商暂只核实到 chat */
  forms: ProviderFormEntry[];
  /** 模型名输入框的占位指引（去哪获取） */
  hint: string;
}

const R = (baseUrl: string): ProviderFormEntry => ({ form: "responses", baseUrl });
const C = (baseUrl: string): ProviderFormEntry => ({ form: "chat", baseUrl });

export const PRESET_PROVIDERS: ProviderPreset[] = [
  {
    id: "deepseek",
    label: "DeepSeek",
    forms: [C("https://api.deepseek.com")],
    hint: "模型名见 DeepSeek 开放平台文档",
  },
  {
    id: "doubao",
    label: "火山引擎（豆包）",
    forms: [
      C("https://ark.cn-beijing.volces.com/api/v3"),
      R("https://ark.cn-beijing.volces.com/api/v3"),
    ],
    hint: "模型名或 ep- 开头的接入点，方舟控制台获取",
  },
  {
    id: "zhipu",
    label: "智谱",
    forms: [
      C("https://open.bigmodel.cn/api/paas/v4"),
      R("https://open.bigmodel.cn/api/v1"),
    ],
    hint: "模型名见智谱开放平台",
  },
  {
    id: "kimi",
    label: "Kimi",
    forms: [C("https://api.moonshot.cn/v1")],
    hint: "模型名见 Kimi 开放平台",
  },
  {
    id: "qwen",
    label: "通义千问",
    forms: [
      C("https://dashscope.aliyuncs.com/compatible-mode/v1"),
      R("https://dashscope.aliyuncs.com/compatible-mode/v1"),
    ],
    hint: "模型名见阿里云百炼控制台",
  },
  {
    id: "mimo",
    label: "小米 MiMo",
    forms: [C("https://api.xiaomimimo.com/v1")],
    hint: "模型名见小米 MiMo 开放平台",
  },
  {
    id: "siliconflow",
    label: "硅基流动",
    forms: [C("https://api.siliconflow.cn/v1")],
    hint: "模型名见硅基流动模型广场",
  },
  {
    id: "openai",
    label: "OpenAI",
    forms: [
      R("https://api.openai.com/v1"),
      C("https://api.openai.com/v1"),
    ],
    hint: "模型名见 platform.openai.com",
  },
  {
    id: "xai",
    label: "xAI",
    forms: [C("https://api.x.ai/v1")],
    hint: "模型名见 xAI 文档",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    forms: [
      C("https://openrouter.ai/api/v1"),
      R("https://openrouter.ai/api/v1"),
    ],
    hint: "填 slug（厂商/模型 形式），OpenRouter 官网查询",
  },
];

/** 按服务地址反查预设与所在形态项（切形态换地址后仍能命中同一预设） */
export function presetByBaseUrl(
  baseUrl: string,
): { preset: ProviderPreset; entry: ProviderFormEntry } | undefined {
  const url = baseUrl.trim();
  for (const preset of PRESET_PROVIDERS) {
    const entry = preset.forms.find((f) => f.baseUrl === url);
    if (entry) return { preset, entry };
  }
  return undefined;
}

/** 取预设某形态的端点项 */
export const formEntryOf = (
  preset: ProviderPreset,
  form: "chat" | "responses",
): ProviderFormEntry | undefined => preset.forms.find((f) => f.form === form);
