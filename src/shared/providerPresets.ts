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
  /** 显示名（i18n 键，ppreset.<id>.label）；消费端经 t() 解析 */
  label: string;
  /** 支持的形态与对应端点前缀；首项 = 新建卡的默认形态。
   *  形态来源（2026-10 官方文档核实）：OpenAI/方舟/百炼/OpenRouter 同 base 拼
   *  路径后缀；智谱 Responses 独立基址 /api/v1；其余厂商暂只核实到 chat */
  forms: ProviderFormEntry[];
  /** 模型名输入框的占位指引（去哪获取；i18n 键 ppreset.<id>.hint） */
  hint: string;
}

const R = (baseUrl: string): ProviderFormEntry => ({ form: "responses", baseUrl });
const C = (baseUrl: string): ProviderFormEntry => ({ form: "chat", baseUrl });

export const PRESET_PROVIDERS: ProviderPreset[] = [
  {
    id: "deepseek",
    label: "ppreset.deepseek.label",
    forms: [C("https://api.deepseek.com")],
    hint: "ppreset.deepseek.hint",
  },
  {
    id: "doubao",
    label: "ppreset.doubao.label",
    forms: [
      C("https://ark.cn-beijing.volces.com/api/v3"),
      R("https://ark.cn-beijing.volces.com/api/v3"),
    ],
    hint: "ppreset.doubao.hint",
  },
  {
    id: "zhipu",
    label: "ppreset.zhipu.label",
    forms: [
      C("https://open.bigmodel.cn/api/paas/v4"),
      R("https://open.bigmodel.cn/api/v1"),
    ],
    hint: "ppreset.zhipu.hint",
  },
  {
    id: "kimi",
    label: "ppreset.kimi.label",
    forms: [C("https://api.moonshot.cn/v1")],
    hint: "ppreset.kimi.hint",
  },
  {
    id: "qwen",
    label: "ppreset.qwen.label",
    forms: [
      C("https://dashscope.aliyuncs.com/compatible-mode/v1"),
      R("https://dashscope.aliyuncs.com/compatible-mode/v1"),
    ],
    hint: "ppreset.qwen.hint",
  },
  {
    id: "mimo",
    label: "ppreset.mimo.label",
    forms: [C("https://api.xiaomimimo.com/v1")],
    hint: "ppreset.mimo.hint",
  },
  {
    id: "siliconflow",
    label: "ppreset.siliconflow.label",
    forms: [C("https://api.siliconflow.cn/v1")],
    hint: "ppreset.siliconflow.hint",
  },
  {
    id: "openai",
    label: "ppreset.openai.label",
    forms: [
      R("https://api.openai.com/v1"),
      C("https://api.openai.com/v1"),
    ],
    hint: "ppreset.openai.hint",
  },
  {
    id: "xai",
    label: "ppreset.xai.label",
    forms: [C("https://api.x.ai/v1")],
    hint: "ppreset.xai.hint",
  },
  {
    id: "openrouter",
    label: "ppreset.openrouter.label",
    forms: [
      C("https://openrouter.ai/api/v1"),
      R("https://openrouter.ai/api/v1"),
    ],
    hint: "ppreset.openrouter.hint",
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
