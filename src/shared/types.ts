// 与 src-tauri/src/settings.rs 的 Settings 保持一致（serde camelCase）
export interface Provider {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface ActionFlags {
  translate: boolean;
  explain: boolean;
  summarize: boolean;
  copy: boolean;
  search: boolean;
  /** 上下文动作：选中文本为 URL 时出现「打开链接」 */
  link: boolean;
  /** 上下文动作：选中文本为邮箱时出现「写邮件」 */
  email: boolean;
  /** 上下文动作：选中文本含验证码时出现「复制验证码」 */
  code: boolean;
  /** 上下文动作：选中文本含电话号码时出现「复制号码」 */
  tel: boolean;
  /** 上下文动作：选中文本含日期时出现「加入日历」 */
  date: boolean;
  /** 上下文动作：选中文本含地点时出现「打开地图」 */
  addr: boolean;
}

export interface SearchEngine {
  name: string;
  /** 链接模板，{q} 为选中文本 */
  url: string;
  enabled: boolean;
}

export interface TranslateConfig {
  /** 启用的翻译服务（多选，浮动条「翻译」展开列表）：["ai", "baidu", "deepl"] */
  enabled: string[];
  /** 默认服务（浮动条「翻译」单击直达） */
  default: string;
  /** 服务展示顺序（设置页行序与浮动条展开顺序）；缺省 id 按注册表顺序追加 */
  order: string[];
  /** 百度翻译开放平台凭据 */
  appId: string;
  appKey: string;
  /** DeepL Authentication Key（Free 密钥以 :fx 结尾） */
  deeplKey: string;
}

/** 用户自定义 AI 动作：与内置三动作同属注册表，只是 prompt 由用户持有 */
export interface CustomAction {
  /** 前缀 "c:" 与内置 id 隔离，actionOrder / actionPrompts 直接引用它 */
  id: string;
  /** 胶囊上的显示名，建议 ≤6 字 */
  name: string;
  /** system 提示词（user 消息固定为选中文本）；空 = 未配置，动作条上不可执行 */
  prompt: string;
  enabled: boolean;
  /** 自定义图标：lucide 组件名（见 shared/icons.tsx 名单）；未设置 = 默认 Sparkles */
  icon?: string;
  /** 预留：挂到某内置动作的二级展开列表（变体挂载），当前未实现 */
  under?: string;
}

export interface Settings {
  providers: Provider[];
  defaultProviderId: string;
  actions: ActionFlags;
  /** 动作展示顺序（浮动条按此渲染）；缺省 id 追加在末尾 */
  actionOrder: string[];
  /** 用户自定义 AI 动作（与 actionOrder 混排，上限 10 个） */
  customActions: CustomAction[];
  /** 浮动胶囊固定显示的动作数（超出收进「⌄N」面板；默认 4） */
  capsuleShowCount: number;
  /** 搜索引擎列表（浮动条「搜索」使用；defaultSearch 为单击直达的引擎） */
  searchEngines: SearchEngine[];
  defaultSearch: string;
  /** 翻译动作的服务配置 */
  translate: TranslateConfig;
  /** AI 动作提示词覆盖（key = 动作 id；缺省或空 = 跟随内置默认，见 shared/actions.ts DEFAULT_PROMPTS） */
  actionPrompts: Record<string, string>;
  /** 是否在 macOS Dock 显示图标（关 = 纯菜单栏常驻模式） */
  showDockIcon: boolean;
  /** 识图取字全局快捷键（如 "Alt+O"、"CmdOrCtrl+Shift+O"；空串 = 禁用） */
  ocrShortcut: string;
  /** 识图翻译全局快捷键（截图→识别→默认翻译服务；空串 = 禁用） */
  ocrTranslateShortcut: string;
  /** 识图解释全局快捷键（截图→识别→AI 解释；空串 = 禁用） */
  ocrExplainShortcut: string;
  /** 识图总结全局快捷键（截图→识别→AI 总结；空串 = 禁用） */
  ocrSummarizeShortcut: string;
  appBlacklist: string[];
  debounceMs: number;
  /** 结果窗口位置记忆（逻辑坐标） */
  resultWindowPos?: [number, number] | null;
  /** 结果窗口尺寸记忆 */
  resultWindowSize?: [number, number] | null;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

// ai_chat Channel 流消息（对应 src-tauri/src/ai.rs AiEvent）
export type AiEvent =
  | { type: "delta"; content: string }
  | { type: "done" }
  | { type: "error"; message: string };
