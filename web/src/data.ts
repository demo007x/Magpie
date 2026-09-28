export const REPO = "https://github.com/demo007x/Magpie";
export const RELEASES = `${REPO}/releases/latest`;

/** 首屏演示用的选区文字与译文 */
export const DEMO = {
  source: "The magpie is one of the few animals that recognises itself in a mirror.",
  translated: "喜鹊是少数能在镜子中认出自己的动物之一。",
};

export const NAV = [
  { id: "actions", label: "动作" },
  { id: "ocr", label: "识图" },
  { id: "gallery", label: "界面" },
  { id: "custom", label: "自定义" },
  { id: "trust", label: "隐私与费用" },
  { id: "faq", label: "常见问题" },
];

/** 真机截图。文件放 web/public/shots/，见 README「界面截图」。
 *  w/h 是图片的真实像素尺寸（写进 img 属性占位，避免加载时跳动）；cls 只用于跨列。
 *  一套图两个主题共用，所以版面色恒定偏亮（见 styles.css 的 .shot）。 */
export const SHOTS = [
  {
    file: "floating-bar.png",
    label: "划词浮动条",
    note: "选中或双击文字后就地显示；点开「翻译」可切换 AI 翻译、百度翻译与 DeepL。",
    w: 1119,
    h: 559,
    cls: "",
  },
  {
    file: "ocr-crop.png",
    label: "识图取字",
    note: "框选屏幕区域后直接识别，视频字幕与图片中的文字同样可取，结果使用同一组动作。",
    w: 1176,
    h: 585,
    cls: "",
  },
  {
    file: "translate-result.png",
    label: "翻译结果",
    note: "结果实时显示，附术语与译法说明，可复制或继续交给其他动作。",
    w: 778,
    h: 583,
    cls: "",
  },
  {
    file: "settings-actions.png",
    label: "设置 · 划词",
    note: "动作开关与排序、显示动作数量、自定义 AI 动作都在这一页。",
    w: 879,
    h: 761,
    cls: "",
  },
  {
    file: "pinned.png",
    label: "钉图",
    note: "截图可固定在屏幕上，钉住后仍能再次识别、复制与搜索。",
    w: 1436,
    h: 620,
    cls: "sm:col-span-2",
  },
];

export const STATS = [
  { value: "2", label: "种取字方式", note: "划词 · 识图" },
  { value: "9", label: "个内置动作", note: "AI 动作 3 个 · 本地动作 6 个" },
  { value: "10", label: "个自定义动作", note: "提示词自行设定" },
  { value: "6", label: "个内置搜索引擎", note: "支持自定义引擎" },
];

export const ACTIONS = [
  {
    name: "翻译",
    desc: "自动判断翻译方向，结果实时显示。支持 AI 翻译、百度翻译、DeepL 三种服务，可设定默认服务。",
  },
  {
    name: "解释",
    desc: "对术语、概念、典故与长句给出说明，无需另开对话窗口。",
  },
  {
    name: "总结",
    desc: "将段落或整篇内容归纳为要点，结果保留在独立窗口中。",
  },
  {
    name: "复制 / 搜索",
    desc: "本机完成的常规动作，无需配置，不消耗模型额度。",
  },
  {
    name: "提取信息",
    desc: "自动识别选区中的网址、邮箱、验证码与电话号码。仅一种信息时直接提供对应动作，多种信息时集中显示。",
  },
  {
    name: "打开链接 / 写邮件",
    desc: "选中网址可直接打开，选中邮箱可直接撰写邮件，电话号码一键复制。",
  },
];

export const OCR_STEPS = [
  { title: "框选", desc: "通过快捷键或菜单栏选择「识图取字」，拖动框选屏幕区域。" },
  { title: "本机识别", desc: "文字识别在本机完成，截图不上传、不留存。" },
  {
    title: "继续处理",
    desc: "识别结果可直接翻译、解释或总结，适用于图片、视频字幕、扫描文档与应用界面中的文字。",
  },
  { title: "钉图", desc: "截图可固定在屏幕上，支持再次识别以及复制、搜索等动作。" },
];

