// 配套笔记类型共享常量：设置页创建（AnkiPage）与建卡兜底（floating）共用。
// 出厂映射不落盘——建卡时按需覆盖；自定义笔记类型无映射，走建卡智能默认。

export const COMPANION_WORD = "拾趣单词卡";
export const COMPANION_CONTENT = "拾趣内容卡";

/** 配套子牌组（Anki 原生层级，「拾趣」父牌组随首个子牌组自动出现） */
export const DECK_WORD = "拾趣::单词卡";
export const DECK_CONTENT = "拾趣::内容卡";

/** ⌄ 菜单/自动路由共用的配套组合：deck 与 model 绑定成对——进哪个子牌组
    就用哪种类型排版；label 为产品名，两种界面语言共用 */
export const COMPANION_ITEMS = [
  { deck: DECK_WORD, model: COMPANION_WORD, label: "单词卡" },
  { deck: DECK_CONTENT, model: COMPANION_CONTENT, label: "内容卡" },
];

/** 两种配套类型是否同名判断（建卡时叠加出厂映射用） */
export const isCompanionModel = (name: string) =>
  name === COMPANION_WORD || name === COMPANION_CONTENT;

/** 配套类型的字段模板出厂值（两种类型同构：正面/背面/来源/链接/日期；
    正面走智能默认，不在表内） */
export const COMPANION_FIELD_MAP: Record<string, string> = {
  背面: "{result}",
  来源: "{source}",
  链接: "{url}",
  日期: "{date}",
};

/** 短划词判定 → 单词卡，其余 → 内容卡（建卡时自动路由；两类型字段同构，
    判错只差排版不丢数据，故启发式可放宽）：无换行、无句读、≤24 字符 */
export const isShortSelection = (s: string) => {
  const v = s.trim();
  return v.length > 0 && v.length <= 24 && !/[\n。！？!?…；;：:]/.test(v);
};
