import type { Locale } from "../i18n";
import { RELEASES } from "../data";

/** Anki 教程页（/anki/）文案：zh 为源，en 对齐翻译。
    语域同专题页：允许步骤指引与第二人称（「你」），不用感叹号与口号式排比。 */

export interface AnkiCopy {
  nav: { crumb: string; home: string };
  hero: {
    badge: string;
    h1a: string;
    h1b: string;
    lead: string;
    cta: string;
    note: string;
  };
  /** 准备清单：开始前的两件事 */
  prereq: {
    eyebrow: string;
    title: string;
    items: { title: string; desc: string }[];
  };
  /** 分步教程：每步 = 标题 + 正文段 + 要点列表 */
  steps: {
    eyebrow: string;
    title: string;
    lead: string;
    step: {
      n: string;
      title: string;
      time: string;
      body: string;
      points: string[];
    }[];
    done: { title: string; desc: string };
  };
  /** 建卡演示区 */
  demo: {
    eyebrow: string;
    titlePre: string;
    titleAccent: string;
    titlePost: string;
    lead: string;
    setupTitle: string;
    setupDesc: string;
    clipTitle: string;
    clipDesc: string;
  };
  /** 学习方法：建完卡怎么用 */
  study: {
    eyebrow: string;
    titlePre: string;
    titleAccent: string;
    titlePost: string;
    lead: string;
    items: { title: string; desc: string }[];
  };
  /** 延伸资源 */
  resources: {
    eyebrow: string;
    title: string;
    lead: string;
    items: { name: string; desc: string; url: string; link: string }[];
  };
  faq: {
    eyebrow: string;
    title: string;
    items: { q: string; a: string }[];
  };
  cta: {
    title: string;
    lead: string;
    button: string;
    guide: string;
  };
}

