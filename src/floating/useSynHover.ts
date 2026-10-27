// src/floating/useSynHover.ts —— 合成 hover + 二级浮层驻留展开/收起（胶囊条与
// 结果窗动作行共用一套）。App.tsx 拆分中耦合最重的一块（2026-10-27 重构，
// 逻辑零改动）。
//
// 为什么存在：悬浮条/结果窗是不抢焦点的非 key 窗口，macOS 不向其派发
// mouseMoved、WebKit 只给活动页面渲染 :hover——原生 hover 在窗口被点击激活前
// 全部失效。Rust 侧 CGEventTap 把全局鼠标位置按光标落点路由到本窗口
// （hover://move，已换算成视口坐标，~60Hz），本 hook 用 elementFromPoint 手动
// 增删 .syn-hover 类，并在同一事件流上做「驻留展开 / 离开收起」判定。
//
// 职责清单：
// - syn-hover：命中 .action/.mitem/.chip/.tool（⌄ 落点点亮同项主按钮）
// - 驻留展开：停在带 ⌄ 的动作项满 HOVER_OPEN_MS 开；已开时划过其他 ⌄ 项立即切
//   （菜单栏心智）；「更多」hover 即开；拖拽中不开
// - 胶囊侧驻留区收起（capsuleRegion）：菜单开着光标离开「触发槽 ∪ 浮层卡」150ms
//   收（触发区 = 整个动作槽，停在主按钮文字上不收不抖）；行侧级联离开子菜单回
//   面板。浮层卡认定双式：macOS 量 DOM，Windows 分离卡用 Rust 带来的 pop 标记
// - 结果窗侧区域规则（IS_OCR）：主堆开着整窗算区域内；chips 开着「触发胶囊 ∪
//   chips」离开 150ms 收子菜单；槽位 ⌄ 菜单离开即收
// - 窗口级离开：document mouseleave / hover://left 记时刻，HOVER_CLOSE_MS 后全收
// - hoverSuppress：弹出瞬间挂起 hover 残留，首个 mousemove / hover://move 解除
//
// 消费方：App.tsx 取 refs（dwellRef/menuStateRef 供 usePopsSync、useCapsuleDrag
// 共用）、switchMenu、fading 与 hoverSuppress（渲染类名）。
import { useCallback, useEffect, useRef, useState } from "react";
import type { MutableRefObject, RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { IS_OCR, POPS_EXTERNAL } from "./env";
import type { HoverMenuId } from "./env";

// hover 驻留展开：光标在「带 ⌄ 的动作项」上停留满 OPEN 才展开二级浮层
// （快速路过不开）；离开胶囊∪浮层满 CLOSE 后自动收起（跨窗口缝隙、
// 瞄准时的犹豫抖动不打断）。收起比展开略长：leave → 进菜单窗口的间隙别误收
export const HOVER_OPEN_MS = 300;
export const HOVER_CLOSE_MS = 350;
// 子菜单退场时长：与 floating.css 的 --menu-out-ms 同步（switchMenu 以 fading
// 快照续挂旧菜单 .m-out 淡出，到点卸载）
export const MENU_FADE_MS = 110;

export function useSynHover(opts: {
  menu: HoverMenuId | null;
  setMenu: (m: HoverMenuId | null) => void;
  barRef: RefObject<HTMLDivElement | null>;
  overflowRef: RefObject<HTMLDivElement | null>;
  menuPopRef: RefObject<HTMLDivElement | null>;
  ocrPanelRef: RefObject<HTMLDivElement | null>;
  dragActiveRef: MutableRefObject<boolean>;
  ocrDragActiveRef: MutableRefObject<boolean>;
}) {
  const { menu, setMenu, overflowRef, menuPopRef, ocrPanelRef, dragActiveRef, ocrDragActiveRef } =
    opts;

  // 弹出瞬间挂起 hover 样式：胶囊常压在光标下，hover 残留会被误认为「选中」；
  // 首次 mousemove 即恢复（非 key 窗口下由 hover://move 合成事件解除）
  const [hoverSuppress, setHoverSuppress] = useState(false);
  // 合成 hover 当前命中的动作：hover://move 驱动 elementFromPoint 增删类，
  // 绕开 WebKit 对非活动页面的 :hover 门控（真 mousemove 在本窗口不可靠）
  const synHoverRef = useRef<HTMLElement | null>(null);
  // —— 二级浮层 hover 驻留展开（胶囊条与结果窗口动作行，两处动作行同构）——
  // dwell：光标连续停在同一个 ⌄ 动作项上的计时；menuStateRef：hover 回调读
  // 最新 menu 的守卫镜像；hoverLeftAtRef：document mouseleave 记下的离开时刻
  // （非 key 窗口收不到逐元素 mousemove，但 document 级离开/进入边沿可靠——
  // ghost-state 修复已依赖同一对事件），null = 光标在胶囊∪浮层内
  const dwellRef = useRef<{ trig: HoverMenuId; since: number } | null>(null);
  const menuStateRef = useRef(menu);
  menuStateRef.current = menu;
  // 子菜单退场快照：纯收起/切换时旧菜单值在此多挂 MENU_FADE_MS 毫秒，
  // 渲染层按它续挂旧内容并加 .m-out 原地淡出（与新菜单入场交叉），到点清空
  // 一并卸载。执行动作的收起不经此（结果区立即接管，退场抢戏）
  const [fading, setFading] = useState<HoverMenuId | null>(null);
  const fadeTimerRef = useRef(0);
  // 菜单纯收起/切换的统一入口（替代直接 setMenu）：事件闭包经 menuStateRef
  // 读最新值，渲染期回调经渲染闭包——两条路径都取到当前菜单；同值调用无副作用
  const switchMenu = useCallback((next: HoverMenuId | null) => {
    const cur = menuStateRef.current;
    if (cur !== null && cur !== next) {
      setFading(cur);
      window.clearTimeout(fadeTimerRef.current);
      fadeTimerRef.current = window.setTimeout(() => setFading(null), MENU_FADE_MS);
    }
    setMenu(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // 胶囊浮层驻留区判定（2026-10-27，与结果窗 pmenu 规则同语言）：菜单/面板
  // 开着时光标须落在「触发项 ∪ 浮层卡」内；行侧级联（pmenu:*）多一层——
  // 在收纳面板内但不在子菜单 = "panel"（只收子菜单回面板），全离开 = "out"。
  // 浮层卡的认定分两式：macOS 同窗直接量 DOM；Windows 分离卡弹层是独立
  // 窗口、DOM 不可见，由 Rust 随 hover://move 带来的 pop 标记判定。
  // 只读 ref 与 DOM（监听注册一次也安全），不依赖渲染期状态
  const capsuleRegion = (
    cx: number,
    cy: number,
    inPop: string | null,
  ): "in" | "panel" | "out" => {
    const m = menuStateRef.current;
    if (!m) return "out";
    const hitEl = (el: Element | null) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom;
    };
    const inMenuCard = POPS_EXTERNAL ? inPop === "menu" : hitEl(menuPopRef.current);
    const inPanelCard = POPS_EXTERNAL ? inPop === "panel" : hitEl(overflowRef.current);
    // 触发区 = 整个动作槽（主按钮 + ⌄），不是 ⌄ 本身——驻留展开后光标停在
    // 主按钮文字上仍算「在自己的菜单项里」，否则 150ms 收 → 驻留再展开 → 抖动
    const trigEl = document.querySelector(`[data-trig="${m}"]`);
    const inTrig = hitEl(
      trigEl?.closest(".action-slot") ?? trigEl?.closest(".pitem") ?? trigEl,
    );
    const inSub = (m !== "overflow" && inMenuCard) || inTrig;
    if (m.startsWith("pmenu:")) {
      if (inSub) return "in";
      return inPanelCard ? "panel" : "out";
    }
    return inSub || inPanelCard ? "in" : "out";
  };
  const hoverLeftAtRef = useRef<number | null>(null);
  // 子菜单级划出时刻：chips 开着时光标离开「胶囊堆 ∪ chips」区域即计时，
  // 150ms 后只收回 chips（回 overflow 态，主堆保留）；窗口级离开仍走 hoverLeft
  const subLeftAtRef = useRef<number | null>(null);
  // 最近一次 hover://move 的光标位置与分离卡命中（pop = "panel"|"menu"|null）：
  // 驻留区收起的宽限复核用（宽限期内可能已点击切换/折返，收起前以最后光标
  // 位置重判，防止误收刚打开的菜单）
  const lastPosRef = useRef<{ x: number; y: number; pop: string | null } | null>(null);

  // hover 挂起恢复：弹出后首次移动鼠标即恢复正常 hover 反馈
  useEffect(() => {
    if (!hoverSuppress) return;
    const onMove = () => setHoverSuppress(false);
    window.addEventListener("mousemove", onMove, { once: true });
    return () => window.removeEventListener("mousemove", onMove);
  }, [hoverSuppress]);

  // 二级浮层 hover 收起：光标离开∪浮层满 HOVER_CLOSE_MS 后自动收（胶囊条与
  // 结果窗口动作行同一套）。只信 mouseleave 离开边沿 + 心跳复核，不做「事件
  // 超时即收」——光标静止时 hover://move 本就不来，超时会把「在菜单里犹豫」
  // 误判成「已划走」。结果窗口的收起走 grow=0 分支，窗口随之缩回
  useEffect(() => {
    if (menu === null) return;
    const iv = window.setInterval(() => {
      const now = performance.now();
      // 胶囊侧驻留区收起（2026-10-27）：光标离开「触发项 ∪ 浮层」150ms 后收；
      // 收前用 lastPosRef 复核——宽限期内可能已点击切换/折返（见 lastPosRef 注释）
      if (!IS_OCR && subLeftAtRef.current !== null && now - subLeftAtRef.current > 150) {
        subLeftAtRef.current = null;
        const p = lastPosRef.current;
        const r = p ? capsuleRegion(p.x, p.y, p.pop) : "out";
        if (r !== "in") {
          hoverLeftAtRef.current = null;
          dwellRef.current = null;
          switchMenu(r === "panel" ? "overflow" : null);
          return;
        }
      }
      // 两级收起：子菜单（chips）开着时光标离开「堆 ∪ chips」→ 150ms 后只收回
      // chips（回 overflow 态，主堆保留）；光标离开窗口 → 350ms 后收回全部
      if (
        menuStateRef.current?.startsWith("pmenu:") &&
        subLeftAtRef.current !== null &&
        now - subLeftAtRef.current > 150
      ) {
        subLeftAtRef.current = null;
        // 光标仍在窗口内（只是离开了堆 ∪ chips 区域）：窗口级收起计时一并作废，
        // 否则停在正文上不动，350ms 后会把整个堆也收掉
        hoverLeftAtRef.current = null;
        switchMenu("overflow");
        return;
      }
      const left = hoverLeftAtRef.current;
      if (left !== null && now - left > HOVER_CLOSE_MS) {
        hoverLeftAtRef.current = null;
        dwellRef.current = null;
        switchMenu(null);
      }
    }, 100);
    return () => window.clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menu]);

  // 事件监听：hover://move（合成 hover + 驻留 + 区域判定）、hover://left（Rust 侧
  // 离开边沿）、document mouseleave/enter（窗口级离开/回归边沿）。只注册一次，
  // 回调经 ref 读最新状态。StrictMode 双挂载防护：cleanup 先于 listen().then
  // 执行时在 then 里自行解绑（见 App.tsx 挂载 effect 同款注释）
  useEffect(() => {
    const unlisteners: Array<() => void> = [];
    let listenCancelled = false;

    // 合成 hover：Rust 侧 CGEventTap 把全局鼠标位置按光标落点路由到本窗口，
    // 并已换算成本窗口视口坐标（~60Hz 节流），elementFromPoint 找到光标下的
    // 动作手动加 hover 类——非 key 窗口收不到 mouseMoved、WebKit 只给活动
    // 页面渲染 :hover，两者都绕开
    listen<{ x: number; y: number; pop?: string | null }>("hover://move", (e) => {
      const cx = e.payload.x;
      const cy = e.payload.y;
      const inPop = e.payload.pop ?? null;
      lastPosRef.current = { x: cx, y: cy, pop: inPop };
      // 「光标在窗口内」的证据链（Rust 按落点路由，含 Windows 分离卡弹层）：
      // 常规清掉 mouseleave 记下的离开边沿；结果窗浮层打开时改按「浮层∪触发区」
      // 判定——大窗口里光标挪到正文/角落留白等同划出，350ms 后收起子菜单，
      // 不让角落停留把浮层钉住；区域内则清边沿照常挑选
      if (IS_OCR && menuStateRef.current !== null) {
        const panel = ocrPanelRef.current;
        const hit = (el: Element | null, pad: number) => {
          if (!el) return false;
          const r = el.getBoundingClientRect();
          return (
            cx >= r.left - pad &&
            cx <= r.right + pad &&
            cy >= r.top - pad &&
            cy <= r.bottom + pad
          );
        };
        if (menuStateRef.current === "overflow") {
          // 主堆（「更多」展开）开着：整个窗口都算区域内——光标从 ⌃2 挪向
          // 胶囊的途中堆不会消失；收起只由光标离开窗口 / 点外 / 再点钮触发
          hoverLeftAtRef.current = null;
        } else if (menuStateRef.current.startsWith("pmenu:")) {
          // 子菜单（chips）开着：区域 = 触发胶囊 ∪ chips——离开两者 150ms 后
          // 收回子菜单（主堆保留）；短防抖吸收边缘抖动/路过，区域内照常挑选。
          // 触发胶囊 = 拥有该子菜单的那一颗（挪到兄弟胶囊上等同离开）
          const anchor = panel
            ? panel.querySelector(`.rail [data-pill="${menuStateRef.current.slice(6)}"]`)
            : null;
          const inRegion =
            hit(anchor, 12) || hit(panel?.querySelector(".hchips") ?? null, 10);
          if (inRegion) {
            hoverLeftAtRef.current = null;
            subLeftAtRef.current = null;
          } else {
            if (hoverLeftAtRef.current === null) hoverLeftAtRef.current = performance.now();
            if (subLeftAtRef.current === null) subLeftAtRef.current = performance.now();
          }
        } else {
          // 槽位子菜单（⌄ 服务/引擎/目标）开着：区域 = 触发槽位 ∪ 槽位 chips
          // ——光标一离开两者立即收回，交互与胶囊堆 chips 一致。
          // 注意：此分支不得吞掉 "overflow"（上一分支已单独处理）
          const inRegion =
            hit(
              panel
                ?.querySelector(`.ocr-actions [data-trig="${menuStateRef.current}"]`)
                ?.closest(".action-slot") ?? null,
              8,
            ) || hit(panel?.querySelector(".ocr-menu-slot") ?? null, 10);
          if (inRegion) {
            hoverLeftAtRef.current = null;
          } else {
            hoverLeftAtRef.current = null;
            switchMenu(null);
          }
        }
      } else if (menuStateRef.current !== null) {
        // 胶囊侧驻留区（2026-10-27）：菜单/面板开着时划过无 ⌄ 的动作（如 总结）
        // = 离开「触发项 ∪ 浮层」，开始 150ms 计时（interval 复核后收）——
        // 不再让菜单错位悬停在无关动作头顶。双平台同行为：浮层卡的认定
        // macOS 量 DOM、Windows 用 pop 标记（见 capsuleRegion 注释）
        if (capsuleRegion(cx, cy, inPop) === "in") {
          subLeftAtRef.current = null;
          hoverLeftAtRef.current = null;
        } else if (subLeftAtRef.current === null) {
          subLeftAtRef.current = performance.now();
        }
      } else {
        hoverLeftAtRef.current = null;
      }
      const el = document.elementFromPoint(cx, cy);
      {
        // 驻留目标检测（胶囊条与结果窗口动作行同构，复用同一套）：命中「带 ⌄
        // 的动作项」才算——主按钮与 ⌄ 同属一个 .action-slot（面板行为 .pitem），
        // 整个项都是驻留区；无 ⌄ 的动作不参与。无浮层时驻留满 HOVER_OPEN_MS
        // 才展开（快速路过不开）；已有浮层开着时划过其他 ⌄ 项立即切换
        // （菜单栏心智，这正是 hover 的核心收益）。拖拽中（胶囊搬移/结果窗拖拽）不开
        const dragging = dragActiveRef.current || ocrDragActiveRef.current;
        const slot =
          el?.closest<HTMLElement>(".action-slot") ?? el?.closest<HTMLElement>(".pitem");
        const trig = (
          dragging ? null : slot?.querySelector<HTMLElement>("[data-trig]")?.dataset.trig ?? null
        ) as HoverMenuId | null;
        const now = performance.now();
        if (!trig || menuStateRef.current === trig) {
          dwellRef.current = null;
        } else if (menuStateRef.current !== null) {
          dwellRef.current = null;
          switchMenu(trig);
        } else if (trig === "overflow") {
          // 「更多」的唯一职责就是展开更多操作（用户定稿 2026-10-25）：hover
          // 即开、无驻留等待——它不是「动作 + 附带 ⌄」的组合项，不存在误触
          // 语义；收起仍走统一的离开宽限（350ms）
          dwellRef.current = null;
          switchMenu(trig);
        } else if (dwellRef.current?.trig !== trig) {
          dwellRef.current = { trig, since: now };
        } else if (now - dwellRef.current.since >= HOVER_OPEN_MS) {
          dwellRef.current = null;
          switchMenu(trig);
        }
      }
      const btn =
        el?.closest<HTMLElement>(".action") ??
        // 二级菜单项（.mitem）与主胶囊按钮同受非 key 窗口 hover 失效影响，
        // 同走合成 hover（原生 :hover 在窗口被点击激活前不渲染）
        el?.closest<HTMLElement>(".mitem") ??
        // 结果窗的存入目标 chips（.ocr-menu-slot .chip）与面板头工具钮（.tool）
        // 同理：非 key 窗口下原生 :hover 不渲染，必须合成（结果窗不点击就 hover）
        el?.closest<HTMLElement>(".chip") ??
        el?.closest<HTMLElement>(".tool") ??
        // 光标落在 ⌄ 上时点亮同项主按钮：⌄ 太小，单独反馈没有「这一项悬停」感
        (el?.closest<HTMLElement>(".chev")?.closest<HTMLElement>(".action-slot") ??
          el?.closest<HTMLElement>(".pchev")?.closest<HTMLElement>(".pitem")
        )?.querySelector<HTMLElement>(".action") ?? null;
      if (btn !== synHoverRef.current) {
        // 诊断（仅 dev）：hover 目标变化时记录；release 落盘日志会刷屏，不记
        if (import.meta.env.DEV) {
          const hitDesc = btn
            ? `进入 ${(btn.textContent ?? "?").slice(0, 6)} <${btn.tagName.toLowerCase()} ${btn.className.split(" ")[0]}>`
            : "离开动作";
          invoke("ui_debug_log", {
            msg: `SYN ${hitDesc} @(${cx.toFixed(0)},${cy.toFixed(0)}) el=${el?.tagName.toLowerCase() ?? "null"}.${(el?.className ?? "").toString().split(" ")[0]}`,
          }).catch(() => undefined);
        }
        synHoverRef.current?.classList.remove("syn-hover");
        if (btn) btn.classList.add("syn-hover");
        synHoverRef.current = btn;
      }
      // 合成 hover 就是真实的鼠标反馈：弹出时挂起的 hover 挂起态一并解除
      setHoverSuppress(false);
    }).then((un) => {
      if (listenCancelled) un();
      else unlisteners.push(un);
    });

    // Rust 侧离开边沿：光标划出全部 hover 目标窗口的瞬间补发给最后命中的
    // 窗口（本窗口若非目标则收不到；Windows 分离卡下胶囊文档看不到弹层窗口
    // 边界，光标从弹层直接划走时收不到 mouseleave）。mouseleave 已先记过
    // 时刻时保留较早值，收起从真正离开那刻起算
    listen("hover://left", () => {
      if (hoverLeftAtRef.current === null) hoverLeftAtRef.current = performance.now();
    }).then((un) => {
      if (listenCancelled) un();
      else unlisteners.push(un);
    });

    // 收起判定的离开/回归边沿：离开窗口记时刻（心跳到点收起浮层，清驻留计时），
    // 回到窗口即撤销——与 App 的 suspendPointer 同用一对 document 级事件
    const markHoverLeft = () => {
      hoverLeftAtRef.current = performance.now();
      dwellRef.current = null;
    };
    const markHoverInside = () => {
      hoverLeftAtRef.current = null;
    };
    document.addEventListener("mouseleave", markHoverLeft);
    document.addEventListener("mouseenter", markHoverInside);

    return () => {
      listenCancelled = true;
      unlisteners.forEach((u) => u());
      window.clearTimeout(fadeTimerRef.current);
      document.removeEventListener("mouseleave", markHoverLeft);
      document.removeEventListener("mouseenter", markHoverInside);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    hoverSuppress,
    setHoverSuppress,
    synHoverRef,
    dwellRef,
    menuStateRef,
    fading,
    switchMenu,
    hoverLeftAtRef,
    subLeftAtRef,
  };
}
