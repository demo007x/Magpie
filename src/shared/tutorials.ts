// src/shared/tutorials.ts —— 各设置页内嵌的使用教程（双语内置，离线可用）。
// 形态：精简步骤版（官网教程页为完整图文版，入口在每篇结尾）。
// 内容与官网各自维护：应用内写操作步骤，官网写完整图文与上游链接背景，
// 不追求逐字一致——应用内版本随发布冻结，官网可随时修订。

import { getLocale } from "./i18n";

export type TutorialId = "anki" | "dict" | "capture" | "vision";

export interface TutorialStep {
  title: string;
  body: string;
}

export interface Tutorial {
  title: string;
  intro: string;
  steps: TutorialStep[];
  /** 官网完整教程页；空串 = 无对应页面（弹窗不渲染链接行） */
  linkUrl: string;
}

const zh: Record<TutorialId, Tutorial> = {
  anki: {
    title: "Anki 使用教程",
    intro: "划词即建卡，复习交给间隔重复。前提：安装 Anki 桌面版与 AnkiConnect 插件。",
    steps: [
      {
        title: "安装 Anki 桌面版",
        body: "到 [apps.ankiweb.net](https://apps.ankiweb.net) 下载安装，免费开源。",
      },
      {
        title: "安装 AnkiConnect 插件",
        body: "Anki › 工具 › 附加组件 › 获取插件，填入代码 2055492159，重启 Anki。",
      },
      {
        title: "一键创建牌组与模板",
        body: "拾趣 › 应用集成 › Anki：连接成功后点「一键配置」，自动创建「拾趣」牌组与单词卡、内容卡两种模板。",
      },
      {
        title: "划词建卡",
        body: "划选单词或短语，胶囊点「Anki」：短划词进单词卡，长内容进内容卡，自动带来源与日期。",
      },
      {
        title: "复习交给间隔重复",
        body: "配合 AnkiWeb 多端同步，电脑与手机随时复习。",
      },
    ],
    linkUrl: "https://demo007x.github.io/Magpie/anki/",
  },
  dict: {
    title: "离线词典教程",
    intro: "划中英文词条，毫秒出释义：完全离线、不消耗模型额度。词库来自开源项目 open-dictionary，8.4 万学习者词条（CC BY-SA 4.0）。",
    steps: [
      {
        title: "路径一：安装 Aictionary（推荐）",
        body: "从 [Aictionary Releases](https://github.com/ahpxex/Aictionary/releases/latest) 下载安装；打开它，在「设置 → 词典」里会自动下载词库。回到拾趣词典页，状态变「已接入」。",
      },
      {
        title: "路径二：手动下载词库",
        body: "打开 [open-dictionary v2.0 Release](https://github.com/ahpxex/open-dictionary/releases/tag/v2.0)，下载 distribution.sqlite.gz（约 207 MB）并解压；词典页「选择文件…」选中解压出的文件。",
      },
      {
        title: "划词查词",
        body: "选中英文单词或短语，胶囊点「词典」：毫秒级出释义、用法说明、双语例句、音标与词源。",
      },
      {
        title: "中文词条用翻译",
        body: "词库只收英文词条；中文词句和长段落请用「翻译」动作。",
      },
    ],
    linkUrl: "https://demo007x.github.io/Magpie/dict/",
  },
  capture: {
    title: "划词与识图翻译教程",
    intro: "选中即译；选不了的 PDF、图片、视频字幕按快捷键框选识别。译文与摘录顺手存进笔记。",
    steps: [
      {
        title: "划词翻译",
        body: "选中文字，胶囊点「翻译」：浮动条浮在当前应用上方，不夺焦点；译文方向自动判断。",
      },
      {
        title: "识图翻译",
        body: "选不到的文字（PDF、图片、字幕）按 ⌥T（快捷键可在设置改）框选识别，识别完成自动翻译。",
      },
      {
        title: "顺势存笔记",
        body: "译文与摘录一键存入 Obsidian 日记；网址、邮箱、电话、验证码、日期等提取信息一键打开或复制。",
      },
      {
        title: "模型服务自选",
        body: "「模型」页配置后，翻译、解释、总结走你自己的模型；不配置也有机翻可用，识图在本机完成。",
      },
    ],
    linkUrl: "https://demo007x.github.io/Magpie/translate/",
  },
  vision: {
    title: "识图用模型教程",
    intro: "四个开关对应识图的四个动作：开启后模型直接看图处理（截图会发送给你配置的模型服务），关闭则走本机识别。",
    steps: [
      {
        title: "配置默认模型服务",
        body: "「模型」页添加一个支持图片理解的服务并设为默认；未配置时开关不生效。",
      },
      {
        title: "按能力开启开关",
        body: "识别文字、翻译、解释、总结分别控制对应动作：开启 = 模型直接看图，关闭 = 先本机识别。",
      },
      {
        title: "失败自动回退",
        body: "模型暂不可用或拒收图片时，自动改用本机识别，不中断操作。",
      },
      {
        title: "隐私边界",
        body: "开关开启后，框选的截图会发送给你配置的模型服务；本机识别与未开启开关的动作不发送任何内容。",
      },
    ],
    linkUrl: "",
  },
};

