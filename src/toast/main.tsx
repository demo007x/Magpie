// 全局 toast 窗口：主窗口隐藏（纯菜单栏模式）时也能看到截图/识别失败等提示。
// 视觉与浮动条同构（实心原生面板，随系统明暗）；尺寸随内容自适应——渲染后
// 测量内容尺寸调 resize_toast 缩放窗口。窗口定位/置前/自动隐藏都在 Rust 侧。
// Rust 通过 win.eval 调用 window.__toastShow 直推消息（不走事件系统）。
import { useEffect, useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { AlertCircle, Info } from "lucide-react";
import "./toast.css";

type Kind = "err" | "info";

declare global {
  interface Window {
    __toastShow?: (message: string, kind?: Kind) => void;
  }
}

function ToastApp() {
  const [toast, setToast] = useState<{ message: string; kind: Kind } | null>(null);

  useEffect(() => {
    window.__toastShow = (message: string, kind: Kind = "info") =>
      setToast({ message, kind });
  }, []);

  // 内容测量 → 缩放窗口（材质层由原生填满窗口，窗口尺寸即面板尺寸）
  useLayoutEffect(() => {
    if (!toast) return;
    const el = document.querySelector<HTMLElement>(".toast-pop");
    if (!el) return;
    invoke("resize_toast", {
      width: el.scrollWidth,
      height: el.offsetHeight,
    }).catch(() => undefined);
  }, [toast]);

  if (!toast) return null;
  const Icon = toast.kind === "err" ? AlertCircle : Info;
  return (
    <div className="stage">
      <div className={`toast-pop ${toast.kind === "err" ? "is-err" : ""}`}>
        <Icon />
        <span className="toast-text">{toast.message}</span>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<ToastApp />);
