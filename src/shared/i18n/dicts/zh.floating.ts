// floating 域词典（中文源）：浮动条 / 动作胶囊 / 结果窗 / 钉图。键只增不改语义。
// 运行时数据（用户自定义动作名、引擎名、AI 输出）不在此列；AI 提示词与解析
// 标记（【译文】/【要点】）随提示词走，不进界面词典。
export const zhFloating = {
  "floating.ocrResultTitle": "识图{action}",

  // 截图胶囊四件套与「提取信息」入口
  "floating.snipOcr": "识别文字",
  "floating.extractEntry": "提取信息",
  "floating.extractTitle": "提取结果",

  // 动作按钮短暂反馈（flash）与全局 toast
  "floating.opened": "已打开",
  "floating.openFailed": "打开失败",
  "floating.copied": "已复制",
  "floating.copy": "复制",
  "floating.ariaReadAloud": "朗读",
  "floating.ariaStopRead": "停止朗读",
  "floating.ttsMissing": "请先在设置 › 朗读里下载音色包",
  "floating.copiedValue": "已复制 {value}",
  "floating.mailOpened": "已打开邮件客户端",
  "floating.calendarOpened": "已打开日历",
  "floating.mapOpened": "已在地图打开",
  "floating.engineMissing": "未配置引擎",
  "floating.translateMissing": "未启用翻译服务",
  "floating.vaultMissing": "未配置 Obsidian vault，请在设置页选择",
  "floating.savedTask": "已存入任务",
  "floating.obsidianOriginal": "原文",
  "floating.savedCard": "已存入卡片：{title}",
  "floating.savedFile": "已存入 {name}",
  "floating.obsidianFailed": "存入 Obsidian 失败",
  "floating.ankiSaved": "已存入 Anki {card}",
  "floating.ankiNotConfigured": "Anki 还没配置，去设置 › Anki 一键开启",
  "floating.cardFallbackName": "卡片 {date} {time}",

  // 图标钮的 aria-label（无可见文字，读屏依赖）
  "floating.ariaMoreTranslate": "更多翻译服务",
  "floating.ariaMoreSearch": "更多搜索引擎",
  "floating.ariaTargets": "存入目标",
  "floating.ariaMoreActions": "还有 {n} 个动作",
  "floating.ariaCopyAll": "复制全部",
  "floating.ariaClose": "收起",
  "floating.ariaPinImage": "钉图",
  "floating.ariaPinPanel": "钉住面板",
  "floating.ariaCopyImage": "复制图片",
  "floating.ariaToggleSource": "展开或收起原文",
  "floating.visionRunning": "正在识别图片文字…",
  "floating.ariaJumpDown": "回到底部",

  // 提取面板行内小动作钮与组头
  "floating.actOpen": "打开",
  "floating.actMail": "邮件",
  "floating.actCalendar": "日历",
  "floating.actMap": "地图",
  "floating.actPath": "打开位置",
  "floating.extractLoading": "正在理解所选内容…",
  "floating.group.tel": "电话",
  "floating.group.email": "邮箱",
  "floating.group.link": "链接",
  "floating.group.code": "验证码",
  "floating.group.date": "日期",
  "floating.group.addr": "地点",
  "floating.group.path": "位置",

  // 「打开位置」的结果反馈（Rust open_local_path 六档，仅 Windows 会走到前两档以外）：
  // 成功说清「做了什么」，失败是陈述不是报错——选区里的路径早就失效是常态
  "path.openedDir": "已打开这个文件夹",
  "path.openedReveal": "已在文件管理器里选中它",
  "path.openedApp": "已打开这个文件",
  "path.missing": "这个位置不存在，可能被移动或删除了",
  "path.failed": "这个位置打不开",
  "path.unsupported": "这台电脑还不会打开文件位置",

  // 结果窗（OCR 面板）
  "floating.ocrTextTitle": "识图取字",
  "floating.ocrResultFallback": "结果",
  "floating.thinking": "正在思考…",
  "floating.retry": "重试",

  // Obsidian 存入目标（胶囊 ⌄ 菜单 / 分离卡菜单共用）
  "floating.targetNote": "笔记",
  "floating.targetTask": "任务",
  "floating.targetCard": "卡片",

  // 离线词典结果窗（版面在 shared/dict.ts；pos 是词库原文，实测封闭取值 14 个）
  "dict.pos.noun": "名词",
  "dict.pos.verb": "动词",
  "dict.pos.adj": "形容词",
  "dict.pos.name": "专有名词",
  "dict.pos.adv": "副词",
  "dict.pos.phrase": "短语",
  "dict.pos.intj": "感叹词",
  "dict.pos.suffix": "后缀",
  "dict.pos.prefix": "前缀",
  "dict.pos.prep": "介词",
  "dict.pos.pron": "代词",
  "dict.pos.proverb": "谚语",
  "dict.pos.num": "数词",
  "dict.pos.det": "限定词",
  "dict.usage": "用法",
  "dict.memory": "助记",
  "dict.etymology": "词源",
  "dict.miss": "词典里没有「{word}」。中文词句和长段落请用「翻译」。",
  "floating.dictFailed": "查词失败",

  // 杂项
  "floating.unknownApp": "未知应用",
  "floating.uiError": "界面异常：{msg}",

  // 日期展示（NSDataDetector 命中的行标签；w = 周几短名，见 weekday.*）
  "floating.dateLabel": "{m}月{d}日 周{w}",
  "floating.weekday.0": "日",
  "floating.weekday.1": "一",
  "floating.weekday.2": "二",
  "floating.weekday.3": "三",
  "floating.weekday.4": "四",
  "floating.weekday.5": "五",
  "floating.weekday.6": "六",
};
