import type { Locale } from "../i18n";

/** 专题页（/translate/）文案：zh 为源，en 对齐翻译。
    语域：专题页比首页放宽一档——允许场景叙事与第二人称（「你」），
    但仍不用感叹号与口号式排比；首页的无人称客观规范不适用于本页。 */

export interface TopicCopy {
  nav: { crumb: string; home: string };
  hero: {
    badge: string;
    h1a: string;
    h1b: string;
    lead: string;
    cta1: string;
    cta2: string;
    note: string;
  };
  flow: {
    eyebrow: string;
    titlePre: string;
    titleAccent: string;
    titlePost: string;
    lead: string;
    steps: { title: string; desc: string }[];
  };
  /** 章节共用结构：痛点场景 lead + 功能点列表 */
  chapter: {
    eyebrow: string;
    titlePre: string;
    titleAccent: string;
    titlePost: string;
    lead: string;
    items: { title: string; desc: string }[];
  };
  audience: {
    eyebrow: string;
    titlePre: string;
    titleAccent: string;
    titlePost: string;
    lead: string;
    people: { who: string; scene: string }[];
  };
  faq: {
    eyebrow: string;
    title: string;
    lead: string;
    items: { q: string; a: string }[];
    home: string;
  };
  cta: {
    title: string;
    lead: string;
    cta1: string;
    cta2: string;
    note: string;
  };
}

const zh: TopicCopy = {
  nav: { crumb: "功能专题 · 划词翻译", home: "首页" },
  hero: {
    badge: "拾趣 · 功能专题",
    h1a: "选中即译，",
    h1b: "阅读不打断",
    lead: "读外文内容遇到生词和难句，老办法是复制、切走、粘贴、查完再切回来——一轮下来，刚才读到哪里都要重新找。拾趣把翻译放进划选这个动作：在任何应用中划选文字，浮动条就地弹出，点「翻译」，译文在旁边实时显示，读完顺手存进 Obsidian。",
    cta1: "下载拾趣",
    cta2: "了解全部功能",
    note: "划选或双击触发 · 方向自动判断 · 多种翻译服务 · 结果可存入 Obsidian",
  },
  flow: {
    eyebrow: "The flow",
    titlePre: "从划选到存入 Obsidian，",
    titleAccent: "完整过程",
    titlePost: "",
    lead: "动画演示了完整过程：划选文字 → 点「翻译」→ 结果实时显示 → 一键存入 Obsidian，全程不离开正在阅读的应用。",
    steps: [
      { title: "划选", desc: "在任何应用中划选或双击文字，浮动条就地在选区旁弹出，不打断当前应用。" },
      { title: "翻译", desc: "点「翻译」，方向自动判断，译文实时显示，无需先选语种。" },
      { title: "结果", desc: "译文显示在独立结果窗，附术语与译法说明，窗口可钉住、可拖动。" },
      { title: "存入 Obsidian", desc: "点「存入 Obsidian」，摘录按模板追加进当日日记，本机完成。" },
    ],
  },
  chapter: {
    eyebrow: "",
    titlePre: "",
    titleAccent: "",
    titlePost: "",
    lead: "",
    items: [],
  },
  audience: {
    eyebrow: "Who it's for",
    titlePre: "谁在用它：",
    titleAccent: "所有在处理文字的人",
    titlePost: "",
    lead: "翻译只是动作，价值取决于你正在读什么、留下什么。同一套动作，落在不同的日常里。",
    people: [
      { who: "语言学习者", scene: "生词和例句随手查，译文与释义一并存进词汇卡；精读材料的句子划选即译，攒出自己的词库。" },
      { who: "研究者与学生", scene: "扫描版论文、课件截图里的文字框选即读，外文段落翻译后直接进读书笔记，引用与查证不再来回切换窗口。" },
      { who: "自媒体与信息整理", scene: "从视频字幕、公众号长文里摘出金句与稿料，翻译、核实、整理顺手完成，素材不再散落在截图相册里。" },
      { who: "以及所有日常时刻", scene: "验证码、快递单号、说明书截图——零散的文字小事，交给同一套动作。" },
    ],
  },
  faq: {
    eyebrow: "FAQ",
    title: "关于划词翻译",
    lead: "更多问题可在 GitHub 仓库提交 issue。",
    items: [
      { q: "使用翻译需要配置什么？", a: "翻译服务三选一：AI 翻译需接入自己的模型服务，地址、模型名称与密钥自行填写；百度翻译与 DeepL 需自备密钥。都可以设定默认服务。就算不配置翻译，复制、搜索、识图等本机动作照常能用。" },
      { q: "翻译时会离开当前应用吗？", a: "不会。浮动条与结果窗浮在当前应用上方，不夺取焦点；查完词，正在读的页面原样保留，输入与滚动不被打断。" },
      { q: "选中的文字会被上传吗？", a: "只有在你使用 AI 翻译或联网翻译服务时，所选文字才会发送给你自己配置的服务；识图在本机完成，拾趣本身不收集任何使用数据；智能提取默认开启、会把所选文字发给你配置的模型，可在设置中关闭。" },
      { q: "文字选不了怎么办？", a: "扫描版 PDF、图片、视频字幕这类选不到的文字，改用识图翻译：按 ⌥T 框选屏幕区域，识别完成后自动翻译，适用于截图、扫描件与应用界面。" },
    ],
    home: "了解拾趣的全部功能 →",
  },
  cta: {
    title: "把翻译放进划选里",
    lead: "永久免费，无需账号。下载后按引导授权辅助功能等系统权限，即可开始划词翻译。",
    cta1: "下载拾趣",
    cta2: "返回首页",
    note: "macOS 与 Windows 均可使用 · 版本与更新说明见 GitHub Releases",
  },
};