export const ANKI: Record<Locale, AnkiCopy> = {
  zh: {
    nav: { crumb: "Anki 使用教程", home: "返回首页" },
    hero: {
      badge: "使用教程",
      h1a: "Anki 划词制卡——",
      h1b: "从安装到第一张单词卡",
      lead:
        "这篇教程带你把拾趣接进 Anki：安装 Anki 与 AnkiConnect 插件，拾趣一键创建牌组和卡片模板，之后划词即建卡——查词进单词卡，整段内容进内容卡，来源与日期自动带上。复习安排交给 Anki 的间隔重复。",
      cta: "下载拾趣",
      note: "需要 macOS 12+ 或 Windows 10+，以及本机运行的 Anki。",
    },
    prereq: {
      eyebrow: "开始之前",
      title: "准备两样东西",
      items: [
        { title: "拾趣", desc: `从 [GitHub Releases](${RELEASES}) 下载安装。macOS 是通用 .dmg，Windows 是 x64 安装包。` },
        { title: "Anki 2.1.50+", desc: "从 [apps.ankiweb.net](https://apps.ankiweb.net/) 下载桌面版（Windows / macOS / Linux），免费开源，本地运行，不联网也能用。" },
      ],
    },
    steps: {
      eyebrow: "五步接入",
      title: "从零到第一张卡",
      lead: "全程约 8 分钟——两处下载、一次点击；之后的建卡动作都发生在划词的瞬间。",
      step: [
        {
          n: "01",
          title: "安装 Anki",
          time: "约 3 分钟",
          body: "访问 Anki 官网 [apps.ankiweb.net](https://apps.ankiweb.net/)，下载对应系统的桌面版并安装。Anki 是免费开源软件，数据全部存在你自己的电脑里。",
          points: [
            "Windows 选 64 位安装包，macOS 选 Apple Silicon 或 Intel 对应版本",
            "首次打开会引导你创建一个空集合（profile），直接用默认即可",
          ],
        },
        {
          n: "02",
          title: "安装 AnkiConnect 插件",
          time: "约 2 分钟",
          body: "拾趣通过 AnkiConnect 插件与本机 Anki 通信，这一步不做，划词建卡会提示连接失败。安装方式：打开 Anki → 顶部菜单「工具（Tools）」→「插件（Add-ons）」→「获取插件…（Get Add-ons…）」，在弹出的输入框里粘贴插件代码 2055492159，点「确定（OK）」——列表里随即出现 AnkiConnect。完成后重启 Anki（完全退出再打开），安装才会生效。",
          points: [
            "插件代码：2055492159（AnkiConnect 是官方插件目录里的免费开源插件）",
            "菜单路径：工具 Tools → 插件 Add-ons → 获取插件 Get Add-ons…",
            "粘贴代码后必须重启 Anki，否则拾趣检测不到",
            "也可在浏览器打开 [ankiweb.net/shared/info/2055492159](https://ankiweb.net/shared/info/2055492159) 查看插件详情",
          ],
        },
        {
          n: "03",
          title: "安装拾趣",
          time: "约 2 分钟",
          body: `回到本页顶部或首页的下载入口，从 [GitHub Releases](${RELEASES}) 下载拾趣并安装。macOS 未签名：首次打开右键 →「打开」；Windows：SmartScreen 提示处选择「仍要运行」。`,
          points: [
            "首次使用划词需在系统设置里授予辅助功能权限（macOS）",
            "安装说明以首页下载卡为准",
          ],
        },
        {
          n: "04",
          title: "一键配置",
          time: "10 秒",
          body: "打开拾趣设置 → Anki，页面会自动检测本机 Anki（保持 Anki 运行）。点击「一键配置」，拾趣会在你的 Anki 里创建：牌组「拾趣」（含两个子牌组）和两种卡片模板。全程只写入拾趣自己的内容，不改动你已有的牌组与模板。",
          points: [
            "已就绪徽标出现即配置完成；牌组和模板已存在时不会重复创建",
            "检测不到 Anki 时，先确认 Anki 已启动且进入主界面",
          ],
        },
        {
          n: "05",
          title: "划词建卡",
          time: "划词即用",
          body: "在任意应用里选中一个单词，浮动条上点「Anki」，卡片即进入 Anki 的「拾趣::单词卡」——正面是原文；选中一段内容则进「拾趣::内容卡」。点浮动条上的 ⌄ 可以手动指定；在拾趣结果窗里点 Anki，背面还会带上当前的解释或翻译。",
          points: [
            "短划词（单词、短语）自动进单词卡，长内容自动进内容卡",
            "卡片自动带来源应用与日期，按天聚簇方便回溯",
            "同一内容重复建卡时 Anki 会提示重复，不会产生重复卡",
          ],
        },
      ],
      done: {
        title: "第一张卡就位",
        desc: "之后的每一次划词，都是一次零成本收藏；复习交给 Anki 的日程。",
      },
    },
    demo: {
      eyebrow: "长什么样",
      titlePre: "配置一次，",
      titleAccent: "划词即建卡",
      titlePost: "",
      lead: "以下为界面示意（与实际界面略有出入）。",
      setupTitle: "设置 · 一键配置",
      setupDesc: "检测连接后点一下，牌组与模板自动就位，徽标显示就绪状态。",
      clipTitle: "划词 · 选卡建卡",
      clipDesc: "浮动条点 Anki 直接建卡；⌄ 展开可指定单词卡或内容卡。",
    },
    study: {
      eyebrow: "开始学习",
      titlePre: "卡片建好了，",
      titleAccent: "复习交给间隔重复",
      titlePost: "",
      lead: "Anki 的核心是间隔重复：在快要遗忘的时间点安排复习，用最少的次数记牢。拾趣负责把内容低成本存进来，记忆这件事交给 Anki 的日程。",
      items: [
        { title: "每天打开 Anki 复习", desc: "主界面会显示今日待复习数量，点「拾趣」牌组开始；新卡默认每天 20 张，可在牌组选项里调整。" },
        { title: "诚实评分", desc: "回忆卡不出来就点「重来」，轻松想起再点「良好」——评分越诚实，日程越准。" },
        { title: "随时补内容", desc: "背面只存了释义？在 Anki 里双击卡片即可编辑，补充例句、图片或发音。" },
        { title: "手机同步复习", desc: "注册 AnkiWeb 账号后，桌面端同步一次，手机装 AnkiDroid（Android，免费）或 AnkiMobile（iOS）即可随时复习。" },
      ],
    },
    resources: {
      eyebrow: "延伸阅读",
      title: "学习资源",
      lead: "想更深入了解 Anki 的用法，这些是官方与社区维护的主要资源。",
      items: [
        { name: "Anki 手册", desc: "官方手册，覆盖牌组、笔记类型、模板与调度算法的完整说明。", url: "https://docs.ankiweb.net/", link: "docs.ankiweb.net" },
        { name: "AnkiConnect", desc: "本教程用到的插件官方项目页，含安装说明与完整 API 文档。", url: "https://github.com/FooSoft/anki-connect", link: "github.com/FooSoft/anki-connect" },
        { name: "共享牌组库", desc: "社区共享的现成牌组（语言、考试、专业），可直接下载配合使用。", url: "https://ankiweb.net/shared/decks", link: "ankiweb.net/shared/decks" },
        { name: "AnkiDroid", desc: "Android 客户端，免费开源，与桌面端通过 AnkiWeb 同步。", url: "https://github.com/ankidroid/Anki-Android", link: "github.com/ankidroid/Anki-Android" },
        { name: "Anki 官方论坛", desc: "社区与开发者聚集地，插件、使用问题都能找到讨论。", url: "https://forums.ankiweb.net/", link: "forums.ankiweb.net" },
        { name: "中文入门教程", desc: "少数派、知乎与 B 站有大量中文入门与进阶教程，搜「Anki 教程」「Anki 记忆卡」即可。", url: "https://sspai.com/search?q=Anki", link: "少数派 / 知乎 / B 站" },
        { name: "剑桥词典", desc: "权威英英/英汉双解、音标与例句——做单词卡时查证释义与拼写的首选。", url: "https://dictionary.cambridge.org/", link: "dictionary.cambridge.org" },
        { name: "YouGlish", desc: "用真实视频听一个词在母语者口中的发音与用法，配合发音卡片食用最佳。", url: "https://youglish.com/", link: "youglish.com" },
        { name: "BBC Learning English", desc: "BBC 的免费系统化英语学习节目，短课+音频+文本，适合配合每日复习节奏。", url: "https://www.bbc.co.uk/learningenglish", link: "bbc.co.uk/learningenglish" },
      ],
    },
    faq: {
      eyebrow: "常见问题",
      title: "关于拾趣 × Anki",
      items: [
        { q: "建卡需要联网吗？", a: "不需要。建卡是拾趣与你本机 Anki 之间的本地通信；只有背面要带 AI 释义时，才会把所选文字发给你自己配置的模型服务。" },
        { q: "会动我已有的牌组和模板吗？", a: "不会。一键配置只创建「拾趣」牌组、两个子牌组和两种卡片模板；已存在的同名项直接跳过，你的其他内容不受影响。" },
        { q: "Anki 没开的时候能建卡吗？", a: "不能。AnkiConnect 随 Anki 进程运行，拾趣检测不到 Anki 时会提示连接失败。先启动 Anki 再划词即可。" },
        { q: "重复的词会重复建卡吗？", a: "不会。Anki 按第一个字段（原文）查重，重复时拾趣会收到提示并告知你该卡已存在。" },
        { q: "手机上能复习吗？", a: "可以。桌面端与 AnkiWeb 同步后，Android 用 AnkiDroid（免费）、iOS 用 AnkiMobile 即可复习同一份牌组。" },
        { q: "卡片样式能改吗？", a: "可以。样式归属 Anki 笔记类型：在 Anki 的「工具 → 管理笔记类型」里找到拾趣单词卡/内容卡即可改模板与 CSS，改动对所有新卡生效。" },
      ],
    },
    cta: {
      title: "准备好开始了吗",
      lead: "下载拾趣，配好 Anki，下一次划词就是你的第一张卡。",
      button: "下载拾趣",
      guide: "先看看划词翻译怎么用",
    },
  },
  en: {
    nav: { crumb: "Anki tutorial", home: "Back to home" },
    hero: {
      badge: "Tutorial",
      h1a: "Anki card clipping — ",
      h1b: "from install to your first word card",
      lead:
        "This guide walks you through connecting Magpie to Anki: install Anki and the AnkiConnect add-on, let Magpie create the deck and card templates in one click, then clip to add cards — words go to Word cards, longer text to Content cards, with source and date attached. Scheduling is handled by Anki's spaced repetition.",
      cta: "Download Magpie",
      note: "Requires macOS 12+ or Windows 10+, and Anki running on this machine.",
    },
    prereq: {
      eyebrow: "Before you start",
      title: "Two things to prepare",
      items: [
        { title: "Magpie", desc: `Download and install from [GitHub Releases](${RELEASES}). macOS ships a universal .dmg; Windows ships an x64 installer.` },
        { title: "Anki 2.1.50+", desc: "Get the desktop app from [apps.ankiweb.net](https://apps.ankiweb.net/) (Windows / macOS / Linux). Free, open source, runs locally, works offline." },
      ],
    },
    steps: {
      eyebrow: "Five steps",
      title: "From zero to your first card",
      lead: "About 8 minutes end to end — two downloads, one click; after that, cards are created at the moment of selection.",
      step: [
        {
          n: "01",
          title: "Install Anki",
          time: "~3 min",
          body: "Visit [apps.ankiweb.net](https://apps.ankiweb.net/), download the desktop build for your system and install it. Anki is free and open source; all data stays on your computer.",
          points: [
            "Windows: 64-bit installer; macOS: pick Apple Silicon or Intel",
            "First launch walks you through a blank profile — the default is fine",
          ],
        },
        {
          n: "02",
          title: "Install the AnkiConnect add-on",
          time: "~2 min",
          body: "Magpie talks to Anki through AnkiConnect — without this step, clipping shows a connection failure. To install: open Anki → the Tools menu → Add-ons → Get Add-ons…, paste the code 2055492159 into the dialog, click OK — AnkiConnect appears in the list. Then restart Anki (quit fully and reopen) for it to take effect.",
          points: [
            "Add-on code: 2055492159 (AnkiConnect is a free, open-source add-on from the official directory)",
            "Menu path: Tools → Add-ons → Get Add-ons…",
            "Restart Anki after pasting the code, or Magpie won't detect it",
            "You can also open [ankiweb.net/shared/info/2055492159](https://ankiweb.net/shared/info/2055492159) in a browser to see the add-on details",
          ],
        },
        {
          n: "03",
          title: "Install Magpie",
          time: "~2 min",
          body: `Use the download link at the top of this page or on the homepage, then install from [GitHub Releases](${RELEASES}). macOS build is unsigned: right-click → Open on first launch. Windows: choose \"Keep anyway\" on the SmartScreen prompt.`,
          points: [
            "Clipping needs the Accessibility permission on macOS (granted in System Settings)",
            "Install notes live in the homepage download card",
          ],
        },
        {
          n: "04",
          title: "One-click setup",
          time: "10 sec",
          body: "Open Magpie settings → Anki; the page detects your local Anki automatically (keep Anki running). Click the setup button and Magpie creates: the \"Magpie\" deck (with two sub-decks) and two card templates. It only writes Magpie's own items and never touches your existing decks or templates.",
          points: [
            "The Ready badge means setup is done; existing decks and templates are never created twice",
            "If Anki isn't detected, make sure it is running and past the profile screen",
          ],
        },
        {
          n: "05",
          title: "Clip to add cards",
          time: "clip away",
          body: "Select a word in any app and click \"Anki\" on the floating bar — the card lands in Magpie::Word with the original text on the front. Longer selections go to Magpie::Content. The ⌄ menu picks a type manually; clicking Anki inside the result window also puts the current explanation or translation on the back.",
          points: [
            "Short selections (words, phrases) go to Word cards; long ones to Content cards",
            "Source app and date are attached automatically, clustered by day for look-back",
            "Duplicates are rejected by Anki — you'll see a notice instead of a second copy",
          ],
        },
      ],
      done: {
        title: "Your first card is in",
        desc: "Every clip after this is a zero-effort save; Anki handles the schedule.",
      },
    },
    demo: {
      eyebrow: "What it looks like",
      titlePre: "Set up once,",
      titleAccent: "clip to add cards",
      titlePost: "",
      lead: "Illustrative mockups (slightly simplified from the real UI).",
      setupTitle: "Settings · one-click setup",
      setupDesc: "Detect, click once, deck and templates land in place — the badge shows readiness.",
      clipTitle: "Clip · pick a card type",
      clipDesc: "Click Anki on the floating bar to add instantly; ⌄ expands to pick Word or Content.",
    },
    study: {
      eyebrow: "Start learning",
      titlePre: "Cards are in —",
      titleAccent: "let spaced repetition schedule the rest",
      titlePost: "",
      lead: "Anki's core is spaced repetition: reviews land right before you're about to forget, so memory sticks with the fewest repetitions. Magpie makes saving effortless; Anki handles the schedule.",
      items: [
        { title: "Review daily", desc: "The main screen shows today's due count — click the \"Magpie\" deck to start. New cards default to 20/day, adjustable in deck options." },
        { title: "Grade honestly", desc: "Couldn't recall? Hit \"Again\". Easy recall gets \"Good\" — the more honest your grades, the sharper the schedule." },
        { title: "Edit any time", desc: "Only the explanation on the back? Double-click a card in Anki to add examples, images or audio." },
        { title: "Review on your phone", desc: "Create an AnkiWeb account, sync once on desktop, then install AnkiDroid (Android, free) or AnkiMobile (iOS) to review anywhere." },
      ],
    },
    resources: {
      eyebrow: "Going further",
      title: "Learning resources",
      lead: "To go deeper with Anki, these are the main official and community resources.",
      items: [
        { name: "Anki manual", desc: "The official manual covering decks, note types, templates and the scheduling algorithm.", url: "https://docs.ankiweb.net/", link: "docs.ankiweb.net" },
        { name: "AnkiConnect", desc: "The add-on's official project page — install notes and the full API reference.", url: "https://github.com/FooSoft/anki-connect", link: "github.com/FooSoft/anki-connect" },
        { name: "Shared decks", desc: "Community-shared decks (languages, exams, disciplines) ready to download and use.", url: "https://ankiweb.net/shared/decks", link: "ankiweb.net/shared/decks" },
        { name: "AnkiDroid", desc: "The Android client — free, open source, synced with desktop via AnkiWeb.", url: "https://github.com/ankidroid/Anki-Android", link: "github.com/ankidroid/Anki-Android" },
        { name: "Anki forums", desc: "Where the community and developers gather; add-ons and usage questions get answered here.", url: "https://forums.ankiweb.net/", link: "forums.ankiweb.net" },
        { name: "Getting-started guides", desc: "Plenty of written and video tutorials exist — search \"Anki tutorial\" or \"how to use Anki\" on your favorite platform.", url: "https://www.google.com/search?q=how+to+use+anki", link: "Guides & videos" },
        { name: "Cambridge Dictionary", desc: "Authoritative learner's dictionary with IPA, examples and translations — the first stop when wording your cards.", url: "https://dictionary.cambridge.org/", link: "dictionary.cambridge.org" },
        { name: "YouGlish", desc: "Hear any word pronounced by real speakers in YouTube contexts — the best companion for pronunciation cards.", url: "https://youglish.com/", link: "youglish.com" },
        { name: "BBC Learning English", desc: "BBC's free, structured English-learning programmes — short lessons with audio and text that pair well with daily reviews.", url: "https://www.bbc.co.uk/learningenglish", link: "bbc.co.uk/learningenglish" },
      ],
    },
    faq: {
      eyebrow: "FAQ",
      title: "About Magpie × Anki",
      items: [
        { q: "Does adding cards need internet?", a: "No. Card creation is local communication between Magpie and Anki on your machine. Only when the back side should carry an AI answer does the selected text go to the model service you configured." },
        { q: "Will it touch my existing decks and templates?", a: "No. Setup only creates the \"Magpie\" deck, its two sub-decks and two card templates; same-name items are skipped, and everything else stays untouched." },
        { q: "Can I add cards while Anki is closed?", a: "No. AnkiConnect runs inside the Anki process; when Anki isn't detected, Magpie shows a connection failure. Start Anki first, then clip." },
        { q: "Will the same word be added twice?", a: "No. Anki deduplicates on the first field (the original text); on duplicates Magpie shows a notice that the card already exists." },
        { q: "Can I review on my phone?", a: "Yes. After syncing desktop with AnkiWeb, review the same deck on Android with AnkiDroid (free) or on iOS with AnkiMobile." },
        { q: "Can I change card styling?", a: "Yes. Styling belongs to the Anki note type: open Tools → Manage Note Types in Anki, find Magpie Word / Content and edit templates or CSS — changes apply to new cards." },
      ],
    },
    cta: {
      title: "Ready to start",
      lead: "Download Magpie, set up Anki, and your next selection is your first card.",
      button: "Download Magpie",
      guide: "First, see how select & translate works",
    },
  },
};
