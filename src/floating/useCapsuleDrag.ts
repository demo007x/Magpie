// src/floating/useCapsuleDrag.ts —— 划词胶囊整条拖拽 + 点击守卫。
// 整条任意位置可拖（含按钮上），按下后位移 > 5px 判定为拖并吞掉其 click；
// 拖拽期间清驻留计时、收起二级浮层（Windows 分离卡是独立窗口，不随胶囊联动），
// 松手回读窗口落位与新屏幕矩形恢复布局 effect 的坐标基准（锚定/翻转判定依赖）。
// onStageMouseDown 同时承载「点空白收起浮层」的 dismiss 规则（与拖拽共享
// mousedown 入口，纯移动保留在同处）。
// 从 App.tsx 拆出（2026-10-27 重构，逻辑零改动）。
// 消费方：App.tsx —— 三个 handler 挂 .stage 的 mouse 事件；guarded 包裹全部
// 动作按钮 onClick（拖拽后残余 click 吞除 + 点击终结驻留计时）。
import { useRef } from "react";
import type { MouseEvent as ReactMouseEvent, MutableRefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { IS_OCR, POPS_EXTERNAL } from "./env";
import type { ScreenRect, WindowPos } from "./env";

export function useCapsuleDrag(opts: {
  menu: string | null;
  setMenu: (m: null) => void;
  switchMenu: (m: null) => void;
  dwellRef: MutableRefObject<{ trig: string; since: number } | null>;
  winPosRef: MutableRefObject<WindowPos | null>;
  screenRef: MutableRefObject<ScreenRect | null>;
  suppressClickRef: MutableRefObject<boolean>;
  dragActiveRef: MutableRefObject<boolean>;
}) {
  const { setMenu, switchMenu, dwellRef, winPosRef, screenRef, suppressClickRef, dragActiveRef } =
    opts;
  const dragStartRef = useRef<{ sx: number; sy: number } | null>(null);

  const onStageMouseDown = (e: ReactMouseEvent) => {
    const t = e.target as HTMLElement;
    // 结果窗：点浮层与动作行之外收起展开中的浮层（与胶囊条同规则）；
    // 不参与浮动条拖拽（结果窗拖拽走 onOcrPanelDown 一条链）
    if (IS_OCR) {
      // .ocr-menu-slot 同样豁免：点子菜单 chip 是要执行动作的点击，mousedown
      // 若抢先收起，click 会落在退场态（pointer-events:none）容器上丢失——
      // 表现为「点了没反应」；chip 的 click 自己负责执行并收起（与 .pop 同理）
      if (
        opts.menu !== null &&
        !t.closest(".pop") &&
        !t.closest(".ocr-actions") &&
        !t.closest(".ocr-menu-slot")
      ) {
        switchMenu(null);
      }
      return;
    }
    // 点空白（胶囊与浮层之外的留白/缝隙）收起二级浮层；点窗口外才整条消失
    // （窗口矩形含留白，Rust 侧 rect_contains 会抑制这区域的 dismiss）
    if (opts.menu !== null && !t.closest(".bar") && !t.closest(".pop")) {
      setMenu(null);
    }
    // 结果文本区保留文字选择/复制，不作为拖拽起点
    if (t.closest(".panel-body")) return;
    dragStartRef.current = { sx: e.screenX, sy: e.screenY };
  };

  const onStageMouseMove = (e: ReactMouseEvent) => {
    const s = dragStartRef.current;
    if (!s || dragActiveRef.current) return;
    if (IS_OCR) return;
    if (Math.hypot(e.screenX - s.sx, e.screenY - s.sy) > 5) {
      dragActiveRef.current = true;
      suppressClickRef.current = true;
      dwellRef.current = null; // 拖拽期间不开二级浮层（拖拽中驻留检测已被守卫，这里清残留计时）
      // 拖动即收起二级浮层（Windows 分离卡是独立窗口，不随胶囊联动移动）
      if (POPS_EXTERNAL) setMenu(null);
      // 用按下时的全局坐标计算抓取偏移（此刻窗口尚未移动）
      invoke("begin_floating_drag", { x: s.sx, y: s.sy }).catch(() => undefined);
    }
  };

  const onStageMouseUp = () => {
    dragStartRef.current = null;
    if (dragActiveRef.current) {
      // 拖拽改变窗口位置（Rust 侧直接落位，前端不感知）：回读落位与新所在
      // 屏幕矩形，恢复布局 effect 的坐标基准（锚定/翻转判定依赖两者）
      invoke<WindowPos>("floating_window_pos")
        .then((p) => {
          winPosRef.current = p;
          return invoke<ScreenRect>("screen_rect_at", { x: p.x, y: p.y });
        })
        .then((r) => {
          screenRef.current = r;
        })
        .catch(() => undefined);
      // DragEnd 由系统事件 tap 的 mouse-up 转发；稍后恢复点击
      window.setTimeout(() => {
        dragActiveRef.current = false;
      }, 60);
      window.setTimeout(() => {
        suppressClickRef.current = false;
      }, 140);
    }
  };

  // 点击守卫：拖拽后吞残余 click；点击终结驻留计时（点主按钮执行动作后光标
  // 仍停在动作项上，残留的计时会让二级浮层在动作执行后「自己弹开」）
  const guarded = (fn: () => void) => () => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    dwellRef.current = null;
    fn();
  };

  return { onStageMouseDown, onStageMouseMove, onStageMouseUp, guarded };
}
