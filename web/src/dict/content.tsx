import type { Locale } from "../i18n";

/** 离线词典教程页（/dict/）文案：zh 为源，en 对齐翻译。
    语域同 Anki 教程页：允许步骤指引与第二人称（「你」），不用感叹号与口号式排比。 */

export interface DictCopy {
  nav: { crumb: string; home: string };
  hero: {
    badge: string;
    h1a: string;
    h1b: string;
    lead: string;
    cta: string;
    note: string;
  };
  prereq: {
    eyebrow: string;
    title: string;
    items: { title: string; desc: string }[];
  };
  /** 获取词库的两条路径 */
  paths: {
    eyebrow: string;
    title: string;
    lead: string;
    a: { name: string; tag: string; steps: string[] };
    b: { name: string; tag: string; steps: string[] };
  };
  usage: {
    eyebrow: string;
    title: string;
    lead: string;
    items: { title: string; desc: string }[];
  };
  attribution: {
    eyebrow: string;
    title: string;
    lead: string;
    items: { name: string; url: string; desc: string }[];
  };
  faq: {
    eyebrow: string;
    title: string;
    items: { q: string; a: string }[];
  };
  cta: { title: string; lead: string; button: string; guide: string };
}

const zh: DictCopy = {
  nav: { crumb: "词典教程", home: "首页" },
  hero: {
    badge: "离线词典 · 使用教程",
    h1a: "离线词典——",
    h1b: "划词查词，毫秒出释义",
    lead: "拾趣的「词典」动作完全离线：不联网、不消耗模型额度，毫秒级给出释义、用法说明、双语例句、音标与词源。词库来自开源项目 open-dictionary——8.4 万学习者词条，CC BY-SA 4.0，装一次永久可用。",
    cta: "下载拾趣",
    note: "已有拾趣？往下看词库获取",
  },
  prereq: {
    eyebrow: "开始之前",
    title: "两件小事",
    items: [
      {
        title: "拾趣 0.2.0 及以上",
        desc: "「词典」动作内置于应用，无需额外安装插件。",
      },
      {
        title: "一份词库文件（约 207 MB）",
        desc: "来自开源项目 [open-dictionary](https://github.com/ahpxex/open-dictionary)（Wiktionary 快照 + LLM 整理，CC BY-SA 4.0）。获取方式有两条，见下。",
      },
    ],
  },
  paths: {
    eyebrow: "获取词库",
    title: "两条路径，选适合你的",
    lead: "两种方式效果完全一致：接入同一份 8.4 万词条的离线词库。",
    a: {
      name: "安装 Aictionary，词库自动到位",
      tag: "推荐 · 全自动",
      steps: [
        "从 [Aictionary Releases](https://github.com/ahpxex/Aictionary/releases/latest) 下载安装（官方签名并公证）。",
        "打开 Aictionary，进入「设置 → 词典」，它会自动从 GitHub 下载词库并解压到位。",
        "回到拾趣：应用集成 › 词典，状态变为「已接入」。拾趣检测的就是这份词库，无需选择文件。",
      ],
    },
    b: {
      name: "手动下载，不装额外应用",
      tag: "纯手动",
      steps: [
        "打开 [open-dictionary v2.0 Release](https://github.com/ahpxex/open-dictionary/releases/tag/v2.0)，下载 `distribution.sqlite.gz`（约 207 MB，附 SHA256 校验和）。",
        "解压得到 `distribution.sqlite`。",
        "拾趣 › 应用集成 › 词典 › 「选择文件…」，选中解压后的文件。",
      ],
    },
  },
  usage: {
    eyebrow: "怎么用",
    title: "划词即查，毫秒出结果",
    lead: "词库接入后，「词典」动作会出现在划词胶囊与识图动作里。",
    items: [
      {
        title: "划中英文单词或短语",
        desc: "胶囊点「词典」，毫秒级出释义：讲用法、语境与常见搭配，附双语例句、US/UK 音标与词源。",
      },
      {
        title: "变形词直接命中",
        desc: "perceive / perceived 各自成条，无需先做词形还原。",
      },
      {
        title: "完全离线",
        desc: "词库就绪后查询不联网、不消耗模型额度，断网照常使用。",
      },
      {
        title: "中文词条与长段落",
        desc: "词典只收英文词条；中文词句和长段落请用「翻译」动作。",
      },
    ],
  },
  attribution: {
    eyebrow: "来源与署名",
    title: "词库数据来自开源社区",
    lead: "拾趣只读本地词库文件，不随安装包分发、不修改数据。按 CC BY-SA 4.0 要求署名如下：",
    items: [
      {
        name: "open-dictionary",
        url: "https://github.com/ahpxex/open-dictionary",
        desc: "词库数据来源：Wiktionary/Wiktextract 快照，经词频筛选与 LLM 整理生成，CC BY-SA 4.0。",
      },
      {
        name: "Aictionary",
        url: "https://github.com/ahpxex/Aictionary",
        desc: "桌面词典客户端：词库托管与接入格式参考，拾趣兼容其数据目录的自动检测。",
      },
    ],
  },
  faq: {
    eyebrow: "常见问题",
    title: "几个常见问题",
    items: [
      {
        q: "「词典」动作没有出现？",
        a: "词库还没接入：按上面任一路径获取词库后动作自动出现；也可在词典页「选择文件…」手动指定。",
      },
      {
        q: "装了 Aictionary 还要再下载吗？",
        a: "不用。拾趣检测的就是 Aictionary 数据目录里的同一份词库文件，它更新后拾趣自动跟随。",
      },
      {
        q: "查不到中文？",
        a: "词库只收英文词条。中文词句和长段落请用「翻译」动作。",
      },
      {
        q: "词库会更新吗？",
        a: "open-dictionary 发布新版后，Aictionary 内可更新词库，拾趣检测同一文件自动跟随；手动接入的用户可下载新版后重新选择。",
      },
    ],
  },
  cta: {
    title: "还没有拾趣？",
    lead: "划词 AI 工具：选中屏幕上的任何文字，翻译、解释、总结、查词、存笔记，一步到位。模型服务自选，永久免费。",
    button: "下载拾趣",
    guide: "划词翻译指南",
  },
};

