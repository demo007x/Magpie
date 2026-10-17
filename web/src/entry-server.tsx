import { StrictMode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import App from "./App";
import { TopicApp } from "./topic/App";
import { LocaleProvider, type Locale, type PageKey } from "./i18n";

/** 构建期预渲染入口：输出含完整正文的静态 HTML（scripts/prerender.mjs 调用） */
export function render(locale: Locale, page: PageKey = "home"): string {
  return renderToStaticMarkup(
    <StrictMode>
      <LocaleProvider initialLocale={locale} page={page} depth={page === "translate" ? 1 : 0}>
        {page === "translate" ? <TopicApp /> : <App />}
      </LocaleProvider>
    </StrictMode>,
  );
}
