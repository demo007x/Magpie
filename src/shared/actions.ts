import type { ChatMessage } from "./types";

// 动作注册表：新增动作 = 注册一个对象，Rust / 窗口 / 设置零改动（M2 起可扩展自定义动作）
// kind "ai" = 走模型流式；"local" = 前端本地处理（如复制选中文本）
// 上下文动作（link/email/code/tel）的可见性由浮动条「提取信息」统一决策（见 floating/App.tsx），
// 不使用 when 谓词；when 机制保留给未来其他上下文动作。
export interface ActionDef {
  id: string;
  label: string;
  kind?: "ai" | "local";
  buildMessages?(text: string): ChatMessage[];
  when?(text: string): boolean;
}

const SYSTEM_BASE =
  "你是拾趣，一个简洁准确的知识助手。直接给结果，不客套、不重复用户输入。输出语言：中文内容用简体中文回答，外文内容译答为简体中文（翻译动作除外，见其模板）。";

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
    buildMessages(text) {
      return [
        {
          role: "system",
          content:
            "你是专业翻译。检测输入语言：中文→译成地道英文；其他语言→译成简体中文。保留专有名词与格式。" +
            "按以下结构输出，除此之外不要输出任何内容：\n" +
            "【译文】\n译文正文\n" +
            "【要点】（学习辅助，可选：仅当原文包含值得解释的关键词、短语或语法点时输出，最多 3 条，每行「词 — 简明释义」；普通句子无则整节省略）",
        },
        { role: "user", content: text },
      ];
    },
  },
  {
    id: "explain",
    label: "解释",
    buildMessages(text) {
      return [
        {
          role: "system",
          content: `${SYSTEM_BASE} 当前任务：解释用户选中的内容——它是什么/为什么重要/关键点。用 2-4 段短文，术语首次出现给简明定义。`,
        },
        { role: "user", content: text },
      ];
    },
  },
  {
    id: "summarize",
    label: "总结",
    buildMessages(text) {
      return [
        {
          role: "system",
          content:
            "你是摘要助手。将选中内容提炼为要点：≤5 条 bullet，每条 ≤20 字，按重要性排序。只输出要点，不加前言总结语。",
        },
        { role: "user", content: text },
      ];
    },
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
