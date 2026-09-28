/** 语言无关的数据：链接、产品拟真演示文案（演示的是应用本身的中文 UI，两语言一致） */

export const REPO = "https://github.com/demo007x/Magpie";
export const RELEASES = `${REPO}/releases/latest`;

/** 首屏演示用的选区文字与译文（产品拟真：展示应用真实的翻译行为，两语言一致） */
export const DEMO = {
  source: "The magpie is one of the few animals that recognises itself in a mirror.",
  translated: "喜鹊是少数能在镜子中认出自己的动物之一。",
};

/** 搜索引擎设置页的示意行：{q} 为选中文本的占位符（应用 UI 拟真） */
export const ENGINE_ROWS = [
  { name: "Google", url: "https://www.google.com/search?q={q}", def: true },
  { name: "百度", url: "https://www.baidu.com/s?wd={q}" },
  { name: "GitHub", url: "https://github.com/search?q={q}" },
  { name: "术语库", url: "https://dict.internal/lookup?word={q}", custom: true },
];
