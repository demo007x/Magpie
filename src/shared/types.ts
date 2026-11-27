// 与 src-tauri/src/settings.rs 的 Settings 保持一致（serde camelCase）
export interface Provider {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 请求形态："chat" = OpenAI Chat Completions（默认，兼容绝大多数厂商）；
   *  "responses" = OpenAI Responses API（input/reasoning.effort/类型化 SSE 事件） */
  form?: "chat" | "responses";
  /** 思考模式：仅对支持的厂商生效（DeepSeek/智谱按服务地址自动识别注入
   *  thinking.type 参数）；未知厂商不传参、保持厂商默认行为。默认关闭 */
  thinking?: boolean;
}

export interface ActionFlags {
  translate: boolean;
  explain: boolean;
  summarize: boolean;
  copy: boolean;
  search: boolean;
  /** 胶囊动作：朗读选中的内容（需已下载音色包，未装时点击给下载指引） */
  speak: boolean;
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
  /** 上下文动作（仅 Windows）：整段选区就是一个本机路径时出现「打开位置」 */
  path: boolean;
  /** 接入动作：已配置 Obsidian vault 时出现「Obsidian」（笔记/任务/卡片） */
  obsidian: boolean;
  /** 接入动作：已连接 AnkiConnect（deck 非空）时出现「Anki」划词建卡 */
  anki: boolean;
  /** 本地动作：本机词库可用时出现「词典」离线查词（不联网、不用 AI） */
  dict: boolean;
}

export interface SearchEngine {
  name: string;
  /** 链接模板，{q} 为选中文本 */
  url: string;
  enabled: boolean;
}

/** 单个翻译服务的凭据：单密钥服务只用 key；签名式（appId+密钥）两者都用；
 *  region 供微软/腾讯等按区域接入的厂商填写（全球/默认区可空） */
export interface TranslateCredentials {
  appId?: string;
  key?: string;
  region?: string;
}

