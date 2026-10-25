// Windows 分离卡（方案甲「一卡一窗」）的二级浮层窗口：floating-panel（收纳
// 面板）与 floating-menu（窄单列菜单）共用本组件的哑渲染端——只按胶囊窗口
// 推来的 payload 渲染卡片，量尺寸回传 pop_ready（Rust 定位显示）；点击经
// floating_pick 回传胶囊窗口执行，动作语义/选区上下文/服务选择都在胶囊窗口
// （见 App.tsx 的 pickRef）。macOS 无这两个窗口，本组件不挂载，分离卡仍由
// 单窗原生阴影承担。卡片样式复用 floating.css 的 .pop（html.win 分支：卡片
// 铺满窗口、圆角与描边对齐 DWM）。
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { ChevronDown } from "lucide-react";
import { iconOf } from "./icons";

/** 收纳面板行（App.tsx 的 restEntries 投影） */
interface OverflowItem {
  id: string;
  label: string;
  icon: string | null;
  hasMenu: boolean;
}

/** 窄单列菜单项（key 语义随 kind：翻译服务 id / 引擎名 / Obsidian 目标） */
interface MenuItem {
  key: string;
  label: string;
  on: boolean;
}

type PopData =
  | { type: "overflow"; subOpen: string | null; items: OverflowItem[] }
  | { type: "menu"; kind: string; items: MenuItem[] };

export default function PopCard() {
  const [data, setData] = useState<PopData | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);
  // 行 hover 上报的去重记忆（仅行变化时上报，见 onPanelRowMove）
  const lastRowRef = useRef("");

  useEffect(() => {
    // 必须用窗口作用域监听：全局 listen() 注册在 EventTarget::Any 上，
    // Rust emit_to 给另一个弹层窗口的定向事件它也收得到——两个弹层会
    // 各自渲染出同一份卡片（一卡一窗双影的根因）
    const un = getCurrentWebviewWindow().listen<{ open: boolean; data: PopData }>(
      "floating://pop",
      (e) => {
        // 面板重开/内容刷新即作废行记忆：上次悬停的行重开后不一定还在光标下
        lastRowRef.current = "";
        setData(e.payload.open ? e.payload.data : null);
      },
    );
    return () => {
      un.then((f) => f()).catch(() => undefined);
    };
  }, []);

  // 渲染完成即量卡片尺寸回传：窗口 = 卡片（零出血），Rust 据此定位显示。
  // 内容刷新（实体渐进出现/设置实时推送）会再次触发，Rust 端锚点不变、原地重定位
  useLayoutEffect(() => {
    if (!data) return;
    const el = ref.current;
    if (!el) return;
    invoke("pop_ready", { width: el.offsetWidth, height: el.offsetHeight }).catch(() => undefined);
  }, [data]);

  const pick = (kind: string, key: string, rowY?: number) => {
    invoke("floating_pick", { kind, key, rowY: rowY ?? null }).catch(() => undefined);
  };

  // 行 hover 上报：胶囊窗口看不到面板窗口内部的行布局，行命中在此检测
  // （WebView2 真 mousemove 可靠），驻留/即切决策仍在胶囊（row-hover 经
  // floating_pick 回传）。仅行变化时上报（进入/离开/换行），不做逐 move 上报；
  // id 为空串 = 光标在行间留白，胶囊据此清驻留计时
  const onPanelRowMove = (e: ReactMouseEvent) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>(".pitem");
    const id = row?.dataset.id ?? "";
    if (id === lastRowRef.current) return;
    lastRowRef.current = id;
    const rowY = row ? Math.round(row.getBoundingClientRect().top) : null;
    pick("row-hover", id, rowY ?? undefined);
  };

  if (!data) return null;

  if (data.type === "overflow") {
    return (
      <div className="stage">
        <div className="pop overflow" ref={ref} onMouseMove={onPanelRowMove}>
          {data.items.map((e) => (
            <span key={e.id} className="pitem" data-id={e.id}>
              <button type="button" className="action" onClick={() => pick("action", e.id)}>
                <span className="ic">{iconOf(e.id, e.icon ?? undefined)}</span>
                <span>{e.label}</span>
              </button>
              {e.hasMenu && (
                <button
                  type="button"
                  className={`pchev ${data.subOpen === e.id ? "open" : ""}`}
                  aria-label="存入目标"
                  onClick={() => {
                    // 行侧菜单锚定整行（NSMenu 心智）：行顶 y 相对面板传给 Rust
                    const row = ref.current?.querySelector<HTMLElement>(`[data-id="${e.id}"]`);
                    const rowY = row ? Math.round(row.getBoundingClientRect().top) : null;
                    pick("menu-toggle", e.id, rowY ?? undefined);
                  }}
                >
                  <ChevronDown size={12} strokeWidth={2} className="chev-svg" />
                </button>
              )}
            </span>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="stage">
      <div className="pop menu" ref={ref}>
        {data.items.map((it) => (
          <button
            key={it.key}
            type="button"
            className={`mitem ${it.on ? "on" : ""}`}
            onClick={() => pick(`pick:${data.kind}`, it.key)}
          >
            <span className="dot" />
            <span>{it.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
