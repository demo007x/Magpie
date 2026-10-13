import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  // 相对 base：同一份 dist 可直接发布到任意路径——GitHub Pages 项目站
  // （…/Magpie/）、自建服务器根目录或子目录都能跑。/en/ 子页的资源前缀
  // 由「运行时按语言计算 + 预渲染改写」解决（见 i18n 的 assetBase 与
  // scripts/prerender.mjs），不要改回绝对 base
  base: "./",
  plugins: [
    react(),
    tailwindcss(),
    {
      // dev 下 /en/ 直连等价于 /（构建产物才是真双页）；dev 里点语言按钮走
      // pushState 软切换不经此。中间件挂载 /en 前缀即剥离，next() 交给 vite 兜底
      name: "en-locale-dev",
      configureServer(server) {
        server.middlewares.use("/en", (_req, _res, next) => next());
      },
    },
  ],
});
