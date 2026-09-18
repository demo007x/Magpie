// 全局 toast 窗口：主窗口隐藏（纯菜单栏模式）时也能看到截图/识别失败等提示。
// 视觉与浮动条同构（实心原生面板，随系统明暗）；尺寸随内容自适应——渲染后
// 测量内容尺寸调 resize_toast 缩放窗口。窗口定位/置前/自动隐藏都在 Rust 侧。
// Rust 通过 win.eval 调用 window.__toastShow 直推消息（不走事件系统）。
import { useEffect, useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { AlertCircle, Info, LoaderCircle } from "lucide-react";
import "./toast.css";

type Kind = "err" | "info" | "progress";

declare global {
  interface Window {
    __toastShow?: (message: string, kind?: Kind) => void;
  }
}

function ToastApp() {
  const [toast, setToast] = useState<{ message: string; kind: Kind } | null>(null);

  useEffect(() => {
    // message 支持「主行\n次行」两段：主行说发生了什么，次行（次要灰）说怎么办。
    // 「识别中→失败」的先后出场由 Rust 侧编排（旧条滚出隐藏后新条滚入），
    // 前端收到调用时窗口处于隐藏间隙，直接渲染新内容即可
    window.__toastShow = (message: string, kind: Kind = "info") =>
      setToast({ message, kind });
    // Liquid Glass（macOS 26）：生效则表面切半透明让玻璃透出；
    // 监听设置页开关的广播，运行时切换即时生效
    const applyGlass = (on: boolean) =>
      document.documentElement.classList.toggle("liquid-glass", on);
    invoke<boolean>("liquid_glass_enabled")
      .then(applyGlass)
      .catch(() => undefined);
    listen<boolean>("theme://liquid-glass", (e) => applyGlass(e.payload)).catch(() => undefined);
    // 用户强制外观（亮/暗）：html 挂 theme class；广播早于挂载会漏听，主动读一次
    const applyTheme = (t: string) => {
      document.documentElement.classList.toggle("theme-light", t === "light");
      document.documentElement.classList.toggle("theme-dark", t === "dark");
    };
    invoke<{ appearance?: string }>("get_settings")
      .then((s) => applyTheme(s.appearance ?? "auto"))
      .catch(() => undefined);
    listen<string>("theme://appearance", (e) => applyTheme(e.payload)).catch(() => undefined);
  }, []);

  // 内容测量 → 缩放窗口（材质层由原生填满窗口，窗口尺寸即面板尺寸）。
  // 宽高都随内容：短文案贴内容宽，长文案封顶后折行增高（上限在 Rust 侧钳制）
  useLayoutEffect(() => {
    if (!toast) return;
    const el = document.querySelector<HTMLElement>(".toast-pop");
    if (!el) return;
    invoke("resize_toast", {
      width: el.offsetWidth,
      height: el.offsetHeight,
    }).catch(() => undefined);
  }, [toast]);

  if (!toast) return null;
  const Icon =
    toast.kind === "err" ? AlertCircle : toast.kind === "progress" ? LoaderCircle : Info;
  const [main, ...rest] = toast.message.split("\n");
  return (
    <div className="stage">
      {/* key 随内容变化：状态换装（如 识别中→失败）时触发滑入动画。
          动画挂在 .toast-body（图标+文字整体），磨砂底面原地不动 */}
      <div className={`toast-pop ${toast.kind}`}>
        <div className="toast-body">
          <Icon className={`ic ${toast.kind === "progress" ? "spin" : ""}`} />
          <span className="toast-text">
            <span className="toast-main">{main}</span>
            {rest.length > 0 && <span className="toast-sub">{rest.join("\n")}</span>}
          </span>
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<ToastApp />);
