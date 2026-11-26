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
  /** 二维码载荷（识图来源）：截图里解码出的码内容，Rust 侧 rqrr 解出后随
   *  识别结果透传；划词路径恒空 */
  qr: string[];
  /** 本机路径（Windows）：整段选区就是一个路径时独占这一组（见 textContext.extractPath） */
  path: string[];
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
  { id: "qr", label: "floating.group.qr" },
  { id: "path", label: "floating.group.path" },
  { id: "code", label: "floating.group.code" },
  { id: "date", label: "floating.group.date" },
  { id: "addr", label: "floating.group.addr" },
];

// 状态机：Bar（胶囊） → Result（流式面板）/ Extract（多值列表）；dismiss/新选区回收
// Snip（截图胶囊）：框选完成、动作未选——固定动作组（识别文字/二维码/识图
// AI 三件）点击走 snip_execute（识别
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
      /** 二维码载荷（识图来源；划词路径恒空） */
      barcodes?: string[];
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
      /** 二维码载荷（截图里解码出的码内容；划词导流恒空） */
      barcodes?: string[];
      /** 视觉分流：文本未识别，动作直接看图（imagePath）驱动模型；流前失败
       *  回退本地识别后置 false。划词导流/本地识别结果不带 */
      vision?: boolean;
      /** 识别截图路径（视觉分流的模型输入与预览源；回退重截成功时更新） */
      imagePath?: string | null;
      /** 识别原文含表格时默认渲染表格预览；true = 用户切到了编辑模式（显示
       *  原始 Markdown 文本）。无表格时无意义 */
      sourceRaw?: boolean;
    };

// Rust ocr_take_pending 回包：识别文本 + 自动执行指令 + 钉住偏好
export interface PendingView {
  text: string;
  /** 截图里解出的二维码载荷（无码为空数组） */
  barcodes: string[];
  fromOcr: boolean;
  /** 视觉分流：true = 文本未识别，前端直接看图驱动模型 */
  vision: boolean;
  pinned: boolean;
  hasImage: boolean;
  /** 截图路径（Rust PendingResult.image 字段名，勿写成 imagePath：
   *  invoke 回包不做运行时校验，字段名拼错只会拿到 undefined） */
  image: string | null;
  run: { id: string; service: string | null } | null;
  pid: number;
  /** 选区来源应用路径（划词导流携带；截屏 OCR 为空串） */
  app: string;
}

// Rust ocr_recognize_local 回包（视觉流前失败的前端回退）：本地识别文本 +
// 可选的自愈重截替换图（原糊图已删，预览/引用需切到新图）
export interface OcrLocalResult {
  text: string;
  /** 截图里解出的二维码载荷（无码为空数组） */
  barcodes: string[];
  image: string | null;
}
