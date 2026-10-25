// 页面组件的公共 props：设置页各页共用（settings 状态机 + 保存动作）。
// patch/saveNow/save 的语义见 App.tsx（patch = 本地合并+置脏；saveNow = 即时落盘；
// save = 保存按钮走 saveNow）。captureReady = 划词捕获能力位（后端真实可用才显示相关页）。
import type { Settings } from "../../shared/types";

export interface PageProps {
  // 非空：App 渲染页面主体前有「正在载入」守卫
  settings: Settings;
  patch: (p: Partial<Settings> | ((s: Settings) => Partial<Settings>)) => void;
  /** 保存按钮页用（自动保存页无按钮） */
  save?: () => void;
  saved?: boolean;
  /** 即时落盘路径（自动保存类页面用；保存按钮页不需要） */
  saveNow?: () => void;
  /** 划词捕获能力位（仅划词/黑名单页需要） */
  captureReady?: boolean;
}
