import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

/** 官网语言：中 / 英。字典结构即站点内容，zh 为源，en 对齐翻译 */
export type Locale = "zh" | "en";

const zh = {
  meta: { lang: "zh-CN", title: "拾趣 Magpie · 屏幕上任何文字，选中或框选就地处理" },
  nav: {
    items: [
      { id: "actions", label: "动作" },
      { id: "ocr", label: "识图" },
      { id: "gallery", label: "界面" },
      { id: "custom", label: "自定义" },
      { id: "trust", label: "隐私与费用" },
      { id: "faq", label: "常见问题" },
      { id: "download", label: "安装" },
    ],
    updates: "更新记录",
    download: "下载",
    langBtn: "EN",
  },
  hero: {
    badge: "macOS 划词 AI 工具 · 永久免费",
    h1a: "屏幕上任何文字，",
    h1b: "选中或框选，",
    h1c: "就地处理",
    lead: "一款 macOS 划词 AI 工具：拖选或双击文字即显示浮动条，图片、视频与扫描文档中的文字可框选识别。翻译、解释、总结实时出结果；复制、搜索、写入 Obsidian、预填日历等动作把结果直接落地，不锁在对话窗口里。",
    cta1: "下载 macOS 版",
    cta2: "GitHub Releases",
    note: "弹出约 0.1 秒 · 模型服务自选 · 识图与提取在本机完成 · 不收集使用数据",
    stats: [
      { value: "2", label: "种取字方式", note: "划词 · 识图" },
      { value: "12", label: "个内置动作", note: "AI 动作 3 个 · 本地动作 9 个" },
      { value: "10", label: "个自定义动作", note: "提示词自行设定" },
      { value: "6", label: "个内置搜索引擎", note: "支持自定义引擎" },
    ],
  },
  actions: {
    eyebrow: "Actions",
    titlePre: "内置 ",
    titleAccent: "12 个动作",
    titlePost: "，分为 AI 与本地两类",
    lead: "翻译、解释、总结由所选模型服务完成；复制、搜索、打开链接、写邮件、提取信息与存入 Obsidian 在本机完成。浮动条默认显示 4 个动作，其余收入展开面板；可用动作随选中内容类型变化，选中网址时提供「打开链接」，选中邮箱时提供「写邮件」。",
    items: [
      { name: "翻译", desc: "自动判断翻译方向，结果实时显示。支持 AI 翻译、百度翻译、DeepL 三种服务，可设定默认服务。" },
      { name: "解释", desc: "对术语、概念、典故与长句给出说明，无需另开对话窗口。" },
      { name: "总结", desc: "将段落或整篇内容归纳为要点，结果保留在独立窗口中。" },
      { name: "复制 / 搜索", desc: "本机完成的常规动作，无需配置，不消耗模型额度。" },
      { name: "提取信息", desc: "自动识别选区中的网址、邮箱、验证码与电话号码。仅一种信息时直接提供对应动作，多种信息时集中显示。" },
      { name: "打开链接 / 写邮件", desc: "选中网址可直接打开，选中邮箱可直接撰写邮件，电话号码一键复制。" },
      { name: "加入日历 / 打开地图", desc: "选中含日期、时间或地点的文字，一键预填日历事件或在地图中打开——信息直接落地，不停留在窗口里。" },
      { name: "存入 Obsidian", desc: "选中文本按模板直写进 vault：摘录追加进当日日记，任务行写入待办（自动识别选区里的截止日期），知识卡一卡一文件。全程本地文件写入，无需安装插件。" },
    ],
  },
  ocr: {
    eyebrow: "Screen Capture",
    titlePre: "无法选中的文字，",
    titleAccent: "框选即可识别",
    titlePost: "",
    lead: "划词仅适用于可选中的文本。图片、视频字幕、扫描文档与应用界面中的文字，可通过框选在本机识别，识别结果使用同一组动作处理。",
    steps: [
      { title: "框选", desc: "通过快捷键或菜单栏选择「识图取字」，拖动框选屏幕区域。" },
      { title: "本机识别", desc: "文字识别在本机完成，截图不上传、不留存。" },
      { title: "继续处理", desc: "识别结果可直接翻译、解释或总结，适用于图片、视频字幕、扫描文档与应用界面中的文字。" },
      { title: "钉图", desc: "截图可固定在屏幕上，支持再次识别以及复制、搜索等动作。" },
    ],
    shortcutsTitle: "四个识图快捷键",
    shortcutsNote: "按下快捷键进入框选，识别完成后自动执行对应动作。键位可在设置中修改。",
    shortcuts: [
      { keys: "⌥ S", label: "识图取字" },
      { keys: "⌥ T", label: "识图翻译" },
      { keys: "⌥ E", label: "识图解释" },
      { keys: "⌥ D", label: "识图总结" },
    ],
    rulesTitle: "其他取词与显示规则",
    rules: [
      "拖选与双击均可触发。界面由应用自绘、划词取不到文字时，改用识图取字。",
      "截图与识别在后台完成，框选期间划词自动暂停。",
      "截图可固定在屏幕上，支持再次识别，复制、搜索与 AI 动作同样可用。",
      "指定应用可加入禁用列表；重复选择同一段文字不会重复弹出。",
    ],
  },
  gallery: {
    eyebrow: "Interface",
    titlePre: "实际",
    titleAccent: "界面",
    titlePost: "",
    lead: "浮动条、识图取字、结果窗、设置页、钉图与 Obsidian 直写的 macOS 实际截图。",
    shots: [
      { file: "floating-bar.png", label: "划词浮动条", note: "选中或双击文字后就地显示；点开「翻译」可切换 AI 翻译、百度翻译与 DeepL。", w: 1119, h: 559, cls: "" },
      { file: "ocr-crop.png", label: "识图取字", note: "框选屏幕区域即可识别——视频字幕、扫描件与图片里的文字同样可取。", w: 1176, h: 585, cls: "" },
      { file: "translate-result.png", label: "翻译结果", note: "结果实时显示，附术语与译法说明，可复制或继续交给其他动作。", w: 778, h: 583, cls: "" },
      { file: "obsidian.png", label: "存入 Obsidian", note: "在 PDF 等任意界面划选文字，直接存入 Obsidian：摘录进日记、任务带截止日期、卡片一卡一文件，按模板直写 vault。", w: 752, h: 542, cls: "" },
      { file: "pinned.png", label: "钉图", note: "截图可固定在屏幕上，钉住后仍能再次识别、复制与搜索。", w: 1436, h: 620, cls: "" },
      { file: "settings-actions.png", label: "设置 · 划词", note: "开关、排序与自定义动作的管理入口，所有调整即时生效。", w: 879, h: 761, cls: "" },
    ],
  },
  audience: {
    eyebrow: "Use cases",
    titlePre: "主要使用者：",
    titleAccent: "高频处理文字内容的人",
    titlePost: "",
    lead: "写作、编辑、翻译、研究与阅读场景中，查阅、核实、摘录、留存的频率最高；对已用 Obsidian、Notion 等笔记工具沉淀内容的人，收集还需要有归宿。拾趣针对该流程提供取字与处理动作，不涉及内容创作。",
    people: [
      { who: "作者 / 编辑", scene: "引用、查证与注释：选中即可解释与复制，无需在窗口之间来回切换。" },
      { who: "译者 / 语言学习者", scene: "提示词可按个人翻译规范设定；常用转换可保存为自定义动作；自定义搜索引擎可接入个人词条库。" },
      { who: "研究者 / 重度阅读者", scene: "扫描版 PDF、图表与截图中的文字无法选中，框选后即可识别并执行翻译、解释或总结。" },
      { who: "学生 / 课程视频观看者", scene: "课件截图、视频字幕与图片板书可框选识别，⌥T 识图翻译、⌥E 识图解释。" },
    ],
  },
  custom: {
    eyebrow: "Customization",
    titlePre: "模型、提示词、动作、检索与显示，",
    titleAccent: "均可在设置中修改",
    titlePost: "",
    lead: "可自定义的范围包括：模型服务、动作提示词、自定义动作、搜索引擎、翻译服务、快捷键、浮动条动作数量与顺序、应用禁用列表与外观。",
    group1: { tag: "AI 相关", note: "Prompt 设置 · 自定义动作 · 模型服务" },
    group2: { tag: "检索与显示", note: "搜索引擎 · 翻译服务 · 快捷键 · 浮动条 · 应用与外观" },
    items: [
      { title: "提示词逐条可改", desc: "翻译、解释、总结的提示词均可修改，编辑框内内容即为实际发送内容，支持查看与恢复系统默认。" },
      { title: "常用指令保存为动作", desc: "设定名称、提示词与样例，试运行确认后保存。自定义动作与内置动作统一排序、统一显示，最多 10 个，还可为每个动作挑选图标。" },
      { title: "模型服务可保存多套", desc: "服务地址、模型名称与密钥自行设定，可随时更换。默认服务供全部 AI 动作使用，密钥仅保存在本机。" },
    ],
    routes: [
      { title: "搜索引擎", desc: "内置 6 个搜索引擎，支持停用与排序。可添加自定义引擎，检索词由 {q} 占位符指定。" },
      { title: "翻译服务", desc: "AI 翻译、百度翻译、DeepL 三种服务支持开关与排序，并可设定默认服务。百度翻译与 DeepL 需自备密钥。" },
      { title: "快捷键", desc: "四个识图功能分别设定快捷键，需包含 ⌘ / Ctrl / Alt / Shift 之一，支持一键恢复默认。菜单栏显示当前键位。" },
      { title: "浮动条", desc: "默认显示 4 个动作，可设置 2–8 个，其余收入展开面板。动作支持停用与排序，调整即时生效。" },
      { title: "应用与外观", desc: "指定应用可加入禁用列表，划词时不显示浮动条。界面支持亮色、暗色与跟随系统，程序坞图标可隐藏。" },
    ],
  },
  position: {
    eyebrow: "Positioning",
    titlePre: "取字、处理、转送、留存，",
    titleAccent: "四个环节连续可用",
    titlePost: "",
    lead: "拾趣覆盖取字、处理、转送、留存四个环节：Obsidian 直写已上线——摘录、任务、知识卡按模板落进 vault；Notion、flomo 等应用接入正在扩展，处理结果可继续流向用户已在用的应用与笔记体系。",
    families: [
      { state: "已上线", live: true, name: "AI 处理", items: ["翻译（三种服务）", "解释", "总结", "自定义动作最多 10 个", "提示词逐条可改"] },
      { state: "已上线", live: true, name: "本地动作", items: ["复制 / 搜索", "打开链接 / 写邮件", "网址、邮箱、验证码、号码提取", "结果窗独立显示，可钉住、可拖动"] },
      { state: "已上线", live: true, name: "Obsidian 接入", items: ["存入笔记：摘录直写当日日记", "存入任务：自动带上识别的截止日期", "存入卡片：一卡一文件，标题取自选中文本", "三套模板均可自定义，无需插件"] },
      { state: "开发中", live: false, name: "应用接入", items: ["存至 Notion / flomo / 备忘录等笔记应用", "生词本、稍后读等同类接入"] },
    ],
    example: "流程示例：选中 → 解释 → 复制 → 粘贴至笔记。",
    exampleCta: "下载拾趣",
  },
  trust: {
    eyebrow: "Privacy & Price",
    titlePre: "权限、",
    titleAccent: "数据去向与费用",
    titlePost: "",
    lead: "以下说明拾趣读取的内容、使用的系统权限、数据的存储与发送范围，以及免费与需要自备服务的边界。",
    items: [
      { title: "模型服务自选", desc: "支持主流模型服务，地址、模型名称与密钥由用户设定，可随时更换，密钥仅保存在本机配置文件。" },
      { title: "内容在本机处理", desc: "识图、信息提取、搜索与复制均在本机完成。使用 AI 动作时，所选文字发送至所配置的模型服务。" },
      { title: "不收集使用数据", desc: "无使用统计、无广告，不向第三方提供内容。更新检查仅读取 GitHub Releases 的公开版本信息。" },
      { title: "永久免费", desc: "内置动作、自定义动作、识图与设置项全部免费，无订阅、无需账号。翻译、解释、总结需接入自己的模型服务，费用由该服务决定。" },
    ],
    note: "系统权限共三项：辅助功能与输入监控用于取词，屏幕录制用于识图框选。权限用途与授权状态在设置页「权限」中逐项列出。",
  },
  download: {
    eyebrow: "Download",
    titlePre: "下载与",
    titleAccent: "安装",
    titlePost: "",
    lead: "永久免费，无需账号。翻译、解释、总结需接入自己的模型服务后使用。",
    card: {
      os: "macOS",
      name: "拾趣 for macOS",
      sub: "通用 .dmg · Apple Silicon 与 Intel 均可运行",
      cta: "从 GitHub Releases 下载",
      repo: "项目主页与更新记录",
      note: "版本号与更新说明见 GitHub Releases。",
      warn: "Windows 版本正在开发中。",
    },
    stepsTitle: "安装步骤",
    steps: [
      { t: "下载", d: "在 GitHub Releases 获取 macOS 通用版（.dmg），打开后将拾趣拖入「应用程序」。" },
      {
        t: "首次打开（未公证应用）",
        d: "双击可能被 macOS 拦截，三种方式任选其一：\n① 右键点击应用 → 选择「打开」\n② 系统设置 → 隐私与安全性 → 点击「仍要打开」\n③ 终端执行下方命令",
        code: "xattr -cr /Applications/Magpie.app",
      },
      {
        t: "补签应用（重要，跳过会导致权限不生效）",
        d: "当前构建为临时签名，直接授权会出现「系统设置里已勾选、应用仍提示未授权」。终端执行：",
        code: "codesign --force --deep --sign - /Applications/Magpie.app",
      },
    ],
    perm: {
      title: "授予权限（最后一步，逐项设置）",
      lead: "退出应用后逐项操作：系统设置 → 隐私与安全性 → 对应面板 → 「＋」添加 /Applications/Magpie.app → 打开开关。此前授权过的，先「−」删除旧条目再重新添加。每张卡片上的「打开面板」链接可直接跳到对应设置（限 macOS）。",
      items: [
        { name: "辅助功能", why: "读取所选文字，供翻译、解释、总结使用", url: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility" },
        { name: "输入监控", why: "监听选区动作，选完文字即弹出浮动条", url: "x-apple.systempreferences:com.apple.preference.security?Privacy_InputMonitoring" },
        { name: "屏幕录制", why: "框选识别屏幕文字（识图与钉图功能）", url: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture" },
      ],
      open: "打开面板",
    },
    note: "应用为临时签名：每次更新或重装后需重新执行补签命令并重新确认权限，之后长期有效。",
  },
  faq: {
    eyebrow: "FAQ",
    title: "常见问题",
    lead: "如有其他问题，可在 GitHub 仓库提交 issue。",
    more: "查看版本更新记录 →",
    items: [
      { q: "支持哪些系统？", a: "支持 macOS，Apple Silicon 与 Intel 通用。Windows 版本正在开发中。" },
      { q: "必须准备 API key 吗？", a: "不需要。复制、搜索、打开链接、写邮件、提取信息、识图与钉图无需配置即可使用。仅翻译、解释、总结需要接入模型服务。" },
      { q: "文字会被上传吗？", a: "识别与提取均在本机完成，屏幕内容不上传。使用 AI 动作时，所选文字发送至用户自行配置的模型服务。" },
      { q: "下载后无法打开怎么办？", a: "当前版本未完成 Apple 签名与公证，首次打开需右键选择「打开」并确认。更新或重装后需重新确认辅助功能权限。" },
      { q: "划词未显示浮动条？", a: "在设置页「权限」确认辅助功能与输入监控已开启，并检查该应用是否位于禁用应用列表。微信、Office 等界面由应用自行绘制的软件，划词可能取不到文字，可改用识图取字。" },
      { q: "与其他划词工具的区别？", a: "一、划词之外还可识图：图片、视频与扫描文档中的文字同样可取。二、结果不锁在对话窗口：保留在独立窗口中，可复制、搜索，也可直写 Obsidian、预填日历与地图。三、模型服务自选，不绑定特定厂商。" },
    ],
  },
  footer: {
    tagline: "屏幕上任何文字，选中或框选，就地处理。",
    github: "GitHub",
    updates: "更新记录",
    download: "下载",
    copyright: "拾趣 Magpie",
  },
};

export type Dict = typeof zh;

const en: Dict = {
  meta: { lang: "en", title: "Magpie · Any text on your screen, selected or captured, handled in place" },
  nav: {
    items: [
      { id: "actions", label: "Actions" },
      { id: "ocr", label: "Capture" },
      { id: "gallery", label: "Interface" },
      { id: "custom", label: "Customization" },
      { id: "trust", label: "Privacy" },
      { id: "faq", label: "FAQ" },
      { id: "download", label: "Install" },
    ],
    updates: "Changelog",
    download: "Download",
    langBtn: "中文",
  },
  hero: {
    badge: "AI text-selection tool for macOS · Free forever",
    h1a: "Any text on your screen,",
    h1b: "select or capture it,",
    h1c: "handle it in place",
    lead: "An AI selection tool for macOS: drag-select or double-click text to summon the floating bar, and capture text inside images, videos and scanned documents by region. Translate, explain and summarize in real time; copy, search, save to Obsidian or prefill a calendar — results land where you work instead of being locked in a chat window.",
    cta1: "Download for macOS",
    cta2: "GitHub Releases",
    note: "Pops in ~0.1s · bring your own model service · OCR & extraction run on-device · No usage tracking",
    stats: [
      { value: "2", label: "capture methods", note: "Selection · OCR" },
      { value: "12", label: "built-in actions", note: "3 AI · 9 local" },
      { value: "10", label: "custom actions", note: "write your own prompts" },
      { value: "6", label: "built-in search engines", note: "custom engines supported" },
    ],
  },
  actions: {
    eyebrow: "Actions",
    titlePre: "",
    titleAccent: "12 built-in actions",
    titlePost: ", in AI and local families",
    lead: "Translate, explain and summarize run through your configured model service; copy, search, open link, compose email, information extraction and Save to Obsidian run locally on your machine. The bar shows 4 actions by default with the rest folded into an expand panel; available actions adapt to the selection — a URL offers Open Link, an email offers Compose Email.",
    items: [
      { name: "Translate", desc: "Picks the translation direction automatically and shows results in real time. Works with AI translation, Baidu Translate and DeepL; a default service can be set." },
      { name: "Explain", desc: "Explains terms, concepts, allusions and long sentences — no need to open a separate chat window." },
      { name: "Summarize", desc: "Turns a paragraph or a whole page into key points, kept in a standalone window." },
      { name: "Copy / Search", desc: "Everyday actions handled on your machine — no configuration, no model quota." },
      { name: "Extract info", desc: "Detects URLs, emails, verification codes and phone numbers in the selection. A single hit gets a direct action; multiple hits open a grouped panel." },
      { name: "Open link / Compose email", desc: "Select a URL to open it, select an email address to compose, copy phone numbers with one click." },
      { name: "Add to Calendar / Open in Maps", desc: "Select text containing a date, time or place — prefill a calendar event or open it in Maps with one click. Information lands where it belongs instead of staying in a window." },
      { name: "Save to Obsidian", desc: "Writes the selection straight into your vault from templates: excerpts append to the daily note, task lines go to your to-dos (due dates detected in the selection), and cards are one file each. Entirely local file writes — no plugin needed." },
    ],
  },
  ocr: {
    eyebrow: "Screen Capture",
    titlePre: "Text you can't select? ",
    titleAccent: "Draw a box — it reads",
    titlePost: "",
    lead: "Selection only works on selectable text. Text inside images, video subtitles, scanned documents and app interfaces can be captured by region and recognized on-device, then processed with the same set of actions.",
    steps: [
      { title: "Capture", desc: "Pick OCR from the hotkey or the menu bar, then drag a region on screen." },
      { title: "On-device recognition", desc: "Recognition runs locally — the screenshot is never uploaded or stored." },
      { title: "Keep processing", desc: "Recognized text can be translated, explained or summarized right away — works for images, video subtitles, scanned documents and app interfaces." },
      { title: "Pin", desc: "Screenshots can be pinned to the screen for re-recognition, copy, search and more." },
    ],
    shortcutsTitle: "Four OCR hotkeys",
    shortcutsNote: "Press a hotkey to enter capture; the matching action runs automatically when recognition finishes. Keys can be changed in settings.",
    shortcuts: [
      { keys: "⌥ S", label: "OCR capture" },
      { keys: "⌥ T", label: "OCR translate" },
      { keys: "⌥ E", label: "OCR explain" },
      { keys: "⌥ D", label: "OCR summarize" },
    ],
    rulesTitle: "Other capture & display rules",
    rules: [
      "Drag or double-click both trigger the bar. When an app draws its own UI and selection can't be read, use OCR instead.",
      "Screenshots and recognition run in the background; selection pauses automatically during capture.",
      "Screenshots can be pinned to the screen for re-recognition — copy, search and AI actions all work.",
      "Specific apps can be added to a blocklist; re-selecting the same text never pops the bar twice.",
    ],
  },
  gallery: {
    eyebrow: "Interface",
    titlePre: "The actual ",
    titleAccent: "interface",
    titlePost: "",
    lead: "Real macOS screenshots of the floating bar, OCR, result window, settings, pinned images and the Obsidian hand-off.",
    shots: [
      { file: "floating-bar.png", label: "Selection bar", note: "Appears in place after selection or double-click; open Translate to switch between AI, Baidu and DeepL services.", w: 1119, h: 559, cls: "" },
      { file: "ocr-crop.png", label: "OCR capture", note: "Drag a region to read text — video subtitles, scanned pages and content inside images all work.", w: 1176, h: 585, cls: "" },
      { file: "translate-result.png", label: "Translation result", note: "Results appear in real time with terminology notes; copy or hand off to other actions.", w: 778, h: 583, cls: "" },
      { file: "obsidian.png", label: "Save to Obsidian", note: "Select text anywhere — a PDF included — and save it straight into Obsidian: excerpts to the daily note, tasks with detected due dates, one card per file, written to your vault from templates.", w: 752, h: 542, cls: "" },
      { file: "pinned.png", label: "Pinned image", note: "Screenshots can be pinned on screen for re-recognition, copying and search.", w: 1436, h: 620, cls: "" },
      { file: "settings-actions.png", label: "Settings · Selection", note: "Toggles, ordering and custom AI actions live here — every change applies instantly.", w: 879, h: 761, cls: "" },
    ],
  },
  audience: {
    eyebrow: "Use cases",
    titlePre: "Built for ",
    titleAccent: "people who process text all day",
    titlePost: "",
    lead: "Writing, editing, translation, research and reading — looking things up, verifying, excerpting and keeping happen at the highest frequency; for people who already keep notes in Obsidian or Notion, collecting also needs a destination. Magpie provides capture and processing actions for exactly that flow; content creation is out of scope.",
    people: [
      { who: "Authors & editors", scene: "Quote, verify and annotate: select to explain and copy — no jumping between windows." },
      { who: "Translators & language learners", scene: "Set prompts to your own translation style; save frequent conversions as custom actions; custom search engines can hook into your personal glossary." },
      { who: "Researchers & heavy readers", scene: "Text in scanned PDFs, figures and screenshots can't be selected — draw a box and it's recognized, ready to translate, explain or summarize." },
      { who: "Students & lecture watchers", scene: "Slide screenshots, video subtitles and whiteboard photos can be captured by region; ⌥T for OCR translate, ⌥E for OCR explain." },
    ],
  },
  custom: {
    eyebrow: "Customization",
    titlePre: "Models, prompts, actions, search and appearance — ",
    titleAccent: "everything is configurable",
    titlePost: "",
    lead: "Customizable: model services, action prompts, custom actions, search engines, translation services, hotkeys, capsule action count and ordering, the app blocklist, and appearance.",
    group1: { tag: "AI related", note: "Prompt settings · Custom actions · Model services" },
    group2: { tag: "Search & display", note: "Search engines · Translation services · Hotkeys · Floating bar · Apps & appearance" },
    items: [
      { title: "Per-action prompt editing", desc: "The prompts behind Translate, Explain and Summarize are all editable — what the editor shows is exactly what gets sent, with view-and-restore for system defaults." },
      { title: "Frequent commands become actions", desc: "Set a name, a prompt and a sample, confirm with a try-run, and save. Custom actions sort and display alongside the built-ins, up to 10, each with a pickable icon." },
      { title: "Multiple model services", desc: "Endpoint, model name and key are yours to set and change anytime. The default service backs all AI actions; keys stay on your machine." },
    ],
    routes: [
      { title: "Search engines", desc: "Six built-in engines with toggle and ordering. Add custom engines — the query is marked by the {q} placeholder." },
      { title: "Translation services", desc: "AI translation, Baidu Translate and DeepL support toggles and ordering, with a default service. Baidu and DeepL need your own keys." },
      { title: "Hotkeys", desc: "The four OCR features each take a hotkey — must include ⌘ / Ctrl / Alt / Shift, with one-click reset to defaults. The menu bar shows current keys." },
      { title: "Floating bar", desc: "Shows 4 actions by default, configurable to 2–8 with the rest in an expand panel. Actions support toggling and ordering, applied instantly." },
      { title: "Apps & appearance", desc: "Specific apps can join a blocklist so the bar never pops there. Light, dark and follow-system themes; the Dock icon can be hidden." },
    ],
  },
  position: {
    eyebrow: "Positioning",
    titlePre: "",
    titleAccent: "Capture, process, hand off, keep",
    titlePost: " — four stages in one continuous flow",
    lead: "Magpie covers capture, processing, hand-off and keeping: direct-to-vault Obsidian writes are live — excerpts, tasks and cards land in your vault from templates — while Notion, flomo and more integrations are on the way, so results keep flowing into the apps and note systems you already use.",
    families: [
      { state: "Live", live: true, name: "AI actions", items: ["Translate (three services)", "Explain", "Summarize", "Up to 10 custom actions", "Per-action prompt editing"] },
      { state: "Live", live: true, name: "Local actions", items: ["Copy / Search", "Open link / Compose email", "URL, email, code & phone extraction", "Standalone result window — pinnable and draggable"] },
      { state: "Live", live: true, name: "Obsidian integration", items: ["Save to note: excerpts append to the daily note", "Save to task: due date detected from the selection", "Save to card: one file per card, titled from the selection", "All three templates editable — no plugin required"] },
      { state: "In development", live: false, name: "App integrations", items: ["Send to Notion / flomo / Apple Notes", "Similar hand-offs: vocabulary, read-later"] },
    ],
    example: "Flow: select → explain → copy → paste into notes.",
    exampleCta: "Download Magpie",
  },
  trust: {
    eyebrow: "Privacy & Price",
    titlePre: "",
    titleAccent: "Permissions, data flow and price",
    titlePost: "",
    lead: "What Magpie reads, which system permissions it uses, where data is stored and sent, and where free ends and bring-your-own begins.",
    items: [
      { title: "Bring your own model service", desc: "Works with mainstream providers — endpoint, model name and key are yours to set and change anytime. Keys stay in a local config file." },
      { title: "Processed on your machine", desc: "OCR, info extraction, search and copying run locally. AI actions send the selected text to the model service you configured." },
      { title: "No usage data collected", desc: "No analytics, no ads, nothing shared with third parties. Update checks only read public GitHub Releases info." },
      { title: "Free forever", desc: "Built-in actions, custom actions, OCR and settings are all free — no subscription, no account. Translate, explain and summarize need your own model service; costs are whatever that service charges." },
    ],
    note: "Three system permissions in total: Accessibility and Input Monitoring for text capture, Screen Recording for OCR region selection. Each permission's purpose and status is listed in the in-app Permissions page.",
  },
  download: {
    eyebrow: "Download",
    titlePre: "",
    titleAccent: "Download & install",
    titlePost: "",
    lead: "Free forever, no account. Translate, explain and summarize need your own model service connected.",
    card: {
      os: "macOS",
      name: "Magpie for macOS",
      sub: "Universal .dmg · runs on Apple Silicon and Intel",
      cta: "Download from GitHub Releases",
      repo: "Project home & changelog",
      note: "Version numbers and release notes on GitHub Releases.",
      warn: "A Windows build is in development.",
    },
    stepsTitle: "Installation steps",
    steps: [
      { t: "Download", d: "Get the universal .dmg from GitHub Releases, open it and drag Magpie into Applications." },
      {
        t: "First launch (unsigned build)",
        d: "A double-click may be blocked by Gatekeeper — any one of these works:\n① Right-click the app → choose Open\n② System Settings → Privacy & Security → Open Anyway\n③ Or run the command below in Terminal",
        code: "xattr -cr /Applications/Magpie.app",
      },
      {
        t: "Re-sign the app (required, or permissions won't stick)",
        d: "The build is ad-hoc signed — granting permissions directly shows as granted in System Settings but never takes effect in the app. Run in Terminal:",
        code: "codesign --force --deep --sign - /Applications/Magpie.app",
      },
    ],
    perm: {
      title: "Grant permissions (final step, one by one)",
      lead: "Quit the app first, then for each item: System Settings → Privacy & Security → the matching pane → \"+\" to add /Applications/Magpie.app → toggle on. If you granted before re-signing, remove the old entries first. Each card's Open-pane link jumps straight to the matching settings pane (macOS only).",
      items: [
        { name: "Accessibility", why: "Read the selected text for translate, explain and summarize", url: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility" },
        { name: "Input Monitoring", why: "Watch for selection gestures so the floating bar pops up", url: "x-apple.systempreferences:com.apple.preference.security?Privacy_InputMonitoring" },
        { name: "Screen Recording", why: "Capture and recognize screen regions (OCR & pinned images)", url: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture" },
      ],
      open: "Open pane",
    },
    note: "The build is ad-hoc signed: after every update or reinstall, run the re-sign command and re-confirm permissions once — they then stay valid.",
  },
  faq: {
    eyebrow: "FAQ",
    title: "FAQ",
    lead: "For anything else, open an issue on the GitHub repository.",
    more: "View release notes →",
    items: [
      { q: "Which systems are supported?", a: "macOS, universal for Apple Silicon and Intel. A Windows build is in development." },
      { q: "Do I need an API key?", a: "No. Copy, search, open link, compose email, info extraction, OCR and pinning work with zero configuration. Only translate, explain and summarize need a model service." },
      { q: "Is my text uploaded?", a: "Recognition and extraction run on your machine; screen content is never uploaded. AI actions send the selected text to the model service you configured yourself." },
      { q: "The app won't open after download?", a: "This build isn't signed and notarized by Apple yet: right-click the app and choose Open to confirm the first launch. After updates or a reinstall, permissions need re-confirming." },
      { q: "No floating bar on selection?", a: "Check Settings → Permissions for Accessibility and Input Monitoring, and make sure the app isn't in the blocklist. Apps that draw their own UI (WeChat, Office…) may not yield text — use OCR capture instead." },
      { q: "How is this different from other selection tools?", a: "One: beyond selectable text, it reads text from images, videos and scanned documents. Two: results aren't locked in a chat — they stay in a standalone window you can copy and search, write straight to Obsidian, or turn into calendar events and map searches. Three: bring your own model service — no vendor lock-in." },
    ],
  },
  footer: {
    tagline: "Any text on your screen, selected or captured, handled in place.",
    github: "GitHub",
    updates: "Changelog",
    download: "Download",
    copyright: "Magpie",
  },
};

const DICTS: Record<Locale, Dict> = { zh, en };

const LocaleCtx = createContext<{
  locale: Locale;
  d: Dict;
  setLocale: (l: Locale) => void;
}>({ locale: "zh", d: zh, setLocale: () => {} });

const STORAGE_KEY = "locale";

function initialLocale(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "zh" || saved === "en") return saved;
  } catch {
    /* localStorage 不可用（隐私模式等）→ 走浏览器语言 */
  }
  return navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
}

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState<Locale>(initialLocale);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, locale);
    } catch {
      /* 忽略：隐私模式下记忆失败不影响当前页展示 */
    }
    document.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
    document.title = DICTS[locale].meta.title;
  }, [locale]);

  const d = DICTS[locale];
  return (
    <LocaleCtx.Provider value={{ locale, d, setLocale }}>
      {children}
    </LocaleCtx.Provider>
  );
}

export function useSite() {
  return useContext(LocaleCtx);
}
