// 内置搜索引擎显示名映射：引擎的存储身份就是 name（defaultSearch / 拖拽排序 /
// 内置判定 / pops 高亮匹配全按名比较，见 settings.rs default_engines），存储值
// 不能随界面语言变——映射只发生在展示层：英文界面下对已知内置中文名显示英文，
// 其余（用户自建、已改名、或中文界面）原样显示。
import { getLocale } from "./i18n";

const EN_ENGINE_NAMES: Record<string, string> = {
  百度AI: "Baidu AI",
  百度: "Baidu",
  必应: "Bing",
};

export function engineDisplayName(name: string): string {
  if (getLocale() !== "en") return name;
  return EN_ENGINE_NAMES[name] ?? name;
}
