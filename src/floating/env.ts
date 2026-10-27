// src/floating/env.ts —— 浮动条工程的窗口身份与平台常量（App.tsx 拆分的地基）。
// 全部为模块级常量：窗口身份在生命周期内不变，事件回调不会读到过期值。
// 拆分说明：App.tsx 原是一整块（3361 行），按域拆为多个 hook/组件文件，
// 本文件是被各拆分文件共享的公共底座。各文件职责见 App.tsx 头部导航注释。

import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

// 窗口身份：floating = 划词浮动条；ocr = 文本识别独立窗口；pin-* = 钉图窗口
export const WIN_LABEL = (() => {
  try {
    return getCurrentWebviewWindow().label;
  } catch {
    return "floating";
  }
})();

export const IS_OCR = WIN_LABEL === "ocr";
export const IS_PIN = WIN_LABEL.startsWith("pin-");

// 平台分叉（与 main.tsx 的 html.win 根类同一判据）：Windows 走方案甲「一卡一窗」
// 分离卡——二级浮层渲染在独立窗口（floating-panel / floating-menu，窗口即卡片，
// 见 floating.rs），本窗口（胶囊）只把渲染数据 + 锚点推给 Rust（set_floating_pops）；
// macOS 维持单窗分离卡（NSWindow 按内容轮廓画影），交互逻辑与样式零改动
export const IS_WIN_LIKE = !/Mac/i.test(navigator.platform);
export const POPS_EXTERNAL = IS_WIN_LIKE && !IS_OCR && !IS_PIN;

// 二级浮层开合状态的取值域（fading 退场快照同域）：chev:* 仅浮动条胶囊、
// overflow 浮动条「更多」收纳 / OCR 结果窗胶囊堆共用一名、pmenu:* 为堆内
// 行侧菜单、search/translate/obsidian 为结果窗动作行 ⌄ 槽位菜单
export type HoverMenuId =
  | "chev:translate"
  | "chev:search"
  | "chev:obsidian"
  | "overflow"
  | "pmenu:translate"
  | "pmenu:search"
  | "pmenu:obsidian"
  | "search"
  | "translate"
  | "obsidian";

// Rust 返回的窗口落位 / 显示器逻辑矩形（逻辑坐标）——布局 effect 的坐标基准
// （锚定/翻转判定依赖），拖拽结束回读刷新
export interface WindowPos {
  x: number;
  y: number;
}
export interface ScreenRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}
