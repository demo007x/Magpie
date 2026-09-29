import React from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import App from "./App";
import "./main.css";

// 设置主窗没有导航兜底：渲染树崩溃 = 整页白屏。边界把异常显示出来并写进
// 终端日志（ui_debug_log），崩溃原因第一眼可见，不用再对着白屏猜。
class MainBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    invoke("ui_debug_log", {
      msg: `MAIN CRASH: ${error.message}\n${info.componentStack ?? ""}`,
    }).catch(() => undefined);
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 24, fontSize: 13, color: "#b3261e" }}>
          <p style={{ fontWeight: 600 }}>界面出现异常</p>
          <pre style={{ whiteSpace: "pre-wrap", marginTop: 8 }}>
            {String(this.state.error.message ?? this.state.error)}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <MainBoundary>
      <App />
    </MainBoundary>
  </React.StrictMode>,
);