const en: Record<TutorialId, Tutorial> = {
  anki: {
    title: "Anki setup guide",
    intro: "Clip to add cards; let spaced repetition handle review. Prerequisites: the Anki desktop app plus the AnkiConnect add-on.",
    steps: [
      {
        title: "Install Anki desktop",
        body: "Download from [apps.ankiweb.net](https://apps.ankiweb.net) — free and open source.",
      },
      {
        title: "Install the AnkiConnect add-on",
        body: "In Anki: Tools › Add-ons › Get Add-ons, enter code 2055492159, then restart Anki.",
      },
      {
        title: "One-click deck & templates",
        body: "Magpie → App integrations → Anki: once connected, click the one-click setup to create the Magpie deck with Word and Content card templates.",
      },
      {
        title: "Clip to add cards",
        body: "Select a word or phrase and click Anki on the capsule: short selections go to Word cards, longer text to Content cards, with source and date attached.",
      },
      {
        title: "Review with spaced repetition",
        body: "Sync via AnkiWeb to review from any device.",
      },
    ],
    linkUrl: "https://demo007x.github.io/Magpie/en/anki/",
  },
  dict: {
    title: "Offline dictionary guide",
    intro: "Select an English word and read definitions in milliseconds — fully offline, no model quota. Library: 84k learner entries from the open-source open-dictionary project (CC BY-SA 4.0).",
    steps: [
      {
        title: "Path 1: install Aictionary (recommended)",
        body: "Download from [Aictionary Releases](https://github.com/ahpxex/Aictionary/releases/latest); open it and its Settings → Dictionary downloads the library automatically. Back in Magpie, the Dictionary page shows Connected.",
      },
      {
        title: "Path 2: download manually",
        body: "Open the [open-dictionary v2.0 release](https://github.com/ahpxex/open-dictionary/releases/tag/v2.0), download distribution.sqlite.gz (about 207 MB) and unpack it; use Choose file… on the Dictionary page to select the unpacked file.",
      },
      {
        title: "Look up words",
        body: "Select an English word or phrase, click Dictionary on the capsule: definitions, usage notes, bilingual examples, phonetics and etymology in milliseconds.",
      },
      {
        title: "Chinese entries",
        body: "The library is English-only; use the Translate action for Chinese words and longer passages.",
      },
    ],
    linkUrl: "https://demo007x.github.io/Magpie/en/dict/",
  },
  capture: {
    title: "Select & capture translate guide",
    intro: "Translate on the spot; capture what can't be selected (PDFs, images, subtitles). Save translations and excerpts into notes as you go.",
    steps: [
      {
        title: "Select & translate",
        body: "Select text and click Translate on the capsule: the bar floats above the current app without stealing focus; direction is detected automatically.",
      },
      {
        title: "Capture & translate",
        body: "For text you can't select — PDFs, images, video subtitles — press ⌥T (customizable in settings), drag a box, and the recognized text is translated automatically.",
      },
      {
        title: "Save into notes",
        body: "Save translations and excerpts into your Obsidian journal in one click; extracted info (URLs, emails, phone numbers, codes, dates) opens or copies in one click.",
      },
      {
        title: "Bring your own model",
        body: "Configure a service on the Model page and translate, explain and summarize run through your own model; without one, machine translation still works and OCR stays on-device.",
      },
    ],
    linkUrl: "https://demo007x.github.io/Magpie/translate/",
  },
  vision: {
    title: "Vision setup guide",
    intro: "Four switches, four capture actions: when on, the model reads the image directly (the screenshot is sent to your configured model service); when off, on-device recognition runs first.",
    steps: [
      {
        title: "Configure a default model service",
        body: "Add a service that understands images on the Model page and set it as default; the switches have no effect until then.",
      },
      {
        title: "Toggle per action",
        body: "Recognize text, Translate, Explain and Summarize control their own actions: on = the model reads the image, off = on-device recognition runs first.",
      },
      {
        title: "Automatic fallback",
        body: "If the model is unavailable or rejects images, on-device recognition takes over automatically.",
      },
      {
        title: "Privacy boundary",
        body: "With a switch on, the screenshot is sent to your configured model service; everything else stays on-device.",
      },
    ],
    linkUrl: "",
  },
};

/** 界面语言决定取哪份教程（与 t() 同口径，随语言切换即时生效） */
export function tutorial(id: TutorialId): Tutorial {
  return (getLocale() === "en" ? en : zh)[id];
}