export interface TranslateConfig {
  /** 启用的翻译服务（多选，浮动条「翻译」展开列表）：["ai", "baidu", "deepl"] */
  enabled: string[];
  /** 默认服务（浮动条「翻译」单击直达） */
  default: string;
  /** 服务展示顺序（设置页行序与浮动条展开顺序）；缺省 id 按注册表顺序追加 */
  order: string[];
  /** 各服务凭据（key = 服务 id，字段取值见注册表 fields 声明）；
   *  旧版平铺字段由 Rust 载入时一次性迁移进这里 */
  credentials: Record<string, TranslateCredentials>;
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

/** Obsidian 接入配置（docs/07）：vault 文件直写——划词/识图/结果按模板落进 vault。
 *  vaultPath 为空 = 未接入，相关动作不出现。追加为无状态一次性送达，不建队列。 */
export interface ObsidianConfig {
  /** vault 根目录（空 = 未接入） */
  vaultPath: string;
  /** 日记子目录（相对 vault 根；空 = 根目录） */
  dailyFolder: string;
  /** 日记文件名格式（默认 yyyy-MM-DD，与 Obsidian Daily Notes 插件约定互认） */
  dailyFileName: string;
  /** 任务目标文件（相对 vault；空 = 写入当日日记） */
  taskFile: string;
  /** 知识卡目录（相对 vault） */
  cardFolder: string;
  /** 摘录块模板（变量 {text}/{source}/{time}/{date}） */
  excerptTemplate: string;
  /** 任务行模板（变量 {text} 任务内容 · {due} 截止日期 yyyy-MM-dd · {dueTag} "📅 日期"或空） */
  taskTemplate: string;
  /** 知识卡内容模板（变量 {text}/{source}/{time}/{date}）；一卡一文件，写入知识卡目录 */
  cardTemplate: string;
}

/** Anki 接入配置：经 AnkiConnect 本地 HTTP 一键建卡。
 *  deck 为空 = 未接入，相关动作不出现。无状态一次性送达：写入本地集合即完，
 *  多端同步归 Anki 自身，不建队列。 */
export interface AnkiConfig {
  /** AnkiConnect 地址（默认本机 8765；Rust 侧仅允许回环地址） */
  connectUrl: string;
  /** 默认牌组（空 = 未接入） */
  deck: string;
  /** ⌄ 菜单牌组列表缓存（连接测试时实拉 deckNames 存入） */
  decks: string[];
  /** 笔记类型列表缓存（连接测试时实拉；设置页下拉用） */
  models: string[];
  /** 笔记类型（addNote 的 modelName） */
  modelName: string;
  /** 标签模板（空格分隔；变量 {date}/{source}） */
  tags: string;
  /** 主按钮默认卡型：auto = 按划词长短自动选；word = 单词卡；content = 内容卡 */
  defaultCard: string;
}

/** 离线词典配置（ADR-12）：只读用户本机已有的兼容词库文件——不随安装包分发、
 *  本版不做下载器。dbPath 空 = 自动探测（装过兼容词典应用时即命中）。 */
export interface DictConfig {
  /** 英→汉词库文件绝对路径（空 = 自动探测） */
  dbPath: string;
  /** 汉→英词库文件绝对路径（CC-CEDICT 转换库；空 = 未接入） */
  zhEnPath: string;
}

/** 本地朗读配置：默认音色 + 功能开关（模型是否已安装由 Rust 侧文件系统判定） */
export interface TtsConfig {
  /** 中文默认音色（Kokoro voice id） */
  zhVoice: number;
  /** 英文默认音色 */
  enVoice: number;
  /** 朗读功能开关（关闭即自动卸载音色包） */
  enabled: boolean;
  /** 语速（引擎 length-scale 系数）：1.2 慢 / 1.0 正常 / 0.85 快 */
  speed: number;
}

export interface Settings {
  providers: Provider[];
  defaultProviderId: string;
  actions: ActionFlags;
  /** 识图用模型处理：四个能力分别开关（识别文字/翻译/解释/总结直接看图）。
   *  默认全关 = 恒走本地识别；开启且默认模型服务已配置密钥即生效，请求失败
   *  自动回退本地识别。qr 例外：纯本机解码开关，只控制二维码入口显隐（默认开） */
  vision: {
    ocr: boolean;
    translate: boolean;
    explain: boolean;
    summarize: boolean;
    qr: boolean;
  };
  /** Obsidian 接入配置（vault 直写；vaultPath 空 = 未接入） */
  obsidian: ObsidianConfig;
  /** Anki 接入配置（AnkiConnect 建卡；deck 空 = 未接入） */
  anki: AnkiConfig;
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
  /** AI 动作提示词覆盖（key = 动作 id；缺省或空 = 跟随当前界面语言的内置默认，见 shared/actions.ts defaultPrompt） */
  actionPrompts: Record<string, string>;
  /** 是否在 macOS Dock 显示图标（关 = 纯菜单栏常驻模式） */
  showDockIcon: boolean;
  /** 登录时自动启动（LaunchAgent；开关即时生效，Rust 落盘） */
  launchAtLogin: boolean;
  /** 识图取字全局快捷键（如 "Alt+O"、"CmdOrCtrl+Shift+O"；空串 = 禁用） */
  ocrShortcut: string;
  /** 识图翻译全局快捷键（截图→识别→默认翻译服务；空串 = 禁用） */
  ocrTranslateShortcut: string;
  /** 识图解释全局快捷键（截图→识别→AI 解释；空串 = 禁用） */
  ocrExplainShortcut: string;
  /** 识图总结全局快捷键（截图→识别→AI 总结；空串 = 禁用） */
  ocrSummarizeShortcut: string;
  /** 访达选图取字全局快捷键（选图片文件→识别；空串 = 禁用） */
  fileOcrShortcut: string;
  appBlacklist: string[];
  /** 兼容取词允许清单（仅 Windows）：逐应用授权「读不到选区时借用一次复制」。
   *  空 = 拾趣绝不代按任何键。条目与 appBlacklist 同一套标识（exe 文件名） */
  compatApps: string[];
  debounceMs: number;
  /** 是否启用「按住辅助键才划词弹出」（issue #14）：false = 选中即弹。
   *  UI 在快捷键页，与 captureAssistKey 组成「开关 + 键位」两项独立配置 */
  captureAssistEnabled: boolean;
  /** 辅助键规范名："Alt"(Windows Alt / macOS Option，默认) | "Ctrl" | "Shift"
   *  | "Cmd"(macOS ⌘ / Windows Win)。仅修饰键，由快捷键页单键录制器写入 */
  captureAssistKey: "Alt" | "Ctrl" | "Shift" | "Cmd";
  /** 结果窗口位置记忆（逻辑坐标） */
  resultWindowPos?: [number, number] | null;
  /** 结果窗口尺寸记忆 */
  resultWindowSize?: [number, number] | null;
  /** 智能提取：「提取信息」面板中日期/地点等语义信息优先由 AI 理解（需已配置
   *  默认模型服务）；关闭或未配置时走系统识别。默认开 */
  smartExtract: boolean;
  /** 启动时后台自动检查新版本（默认开）；关闭后仅关于页手动检查。
   *  更新从不静默安装：发现新版弹窗确认后才下载替换 */
  autoUpdateCheck: boolean;
  /** 本地朗读：默认中英文音色（音色包安装状态由 Rust 侧判定） */
  tts: TtsConfig;
  /** 离线词典：本机词库文件位置（空 = 自动探测） */
  dict: DictConfig;
}

/** 多模态消息的内容分片：文本或图片（base64 data URL）。chat 形态原样透传，
 *  responses 形态由 Rust 管道转 input_image */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string | ContentPart[];
}

