// src/floating/useMaterialSync.ts —— vibrancy 材质同步（macOS 条窗专属）。
// Rust 侧见 floating/material.rs：每张卡片（胶囊 + 已展开二级浮层）一个材质
// 视图，缝隙/留白无视图 = 真实桌面。
// 从 App.tsx 拆出（2026-10-27 重构，逻辑零改动）。两路消费方：
// 1. syncMaterial —— 主题切换/系统亮暗变化时刷新材质明暗（尺寸不变）；
// 2. materialCards/materialDark —— show/resize 布局 effect 组装 payload，
//    矩形随命令同趟上报（Rust 同命令内先落窗口尺寸再摆材质，顺序保证不残影）。
// 当前 MATERIAL_ENABLED = false（2026-10-25 材质定稿关闭，逻辑保留备翻案）。
import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { RefObject } from "react";
import { IS_OCR, IS_PIN, IS_WIN_LIKE } from "./env";

const MATERIAL_ENABLED = false;

export function useMaterialSync(
  barRef: RefObject<HTMLDivElement | null>,
  overflowRef: RefObject<HTMLDivElement | null>,
  menuPopRef: RefObject<HTMLDivElement | null>,
) {
  const materialActive = MATERIAL_ENABLED && !IS_WIN_LIKE && !IS_OCR && !IS_PIN;
  const materialDark = () => {
    const root = document.documentElement;
    return (
      root.classList.contains("theme-dark") ||
      (!root.classList.contains("theme-light") &&
        window.matchMedia("(prefers-color-scheme: dark)").matches)
    );
  };
  const materialCards = () => {
    const cards: { x: number; y: number; w: number; h: number }[] = [];
    const bar = barRef.current;
    if (!bar) return cards;
    const rect = (el: HTMLElement) => {
      const b = el.getBoundingClientRect();
      return { x: b.x, y: b.y, w: b.width, h: b.height };
    };
    cards.push(rect(bar));
    if (overflowRef.current) cards.push(rect(overflowRef.current));
    if (menuPopRef.current) cards.push(rect(menuPopRef.current));
    return cards;
  };
  const syncMaterial = () => {
    if (!materialActive || !barRef.current) return;
    invoke("update_floating_material", { cards: materialCards(), dark: materialDark() }).catch(
      () => undefined,
    );
  };

  // 跟随系统模式时系统亮暗切换不发 theme://appearance——材质明暗自听媒体查询
  useEffect(() => {
    if (!materialActive) return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", syncMaterial);
    return () => mq.removeEventListener("change", syncMaterial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { materialActive, materialCards, materialDark, syncMaterial };
}
