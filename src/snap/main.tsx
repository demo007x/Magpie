// 截屏遮罩窗（Windows 框选识图）：铺满光标所在显示器的透明置顶窗。
// 交互对位 macOS `screencapture -i`：拖拽出选区（四向自适应），Esc 取消，
// 过小选区（<4px）视为误触取消。选区完成后 invoke 回 Rust 做坐标换算与截屏。
// 遮罩变暗用 selection 的巨大 box-shadow 实现（洞外半透明、洞内清晰，
// 免去四块遮罩拼接），与 Snipaste/ShareX 同款手法。
import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function normDrag(
  sx: number,
  sy: number,
  cx: number,
  cy: number
): Rect {
  return {
    x: Math.min(sx, cx),
    y: Math.min(sy, cy),
    w: Math.abs(cx - sx),
    h: Math.abs(cy - sy),
  };
}

function Overlay() {
  const [drag, setDrag] = useState<{ sx: number; sy: number; cx: number; cy: number } | null>(null);
  const done = useRef(false);

  const finish = useCallback((r: Rect | null) => {
    if (done.current) return;
    done.current = true;
    if (r && r.w >= 4 && r.h >= 4) {
      invoke("ocr_region_selected", { x: r.x, y: r.y, w: r.w, h: r.h }).catch(() =>
        invoke("ocr_region_cancel").catch(() => undefined)
      );
    } else {
      invoke("ocr_region_cancel").catch(() => undefined);
    }
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") finish(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [finish]);

  const rect = drag ? normDrag(drag.sx, drag.sy, drag.cx, drag.cy) : null;

  return (
    <div
      style={{ position: "fixed", inset: 0, cursor: "crosshair" }}
      onMouseDown={(e) => {
        if (e.button !== 0 || done.current) return;
        setDrag({ sx: e.clientX, sy: e.clientY, cx: e.clientX, cy: e.clientY });
      }}
      onMouseMove={(e) => {
        if (drag) setDrag({ ...drag, cx: e.clientX, cy: e.clientY });
      }}
      onMouseUp={() => {
        if (drag) finish(normDrag(drag.sx, drag.sy, drag.cx, drag.cy));
      }}
    >
      {/* 选区前整屏淡暗提示截屏模式（对齐 screencapture -i 的即时反馈）；
          拖拽后由选区的 box-shadow 接管变暗（洞外暗、洞内清晰） */}
      {!rect && <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.15)" }} />}
      {rect && (
        <div
          style={{
            position: "fixed",
            left: rect.x,
            top: rect.y,
            width: rect.w,
            height: rect.h,
            border: "1px solid #4f8cff",
            boxShadow: "0 0 0 100000px rgba(0, 0, 0, 0.3)",
            background: "transparent",
            pointerEvents: "none",
          }}
        />
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Overlay />);
