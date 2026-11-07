// 界面语言（中/英）：轻量自建词典 + 模块级 locale store，不引第三方 i18n 库
//（与项目「浮层原语自建」同一取向）。与 src-tauri/src/i18n.rs 共用同一套键名
// 与同一条 auto 解析规则；语言偏好存 Settings.uiLocale（"auto"|"zh"|"en"，
// 默认 auto），切换经 set_ui_locale 命令由 Rust 广播 locale://changed（payload =
// 偏好值，auto 由各端按系统语言自行解析），store 更新后订阅组件整体重渲染。
//
// 用法：入口 main.tsx 先 `initLocale()`（异步拉设置，不阻塞首帧——首帧先用
// 浏览器语言，拉到后整体刷新）；组件里 `useLocale()` 触发重渲染，`t(key)`
// 取文案；非 React 模块（toast 提示等）在事件回调里直接调 `t()`，取的是
// 当时 store 里的现行语言。
import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { zh } from "./zh";
import { en } from "./en";

export type Locale = "zh" | "en";
export type UiLocalePref = "auto" | Locale;

// 词典：zh 为源（键集的权威），en 类型强制键齐全
export type Dict = typeof zh;

const DICTS: Record<Locale, Dict> = { zh, en };

// auto 解析：系统语言 zh*→中文，其余（含英文与非中英语言）→英文。
// 与 src-tauri/src/i18n.rs::resolve_auto 同规则，改动须两侧同步
export function resolveAuto(lang: string): Locale {
  const l = lang.toLowerCase();
  if (l.startsWith("zh")) return "zh";
  return "en";
}

let effective: Locale = resolveAuto(navigator.language);
const listeners = new Set<() => void>();

function setEffective(l: Locale) {
  if (l === effective) return;
  effective = l;
  // html lang 跟随（4 个入口 html 硬编码 zh-CN 的动态化）
  document.documentElement.lang = l === "zh" ? "zh-CN" : l;
  for (const fn of [...listeners]) fn();
}

export function getLocale(): Locale {
  return effective;
}

function subscribeLocale(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/// React 订阅：返回生效语言，语言变化时触发组件重渲染（t() 在渲染期取词）
export function useLocale(): Locale {
  return useSyncExternalStore(subscribeLocale, getLocale);
}

/// 取文案；缺键时回退中文、再回退键名本身（开发期可见，不静默吞）
export function t(key: string, vars?: Record<string, string | number>): string {
  const table = DICTS[effective] as unknown as Record<string, string>;
  let s: string = table[key] ?? (zh as unknown as Record<string, string>)[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      s = s.replaceAll(`{${k}}`, String(v));
    }
  }
  return s;
}

function applyPref(pref: string) {
  setEffective(pref === "auto" ? resolveAuto(navigator.language) : (pref as Locale));
}

let inited = false;

/// 入口启动调用（main / floating / snap / toast 各一次，幂等）：拉取
/// Settings.uiLocale 算出生效语言，并监听 Rust 的 locale://changed 广播。
/// 首帧不等待——先用浏览器语言渲染，设置拉到后整体刷新
export async function initLocale(): Promise<void> {
  if (inited) return;
  inited = true;
  const un = listen<string>("locale://changed", (e) => applyPref(e.payload))
    .catch(() => undefined);
  try {
    const s = await invoke<{ uiLocale?: string }>("get_settings");
    applyPref(s.uiLocale ?? "auto");
  } catch {
    // 设置读取失败保持浏览器语言回退，不打断窗口加载
  }
  void un;
}
