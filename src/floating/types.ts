// src/floating/types.ts —— 浮动条工程的领域类型（App.tsx 拆分中多文件共用）。
// Phase 是「胶囊 → 结果面板/提取面板」的状态机取值域，useCaptureSession /
// useOcrPipeline / App 渲染层三方共同消费；PendingView 是 Rust 侧 ocr_take_pending
// 的回包形状。其余（窗口身份/平台常量/浮层菜单取值域）见 env.ts。
import type { AiEventItem } from "../shared/aiExtract";

// 上下文智能动作的分组载体：由「提取信息」统一承载（多值/混合进面板），
// 不再逐个上胶囊条（id 集合见 shared/actions.ts CONTEXT_ACTION_IDS）
export type ExtractGroups = {
  tel: string[];
  email: string[];
  link: string[];
  code: string[];
  date: string[];
  addr: string[];
};

// 分组顺序/文案（渲染与 dominantGroup 共用）。label 是 i18n 键（floating.group.*），
// 渲染端 t() 解析
export const EXTRACT_GROUPS: Array<{ id: keyof ExtractGroups; label: string }> = [
  { id: "tel", label: "floating.group.tel" },
  { id: "email", label: "floating.group.email" },
  { id: "link", label: "floating.group.link" },
  { id: "code", label: "floating.group.code" },
  { id: "date", label: "floating.group.date" },
  { id: "addr", label: "floating.group.addr" },
];

// 状态机：Bar（胶囊） → Result（流式面板）/ Extract（多值列表）；dismiss/新选区回收
// Snip（截图胶囊）：框选完成、动作未选——四件套动作点击走 snip_execute（识别
// 后再执行），不走 runAction（无文本源）；dismiss/新划词由 useCaptureSession 清理
export type Phase =
  | { kind: "bar" }
  | { kind: "snip" }
  | {
      kind: "extract";
      /** 主要实体类型（决定面板图标） */
      actionId: string;
      label: string;
      groups: ExtractGroups;
      /** 原始选中文本：日期实体异步合并、「加入日历」行点击时重检测用 */
      text?: string;
      /** AI 语义提取的结构化事件（非空时日期组按此渲染，点击直接写日历，不再重检测） */
      events?: AiEventItem[];
      /** AI 提取进行中：日期/地点的确定性识别暂缓兜底，等 AI 结果定夺 */
      aiPending?: boolean;
      /** 确定性日期/地点识别已回填过（含回填为空），防止 effect 重复拉取 */
      deterministicLoaded?: boolean;
      /** 选区来源页面 URL（浏览器地址栏，面板打开时现查）：提交 AI 的来源上下文，
       * 写日历时优先于选区内提取的链接（活动页往往链接不在选区文本里） */
      sourceUrl?: string;
    }
  | {
      /** OCR 识图取字：合并面板（文本可见 + 动作内嵌 + 结果流式）。
          fromOcr = 识别来源（显示钉图/识图取字标题）；false = 划词导流结果 */
      kind: "ocr";
      text: string;
      fromOcr: boolean;
      actionId: string | null;
      output: string;
      streaming: boolean;
      error: string | null;
      expanded: boolean;
      /** 机器翻译结果按纯文本渲染（API 返回即纯文本，不进 markdown 解释） */
      plain?: boolean;
    };

// Rust ocr_take_pending 回包：识别文本 + 自动执行指令 + 钉住偏好
export interface PendingView {
  text: string;
  fromOcr: boolean;
  pinned: boolean;
  hasImage: boolean;
  imagePath: string | null;
  run: { id: string; service: string | null } | null;
  pid: number;
}
