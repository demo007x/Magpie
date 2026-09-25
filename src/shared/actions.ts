// 动作注册表：内置动作写在这里（新增内置 = 注册一个对象，Rust / 窗口 / 设置零改动），
// 用户自定义动作存 settings.customActions，经 actionRegistry() 合并成消费端视图。
// kind "ai" = 走模型流式（内置动作提示词见 DEFAULT_PROMPTS，可在设置页「Prompt 设置」覆盖；
// 自定义动作的 prompt 随对象带过来）；"local" = 前端本地处理（如复制选中文本）
// 上下文动作（link/email/code/tel）的可见性由浮动条「提取信息」统一决策（见 floating/App.tsx），
// 不使用 when 谓词；when 机制保留给未来其他上下文动作。
import type { CustomAction } from "./types";

export interface ActionDef {
  id: string;
  label: string;
  kind?: "ai" | "local";
  /** 自定义动作的 system 提示词；内置动作不带此字段，走 DEFAULT_PROMPTS + actionPrompts 覆盖 */
  prompt?: string;
  /** 自定义动作的 lucide 图标名（shared/icons.tsx）；内置动作不带此字段 */
  icon?: string;
  when?(text: string): boolean;
}

/** 自定义动作 id 前缀：与内置 id 隔离，actionOrder 里两种 id 混排 */
export const CUSTOM_ID_PREFIX = "c:";

/** 注册表合并视图：内置在前、自定义在后（各自再按 actionOrder 排）。
    传入前请自行过滤 enabled——这里只管形状，不管开关语义 */
export function actionRegistry(custom: CustomAction[] = []): ActionDef[] {
  return [
    ...ACTIONS,
    ...custom.map((c) => ({
      id: c.id,
      label: c.name,
      kind: "ai" as const,
      prompt: c.prompt,
      icon: c.icon,
    })),
  ];
}

export type AiActionId = "translate" | "explain" | "summarize";

// 内置默认提示词（系统内置，用户只读参考；自定义值存 settings.actionPrompts，恢复默认 = 删除覆盖项）。
// 每条自包含——最终发送的 system 就是这一整段，不存在拼接出去的隐藏指令，
// 这样设置页「所见即所发」才成立。改这里的文案要同步设置页的默认展示。
export const DEFAULT_PROMPTS: Record<AiActionId, string> = {
  translate: `你是专业译者。把用户提供的文本翻译为地道的目标语言，只做翻译这一件事。

目标语言：中文→英文；其他语言→简体中文。
译文策略：
- 先判断文本的领域与语体（技术/学术/商务/口语/文学），译文保持同等语域，不要把专业术语口语化
- 术语优先采用该领域通行译法；无通行译法时保留原文并在【要点】中说明
- 人名、品牌、代码、URL、占位符原样保留；数字与单位按目标语言习惯处理
- 保持原文的段落、换行与列表结构，不合并、不拆分

输出格式（严格遵守，除此之外不输出任何内容）：
【译文】
（译文正文，纯文本，不加引用块 > 与代码块装饰）
【要点】
（可选，最多 3 条，仅当原文有值得学习的关键词/短语/语法点时输出，每行「词 — 简明释义」；无则整节连同标题一起省略）

不确定的地方宁可直译，不要编造。不解释、不客套、不复述原文。`,

  explain: `你是一个简洁准确的知识助手。解释用户选中的内容，直接给结果，不客套、不复述原文。
回答语言：简体中文（原文为中文时同样用简体中文）。

按选区粒度自适应，不要用同一套篇幅应对所有内容：
- 单词/术语：是什么 + 一句话关键点，必要时给一个常见搭配或例子
- 短语/句子：说清它在说什么，以及为什么这么说（背景、机制、意图）
- 段落/长文：先给一句结论，再讲 2-3 个关键点，术语首次出现给简明定义
长内容用 2-4 段短文；短内容两三句即可，不要为凑段落注水。

有具体例子或类比能让理解更快时，给一个，但控制在一句之内。
超出选中范围才能确定的信息，明确标注不确定，不要猜测；内容过于零散或语义不明以致无法解释时，
直接说明并请用户提供更完整的文本。`,

  summarize: `你是摘要助手。把用户选中的内容提炼为要点，直接输出要点，不加前言、不加总结语。
输出语言与原文一致（原文为中文则中文输出，外文则用简体中文概括）。

条数与粒度按内容体量自适应：
- 短文本（一两句）：1-2 条即可，不要拆碎
- 中等段落：3-5 条
- 长文：5-8 条，按重要性降序
每条一行，控制在 30 字以内，写结论本身而不是「文章谈了……」这类元描述。
原文中的关键数字、结论、限定条件（时间、范围、例外）必须保留，不要为了简洁丢掉。
内容过于零散或不含有效信息时，不要强行归纳，直接说明并请用户提供更完整的文本。`,
};

export const AI_ACTION_IDS = Object.keys(DEFAULT_PROMPTS) as AiActionId[];

/** 当前生效提示词：用户覆盖优先，空/空白回落内置默认 */
export function effectivePrompt(
  id: AiActionId,
  overrides?: Partial<Record<string, string>>,
): string {
  const custom = overrides?.[id];
  return custom && custom.trim() ? custom : DEFAULT_PROMPTS[id];
}

/** 动作生效提示词：自定义动作就是它自己那份 prompt，内置动作走覆盖/默认回落。
    两者都是"最终发出的 system 文本"，设置页因此可以继续宣称所见即所发 */
export function actionPrompt(
  action: ActionDef,
  overrides?: Partial<Record<string, string>>,
): string {
  return action.prompt ?? effectivePrompt(action.id as AiActionId, overrides);
}

export const ACTIONS: ActionDef[] = [
  {
    id: "copy",
    label: "复制",
    kind: "local",
  },
  {
    id: "search",
    label: "搜索",
    kind: "local",
  },
  {
    id: "translate",
    label: "翻译",
    kind: "ai",
  },
  {
    id: "explain",
    label: "解释",
    kind: "ai",
  },
  {
    id: "summarize",
    label: "总结",
    kind: "ai",
  },
  {
    id: "link",
    label: "打开链接",
    kind: "local",
  },
  {
    id: "email",
    label: "写邮件",
    kind: "local",
  },
  {
    id: "code",
    label: "复制验证码",
    kind: "local",
  },
  {
    id: "tel",
    label: "复制号码",
    kind: "local",
  },
];

export function actionById(id: string): ActionDef | undefined {
  return ACTIONS.find((a) => a.id === id);
}

/** 上下文动作：选中内容里出现对应实体才上胶囊，因此它们的相互顺序对胶囊无意义
    （恰好一个 → 该动作单独出现；多个 → 合并成一个「提取信息」按钮）。
    设置页据此把它们与常驻动作分成两张卡（见 main/App.tsx） */
export const CONTEXT_ACTION_IDS = new Set(["link", "email", "tel", "code"]);
export const isContextAction = (id: string) => CONTEXT_ACTION_IDS.has(id);
