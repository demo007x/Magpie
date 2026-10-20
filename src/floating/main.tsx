import React from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import App from "./App";
import PopCard from "./pops";
import { interceptExternalLinks } from "../shared/external-links";
import "./floating.css";

// 应用内链接一律外部打开（结果窗译文里的 URL 等），webview 永不自行导航
interceptExternalLinks();

// 平台根类：Windows 上窗口阴影（DWM 矩形投影）在透明窗上不渲染，
// 悬浮感由 CSS 自绘接管（floating.css 的 html.win 规则，对齐 toast.css 先例）；
// macOS 保持 NSWindow 原生阴影（按内容 alpha 形状画影），不加根类、样式零改动
if (!/Mac/i.test(navigator.platform)) {
  document.documentElement.classList.add("win");
  // 物理像素对齐变量：发丝描边/圆角按物理像素取值（floating.css html.win），
  // 跨屏拖动触发 DPI 变化时随 resize 刷新
  const syncDpr = () =>
    document.documentElement.style.setProperty("--dpr", String(window.devicePixelRatio || 1));
  syncDpr();
  window.addEventListener("resize", syncDpr);
}

// 窗口身份：floating = 划词胶囊；floating-panel / floating-menu = Windows 分离卡
// 的二级浮层窗口（方案甲「一卡一窗」，哑渲染端，见 pops.tsx）；ocr / pin-* 走 App
const WIN_LABEL = (() => {
  try {
    return getCurrentWebviewWindow().label;
  } catch {
    return "floating";
  }
})();
const IS_POP = WIN_LABEL === "floating-panel" || WIN_LABEL === "floating-menu";

// 主题根类：App 与弹层窗口（floating-panel/menu）共用同一外观设置——弹层窗口
// 若不挂主题类会跟系统偏好走（系统浅色 + 应用深色 → 深色胶囊条旁出白卡片错配）；
// appearance = auto 时不挂类，交由 prefers-color-scheme 媒体查询
const applyTheme = (t: string) => {
  document.documentElement.classList.toggle("theme-light", t === "light");
  document.documentElement.classList.toggle("theme-dark", t === "dark");
};
invoke<{ appearance?: string }>("get_settings")
  .then((s) => applyTheme(s.appearance ?? "auto"))
  .catch(() => undefined);
getCurrentWebviewWindow()
  .listen<string>("theme://appearance", (e) => applyTheme(e.payload))
  .catch(() => undefined);

// 悬浮窗是透明无边框窗口：渲染树一旦崩溃，窗口就变成全透明空壳，
// 用户看到的不是报错而是"胶囊没出现"。边界把异常显示出来并写进日志，
// 便于在终端（ui_debug_log）直接定位崩溃原因。
class FloatingBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    invoke("ui_debug_log", {
      msg: `FLOATING CRASH: ${error.message}\n${info.componentStack ?? ""}`,
    }).catch(() => undefined);
  }

  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            padding: 12,
            borderRadius: 12,
            color: "#fff",
            background: "#b3261e",
            fontSize: 12,
            whiteSpace: "pre-wrap",
            maxWidth: 360,
          }}
        >
          界面异常：{String(this.state.error.message ?? this.state.error)}
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <FloatingBoundary>{IS_POP ? <PopCard /> : <App />}</FloatingBoundary>
  </React.StrictMode>,
);
