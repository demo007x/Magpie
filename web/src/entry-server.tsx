import { StrictMode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import App from "./App";
import { LocaleProvider, type Locale } from "./i18n";

/** 构建期预渲染入口：输出含完整正文的静态 HTML（scripts/prerender.mjs 调用） */
export function render(locale: Locale): string {
  return renderToStaticMarkup(
    <StrictMode>
      <LocaleProvider initialLocale={locale}>
        <App />
      </LocaleProvider>
    </StrictMode>,
  );
}