export const CUSTOM_AI = [
  {
    title: "提示词逐条可改",
    desc: "翻译、解释、总结的提示词均可修改，编辑框内内容即为实际发送内容，支持查看与恢复系统默认。",
  },
  {
    title: "常用指令保存为动作",
    desc: "设定名称、提示词与样例，试运行确认后保存。自定义动作与内置动作统一排序、统一显示，最多 10 个。",
  },
  {
    title: "模型服务可保存多套",
    desc: "服务地址、模型名称与密钥自行设定，可随时更换。默认服务供全部 AI 动作使用，密钥仅保存在本机。",
  },
];

export const CUSTOM_ROUTES = [
  {
    title: "搜索引擎",
    desc: "内置 6 个搜索引擎，支持停用与排序。可添加自定义引擎，检索词由 {q} 占位符指定。",
  },
  {
    title: "翻译服务",
    desc: "AI 翻译、百度翻译、DeepL 三种服务支持开关与排序，并可设定默认服务。百度翻译与 DeepL 需自备密钥。",
  },
  {
    title: "快捷键",
    desc: "四个识图功能分别设定快捷键，需包含 ⌘ / Ctrl / Alt / Shift 之一，支持一键恢复默认。菜单栏显示当前键位。",
  },
  {
    title: "浮动条",
    desc: "默认显示 4 个动作，可设置 2–8 个，其余收入展开面板。动作支持停用与排序，调整即时生效。",
  },
  {
    title: "应用与外观",
    desc: "指定应用可加入禁用列表，划词时不显示浮动条。界面支持亮色、暗色与跟随系统，程序坞图标可隐藏。",
  },
];

/** 搜索引擎设置页的示意行：{q} 为选中文本的占位符 */
export const ENGINE_ROWS = [
  { name: "Google", url: "https://www.google.com/search?q={q}", def: true },
  { name: "百度", url: "https://www.baidu.com/s?wd={q}" },
  { name: "GitHub", url: "https://github.com/search?q={q}" },
  { name: "术语库", url: "https://dict.internal/lookup?word={q}", custom: true },
];

export const TRUST = [
  {
    title: "模型服务自选",
    desc: "支持主流模型服务，地址、模型名称与密钥由用户设定，可随时更换，密钥仅保存在本机配置文件。",
  },
  {
    title: "内容在本机处理",
    desc: "识图、信息提取、搜索与复制均在本机完成。使用 AI 动作时，所选文字发送至所配置的模型服务。",
  },
  {
    title: "不收集使用数据",
    desc: "无使用统计、无广告，不向第三方提供内容。更新检查仅读取 GitHub Releases 的公开版本信息。",
  },
  {
    title: "永久免费",
    desc: "内置动作、自定义动作、识图与设置项全部免费，无订阅、无需账号。翻译、解释、总结需接入自己的模型服务，费用由该服务决定。",
  },
];

export const SHORTCUTS = [
  { keys: "⌥ S", label: "识图取字" },
  { keys: "⌥ T", label: "识图翻译" },
  { keys: "⌥ E", label: "识图解释" },
  { keys: "⌥ D", label: "识图总结" },
];

export const FAQ = [
  {
    q: "支持哪些系统？",
    a: "支持 macOS，Apple Silicon 与 Intel 通用。Windows 版本暂未发布安装包。",
  },
  {
    q: "必须准备 API key 吗？",
    a: "不需要。复制、搜索、打开链接、写邮件、提取信息、识图与钉图无需配置即可使用。仅翻译、解释、总结需要接入模型服务。",
  },
  {
    q: "文字会被上传吗？",
    a: "识别与提取均在本机完成，屏幕内容不上传。使用 AI 动作时，所选文字发送至用户自行配置的模型服务。",
  },
  {
    q: "下载后无法打开怎么办？",
    a: "当前版本未完成 Apple 签名与公证，首次打开需右键选择「打开」并确认。更新或重装后需重新确认辅助功能权限。",
  },
  {
    q: "划词未显示浮动条？",
    a: "在设置页「权限」确认辅助功能与输入监控已开启，并检查该应用是否位于禁用应用列表。微信、Office 等界面由应用自行绘制的软件，划词可能取不到文字，可改用识图取字。",
  },
  {
    q: "与其他划词工具的区别？",
    a: "一、除可选中文本外，还可读取图片、视频与扫描文档中的文字。二、结果保留在独立窗口中，可继续复制、搜索或转向其他应用，不限于对话界面。",
  },
];
