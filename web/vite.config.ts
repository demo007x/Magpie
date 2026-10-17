import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  // 相对 base：同一份 dist 可直接发布到任意路径——GitHub Pages 项目站
  // （…/Magpie/）、自建服务器根目录或子目录都能跑。/en/ 子页与 /translate/
  // 专题页的资源前缀由「运行时按语言与深度计算 + 预渲染改写」解决
  // （见 i18n 的 assetBase 与 scripts/prerender.mjs），不要改回绝对 base
  base: "./",
  build: {
    rollupOptions: {
      // 相对路径由 vite 按 root 解析；工程未装 @types/node，避免 node:path
      input: { main: "index.html", translate: "translate.html" },
    },
  },
  plugins: [
    react(),
    tailwindcss(),
    {
      // dev 下 /en/ 直连等价于 /、/translate/ 直连 /translate.html（构建产物
      // 才是真目录页）；dev 里点语言按钮走 pushState 软切换不经此。两个中间件
      // 依次剥离前缀再交给 vite 兜底。req 经断言访问 url（同上，无 node 类型）
      name: "locale-dev",
      configureServer(server) {
        server.middlewares.use("/en", (_req, _res, next) => next());
        server.middlewares.use((req, _res, next) => {
          const url = (req as { url?: string }).url ?? "";
          if (/^\/translate\/?$/.test(url)) (req as { url: string }).url = "/translate.html";
          next();
        });
      },
    },
  ],
});
