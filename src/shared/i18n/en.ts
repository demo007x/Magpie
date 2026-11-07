// 英文词典 = 各域词典合并，键集与 zh.ts 完全一致（缺键/多键编译期报错）。
import type { Dict } from "./index";
import { enShared } from "./dicts/en.shared";
import { enMain } from "./dicts/en.main";
import { enFloating } from "./dicts/en.floating";

export const en: Dict = {
  ...enShared,
  ...enMain,
  ...enFloating,
};
