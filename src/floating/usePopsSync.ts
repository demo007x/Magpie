// src/floating/usePopsSync.ts —— Windows 分离卡（一卡一窗）的浮层数据同步。
// 弹层窗口（floating-panel / floating-menu）是哑渲染端：本 hook 按当前状态组装
// payload，经 set_floating_pops 推给 Rust（payload 变化即重发——实体渐进补进
// 胶囊、设置实时推送改了收纳清单，弹层内容都须跟上）；弹层量尺寸回传
// pop_ready 后由 Rust 定位显示。pmenu:* 的行侧锚点只有面板窗口知道，
// 不经 payload effect，由 floating://pick(menu-toggle) → showRowMenu 直接下发。
// 仅 Windows（POPS_EXTERNAL）生效；macOS 同窗渲染浮层，本 hook 全部短路。
// 从 App.tsx 拆出（2026-10-27 重构，逻辑零改动）。
import { useEffect } from "react";
import type { MutableRefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { POPS_EXTERNAL } from "./env";
import type { HoverMenuId } from "./env";
import type { SearchEngine } from "../shared/types";

// 弹层同步的入参类型：数据端（服务/引擎/收纳清单）与状态端（menu、服务选择）
// 全部由 App 渲染期闭包提供，签名依赖在 App 处声明（见 hook 内 effect 注释）
export function usePopsSync(opts: {
  menu: HoverMenuId | null;
  setMenu: (m: HoverMenuId | null) => void;
  menuStateRef: MutableRefObject<HoverMenuId | null>;
  dwellRef: MutableRefObject<{ trig: HoverMenuId; since: number } | null>;
  restEntries: Array<{ id: string; label: string; icon?: string; hasMenu?: boolean }>;
  enabledTranslates: Array<{ id: string; label: string }>;
  enabledEngines: SearchEngine[];
  usedTranslate: string | null;
  usedEngine: string | null;
  defaultTranslateId: string | null | undefined;
  defaultEngineName: string | null | undefined;
  obsidianVaultConfigured: boolean;
  runAction: (id: string, service?: string, source?: string, target?: string) => void;
  openEngine: (en: SearchEngine) => void;
  setUsedTranslate: (v: string) => void;
  setUsedEngine: (v: string) => void;
}) {
  const {
    menu,
    setMenu,
    menuStateRef,
    dwellRef,
    restEntries,
    enabledTranslates,
    enabledEngines,
    usedTranslate,
    usedEngine,
    defaultTranslateId,
    defaultEngineName,
    obsidianVaultConfigured,
    runAction,
    openEngine,
    setUsedTranslate,
    setUsedEngine,
  } = opts;

  const menuItemsFor = (kind: string) =>
    kind === "translate"
      ? enabledTranslates.map((s) => ({
          key: s.id,
          label: s.label,
          on: s.id === (usedTranslate ?? defaultTranslateId ?? null),
        }))
      : kind === "search"
        ? enabledEngines.map((en) => ({
            key: en.name,
            label: en.name,
            on: en.name === (usedEngine ?? defaultEngineName ?? null),
          }))
        : [
            { key: "note", label: "笔记", on: true },
            { key: "task", label: "任务", on: false },
            { key: "card", label: "卡片", on: false },
          ];
  // 行 ⌄ 的判定（动态，非 barEntries.hasMenu）：翻译行=多个翻译服务、
  // 搜索行=多个引擎、Obsidian 行=已配置 vault——macOS 面板渲染、Windows
  // 面板数据组装与行 hover 回传校验共用同一判据
  const entryHasMenu = (id: string) =>
    (id === "translate" && enabledTranslates.length > 1) ||
    (id === "search" && enabledEngines.length > 1) ||
    (id === "obsidian" && obsidianVaultConfigured);
  const panelData = (subOpenForce?: string | null) => ({
    type: "overflow" as const,
    subOpen:
      subOpenForce !== undefined
        ? subOpenForce
        : menu && menu.startsWith("pmenu:")
          ? menu.slice(6)
          : null,
    items: restEntries.map((e) => ({
      id: e.id,
      label: e.label,
      icon: e.icon ?? null,
      hasMenu: entryHasMenu(e.id),
    })),
  });
  // 弹层同步的内容签名（id/文案/图标/⌄ 有无——任一变化才重发 payload）
  const panelSig = restEntries
    .map((e) => `${e.id}|${e.label}|${e.icon ?? ""}|${e.hasMenu ? 1 : 0}`)
    .join(",");
  const translateSig = enabledTranslates.map((s) => s.id).join(",");
  const enginesSig = enabledEngines.map((en) => en.name).join(",");

  // 同屏只开一个入口：开面板收菜单、开胶囊 ⌄ 菜单收面板（close-* 由 Rust
  // 隐藏对应窗口并清锚点；close 与 payload 作用在不同窗口，次序无关）
  useEffect(() => {
    if (!POPS_EXTERNAL) return;
    if (menu !== null && menu.startsWith("pmenu:")) return;
    const trigX = (id: string): number | null => {
      const el = document.querySelector<HTMLElement>(`[data-trig="${id}"]`);
      if (!el) return null;
      // 锚「整个动作项」左缘（用户定稿 2026-10-26：子菜单展开到对应主菜单
      // 正下方），而非尾部 16px 的 ⌄ 按钮——否则子菜单右偏一个图标位
      const slot = el.closest<HTMLElement>(".action-slot");
      return Math.round((slot ?? el).getBoundingClientRect().left);
    };
    if (menu === null) {
      invoke("set_floating_pops", { target: "none", data: {}, trigX: null, rowY: null }).catch(
        () => undefined,
      );
      return;
    }
    if (menu === "overflow") {
      invoke("set_floating_pops", {
        target: "close-menu",
        data: {},
        trigX: null,
        rowY: null,
      }).catch(() => undefined);
      invoke("set_floating_pops", {
        target: "panel",
        trigX: trigX("overflow"),
        rowY: null,
        data: panelData(),
      }).catch(() => undefined);
      return;
    }
    // chev:* → 窄单列菜单锚在胶囊触发钮下方
    const kind = menu.startsWith("chev:") ? menu.slice(5) : menu;
    invoke("set_floating_pops", {
      target: "close-panel",
      data: {},
      trigX: null,
      rowY: null,
    }).catch(() => undefined);
    invoke("set_floating_pops", {
      target: "menu",
      trigX: trigX(menu),
      rowY: null,
      data: { type: "menu", kind, items: menuItemsFor(kind) },
    }).catch(() => undefined);
    // panelData/menuItemsFor 是渲染期闭包：数据变化由上面的签名依赖表达
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menu, panelSig, translateSig, enginesSig, usedTranslate, usedEngine, defaultTranslateId, defaultEngineName]);

  // 行侧菜单展开（Windows 分离卡）：pmenu 锚点 rowY 只有面板窗口知道，随
  // menu-toggle 点击 / row-hover 上报带来；面板 payload 一并重发让 pchev
  // 高亮跟着 subOpen 走（panelData 显式传 subOpen——此刻 menu 还是旧状态）
  const showRowMenu = (key: string, rowY: number | null) => {
    setMenu(`pmenu:${key}` as "pmenu:translate" | "pmenu:search" | "pmenu:obsidian");
    invoke("set_floating_pops", {
      target: "menu",
      trigX: null,
      rowY,
      data: { type: "menu", kind: key, items: menuItemsFor(key) },
    }).catch(() => undefined);
    invoke("set_floating_pops", {
      target: "panel",
      trigX: null,
      rowY: null,
      data: panelData(key),
    }).catch(() => undefined);
  };

  // 弹层窗口点击回传（floating://pick）的处理器组装：动作语义、选区上下文、
  // 服务选择与反馈全在本窗口执行（弹层是哑渲染端）。App 用返回值填充 pickRef
  // （监听只注册一次，经 ref 读最新渲染）
  const buildPickHandler =
    () =>
    (p: { kind: string; key: string; rowY: number | null }) => {
      if (p.kind === "action") {
        setMenu(null);
        runAction(p.key);
        return;
      }
      if (p.kind === "row-hover") {
        // 面板行 hover 回传：面板开着 ⇒ 必有浮层入口开着，行 ⌄ 恒走「已开即切」
        // （与胶囊 ⌄ 一致）；无 ⌄ 的行只清驻留计时。行命中在面板窗口检测
        // （WebView2 真 mousemove 可靠），决策集中在胶囊
        const hasMenu = entryHasMenu(p.key) && restEntries.some((x) => x.id === p.key);
        if (!hasMenu) {
          dwellRef.current = null;
          return;
        }
        if (menuStateRef.current !== `pmenu:${p.key}`) showRowMenu(p.key, p.rowY);
        return;
      }
      if (p.kind === "menu-toggle") {
        if (menu !== `pmenu:${p.key}`) {
          showRowMenu(p.key, p.rowY);
        } else {
          // 收起 = 回到父级（面板保持展开），effect 会重发面板 payload 复位高亮
          setMenu("overflow");
        }
        return;
      }
      if (p.kind === "pick:translate") {
        setUsedTranslate(p.key);
        setMenu(null);
        runAction("translate", p.key);
        return;
      }
      if (p.kind === "pick:search") {
        setUsedEngine(p.key);
        setMenu(null);
        const en = enabledEngines.find((x) => x.name === p.key);
        if (en) openEngine(en);
        return;
      }
      if (p.kind === "pick:obsidian") {
        setMenu(null);
        runAction("obsidian", undefined, undefined, p.key);
      }
    };

  return { entryHasMenu, showRowMenu, buildPickHandler };
}
