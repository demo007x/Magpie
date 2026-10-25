// 动作名/描述与 Obsidian 模板默认值：capture（动作卡）与 prompts（提示词卡）两页共用
export const ACTION_LABELS: Record<string, string> = {
  translate: "翻译",
  explain: "解释",
  summarize: "总结",
  extract: "智能提取",
  copy: "复制",
  search: "搜索",
  link: "打开链接",
  email: "写邮件",
  code: "复制验证码",
  tel: "复制号码",
  date: "加入日历",
  addr: "打开地图",
  obsidian: "Obsidian",
};

/** Obsidian 模板出厂默认值，与 src-tauri/src/settings.rs 的 ObsidianConfig::default 保持一致
    （「恢复默认」按钮的目标值；obsidian 配置为全量存储，没有缺省回落机制） */
export const DEFAULT_EXCERPT_TEMPLATE = "- **{time}** · 来源：{source}\n  > {text}";
export const DEFAULT_TASK_TEMPLATE = "- [ ] {text} {dueTag}";
export const DEFAULT_CARD_TEMPLATE = "- **{time}** · 来源：{source}\n  > {text}";

export const ACTION_DESC: Record<string, string> = {
  translate: "中文译英文，其他译中文，附学习要点",
  explain: "解释选中内容是什么、为什么重要",
  summarize: "按内容体量提炼要点，长短自适应",
  copy: "复制选中的原文",
  search: "用默认搜索引擎搜索选中内容",
  link: "选中的是网址时，一键打开网页",
  email: "选中的是邮箱时，唤起邮件客户端",
  code: "选中含验证码时，一键复制纯数字",
  tel: "选中含电话号码时，一键复制号码",
  date: "选中含日期时间时（如“周四下午3点”），一键预填进日历",
  addr: "选中含地点时（如“国贸B座”），一键在地图打开",
  obsidian: "已配置 Obsidian vault 时，把选中内容按摘录模板追加进日记",
};
