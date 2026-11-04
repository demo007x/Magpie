// 截屏遮罩窗（Windows 框选识图）：铺满光标所在显示器的透明置顶窗。
// 拖拽出选区（四向自适应），Esc 取消，过小选区（<8px）视为误触取消。
// 选区完成后 invoke 回 Rust 做坐标换算与截屏；遮罩原位切会话模式（对齐
// macOS 截图胶囊：选区洞保留、洞外变暗），动作胶囊由 floating 窗口渲染，
// 本窗任意点击 = 取消，动作执行后由 Rust 关窗。遮罩变暗用 selection 的
// 巨大 box-shadow 实现（洞外半透明、洞内清晰，免去四块遮罩拼接），
// 与 Snipaste/ShareX 同款手法。
import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

// 模块执行标记（最早的下钻点）：页面加载完成事件有、这条没有 = 模块级
// JS 错误（import/顶层代码崩溃），React 尚未挂载
invoke("ui_debug_log", { msg: "[snip] 模块脚本执行" }).catch(() => undefined);

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// 会话选区的边命中：h ∈ w/e（左右边），v ∈ n/s（上下边），空串 = 未命中。
// h+v 同时命中 = 角（缩放两轴）
type EdgeHit = { h: "" | "w" | "e"; v: "" | "n" | "s" };

// 边命中带宽（px，矩形边线两侧各算）——抓取热区；带宽内点击 = 缩放，
// 之外点击选区内 = 移动、选区外 = 取消
const EDGE_BAND = 8;

// 光标位置 → 边命中（距离按到边线的绝对距离算，内侧外侧同等对待——
// 白环画在矩形外侧，抓「可见的环」时落点常在矩形外 1-2px）。
// 窄矩形两边带重叠时取更近的一侧
function hitEdge(r: Rect, x: number, y: number): EdgeHit {
  const dW = Math.abs(x - r.x);
  const dE = Math.abs(x - (r.x + r.w));
  const dN = Math.abs(y - r.y);
  const dS = Math.abs(y - (r.y + r.h));
  const h = Math.min(dW, dE) <= EDGE_BAND ? (dW <= dE ? "w" : "e") : "";
  const v = Math.min(dN, dS) <= EDGE_BAND ? (dN <= dS ? "n" : "s") : "";
  return h || v ? { h: h as EdgeHit["h"], v: v as EdgeHit["v"] } : { h: "", v: "" };
}