const en: DictCopy = {
  nav: { crumb: "Dictionary guide", home: "Home" },
  hero: {
    badge: "Offline dictionary · Guide",
    h1a: "Offline dictionary — ",
    h1b: "select a word, get definitions in milliseconds",
    lead: "Magpie's Dictionary action is fully offline: no network, no model quota, and definitions in milliseconds — usage notes, bilingual examples, US/UK phonetics and etymology. The word library comes from the open-source open-dictionary project (84k learner entries, CC BY-SA 4.0), set up once and yours forever.",
    cta: "Download Magpie",
    note: "Already have Magpie? See how to get the library below",
  },
  prereq: {
    eyebrow: "Before you start",
    title: "Two small things",
    items: [
      {
        title: "Magpie 0.2.0 or later",
        desc: "The Dictionary action is built in — no extra plug-ins to install.",
      },
      {
        title: "A library file (about 207 MB)",
        desc: "From the open-source [open-dictionary](https://github.com/ahpxex/open-dictionary) project (Wiktionary snapshot + LLM curation, CC BY-SA 4.0). Two ways to get it, below.",
      },
    ],
  },
  paths: {
    eyebrow: "Get the library",
    title: "Two paths — pick what suits you",
    lead: "Both routes land on the same 84k-entry offline library.",
    a: {
      name: "Install Aictionary — library included",
      tag: "Recommended · fully automatic",
      steps: [
        "Download and install from [Aictionary Releases](https://github.com/ahpxex/Aictionary/releases/latest) (signed and notarized).",
        "Open Aictionary and go to Settings → Dictionary: it downloads and unpacks the library from GitHub automatically.",
        "Back in Magpie: App integrations → Dictionary shows Connected. Magpie detects that very file — no file picking needed.",
      ],
    },
    b: {
      name: "Manual download, no extra app",
      tag: "Manual",
      steps: [
        "Open the [open-dictionary v2.0 release](https://github.com/ahpxex/open-dictionary/releases/tag/v2.0) and download `distribution.sqlite.gz` (about 207 MB, SHA256 checksums provided).",
        "Unpack it to get `distribution.sqlite`.",
        "Magpie → App integrations → Dictionary → “Choose file…”, and select the unpacked file.",
      ],
    },
  },
  usage: {
    eyebrow: "How to use it",
    title: "Select a word, read the entry",
    lead: "Once the library is connected, the Dictionary action appears in the capsule and among the capture actions.",
    items: [
      {
        title: "Select an English word or phrase",
        desc: "Click Dictionary on the capsule: definitions in milliseconds — usage, context and collocations, with bilingual examples, US/UK phonetics and etymology.",
      },
      {
        title: "Inflected forms hit directly",
        desc: "perceive / perceived are separate entries; no lemmatization needed first.",
      },
      {
        title: "Fully offline",
        desc: "With the library in place, lookups never touch the network and consume no model quota.",
      },
      {
        title: "Chinese entries and longer text",
        desc: "The library is English-only. For Chinese words and longer passages use the Translate action.",
      },
    ],
  },
  attribution: {
    eyebrow: "Source & credit",
    title: "Library data comes from the open-source community",
    lead: "Magpie only reads the local library file — it is not bundled with the installer and never modified. Credit, as required by CC BY-SA 4.0:",
    items: [
      {
        name: "open-dictionary",
        url: "https://github.com/ahpxex/open-dictionary",
        desc: "Library data source: Wiktionary/Wiktextract snapshot, filtered by frequency and curated with LLMs. CC BY-SA 4.0.",
      },
      {
        name: "Aictionary",
        url: "https://github.com/ahpxex/Aictionary",
        desc: "Desktop dictionary client: hosting of the library releases and the integration format Magpie detects.",
      },
    ],
  },
  faq: {
    eyebrow: "FAQ",
    title: "Common questions",
    items: [
      {
        q: "The Dictionary action doesn't appear?",
        a: "The library isn't connected yet: get it via either path above and the action appears automatically; you can also point to it manually via “Choose file…” on the Dictionary page.",
      },
      {
        q: "I installed Aictionary — do I still need to download?",
        a: "No. Magpie detects the same library file inside Aictionary's data folder and follows it automatically when it updates.",
      },
      {
        q: "No Chinese definitions?",
        a: "The library is English-only. For Chinese words and longer passages use the Translate action.",
      },
      {
        q: "Will the library be updated?",
        a: "When open-dictionary publishes a new build, Aictionary can update its library and Magpie follows the same file. Manual users can download the new build and re-select it.",
      },
    ],
  },
  cta: {
    title: "Don't have Magpie yet?",
    lead: "A select-to-AI tool: select any text on screen and translate, explain, summarize, look it up or save it to your notes — in one step. Bring your own model service, free forever.",
    button: "Download Magpie",
    guide: "Select & translate guide",
  },
};

export const DICT: Record<Locale, DictCopy> = { zh, en };
