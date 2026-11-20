import { StrictMode } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { DictApp } from "./App";
import { LocaleProvider, localeFromPath } from "../i18n";
import "../styles.css";

const tree = (
  <StrictMode>
    <LocaleProvider
      initialLocale={localeFromPath(window.location.pathname)}
      page="dict"
      depth={1}
    >
      <DictApp />
    </LocaleProvider>
  </StrictMode>
);

// 预渲染页（构建产物含静态正文）走水合；dev 空壳走客户端渲染
const rootEl = document.getElementById("root")!;
if (rootEl.childNodes.length > 0) {
  hydrateRoot(rootEl, tree);
} else {
  createRoot(rootEl).render(tree);
}
