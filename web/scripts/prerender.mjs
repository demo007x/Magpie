// 构建期预渲染：vite build 之后运行，把 React 树渲染成含完整正文的静态 HTML。
// 四份产物——首页与划词翻译专题页各两语言：
//   dist/index.html（/）            dist/en/index.html（/en/）
//   dist/translate/index.html（/translate/）
//   dist/en/translate/index.html（/en/translate/）
// 爬虫、禁 JS 访问与社交卡片直接读到全文；客户端再水合接管交互。
// 每页的 <head>（lang/title/description/og/canonical）由 META[page][locale] 覆写。
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
  const shells = {
    home: readFileSync("dist/index.html", "utf8"),
    translate: readFileSync("dist/translate.html", "utf8"),
  };

  const pages = [
    { locale: "zh", page: "home", url: "https://fm126.top/", file: "dist/index.html" },
    { locale: "en", page: "home", url: "https://fm126.top/en/", file: "dist/en/index.html" },
    {
      locale: "zh",
      page: "translate",
      url: "https://fm126.top/translate/",
      file: "dist/translate/index.html",
    },
    {
      locale: "en",
      page: "translate",
      url: "https://fm126.top/en/translate/",
      file: "dist/en/translate/index.html",
    },
  ];

  for (const page of pages) {
    const m = META[page.page][page.locale];
    // 替换一律走函数形式并显式拼接捕获组——返回串里的 $ 序列不会被展开，
    // 标题/描述里的 —、中文标点也天然安全
    let html = shells[page.page]
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
      .replace(
        '<div id="root"></div>',
        () => `<div id="root">${render(page.locale, page.page)}</div>`,
      );

    // 深页比站点根深（/translate/ 一层、/en/ 一层、/en/translate/ 两层）：
    // head 里 vite 产物与 favicon 的 ./ 前缀、正文里 SSR（PRERENDER 期
    // assetBase="./"）渲染出的 shots 前缀，统一改写为对应深度的 ../ 前缀——
    // 与客户端 PROD 构建（assetBase 按深度取值）一致，水合不冲突；站点按
    // 相对路径部署，根域名 / 子路径（GitHub Pages /Magpie/）/ 自建服务器
    // 任意目录通用
    const up =
      (page.page === "translate" ? 1 : 0) + (page.locale === "en" ? 1 : 0);
    if (up > 0) {
      const prefix = "../".repeat(up);
      html = html
        .replaceAll('"./', `"${prefix}`)
        .replaceAll('src="shots/', `src="${prefix}shots/`)
        .replaceAll('srcset="shots/', `srcset="${prefix}shots/`);
    }

    const out = resolve(root, page.file);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, html);
    console.log(`prerendered ${page.url} -> ${page.file}`);
  }
} finally {
  await server.close();
}
