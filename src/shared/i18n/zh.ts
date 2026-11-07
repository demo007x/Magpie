// 中文源词典 = 各域词典合并（shared / main / floating）。域拆分是为了并行
// 迁移时各域文件互不冲突；键冲突 = 合并时后者覆盖，属错误，勿用重复前缀。
import { zhShared } from "./dicts/zh.shared";
import { zhMain } from "./dicts/zh.main";
import { zhFloating } from "./dicts/zh.floating";

export const zh = {
  ...zhShared,
  ...zhMain,
  ...zhFloating,
};