/** 离线词典状态（对应 src-tauri/src/dict/mod.rs DictStatus）。
 *  ready = 词库文件可读且结构认识；其余取值下「词典」动作不出现 */
export interface DictStatus {
  /** ready = 可用 / unset = 未找到词库 / missing = 文件不存在 / unknown = 结构不认识 */
  state: "ready" | "unset" | "missing" | "unknown";
  /** 实际生效的词库文件路径（未探测到时为空串） */
  path: string;
  /** 词条数（不可用为 0） */
  entryCount: number;
  /** 词库自述版本（未知为空串） */
  version: string;
}

/** dict_status 回包：两本词库各自体检，胶囊只要任一 ready 就出现「词典」 */
export interface DictStatusBundle {
  enZh: DictStatus;
  zhEn: DictStatus;
}

/** 词典例句 / 义项 / 词条（对应 src-tauri/src/dict/query.rs）。
 *  pos 是词库原文（noun/verb/…），显示名由 shared/dict.ts 经 i18n 映射 */
export interface DictExample {
  text: string;
  translation: string;
}

export interface DictSense {
  pos: string;
  gloss: string;
  explanation: string;
  usageNote: string;
  examples: DictExample[];
}

export interface DictEntry {
  headword: string;
  ipa: string[];
  /** 拼音（汉→英库）；英→汉库为空串 */
  reading: string;
  senses: DictSense[];
  memoryHook: string;
  etymology: string;
}

/** Rust paths::open_local_path 的回包（对应 src-tauri/src/paths.rs 六个常量）。
 * 成功分三档：打开目录 / 在文件管理器里选中 / 交给默认应用——三种结局用户看到的
 * 完全不同，文案也就不同。前端只按值取文案、不做算术——所以这里用字面量联合而不是
 * string：Rust 侧新增一档时取值处编译期报错，不会把 unknown 当成功提示发出去 */
export type PathOutcome =
  | "opened-dir"
  | "opened-reveal"
  | "opened-app"
  | "missing"
  | "failed"
  | "unsupported";

// ai_chat Channel 流消息（对应 src-tauri/src/ai.rs AiEvent）
export type AiEvent =
  | { type: "delta"; content: string }
  | { type: "done" }
  | { type: "error"; message: string };
