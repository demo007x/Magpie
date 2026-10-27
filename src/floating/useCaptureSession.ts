// src/floating/useCaptureSession.ts —— 划词会话生命周期：selection://captured
// 与 selection://dismiss 两个事件的消费端。App.tsx 拆分第二批（2026-10-27，
// 逻辑零改动）。
//
// captured 的分诊树（保持原序，勿重排）：
// 1. 钉图窗口忽略广播；
// 2. app="ocr" 内部合成事件 → 仅 OCR 窗口消费：取 pending（识别文本+自动执行
//    指令），开结果面板 phase；__extract 走提取分组面板；
// 3. OCR 窗口忽略普通划词；
// 4. 全关守卫：常驻动作与同步实体全空时不弹（防空"·"胶囊）；
// 5. 普通划词 → 浮动条在鼠标位置弹出（setPending 驱动布局 effect）。
// 共同前置：计时打点、ghost 态复位、焦点清理、流失效、菜单/驻留清空。
//
// dismiss：钉图忽略；OCR 已钉住忽略；流式进行中忽略；其余隐藏窗口并复位菜单。
//
// StrictMode 双挂载防护：cleanup 先于 listen().then 执行时在 then 里自行解绑
// （同 App.tsx 挂载 effect 注释）。
import { useEffect } from "react";
import type { MutableRefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { IS_OCR, IS_PIN, POPS_EXTERNAL } from "./env";
import type { HoverMenuId, ScreenRect } from "./env";
import type { PendingView, Phase } from "./types";
import { extractAll } from "../shared/textContext";
export function useCaptureSession(opts: {
  menu: HoverMenuId | null;
  setMenu: (m: HoverMenuId | null) => void;
  dwellRef: MutableRefObject<{ trig: HoverMenuId; since: number } | null>;
  hoverLeftAtRef: MutableRefObject<number | null>;
  synHoverRef: MutableRefObject<HTMLElement | null>;
  setHoverSuppress: (v: boolean) => void;
  screenRef: MutableRefObject<ScreenRect | null>;
  actionsRef: MutableRefObject<Record<string, boolean>>;
  barLiveRef: MutableRefObject<boolean>;
  runIdRef: MutableRefObject<number>;
  streamingRef: MutableRefObject<boolean>;
  ocrReadyRef: MutableRefObject<boolean>;
  ocrPinnedRef: MutableRefObject<boolean>;
  capturedAtRef: MutableRefObject<number>;
  sourceAppRef: MutableRefObject<string>;
  sourcePidRef: MutableRefObject<number>;
  setText: (t: string) => void;
  setPending: (p: { x: number; y: number } | null) => void;
  setPhase: (p: Phase | ((prev: Phase) => Phase)) => void;
  setOcrPinnedState: (v: boolean) => void;
  setUsedTranslate: (v: string | null) => void;
  setUsedEngine: (v: string | null) => void;
  runAction: (id: string, service?: string, source?: string) => void;
  showExtractPanel: (rawText: string, sourcePid?: number) => void;
  resetGhostStates: () => void;
}) {
  const o = opts;

  useEffect(() => {
    const unlisteners: Array<() => void> = [];
    let listenCancelled = false;

    listen<{ text: string; x: number; y: number; app?: string; pid?: number }>("selection://captured", (e) => {
      // 钉图窗口与划词流无关：忽略广播（防止误触发浮动条弹出/窗口移动）
      if (IS_PIN) return;
      // app=ocr 是 OCR/结果流的内部合成事件（len=0、坐标 -1），由下方 OCR 分支消费；
      // 结果窗（IS_OCR）靠这些事件显示结果面板——两者都只是不记日志，流程照常
      if (e.payload.app !== "ocr" && !IS_OCR) {
        invoke("ui_debug_log", {
          msg: `收到 captured 事件：len=${e.payload.text.length} (${e.payload.x.toFixed(0)},${e.payload.y.toFixed(0)}) app=${e.payload.app ?? "-"}`,
        }).catch(() => undefined);
      }
      o.capturedAtRef.current = performance.now();
      o.resetGhostStates();
      // 清除上一个操作可能残留的焦点态（避免新胶囊里按钮呈现选中样式）
      (document.activeElement as HTMLElement | null)?.blur?.();
      // 新选区使进行中的流失效（否则 streamingRef 卡住，dismiss 会被误拦）
      o.runIdRef.current++;
      o.streamingRef.current = false;
      o.setMenu(null);
      // 驻留计时一并作废：残留的 since 会让新胶囊的同一动作「一碰就开」
      o.dwellRef.current = null;
      o.hoverLeftAtRef.current = null;
      // OCR 来源事件：仅 OCR 独立窗口消费（浮动条抢走 pending 会与之竞争）
      if (e.payload.app === "ocr") {
        if (!IS_OCR) return;
        invoke<PendingView | null>("ocr_take_pending")
          .then((p) => {
            if (!p) return;
            // 新结果：重置测量/显示状态——若尺寸与上次相同也必须重新显示窗口
            o.ocrReadyRef.current = false;
            o.setOcrPinnedState(p.pinned);
            o.setMenu(null); // 新结果回收展开中的二级菜单（防陈旧菜单泄漏进新面板）
            o.setUsedTranslate(null); // 选中态回落到默认服务
            o.setUsedEngine(null);
            o.setHoverSuppress(true);
            if (p.run?.id === "__extract") {
              o.showExtractPanel(p.text, p.pid);
            } else {
              o.setPhase({
                kind: "ocr",
                text: p.text,
                fromOcr: p.fromOcr,
                actionId: p.run?.id ?? null,
                output: "",
                streaming: false,
                error: null,
                expanded: false,
              });
              if (p.run) o.runAction(p.run.id, p.run.service ?? undefined, p.text);
            }
          })
          .catch(() => undefined);
        return;
      }
      // OCR 窗口忽略普通划词广播
      if (IS_OCR) return;
      // 全关极端态守卫：常驻动作数为 0（复制关闭、Obsidian 未配 vault、
      // 自定义动作全停等过滤后）且选区无同步实体（网址/邮箱/验证码/电话）、
      // 日期/地点识别又未启用 → 无任何可显示内容，不弹（否则出现空"·"胶囊）。
      // 判定走 ref + 现算实体（监听闭包拿不到渲染期状态）；日期/地点是异步
      // 识别，开关开着时保守放行——宁弹空壳不漏真实的上下文动作
      const all = extractAll(e.payload.text);
      const acts = o.actionsRef.current;
      const syncCtx =
        (acts.link !== false && all.urls.length > 0) ||
        (acts.email !== false && all.emails.length > 0) ||
        (acts.code !== false && all.codes.length > 0) ||
        (acts.tel !== false && all.tels.length > 0);
      if (!o.barLiveRef.current && !syncCtx && acts.date === false && acts.addr === false) {
        invoke("hide_floating_bar").catch(() => undefined);
        return;
      }
      // 普通划词：浮动条在鼠标位置弹出（x/y 来自选区）
      // 新划词 = 新胶囊：清掉上一轮残留的合成 hover 类（否则旧高亮在挂起解除后显形，
      // 表现为"没碰到任何动作却有个动作是 hover 态"）
      o.synHoverRef.current?.classList.remove("syn-hover");
      o.synHoverRef.current = null;
      o.sourceAppRef.current = e.payload.app ?? "";
      o.sourcePidRef.current = e.payload.pid ?? 0;
      o.setPending({ x: e.payload.x, y: e.payload.y });
      // 屏幕矩形：二级浮层贴边翻转的判定基准（跨屏拖动后由拖拽结束回读刷新）
      invoke<ScreenRect>("screen_rect_at", { x: e.payload.x, y: e.payload.y })
        .then((r) => (o.screenRef.current = r))
        .catch(() => undefined);
      o.setText(e.payload.text);
      o.setPhase({ kind: "bar" });
    }).then((un) => {
      if (listenCancelled) un();
      else unlisteners.push(un);
    });

    listen("selection://dismiss", () => {
      // 钉图窗口不受划词 dismiss 影响
      if (IS_PIN) return;
      // OCR 窗口钉住：忽略 dismiss（Rust 侧同样不会隐藏窗口）
      if (IS_OCR && o.ocrPinnedRef.current) {
        invoke("ui_debug_log", { msg: "忽略 dismiss：OCR 已钉住" }).catch(() => undefined);
        return;
      }
      // 任务流式进行中不打断；其余点击空白即隐藏
      if (o.streamingRef.current) {
        invoke("ui_debug_log", { msg: "忽略 dismiss：任务进行中" }).catch(() => undefined);
        return;
      }
      invoke("hide_floating_bar").catch(() => undefined);
      // Windows 分离卡：弹层窗口已随 hide_pops 隐藏，菜单状态同步复位，
      // 否则胶囊下次弹出时「更多」钮残留点亮态
      if (POPS_EXTERNAL) o.setMenu(null);
      if (IS_OCR) invoke("hide_ocr_window").catch(() => undefined);
    }).then((un) => unlisteners.push(un));

    return () => {
      listenCancelled = true;
      unlisteners.forEach((u) => u());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