/** 各功能章节（划词 / 识图 / 收集 / 存入）按 chapter 结构取用 */
export const SELECT: Record<Locale, TopicCopy["chapter"]> = {
  zh: {
    eyebrow: "Select & Translate",
    titlePre: "外文阅读：一个生词、一句话，",
    titleAccent: "划选就能翻译",
    titlePost: "",
    lead: "读外文最怕的不是长难句，是被打断：选中一个生词，切到词典应用，查完切回来，刚才读的那一行已经找不到了。现在划选文字，浮动条就地在选区旁弹出——单词、短语、整句话都行，点「翻译」，译文和解释就在原文旁边。",
    items: [
      { title: "多语种，方向自动判断", desc: "外语划选译成中文，中文划选译成英文，不用先选语种。" },
      { title: "多种翻译服务", desc: "AI 翻译、百度翻译、DeepL 随时切换，可设定默认；AI 翻译还能接入自己的模型服务，配置多套随时更换。" },
      { title: "术语与译法说明", desc: "译文之外还给出术语与译法说明，长难句为什么这样译，说得出依据。" },
      { title: "独立结果窗", desc: "译文留在单独的窗口里，可钉住、可拖动，尺寸与位置自动记忆。" },
    ],
  },
  en: {
    eyebrow: "Select & Translate",
    titlePre: "Reading in another language: a word, a sentence — ",
    titleAccent: "select it and it's translated",
    titlePost: "",
    lead: "What breaks your reading isn't the long sentence — it's the interruption: select a word, switch to a dictionary app, look it up, switch back, and the line you were on is gone. Now select text and the floating bar appears right beside it — a word, a phrase or a whole sentence. Tap Translate, and the translation and notes sit next to the original.",
    items: [
      { title: "Many languages, direction detected", desc: "Select foreign text and it becomes Chinese; select Chinese and it becomes English — no language picking." },
      { title: "Multiple translation services", desc: "AI translation, Baidu Translate and DeepL, switchable anytime with a default you set; the model service behind AI translation is yours to configure — save several and swap freely." },
      { title: "Terminology & usage notes", desc: "Beyond the translation, results come with terminology and usage notes — long sentences show why they were rendered that way." },
      { title: "Standalone result window", desc: "The translation stays in its own window — pinnable, draggable, with size and position remembered." },
    ],
  },
};

