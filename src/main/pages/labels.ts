// 动作名/描述与 Obsidian 模板默认值：capture（动作卡）与 prompts（提示词卡）两页共用。
// 动作名/描述走 i18n 词典（action.* / actionDesc.*，随界面语言切换）；
// 原先与 actions.ts 双份定义的中文名已由此合一。
import { t } from "../../shared/i18n";

export const actionLabel = (id: string): string => t(`action.${id}`);

export const actionDesc = (id: string): string => t(`actionDesc.${id}`);

/** Obsidian 模板出厂默认值，与 src-tauri/src/settings.rs 的 ObsidianConfig::default 保持一致
    （「恢复默认」按钮的目标值；obsidian 配置为全量存储，没有缺省回落机制）。
    模板是随 settings 存储的用户数据、不随界面语言切换，默认值因此用中性写法：
    {source} 本身是应用名，无需「来源：」标签（2026-11-07 界面双语化时调整） */
export const DEFAULT_EXCERPT_TEMPLATE = "- **{time}** · {source}\n  > {text}";
export const DEFAULT_TASK_TEMPLATE = "- [ ] {text} {dueTag}";
export const DEFAULT_CARD_TEMPLATE = "- **{time}** · {source}\n  > {text}";
