import React from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import App from "./App";
import "./floating.css";

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
    <FloatingBoundary>
      <App />
    </FloatingBoundary>
  </React.StrictMode>,
);