export const CAPTURE: Record<Locale, TopicCopy["chapter"]> = {
  zh: {
    eyebrow: "Capture & Translate",
    titlePre: "PDF、图片、视频里选不了的文字，",
    titleAccent: "框选就提取、翻译",
    titlePost: "",
    lead: "扫描版 PDF、图片、视频字幕、应用界面——这些文字天生选不中，复制粘贴在这里失效。按下 ⌥S 框选屏幕区域，文字在本机识别出来；按下 ⌥T，识别完成直接翻译。整个过程截图不上传，屏幕内容不出你的电脑。",
    items: [
      { title: "四个识图快捷键", desc: "⌥S 取字、⌥T 翻译、⌥E 解释、⌥D 总结，识别完成后自动执行对应动作，键位可改。" },
      { title: "系统 OCR，本机完成", desc: "使用系统自带的文字识别，速度快，截图不上传、不留存。" },
      { title: "钉图常驻", desc: "截图可固定在屏幕上，支持再次识别，复制、搜索与 AI 动作同样可用。" },
    ],
  },
  en: {
    eyebrow: "Capture & Translate",
    titlePre: "PDFs, images, videos — text you can't select? ",
    titleAccent: "Box it: extracted and translated",
    titlePost: "",
    lead: "Scanned PDFs, images, video subtitles, app interfaces — text that was never selectable, where copy-paste simply fails. Press ⌥S and drag a box over the screen region: the text is recognized on your machine. Press ⌥T and it's translated as soon as recognition finishes. Screenshots are never uploaded — screen content stays on your computer.",
    items: [
      { title: "Four OCR hotkeys", desc: "⌥S capture, ⌥T translate, ⌥E explain, ⌥D summarize — the matching action runs when recognition finishes, keys remappable." },
      { title: "System OCR, on-device", desc: "Built-in system text recognition, fast and local; screenshots are never uploaded or stored." },
      { title: "Pinned screenshots", desc: "Pin a screenshot to the screen for re-recognition; copy, search and AI actions all work." },
    ],
  },
};

/** 收集与保存是一个章节的两半：先取字，再按模板落库 */
export type CollectChapter = TopicCopy["chapter"] & {
  keepItems: { title: string; desc: string }[];
  note: string;
};

export const COLLECT: Record<Locale, CollectChapter> = {
  zh: {
    eyebrow: "Collect & Keep",
    titlePre: "刷到的、读到的，",
    titleAccent: "存进你自己的知识库",
    titlePost: "",
    lead: "视频里一闪而过的字幕、公众号里写到心里的段落、社交笔记里的方法清单——看到时觉得有用，存了截图、点了收藏，之后就再也没打开过。碎片信息的问题从来不是收集，是没有去处：框选屏幕上的任意文字取出来，按模板直写进笔记库，收集和保存一步到位。",
    items: [
      { title: "任意来源取字", desc: "视频字幕、图片、聊天记录、网页长文——屏幕上能看到的文字，都能框选取出。" },
      { title: "取出即可用", desc: "复制、搜索、翻译、总结，或交给自定义动作，整理成你要的格式。" },
      { title: "收集有归宿", desc: "处理完按模板写进笔记库，不再散落在截图相册和收藏夹里。" },
    ],
    keepItems: [
      { title: "摘录进当日日记", desc: "原文与译文按模板追加进当天的日记，按日期留存。" },
      { title: "任务带上截止日期", desc: "写入待办时自动识别选区里的日期，不用手动补。" },
      { title: "知识卡一卡一文件", desc: "生词、释义与方法存成独立卡片，标题取自选中文本，慢慢攒成自己的词库。" },
    ],
    note: "当前支持直写 Obsidian；Notion、备忘录等笔记应用的接入在开发中。",
  },
  en: {
    eyebrow: "Collect & Keep",
    titlePre: "What you scroll past, ",
    titleAccent: "into your own knowledge base",
    titlePost: "",
    lead: "A subtitle flashing past in a video, a paragraph that hits home in a long article, a method list in someone's post — you save a screenshot, tap collect, and never open it again. The problem with fragments was never collecting them; it's that they have nowhere to go. Box-select any text on screen, lift it out, and write it straight into your notes from a template — collecting and keeping in one step.",
    items: [
      { title: "Lift text from anywhere", desc: "Video subtitles, images, chat history, long articles — anything visible on screen can be captured." },
      { title: "Usable the moment it's out", desc: "Copy, search, translate, summarize, or hand it to a custom action to reshape it." },
      { title: "A place to land", desc: "Write it into your notes from a template instead of losing it in your photo album and bookmarks." },
    ],
    keepItems: [
      { title: "Excerpts into the daily note", desc: "Original and translation append to today's note from the template, kept by date." },
      { title: "Tasks with due dates", desc: "Dates in the selection are detected when a task is saved — nothing to fill in by hand." },
      { title: "Knowledge cards, one file each", desc: "Words, definitions and methods become standalone cards titled from the selection, building your own deck." },
    ],
    note: "Direct writes currently support Obsidian; integrations with Notion, Apple Notes and more are in development.",
  },
};

