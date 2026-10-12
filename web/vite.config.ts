import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  // 根路径部署：双语言子页（/en/）下的绝对资源 URL 依赖它；改子路径需连 canonical/og 一起调
  base: "/",
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
