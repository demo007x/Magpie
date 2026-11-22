// 构建期预渲染：vite build 之后运行，把 React 树渲染成含完整正文的静态 HTML。
// 八份产物——首页与三个专题页（划词翻译 / Anki / 词典）各两语言：
//   dist/index.html（/）            dist/en/index.html（/en/）
//   dist/translate/index.html（/translate/）
//   dist/en/translate/index.html（/en/translate/）
//   dist/anki/index.html（/anki/）  dist/en/anki/index.html（/en/anki/）
//   dist/dict/index.html（/dict/）  dist/en/dict/index.html（/en/dict/）
// 爬虫、禁 JS 访问与社交卡片直接读到全文；客户端再水合接管交互。
// 每页的 <head>（lang/title/description/keywords/og/canonical）由
// META[page][locale] 覆写；另注入 JSON-LD 结构化数据（SEO）。
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
  const { META, DICTS } = await server.ssrLoadModule("/src/i18n.tsx");
  const shells = {
    home: readFileSync("dist/index.html", "utf8"),
    translate: readFileSync("dist/translate.html", "utf8"),
    anki: readFileSync("dist/anki.html", "utf8"),
    dict: readFileSync("dist/dict.html", "utf8"),
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
    {
      locale: "zh",
      page: "anki",
      url: "https://fm126.top/anki/",
      file: "dist/anki/index.html",
    },
    {
      locale: "en",
      page: "anki",
      url: "https://fm126.top/en/anki/",
      file: "dist/en/anki/index.html",
    },
    {
      locale: "zh",
      page: "dict",
      url: "https://fm126.top/dict/",
      file: "dist/dict/index.html",
    },
    {
      locale: "en",
      page: "dict",
      url: "https://fm126.top/en/dict/",
      file: "dist/en/dict/index.html",
    },
  ];

  // JSON-LD 结构化数据（SEO）：首页 = SoftwareApplication + FAQPage（问答与
  // 正文 FAQ 同源），子页 = BreadcrumbList。静态注入进 head，不进 React 水合；
  // < 转义为 \u003c，防止问答文本里的 < 提前闭合 script 标签
  const jsonLd = (page, locale, url) => {
    const d = DICTS[locale];
    const graph = [];
    if (page === "home") {
      graph.push({
        "@context": "https://schema.org",
        "@type": "SoftwareApplication",
        name: locale === "zh" ? "拾趣 Magpie" : "Magpie",
        applicationCategory: "UtilitiesApplication",
        operatingSystem: "macOS, Windows",
        description: META.home[locale].description,
        url,
        offers: { "@type": "Offer", price: "0", priceCurrency: "CNY" },
      });
      graph.push({
        "@context": "https://schema.org",
        "@type": "FAQPage",
        mainEntity: d.faq.items.map((it) => ({
          "@type": "Question",
          name: it.q,
          acceptedAnswer: { "@type": "Answer", text: it.a },
        })),
      });
    } else {
      const name = { translate: d.footer.topic, anki: d.footer.anki, dict: d.footer.dict }[page];
      graph.push({
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        itemListElement: [
          {
            "@type": "ListItem",
            position: 1,
            name: locale === "zh" ? "首页" : "Home",
            url: locale === "zh" ? "https://fm126.top/" : "https://fm126.top/en/",
          },
          { "@type": "ListItem", position: 2, name, url },
        ],
      });
    }
    return graph
      .map(
        (g) =>
          `<script type="application/ld+json">${JSON.stringify(g).replace(/</g, "\\u003c")}</script>`,
      )
      .join("\n    ");
  };

  for (const page of pages) {
    const m = META[page.page][page.locale];
    // 替换一律走函数形式并显式拼接捕获组——返回串里的 $ 序列不会被展开，
    // 标题/描述里的 —、中文标点也天然安全。
    // meta 的匹配用 \s+ 连接属性（壳里 meta 是多行排版，单行正则会静默
    // 不匹配——description 的 en 改写曾因此一直失效），[^>]* 容忍属性重排
    let html = shells[page.page]
      .replace(/<html lang="[^"]*"/, (s) => s.replace(/lang="[^"]*"/, `lang="${m.lang}"`))
      .replace(/<title>[^<]*<\/title>/, () => `<title>${m.title}</title>`)
      .replace(
        /(<meta\s+name="description"\s+content=")[^"]*(")/,
        (_, p1, p2) => `${p1}${m.description}${p2}`,
      )
      .replace(
        /(<meta\s+name="keywords"\s+content=")[^"]*(")/,
        (_, p1, p2) => `${p1}${m.keywords}${p2}`,
      )
      .replace(
        /(<meta\s+property="og:title"\s+content=")[^"]*(")/,
        (_, p1, p2) => `${p1}${m.title}${p2}`,
      )
      .replace(
        /(<meta\s+property="og:description"\s+content=")[^"]*(")/,
        (_, p1, p2) => `${p1}${m.description}${p2}`,
      )
      .replace(
        /(<meta\s+property="og:locale"\s+content=")[^"]*(")/,
        (_, p1, p2) => `${p1}${m.ogLocale}${p2}`,
      )
      .replace(/(<link\s+rel="canonical"\s+href=")[^"]*(")/, (_, p1, p2) => `${p1}${page.url}${p2}`)
      // og:url 此前不改写，en 页与 canonical 不一致（社交卡片抓错语言页）——补齐
      .replace(
        /(<meta\s+property="og:url"\s+content=")[^"]*(")/,
        (_, p1, p2) => `${p1}${page.url}${p2}`,
      )
      .replace(
        '</head>',
        () => `${jsonLd(page.page, page.locale, page.url)}\n  </head>`,
      )
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
      (page.page === "home" ? 0 : 1) + (page.locale === "en" ? 1 : 0);
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