// 边命中 → 缩放游标（角按 w+n / e+s = ↘↖、e+n / w+s = ↗↙ 配对）
function cursorFor(hit: EdgeHit): string {
  const { h, v } = hit;
  if (h && v) return (h === "w") === (v === "n") ? "nwse-resize" : "nesw-resize";
  if (h) return "ew-resize";
  if (v) return "ns-resize";
  return "move";
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

// 钳制在本屏视口内（窗口铺满所在显示器，视口 = 显示器逻辑矩形；
// Rust 侧 snip_frame_move 按会话 mon 同规则钳，双保险）
function clampRect(r: Rect): Rect {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = Math.max(8, Math.min(r.w, vw));
  const h = Math.max(8, Math.min(r.h, vh));
  return {
    w,
    h,
    x: Math.max(0, Math.min(r.x, vw - w)),
    y: Math.max(0, Math.min(r.y, vh - h)),
  };
}

// 洞样式（Overlay 与 FrameSession 共用）：白环用外扩 box-shadow 画在矩形
// 外侧——洞内像素不被遮罩污染，静默截图即屏幕原始内容；贴浅色内容时靠
// 外圈暗晕区分边界（Snipaste 同款），选区外的整幅变暗由最后一个
// 100000px shadow 承担
function holeStyle(h: Rect, cursor: string): CSSProperties {
  return {
    position: "fixed",
    left: h.x,
    top: h.y,
    width: h.w,
    height: h.h,
    boxShadow:
      "0 0 0 1.5px #ffffff, 0 0 0 2.5px rgba(0, 0, 0, 0.35), 0 0 8px rgba(0, 0, 0, 0.45), 0 0 0 100000px rgba(0, 0, 0, 0.3)",
    background: "transparent",
    cursor,
    pointerEvents: "none",
  };
}

// 两阶段同一窗（与 macOS snip-frame 会话段同构）：
// - 选区阶段：整屏淡暗提示，按下拖出选区（白环实时跟随、画在矩形外侧——
//   洞内像素不被遮罩污染，Rust 松手后静默截图），过小（<8px）= 取消
// - 会话阶段（rect 非空）：松手上报 ocr_region_selected 后遮罩原位无缝切
//   会话模式（选区洞保留、洞外变暗），动作胶囊由 floating 窗口渲染在选区
//   右下角；选区可拖动（洞内按住整体移动）、边/角 8px 热区可缩放（对侧边
//   锚定、最小 8px、钳在本屏），拖动中每次移动 invoke snip_frame_move 让
//   Rust 重排胶囊并更新会话矩形（执行动作按新矩形 BitBlt 重截）；点击
//   选区外 = 取消（ocr_region_cancel：胶囊随 dismiss 管线收起、挂起截图
//   清理），Esc 兜底同取消；动作执行后由 Rust（snip_execute →
//   finish_windows_snap_session）关窗
function Overlay() {
  // 会话矩形（非空 = 会话模式）；选区阶段的拖拽矩形独立存 sel
  const [rect, setRect] = useState<Rect | null>(null);
  const [sel, setSel] = useState<{ sx: number; sy: number; cx: number; cy: number } | null>(null);
  // 会话拖拽两模式：move = 按住选区内整体移动；resize = 按住边/角缩放
  // （对侧边锚定，最小 8px）。起点 rect 快照 + 起点光标算位移——与
  // FrameSession 会话拖拽同构
  const drag = useRef<
    | { mode: "move"; sx: number; sy: number; rect: Rect }
    | { mode: "resize"; sx: number; sy: number; rect: Rect; hit: EdgeHit }
    | null
  >(null);
  // 悬停边命中对应的游标（无拖拽时的光标反馈；随 mousemove 刷新）
  const [hoverCursor, setHoverCursor] = useState<string>("default");
  const done = useRef(false);

  // 取消整段流程（会话点击选区外/Esc/误触）
  const finishCancel = useCallback(() => {
    if (done.current) return;
    done.current = true;
    invoke("ocr_region_cancel").catch(() => undefined);
  }, []);

  // 会话矩形变化上报：Rust 更新会话状态 + 按新选区右下角重排胶囊
  const report = useCallback((r: Rect) => {
    invoke("snip_frame_move", { x: r.x, y: r.y, w: r.w, h: r.h }).catch(() => undefined);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") finishCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [finishCancel]);

  const dragRect = sel ? normDrag(sel.sx, sel.sy, sel.cx, sel.cy) : null;
  const hole = rect ?? dragRect;

  return (
    <div
      style={{ position: "fixed", inset: 0, cursor: rect ? hoverCursor : "crosshair" }}
      onMouseDown={(e) => {
        if (e.button !== 0 || done.current) return;
        if (rect) {
          // 会话阶段：边/角带内 = 缩放（对侧边锚定）、洞内 = 移动、
          // 洞外（边带之外）= 取消
          const hit = hitEdge(rect, e.clientX, e.clientY);
          if (hit.h || hit.v) {
            drag.current = { mode: "resize", sx: e.clientX, sy: e.clientY, rect, hit };
            return;
          }
          const inside =
            e.clientX >= rect.x &&
            e.clientX <= rect.x + rect.w &&
            e.clientY >= rect.y &&
            e.clientY <= rect.y + rect.h;
          if (inside) {
            drag.current = { mode: "move", sx: e.clientX, sy: e.clientY, rect };
          } else {
            finishCancel();
          }
          return;
        }
        setSel({ sx: e.clientX, sy: e.clientY, cx: e.clientX, cy: e.clientY });
      }}
      onMouseMove={(e) => {
        const d = drag.current;
        if (d && rect) {
          // 会话拖拽：本地渲染跟随（60fps），每次移动上报 Rust 重排胶囊
          if (d.mode === "move") {
            const next = clampRect({
              x: d.rect.x + e.clientX - d.sx,
              y: d.rect.y + e.clientY - d.sy,
              w: d.rect.w,
              h: d.rect.h,
            });
            setRect(next);
            report(next);
            return;
          }
          // 缩放：抓到的边跟随光标，对侧边锚定；最小 8px、钳在本屏内
          const { hit } = d;
          const s = d.rect;
          const vw = window.innerWidth;
          const vh = window.innerHeight;
          let n: Rect = { ...s };
          if (hit.h === "w") {
            const nx = Math.max(0, Math.min(s.x + (e.clientX - d.sx), s.x + s.w - 8));
            n.x = nx;
            n.w = s.w + (s.x - nx);
          } else if (hit.h === "e") {
            n.w = Math.max(8, Math.min(s.w + (e.clientX - d.sx), vw - s.x));
          }
          if (hit.v === "n") {
            const ny = Math.max(0, Math.min(s.y + (e.clientY - d.sy), s.y + s.h - 8));
            n.y = ny;
            n.h = s.h + (s.y - ny);
          } else if (hit.v === "s") {
            n.h = Math.max(8, Math.min(s.h + (e.clientY - d.sy), vh - s.y));
          }
          const next = clampRect(n);
          setRect(next);
          report(next);
          return;
        }
        // 无拖拽：悬停边命中刷新游标（边带 = 缩放、其余 = move）
        if (rect) {
          setHoverCursor(cursorFor(hitEdge(rect, e.clientX, e.clientY)));
          return;
        }
        if (sel && !rect) setSel({ ...sel, cx: e.clientX, cy: e.clientY });
      }}
      onMouseUp={() => {
        if (rect) {
          // 拖拽收尾：上报终值（move / resize 同路），选区保持
          const d = drag.current;
          drag.current = null;
          if (d) report(rect);
          return;
        }
        if (done.current || !sel) return;
        const r = normDrag(sel.sx, sel.sy, sel.cx, sel.cy);
        setSel(null);
        if (r.w >= 8 && r.h >= 8) {
          // 选区确认：本窗原位切会话模式（选区洞保留），静默截图与胶囊由
          // Rust 驱动（截图失败时 Rust 关窗终止 + 报错）。白环画在矩形外侧，
          // 遮罩显示期间截图洞内也是屏幕原始内容
          setRect(r);
          invoke("ocr_region_selected", { x: r.x, y: r.y, w: r.w, h: r.h }).catch(() =>
            finishCancel()
          );
        } else {
          finishCancel();
        }
      }}
    >
      {hole ? (
        <div style={holeStyle(hole, rect ? "move" : "crosshair")} />
      ) : (
        // 选区前整屏淡暗提示截屏模式（对齐 screencapture -i 的即时反馈）
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.15)" }} />
      )}
    </div>
  );
}

// 截图胶囊遮罩（snip-frame，macOS 截图胶囊会话）：铺满框选所在屏的交互
// 遮罩窗——洞外半透明变暗、洞内清晰（巨大 box-shadow 挖洞，与 Overlay 同款
// 手法）。两个阶段同一窗无缝过渡（无闪变）：
// - 选区阶段（rect=null）：触发即整屏淡暗提示，按下拖出选区（白环实时跟随），
//   松手 ≥8px invoke snip_region_selected（静默截图后 Rust 发 snip://frame
//   切到会话模式），过小 = snip_region_cancel 整段取消
// - 会话阶段（rect 非空）：选区可拖动，页面本地渲染洞/描边跟随（60fps），
//   每次移动 invoke snip_frame_move 让 Rust 重排右下角胶囊（实时跟随）；
//   点击选区外 = 取消会话（snip_cancel）。
// 白环用外扩 box-shadow 画在矩形外侧：洞内像素不被遮罩污染，静默截图即
// 屏幕原始内容。与 Windows 框选交互窗（Overlay）共用 snap.html 入口，按
// 窗口 label 分流
function FrameSession() {
  // 会话矩形（非空 = 会话模式）；选区阶段的拖拽矩形独立存 sel
  const [rect, setRect] = useState<Rect | null>(null);
  const [sel, setSel] = useState<Rect | null>(null);
  // 拖拽会话两模式：move = 按住选区内整体移动；resize = 按住边/角缩放
  //（对侧边锚定，最小 8px）。起点 rect 快照 + 起点光标算位移
  const drag = useRef<
    | { mode: "move"; sx: number; sy: number; rect: Rect }
    | { mode: "resize"; sx: number; sy: number; rect: Rect; hit: EdgeHit }
    | null
  >(null);
  // 悬停边命中对应的游标（无拖拽时的光标反馈；随 mousemove 刷新）
  const [hoverCursor, setHoverCursor] = useState<string>("move");
  const selecting = useRef<{ sx: number; sy: number } | null>(null);
  const done = useRef(false);

  useEffect(() => {
    // 页面加载标记：日志里「遮罩窗已创建并显示」之后若没有这条，即页面
    // 加载失败（窗口在但不可见内容，全屏吞点击）
    invoke("ui_debug_log", { msg: "[snip] 遮罩页面已加载" }).catch(() => undefined);
    // 会话矩形由 snip_region_selected 后的 Rust 事件下发——此时用户已在
    // 本页面完成拖选交互，listen 早已注册，无注册竞态
    const un = listen<Rect>("snip://frame", (e) => {
      setSel(null);
      setRect(e.payload);
    });
    const onKey = (e: KeyboardEvent) => {
      // 窗口非 key 一般收不到键盘；收到 Esc（聚焦态异常时兜底）按取消处理
      if (e.key === "Escape") finishCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      un.then((f) => f()).catch(() => undefined);
      window.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const finishCancel = useCallback(() => {
    if (done.current) return;
    done.current = true;
    invoke("snip_cancel").catch(() => undefined);
  }, []);

  const report = useCallback((r: Rect) => {
    invoke("snip_frame_move", { x: r.x, y: r.y, w: r.w, h: r.h }).catch(() => undefined);
  }, []);

  // 拖拽中的选区矩形（起点 → 当前光标归一化，钳在本屏视口内）。
  // 注意不做 8px 最小尺寸钳制——那是会话拖动的规则；选区阶段必须保留
  // 真实尺寸让 mouseup 的过小阈值（误触取消）能生效
  const normDrag = useCallback((sx: number, sy: number, cx: number, cy: number): Rect => {
    const x = Math.min(sx, cx);
    const y = Math.min(sy, cy);
    return {
      x: Math.max(0, x),
      y: Math.max(0, y),
      w: Math.min(Math.abs(cx - sx), window.innerWidth - Math.max(0, x)),
      h: Math.min(Math.abs(cy - sy), window.innerHeight - Math.max(0, y)),
    };
  }, []);

  // 洞 = 会话矩形（会话模式）或选区拖拽矩形（选区阶段）。样式按矩形参数
  // 构造——勿在渲染期对可能为 null 的洞直接取属性（首帧 rect/sel 均为
  // null，无条件构造曾在渲染层抛 TypeError，页面全程空白，2026-11-04）
  const hole = rect ?? sel;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        cursor: rect ? hoverCursor : "crosshair",
      }}
      onMouseDown={(e) => {
        if (e.button !== 0 || done.current) return;
        if (rect) {
          const hit = hitEdge(rect, e.clientX, e.clientY);
          if (hit.h || hit.v) {
            // 边/角带内 = 缩放（对侧边锚定）
            drag.current = { mode: "resize", sx: e.clientX, sy: e.clientY, rect, hit };
            return;
          }
          const inside =
            e.clientX >= rect.x &&
            e.clientX <= rect.x + rect.w &&
            e.clientY >= rect.y &&
            e.clientY <= rect.y + rect.h;
          if (inside) {
            drag.current = { mode: "move", sx: e.clientX, sy: e.clientY, rect };
          } else {
            finishCancel(); // 点选区外（边带之外）= 取消
          }
        } else {
          selecting.current = { sx: e.clientX, sy: e.clientY };
          setSel({ x: e.clientX, y: e.clientY, w: 0, h: 0 });
        }
      }}
      onMouseMove={(e) => {
        const d = drag.current;
        if (d && rect) {
          // 会话模式：实时上报 Rust 重排胶囊
          if (d.mode === "move") {
            const next = clampRect({
              x: d.rect.x + e.clientX - d.sx,
              y: d.rect.y + e.clientY - d.sy,
              w: d.rect.w,
              h: d.rect.h,
            });
            setRect(next);
            report(next);
            return;
          }
          // 缩放：抓到的边跟随光标，对侧边锚定；最小 8px、钳在本屏内
          const { hit } = d;
          const s = d.rect;
          const vw = window.innerWidth;
          const vh = window.innerHeight;
          let n: Rect = { ...s };
          if (hit.h === "w") {
            const nx = Math.max(0, Math.min(s.x + (e.clientX - d.sx), s.x + s.w - 8));
            n.x = nx;
            n.w = s.w + (s.x - nx);
          } else if (hit.h === "e") {
            n.w = Math.max(8, Math.min(s.w + (e.clientX - d.sx), vw - s.x));
          }
          if (hit.v === "n") {
            const ny = Math.max(0, Math.min(s.y + (e.clientY - d.sy), s.y + s.h - 8));
            n.y = ny;
            n.h = s.h + (s.y - ny);
          } else if (hit.v === "s") {
            n.h = Math.max(8, Math.min(s.h + (e.clientY - d.sy), vh - s.y));
          }
          const next = clampRect(n);
          setRect(next);
          report(next);
          return;
        }
        // 无拖拽：悬停边命中刷新游标（边带 = 缩放、洞内 = move、洞外 = 交叉线）
        if (rect) {
          setHoverCursor(cursorFor(hitEdge(rect, e.clientX, e.clientY)));
          return;
        }
        const s = selecting.current;
        if (s) setSel(normDrag(s.sx, s.sy, e.clientX, e.clientY));
      }}
      onMouseUp={() => {
        if (rect) {
          const d = drag.current;
          drag.current = null;
          if (d) report(rect); // 收尾上报终值（move / resize 同路）
          return;
        }
        if (!selecting.current) return;
        selecting.current = null;
        const r = sel;
        if (r && r.w >= 8 && r.h >= 8) {
          // 选区确认：静默截图 + 会话模式切换由 Rust 驱动（snip://frame 回发）
          invoke("snip_region_selected", { x: r.x, y: r.y, w: r.w, h: r.h }).catch(() =>
            invoke("snip_region_cancel").catch(() => undefined),
          );
        } else {
          // 过小选区 = 误触：整段取消
          finishCancel();
        }
      }}
    >
      {hole ? (
        <div style={holeStyle(hole, rect ? "move" : "crosshair")} />
      ) : (
        // 选区前整屏淡暗提示截图模式（对齐 Overlay 的即时反馈）
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.15)", pointerEvents: "none" }} />
      )}
    </div>
  );
}

// 全局错误捕获（页面诊断，2026-11-04）：webview 控制台错误不进终端/日志，
// 模块/渲染层任何未捕获异常都会表现为「隐形窗吞点击」——全部捞进日志
window.addEventListener("error", (e) => {
  invoke("ui_debug_log", {
    msg: `[snip] 页面错误：${e.message} @${e.filename}:${e.lineno}:${e.colno}`,
  }).catch(() => undefined);
});
window.addEventListener("unhandledrejection", (e) => {
  invoke("ui_debug_log", {
    msg: `[snip] 未处理的 Promise 拒绝：${String(e.reason)}`,
  }).catch(() => undefined);
});

const root = createRoot(document.getElementById("root")!);
try {
  const label = getCurrentWebviewWindow().label;
  invoke("ui_debug_log", { msg: `[snip] 窗口 label=${label}，挂载渲染` }).catch(
    () => undefined,
  );
  if (label === "snip-frame") {
    root.render(<FrameSession />);
  } else {
    root.render(<Overlay />);
  }
} catch (e) {
  invoke("ui_debug_log", { msg: `[snip] 挂载异常：${String(e)}` }).catch(
    () => undefined,
  );
}
