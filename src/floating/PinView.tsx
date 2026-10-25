// 钉图窗口（pin-* label 的渲染端）：缩放（光标锚点）+ 自定义拖拽 + 识别/复制。
// 从 App.tsx 拆出的自包含组件——只依赖 pin_* 命令与 icons，不碰浮动条/结果窗状态
import { useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, SyntheticEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { ScanSearch } from "lucide-react";
import { CheckIcon, CloseIcon, CopyIcon } from "./icons";

// 钉图四周透明出血（给投影留渲染空间）：与 floating.css .pin 的 padding、
// pin.rs 的 PIN_PAD 三处同步
const PAD = 12;

export default function PinView() {
  const [data, setData] = useState<{ url: string; scale: number } | null>(null);
  // 实时屏幕缩放系数：payload 快照只作初值——窗口刚创建未落屏时 scale_factor
  // 取不到、Rust 兜底 2.0，在 @1x 屏上会把图按一半尺寸渲染（浏览器插值缩小，
  // 钉图整体发虚的根因，2026-10-25）；挂载后改读实时值并监听跨屏变化
  const [scale, setScale] = useState(1);
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const copiedTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    invoke<{ url: string; scale: number }>("pin_get_data")
      .then((d) => {
        setData(d);
        setScale(d.scale);
      })
      .catch(() => undefined);
    // 实时 scale：落屏后回读 + 跨屏拖动随事件刷新（logical 随之重算并同步窗口）
    const win = getCurrentWebviewWindow();
    let unScale: (() => void) | undefined;
    win
      .scaleFactor()
      .then((s) => setScale(s))
      .catch(() => undefined);
    win
      .onScaleChanged((e) => setScale(e.payload.scaleFactor))
      .then((f) => {
        unScale = f;
      })
      .catch(() => undefined);
    return () => unScale?.();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") invoke("close_pin").catch(() => undefined);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // 逻辑尺寸 = 物理像素 / 实时屏幕缩放系数；物理尺寸取整——半像素的元素尺寸
  // 会让图片插值模糊（与 Rust 侧 to_grid 同一目的）
  const logical = nat
    ? {
        w: Math.round(nat.w * zoom) / scale,
        h: Math.round(nat.h * zoom) / scale,
      }
    : null;

  // 缩放锚点：光标在窗口内的相对位置（0..1）——缩放时该点保持不动。
  // 首帧 resize（naturalWidth 上报）时为 0,0 = 左上角，尺寸不变无影响
  const zoomAnchorRef = useRef({ fx: 0, fy: 0 });

  // 缩放（含首帧）后同步窗口尺寸（图片逻辑尺寸 + 四周出血）；Rust 侧按锚点
  // 补偿位置并做屏内钳制
  useEffect(() => {
    if (logical) {
      invoke("resize_pin", {
        width: logical.w + 2 * PAD,
        height: logical.h + 2 * PAD,
        fx: zoomAnchorRef.current.fx,
        fy: zoomAnchorRef.current.fy,
      }).catch(() => undefined);
    }
  }, [logical?.w, logical?.h]);

  // 图片加载完成 → 报告像素尺寸（Rust 换算逻辑尺寸、就近放置并显示）
  const onImgLoad = (e: SyntheticEvent<HTMLImageElement>) => {
    const el = e.currentTarget;
    setNat({ w: el.naturalWidth, h: el.naturalHeight });
    invoke("pin_window_ready", { width: el.naturalWidth, height: el.naturalHeight }).catch(
      () => undefined,
    );
  };

  const onWheel = (e: React.WheelEvent) => {
    // 页面本身不可滚动（overflow hidden），滚轮纯粹驱动缩放。
    // 按 deltaY 连续映射（指数曲线）：鼠标一档 ≈×0.9，触控板微滑微缩，
    // 不再用固定步进——触控板连发事件也不会「唰一下」缩过头
    const rect = e.currentTarget.getBoundingClientRect();
    zoomAnchorRef.current = {
      fx: e.clientX / rect.width,
      fy: e.clientY / rect.height,
    };
    const factor = Math.min(1.15, Math.max(0.87, Math.exp(-e.deltaY * 0.0009)));
    setZoom((z) => Math.min(5, Math.max(0.25, z * factor)));
  };

  // ---- 自定义拖拽：不用系统拖动（无法钳制边界），位移换算成窗口目标位置，
  //      由 Rust 侧 move_pin 钳制在屏幕内后落位 ----
  const dragRef = useRef<{ sx: number; sy: number; wx: number; wy: number } | null>(null);

  const onPinDragStart = (e: ReactMouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    invoke<{ x: number; y: number }>("pin_window_pos")
      .then((p) => {
        if (!p) return;
        dragRef.current = { sx: e.screenX, sy: e.screenY, wx: p.x, wy: p.y };
      })
      .catch(() => undefined);
  };

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      invoke("move_pin", {
        x: d.wx + (e.screenX - d.sx),
        y: d.wy + (e.screenY - d.sy),
      }).catch(() => undefined);
    };
    const onUp = () => {
      dragRef.current = null;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  const copyImage = () => {
    invoke("pin_copy_image").then(
      () => {
        setCopied(true);
        if (copiedTimer.current) window.clearTimeout(copiedTimer.current);
        copiedTimer.current = window.setTimeout(() => setCopied(false), 1200);
      },
      () => undefined,
    );
  };

  const recognize = () => {
    if (busy) return;
    setBusy(true);
    // 失败静默：按钮回到可点状态即可重试（提示类 UI 已按产品要求全部摘除）
    invoke("pin_to_ocr").finally(() => setBusy(false));
  };

  if (!data) return null;
  return (
    <div className="pin" onWheel={onWheel}>
      {/* 先渲染 img 才有 onLoad；nat 就绪前不给尺寸（避免循环依赖导致空白） */}
      <img
        src={data.url}
        draggable={false}
        style={logical ? { width: logical.w, height: logical.h } : undefined}
        onLoad={onImgLoad}
        onMouseDown={onPinDragStart}
        alt=""
      />
      <div className="pin-tools">
        <button
          className="tool"
          aria-label="识别文字"
          disabled={busy}
          onClick={recognize}
        >
          <ScanSearch size={13} strokeWidth={1.75} />
        </button>
        <button className="tool" aria-label="复制图片" onClick={copyImage}>
          {copied ? CheckIcon : CopyIcon}
        </button>
        <button className="tool" aria-label="关闭" onClick={() => invoke("close_pin").catch(() => undefined)}>
          {CloseIcon}
        </button>
      </div>
    </div>
  );
}
