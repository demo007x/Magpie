// 构建期预渲染：vite build 之后运行，把 React 树渲染成含完整正文的静态 HTML。
// 产物两份——dist/index.html（中文，/）与 dist/en/index.html（英文，/en/），
// 爬虫、禁 JS 访问与社交卡片直接读到全文；客户端再水合接管交互。
// 每页的 <head>（lang/title/description/og/canonical）由 META[locale] 逐页覆写。
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createServer } from "vite";

const root = resolve(import.meta.dirname, "..");
process.chdir(root);

const server = await createServer({
  server: { middlewareMode: true },
  appType: "custom",
  logLevel: "error",
});

try {
  const { render } = await server.ssrLoadModule("/src/entry-server.tsx");
  const { META } = await server.ssrLoadModule("/src/i18n.tsx");
  const shell = readFileSync("dist/index.html", "utf8");

  const pages = [
    { locale: "zh", url: "https://fm126.top/", file: "dist/index.html" },
    { locale: "en", url: "https://fm126.top/en/", file: "dist/en/index.html" },
  ];

  for (const page of pages) {
    const m = META[page.locale];
    // 替换一律走函数形式并显式拼接捕获组——返回串里的 $ 序列不会被展开，
    // 标题/描述里的 —、中文标点也天然安全
    const html = shell
      .replace(/<html lang="[^"]*"/, (s) => s.replace(/lang="[^"]*"/, `lang="${m.lang}"`))
      .replace(/<title>[^<]*<\/title>/, () => `<title>${m.title}</title>`)
      .replace(
        /(<meta name="description" content=")[^"]*(")/,
        (_, p1, p2) => `${p1}${m.description}${p2}`,
      )
      .replace(/(<meta property="og:title" content=")[^"]*(")/, (_, p1, p2) => `${p1}${m.title}${p2}`)
      .replace(
        /(<meta property="og:description" content=")[^"]*(")/,
        (_, p1, p2) => `${p1}${m.description}${p2}`,
      )
      .replace(
        /(<meta property="og:locale" content=")[^"]*(")/,
        (_, p1, p2) => `${p1}${m.ogLocale}${p2}`,
      )
      .replace(/(<link rel="canonical" href=")[^"]*(")/, (_, p1, p2) => `${p1}${page.url}${p2}`)
      .replace('<div id="root"></div>', () => `<div id="root">${render(page.locale)}</div>`);

    const out = resolve(root, page.file);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, html);
    console.log(`prerendered ${page.url} -> ${page.file}`);
  }
} finally {
  await server.close();
}
