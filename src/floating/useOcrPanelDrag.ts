// src/floating/useOcrPanelDrag.ts —— 结果面板（ocr 窗口）拖拽。
// 面板任意空白处按住即可拖动（标题栏/动作行/留白区）；文本区（原文/结果）保留
// 文字选择复制；按钮/开关/尺寸手柄不作为拖拽起点；位移 >5px 判定为拖并吞掉
// 结束后的残余 click。move_ocr 落位时钳制在屏幕内。
// 从 App.tsx 拆出（2026-10-27 重构，逻辑零改动）。
// 消费方：App.tsx —— onOcrPanelDown 挂面板 onMouseDown；ocrDragActiveRef 供
// 合成 hover 的「拖拽中不开浮层」判定（useSynHover 消费）。
import { useEffect, useRef } from "react";
import type { MouseEvent as ReactMouseEvent, MutableRefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { IS_OCR } from "./env";

export function useOcrPanelDrag(suppressClickRef: MutableRefObject<boolean>) {
  const ocrArmRef = useRef<{ sx: number; sy: number } | null>(null);
  const ocrDragRef = useRef<{ sx: number; sy: number; wx: number; wy: number } | null>(null);
  const ocrDragActiveRef = useRef(false);

  const onOcrPanelDown = (e: ReactMouseEvent) => {
    if (!IS_OCR || e.button !== 0) return;
    const t = e.target as HTMLElement;
    // 按钮等交互元素：即点即聚焦（不会演变成拖拽，激活无副作用）
    if (
      t.closest(
        "button, .ocr-source, .ocr-result-scroll, .panel-body, .resize-handle, .resize-handle-v",
      )
    ) {
      invoke("focus_ocr_window").catch(() => undefined);
      return;
    }
    // 拖拽起点区域：不在此刻聚焦——按住期间激活应用会打断首次拖拽手势；
    // 聚焦延迟到松手且未拖动时（纯点击），见拖拽 effect 的 onUp
    ocrArmRef.current = { sx: e.screenX, sy: e.screenY };
  };

  useEffect(() => {
    if (!IS_OCR) return;
    let raf = 0;
    let latest: { x: number; y: number } | null = null;
    // rAF 合帧：最多一次 IPC/帧，拖动跟手且不淹没 IPC 通道
    const flush = () => {
      raf = 0;
      const d = ocrDragRef.current;
      const p = latest;
      latest = null;
      if (d && p) {
        invoke("move_ocr", {
          x: d.wx + (p.x - d.sx),
          y: d.wy + (p.y - d.sy),
        }).catch(() => undefined);
      }
    };
    const onMove = (e: MouseEvent) => {
      const s = ocrArmRef.current;
      if (!s) return;
      if (!ocrDragActiveRef.current) {
        if (Math.hypot(e.screenX - s.sx, e.screenY - s.sy) <= 5) return;
        ocrDragActiveRef.current = true;
        suppressClickRef.current = true;
        document.body.style.cursor = "grabbing";
        // 用按下时的全局坐标取窗口位置：此刻窗口尚未移动，抓取偏移精确
        invoke<{ x: number; y: number }>("ocr_window_pos")
          .then((p) => {
            if (p) ocrDragRef.current = { sx: s.sx, sy: s.sy, wx: p.x, wy: p.y };
          })
          .catch(() => undefined);
        return;
      }
      const d = ocrDragRef.current;
      if (!d) return; // 等窗口位置回包，起步头几 px 丢弃（绝对坐标计算，无累积误差）
      latest = { x: e.screenX, y: e.screenY };
      if (!raf) raf = requestAnimationFrame(flush);
    };
    const onUp = () => {
      const hadArm = ocrArmRef.current !== null;
      ocrArmRef.current = null;
      ocrDragRef.current = null;
      latest = null;
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
      if (ocrDragActiveRef.current) {
        ocrDragActiveRef.current = false;
        document.body.style.cursor = "";
        window.setTimeout(() => {
          suppressClickRef.current = false;
        }, 140);
        // 拖完即持久化位置（含尺寸），下次显示/重启都在用户放下的地方
        invoke("persist_result_window_state").catch(() => undefined);
      } else if (hadArm) {
        // 纯点击（未拖动）：此刻才聚焦——Esc/⌘P/⌘W 键盘闭环生效，
        // 且不会打断可能正在进行的拖拽手势
        invoke("focus_ocr_window").catch(() => undefined);
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      if (raf) cancelAnimationFrame(raf);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { onOcrPanelDown, ocrDragActiveRef };
}
