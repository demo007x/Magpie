// 应用内 webview 永不自行导航：结果窗（AI 译文/识图文本）与设置页里渲染出的
// 链接，点击时一律交给系统默认浏览器（open_url 命令，内置协议白名单兜底
// 安全边界）。应用 webview 没有第三方站点的登录态与回退路径，页内导航只会
// 把应用界面整体替换成别人的页面（且必然是残缺状态）。
// 捕获阶段拦截：先于 React 合成事件与浏览器默认行为生效。
import { invoke } from "@tauri-apps/api/core";

export function interceptExternalLinks(): void {
  document.addEventListener(
    "click",
    (e) => {
      const target = e.target as HTMLElement | null;
      const a = target?.closest?.("a");
      if (!a) return;
      const href = a.getAttribute("href");
      // 应用内锚点（同页跳转）放行；其余一律外部打开
      if (!href || href.startsWith("#")) return;
      e.preventDefault();
      invoke("open_url", { url: href }).catch(() => undefined);
    },
    true,
  );
}
