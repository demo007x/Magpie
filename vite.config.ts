import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 多入口 MPA：main（主窗口：设置/自检） + floating（浮动条/OCR 面板） + toast（全局提示）
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    // 监视排除 Rust 构建产物：cargo 链接期间 magpie.exe 被锁，
    // chokidar watch 到 EBUSY 直接崩掉整个 dev 进程（Windows 实测）
    watch: {
      ignored: ["**/src-tauri/target/**", "**/dist/**"],
    },
  },
  build: {
    rollupOptions: {
      input: {
        main: "index.html",
        floating: "floating.html",
        toast: "toast.html",
        snap: "snap.html",
      },
    },
  },
});