const en: TopicCopy = {
  nav: { crumb: "Feature · Select & Translate", home: "Home" },
  hero: {
    badge: "Magpie · Feature spotlight",
    h1a: "Select to translate — ",
    h1b: "without leaving the page",
    lead: "Come across an unfamiliar word while reading, and the old routine kicks in: copy, switch apps, paste, look it up, switch back — then find your place again. Magpie folds all of that into the selection itself: select text in any app, the floating bar appears on the spot, tap Translate, and the translation shows up right beside it — ready to save into Obsidian when you're done.",
    cta1: "Download Magpie",
    cta2: "See all features",
    note: "Select or double-click · direction detected automatically · multiple translation services · results can go straight into Obsidian",
  },
  flow: {
    eyebrow: "The flow",
    titlePre: "",
    titleAccent: "The complete flow",
    titlePost: " — select, translate, keep",
    lead: "The animation walks the full path: select text → tap Translate → read the result → save it into Obsidian, without ever leaving the app you're reading in.",
    steps: [
      { title: "Select", desc: "Select or double-click text in any app — the floating bar pops up right beside the selection, without interrupting it." },
      { title: "Translate", desc: "Tap Translate — direction is detected automatically and the translation shows in real time, no language picking." },
      { title: "Read the result", desc: "The translation lands in a standalone window with terminology notes; pin it, drag it, keep it around." },
      { title: "Save to Obsidian", desc: "Tap Save to Obsidian and the excerpt is appended to the daily note from a template — all local." },
    ],
  },
  chapter: { eyebrow: "", titlePre: "", titleAccent: "", titlePost: "", lead: "", items: [] },
  audience: {
    eyebrow: "Who it's for",
    titlePre: "Who uses it: ",
    titleAccent: "anyone who works with text",
    titlePost: "",
    lead: "Translation is just the action; the value depends on what you're reading and what you keep. The same moves, in different daily lives.",
    people: [
      { who: "Language learners", scene: "Look up words and example sentences on the spot, keep translations and definitions as vocabulary cards, and build a deck that's actually yours." },
      { who: "Researchers & students", scene: "Box-select text in scanned papers and slide screenshots; translated passages go straight into reading notes — no window juggling for citations and checks." },
      { who: "Creators & info keepers", scene: "Pull quotes and material out of video subtitles and long articles; translate, verify and organize in one pass — nothing lost in screenshots." },
      { who: "And every small moment", scene: "Verification codes, tracking numbers, manual screenshots — scattered text chores, one set of actions." },
    ],
  },
  faq: {
    eyebrow: "FAQ",
    title: "About select & translate",
    lead: "For anything else, open an issue on the GitHub repository.",
    items: [
      { q: "What do I need to set up for translation?", a: "Pick any of the three services: AI translation connects to your own model service (address, model name and key are yours to fill in); Baidu Translate and DeepL need your own keys. Set a default service either way. Without translation configured, copy, search, OCR and other local actions still work." },
      { q: "Does translating pull me out of the current app?", a: "No. The floating bar and the result window sit above the current app without taking focus. The page you're reading stays exactly as it was; typing and scrolling go on undisturbed." },
      { q: "Is the selected text uploaded?", a: "Only when you use AI or online translation services — the selection goes to the service you configured yourself. OCR runs on-device and Magpie collects no usage data of any kind; smart extraction (on by default) sends the selection to the model you configured and can be turned off in settings." },
      { q: "What if the text can't be selected?", a: "Scanned PDFs, images and video subtitles were never selectable — use OCR translate instead: press ⌥T, drag a box over the region, and the recognized text is translated automatically. Works for screenshots, scanned pages and app interfaces." },
    ],
    home: "Explore everything Magpie can do →",
  },
  cta: {
    title: "Translation, built into the selection",
    lead: "Free forever, no account. After installing, grant the accessibility permissions when prompted and you're ready to select and translate.",
    cta1: "Download Magpie",
    cta2: "Back to home",
    note: "Available for macOS and Windows · versions and release notes on GitHub Releases",
  },
};

export const TOPIC: Record<Locale, TopicCopy> = { zh, en };

/** 综述动画（FlowDemo）的拟真内容：应用本身的中文 UI，两语言一致 */
export const FLOW_DEMO = {
  docLabel: "任意应用 · 阅读中",
  context: "Reviewing right after class feels productive, yet memory research points the other way.",
  source: "Spaced repetition works because forgetting is part of learning.",
  translated: "间隔重复之所以有效，是因为遗忘本身就是学习的一部分。",
  pills: ["翻译", "解释", "总结", "搜索"],
  resultTag: "AI 翻译",
  vault: "拾趣笔记库",
  noteFile: "日记 / 2026-10-17.md",
  noteExisting: ["整理昨晚的读书笔记", "术语：consolidation → 记忆巩固"],
  savedLabel: "已存入 · 摘录进当日日记",
};
