import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 多入口 MPA：main（主窗口：设置/自检） + floating（浮动条/OCR 面板） + toast（全局提示）
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  build: {
    rollupOptions: {
      input: {
        main: "index.html",
        floating: "floating.html",
        toast: "toast.html",
      },
    },
  },
});
