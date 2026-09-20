import { invoke } from "@tauri-apps/api/core";

/** 全局轻提示：Rust 的 toast 窗口，主窗口隐藏（菜单栏模式）时也能看到。
 *  不要用 window.alert / window.confirm——WKWebView 里它们是静默空操作，
 *  什么都不会弹，代码还会在 confirm() 的 false 分支上直接 return（表现为按钮"没反应"） */
export function toast(message: string, kind: "info" | "err" | "progress" = "info") {
  void invoke("notify", { message, kind });
}
