import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { MouseEvent as ReactMouseEvent } from "react";import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { toast } from "../shared/toast";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

// AI 输出里的图片不自动加载：远程图片会在渲染时向第三方服务器发起请求
//（跟踪像素类的外联，与"不收集使用数据"的产品承诺冲突），死链还会显示破图。
// 转为可点链接交给外部浏览器（点击走 external-links 拦截器 → open_url），
// 默认零外联、想看的人自己点。urlTransform 默认值会先剥掉 javascript: 等协议
const mdComponents: Components = {
  img: ({ src, alt }) => (src ? <a href={src}>{alt || src}</a> : null),
};
import {
  AlignLeft,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ClipboardCheck,
  Copy,
  ExternalLink,
  ImagePlus,
  Languages,
  Lightbulb,
  Mail,
  MapPin,
  NotebookPen,
  Phone,
  Pin,
  PinOff,
  ScanSearch,
  Search,
  Sparkles,
  X,
} from "lucide-react";
import { actionPrompt, actionRegistry, isContextAction } from "../shared/actions";
import { customIconNode } from "../shared/icons";
import { aiChat } from "../shared/ai";
import { TRANSLATE_SERVICES, translateMissingReason, translateService } from "../shared/translate";
import {
  extractAll,
  extractCode,
  extractEmail,
  extractTel,
  extractUrl,
} from "../shared/textContext";
import type {
  CustomAction,
  ObsidianConfig,
  Provider,
  SearchEngine,
  Settings,
  TranslateConfig,
} from "../shared/types";

// 窗口身份（生命周期内不变 → 模块级常量，事件回调不会读到过期值）：
// floating = 划词浮动条；ocr = 文本识别独立窗口；pin-* = 钉图窗口
const WIN_LABEL = (() => {
  try {
    return getCurrentWebviewWindow().label;
  } catch {
    return "floating";
  }
})();
const IS_OCR = WIN_LABEL === "ocr";
const IS_PIN = WIN_LABEL.startsWith("pin-");
// 平台分叉（与 main.tsx 的 html.win 根类同一判据）：Windows 走方案甲「一卡一窗」
// 分离卡——二级浮层渲染在独立窗口（floating-panel / floating-menu，窗口即卡片，
// 见 floating.rs），本窗口（胶囊）只把渲染数据 + 锚点推给 Rust（set_floating_pops）；
// macOS 维持单窗分离卡（NSWindow 按内容轮廓画影），交互逻辑与样式零改动
const IS_WIN_LIKE = !/Mac/i.test(navigator.platform);
const POPS_EXTERNAL = IS_WIN_LIKE && !IS_OCR && !IS_PIN;

// 上下文智能动作：由「提取信息」统一承载（多值/混合进面板），不再逐个上胶囊条
// （id 集合见 shared/actions.ts CONTEXT_ACTION_IDS）
type ExtractGroups = {
  tel: string[];
  email: string[];
  link: string[];
  code: string[];
  date: string[];
  addr: string[];
};

const EXTRACT_GROUPS: Array<{ id: keyof ExtractGroups; label: string }> = [
  { id: "tel", label: "电话" },
  { id: "email", label: "邮箱" },
  { id: "link", label: "链接" },
  { id: "code", label: "验证码" },
  { id: "date", label: "日期" },
  { id: "addr", label: "地点" },
];

/** 数量最多的实体类型（面板图标用） */
function dominantGroup(groups: ExtractGroups): string {
  let best: keyof ExtractGroups = "link";
  for (const g of EXTRACT_GROUPS) {
    if (groups[g.id].length > groups[best].length) best = g.id;
  }
  return best;
}

// ---------- 日期实体（加入日历场景动作） ----------
// 识别在 Rust 侧（NSDataDetector，系统级/离线/确定性，entities.rs）；
// TS 只负责格式化展示与 .ics 时间串计算（JS 原生 Date 处理本地时区）

/** Rust detect_dates 的日期命中（entities.rs DateHit，camelCase） */
interface DateHit {
  unix: number;
  duration: number;
  start: number;
  len: number;
}

/** 命中的展示标签："10月1日 周四 15:00"；零点视为全天（不带时间） */
function formatDateLabel(h: DateHit): string {
  const d = new Date(h.unix * 1000);
  const base = `${d.getMonth() + 1}月${d.getDate()}日 周${"日一二三四五六"[d.getDay()]}`;
  if (d.getHours() === 0 && d.getMinutes() === 0) return base;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${base} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 日期命中 → 本地 .ics 交给系统日历（预填事件）。标题取选中文本前 40 字 */
function openInCalendar(hit: DateHit, title: string, onDone?: (ok: boolean) => void): void {
  const d = new Date(hit.unix * 1000);
  const allDay = d.getHours() === 0 && d.getMinutes() === 0;
  const p = (n: number) => String(n).padStart(2, "0");
  const dt = (x: Date) =>
    `${x.getFullYear()}${p(x.getMonth() + 1)}${p(x.getDate())}T${p(x.getHours())}${p(x.getMinutes())}00`;
  const durMs = (hit.duration > 0 ? hit.duration : 3600) * 1000;
  const start = allDay ? `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` : dt(d);
  const endDate = new Date(d.getTime() + (allDay ? 86400000 : durMs));
  const end = allDay
    ? `${endDate.getFullYear()}${p(endDate.getMonth() + 1)}${p(endDate.getDate())}`
    : dt(endDate);
  invoke("open_in_calendar", { start, end, title: title.slice(0, 40), allDay })
    .then((ok) => onDone?.(ok === true))
    .catch(() => onDone?.(false));
}

/** 面板行点击：从文本重检测（µs 级）并按展示标签匹配命中，打开日历。
 *  OCR 窗口侧不保存命中列表——重新检测比跨窗口传状态简单 */
function detectAndOpenCalendar(text: string, label: string, onDone?: (ok: boolean) => void): void {
  invoke<DateHit[]>("detect_dates", { text })
    .then((hits) => {
      const hit = (hits ?? []).find((h) => formatDateLabel(h) === label);
      if (hit) openInCalendar(hit, text, onDone);
      else onDone?.(false);
    })
    .catch(() => onDone?.(false));
}

/** URL 展示：域名正文字色、路径弱化灰，并列多条时一眼分辨站点。
 * 超长 URL（如贴图床/markdown 图片链接）中段省略：保目录头 + 尾段（文件名），
 * hash 类文件名的差异在开头，故尾段超长时掐中段保留开头；
 * 原始完整值始终用于复制（提取值不改动），悬停 tooltip 看全文。
 * 切分交给 URL 标准解析器，解析失败退回纯文本 */
function renderUrl(item: string): React.ReactNode {
  let u: URL;
  try {
    u = new URL(item);
  } catch {
    return item;
  }
  const path = item.slice(u.origin.length);
  if (!path) return item;
  if (item.length <= 46) {
    return (
      <>
        {u.origin}
        <span className="url-path">{path}</span>
      </>
    );
  }
  const cut = path.lastIndexOf("/");
  const dir = cut <= 0 ? "" : path.slice(0, cut);
  const file = cut <= 0 ? path : path.slice(cut);
  const dirShow = dir.length > 16 ? dir.slice(0, 16) : dir;
  const fileShow = file.length > 26 ? file.slice(0, 12) + "…" + file.slice(-9) : file;
  return (
    <>
      {u.origin}
      <span className="url-path">
        {dirShow}…{fileShow}
      </span>
    </>
  );
}

// ---- 图标（lucide-react 图标库，统一 15px / 1.75 描边，随文字色）----
// 导出给 pops.tsx（分离卡的弹层窗口是哑渲染端，图标语言必须一致）
export const ICONS: Record<string, React.ReactNode> = {
  copy: <Copy size={14} strokeWidth={1.75} />,
  search: <Search size={14} strokeWidth={1.75} />,
  translate: <Languages size={14} strokeWidth={1.75} />,
  explain: <Lightbulb size={14} strokeWidth={1.75} />,
  summarize: <AlignLeft size={14} strokeWidth={1.75} />,
  link: <ExternalLink size={14} strokeWidth={1.75} />,
  email: <Mail size={14} strokeWidth={1.75} />,
  code: <ClipboardCheck size={14} strokeWidth={1.75} />,
  tel: <Phone size={14} strokeWidth={1.75} />,
  date: <CalendarDays size={14} strokeWidth={1.75} />,
  obsidian: <NotebookPen size={14} strokeWidth={1.75} />,
  addr: <MapPin size={14} strokeWidth={1.75} />,
  __extract: <ScanSearch size={14} strokeWidth={1.75} />,
  // 自定义动作共用一枚图标：用户自己起的名字已经是辨识度，不做图标选择器
  __custom: <Sparkles size={14} strokeWidth={1.75} />,
};
// 自定义动作带 icon（lucide 名，shared/icons.tsx）时优先用之；未设置/查不到
// 回落内置表，再回落默认 Sparkles
export const iconOf = (id: string, icon?: string) =>
  customIconNode(icon, 14) ?? ICONS[id] ?? ICONS.__custom;
const CopyIcon = <Copy size={13} strokeWidth={1.75} />;
const CheckIcon = <Check size={13} strokeWidth={2} className="ok" />;
const CloseIcon = <X size={13} strokeWidth={1.75} />;

// 状态机：Bar（胶囊） → Result（流式面板）/ Extract（多值列表）；dismiss/新选区回收
type Phase =
  | { kind: "bar" }
  | {
    kind: "extract";
    /** 主要实体类型（决定面板图标） */
    actionId: string;
    label: string;
    groups: ExtractGroups;
    /** 原始选中文本：日期实体异步合并、「加入日历」行点击时重检测用 */
    text?: string;
  }
  | {
    /** OCR 识图取字：合并面板（文本可见 + 动作内嵌 + 结果流式）。
        fromOcr = 识别来源（显示钉图/识图取字标题）；false = 划词导流结果 */
    kind: "ocr";
    text: string;
    fromOcr: boolean;
    actionId: string | null;
    output: string;
    streaming: boolean;
    error: string | null;
    expanded: boolean;
    /** 机器翻译结果按纯文本渲染（API 返回即纯文本，不进 markdown 解释） */
    plain?: boolean;
  };

// 重复查询缓存：同动作 + 同服务 + 同文本，5 分钟内直接复用结果
// （容量 50，LRU 淘汰；划词场景「反复选中同一段」很常见）
const resultCache = new Map<string, { output: string; at: number }>();
const CACHE_TTL = 5 * 60_000;
const CACHE_CAP = 50;

// 分离卡几何常量（与 floating.rs 的 FLOAT_PAD / floating.css 的 .bar margin 一致）：
// FLOAT_PAD = 卡片四周透明留白（卡片边缘不得压窗口边界）；CARD_GAP = 胶囊与二级卡片的缝。
// Windows 一卡一窗：窗口即卡片，留白归零（出血会原样透出桌面）
const FLOAT_PAD = IS_WIN_LIKE ? 0 : 8;
const CARD_GAP = 3;

// hover 驻留展开：光标在「带 ⌄ 的动作项」上停留满 OPEN 才展开二级浮层
// （快速路过不开）；离开胶囊∪浮层满 CLOSE 后自动收起（跨窗口缝隙、
// 瞄准时的犹豫抖动不打断）。收起比展开略长：leave → 进菜单窗口的间隙别误收
const HOVER_OPEN_MS = 300;
const HOVER_CLOSE_MS = 350;
// 子菜单退场时长：与 floating.css 的 --menu-out-ms 同步（switchMenu 以 fading
// 快照续挂旧菜单 .m-out 淡出，到点卸载）
const MENU_FADE_MS = 110;

// hover 驻留的作用域入口 id（menu 状态取值域的子集）：
// chev:* = 胶囊动作 ⌄，overflow = 最右收纳钮，pmenu:* = 收纳面板行的行侧菜单
// （面板开着才可达，故行 hover 恒走「已开即切」，不走驻留分支），
// search/translate/obsidian = 结果窗口动作行 ⌄（同窗流内菜单，窗口向下生长）
type HoverMenuId =
  | "chev:translate"
  | "chev:search"
  | "chev:obsidian"
  | "overflow"
  | "pmenu:translate"
  | "pmenu:search"
  | "pmenu:obsidian"
  | "search"
  | "translate"
  | "obsidian";

// 二级浮层开合状态的取值域（fading 退场快照同域）：chev:* 仅浮动条胶囊、
// overflow 浮动条「更多」收纳 / OCR 结果窗胶囊堆共用一名、pmenu:* 为堆内
// 行侧菜单、search/translate/obsidian 为结果窗动作行 ⌄ 槽位菜单
type MenuState = HoverMenuId;

// Rust 返回的窗口落位 / 显示器逻辑矩形（逻辑坐标）
interface WindowPos {
  x: number;
  y: number;
}
interface ScreenRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function cacheGet(key: string): string | null {
  const hit = resultCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL) {
    resultCache.delete(key);
    return null;
  }
  resultCache.delete(key);
  resultCache.set(key, hit); // LRU touch
  return hit.output;
}

function cachePut(key: string, output: string) {
  if (resultCache.size >= CACHE_CAP) {
    const oldest = resultCache.keys().next().value;
    if (oldest !== undefined) resultCache.delete(oldest);
  }
  resultCache.set(key, { output, at: Date.now() });
}

// 结果窗口待显示结果（Rust ocr_take_pending 的返回结构）
interface PendingView {
  text: string;
  fromOcr: boolean;
  pinned: boolean;
  hasImage: boolean;
  imagePath: string | null;
  run: { id: string; service: string | null } | null;
}

// ---- 钉图视图：无边框置顶窗口内渲染截图 ----
// 交互：图片即拖拽区（data-tauri-drag-region 系统级拖动）；滚轮缩放；
// 悬停工具条（识别文字 / 复制图片 / 关闭）；Esc 关闭。
function PinView() {
  const [data, setData] = useState<{ url: string; scale: number } | null>(null);
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const copiedTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    invoke<{ url: string; scale: number }>("pin_get_data")
      .then(setData)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") invoke("close_pin").catch(() => undefined);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const logical = nat ? { w: (nat.w * zoom) / data!.scale, h: (nat.h * zoom) / data!.scale } : null;

  // 缩放锚点：光标在窗口内的相对位置（0..1）——缩放时该点保持不动。
  // 首帧 resize（naturalWidth 上报）时为 0,0 = 左上角，尺寸不变无影响
  const zoomAnchorRef = useRef({ fx: 0, fy: 0 });

  // 缩放（含首帧）后同步窗口尺寸；Rust 侧按锚点补偿位置并做屏内钳制
  useEffect(() => {
    if (logical) {
      invoke("resize_pin", {
        width: logical.w,
        height: logical.h,
        fx: zoomAnchorRef.current.fx,
        fy: zoomAnchorRef.current.fy,
      }).catch(() => undefined);
    }
  }, [logical?.w, logical?.h]);

  // 图片加载完成 → 报告像素尺寸（Rust 换算逻辑尺寸、就近放置并显示）
  const onImgLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
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

// 识别原文（可编辑）：OCR 可能识别错字，错字会静默传导给后续动作——
// 允许在原地用 contentEditable 纯文本修正，onInput 同步回 phase.text。
// DOM 回写仅在文本「外部变化」（新识别/重置）时发生：用户输入引发的重渲染里
// DOM 与 state 已一致，跳过回写以保住光标位置（受控 contentEditable 的经典坑）
function EditableSource({
  text,
  sourceRef,
  onEdit,
}: {
  text: string;
  sourceRef: React.RefObject<HTMLDivElement | null>;
  onEdit: (t: string) => void;
}) {
  useLayoutEffect(() => {
    const el = sourceRef.current;
    if (el && el.textContent !== text) el.textContent = text;
  }, [text, sourceRef]);
  return (
    <div
      ref={sourceRef as React.RefObject<HTMLDivElement>}
      className="ocr-source"
      contentEditable="plaintext-only"
      suppressContentEditableWarning
      onInput={(e) => onEdit(e.currentTarget.textContent ?? "")}
    />
  );
}

// 翻译的富结果：译文主体 + 要点（学习辅助）。展示分层，复制只取译文。
function splitTranslate(output: string): { main: string; notes: string | null } {
  let s = output.trim();
  if (s.startsWith("【译文】")) s = s.slice(4).trim();
  // 模型偶尔会给译文加 markdown 引用前缀（>），提示词已禁止；此处兜底剥掉，
  // 避免被渲染成引用块样式（翻译应为纯文本，不添加程序自带的装饰）
  while (s.startsWith(">")) s = s.replace(/^>\s?/m, "").trim();
  const i = s.indexOf("【要点】");
  if (i < 0) return { main: s, notes: null };
  return { main: s.slice(0, i).replace(/^>\s?/gm, "").trim(), notes: s.slice(i + 4).trim() || null };
}

export default function App() {
  // 钉图窗口：只渲染图片视图（不注册划词监听、不渲染浮动条/面板）
  if (IS_PIN) return <PinView />;

  const [text, setText] = useState("");
  const [pending, setPending] = useState<{ x: number; y: number } | null>(null);
  // OCR 面板钉住：钉住后忽略 dismiss（ref 供事件闭包读最新值）
  const [ocrPinned, setOcrPinned] = useState(false);
  const ocrPinnedRef = useRef(false);
  // ⏱ 划词弹出耗时测量：captured 事件到达时刻，show_floating_bar 返回时结算
  const capturedAtRef = useRef(0);
  const setOcrPinnedState = (v: boolean) => {
    ocrPinnedRef.current = v;
    setOcrPinned(v);
  };
  const [actions, setActions] = useState<Record<string, boolean>>({
    translate: true,
    explain: true,
    summarize: true,
    copy: true,
    link: true,
    email: true,
    code: true,
    tel: true,
  });
  const [actionOrder, setActionOrder] = useState<string[]>([]);
  /** 用户自定义 AI 动作（注册表 = 内置 + 这份数据，见 registry） */
  const [customActions, setCustomActions] = useState<CustomAction[]>([]);
  // runAction 可能由挂载效应里的首帧闭包调用（划词/识图导流的自动执行路径），
  // 那份闭包读到的 state 永远停在初始值：注册表与提示词覆盖因此经 ref 取。
  // 新增设置项若被 runAction 用到，一并写进这里，否则表现为"改了没生效"。
  const liveRef = useRef<{
    registry: ReturnType<typeof actionRegistry>;
    prompts: Record<string, string>;
  }>({ registry: actionRegistry(), prompts: {} });
  const [capsuleMax, setCapsuleMax] = useState(4);
  const [translateEnabled, setTranslateEnabled] = useState<string[]>(["ai"]);
  const [translateDefault, setTranslateDefault] = useState("ai");
  const [translateOrder, setTranslateOrder] = useState<string[]>([]);
  // 翻译服务配置快照：使用时兜底提醒的判据（shared/translate.ts）
  const [translateCfg, setTranslateCfg] = useState<TranslateConfig | null>(null);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [defaultProviderId, setDefaultProviderId] = useState("");
  const [flashId, setFlashId] = useState<string | null>(null);
  const [flashMsg, setFlashMsg] = useState("");
  const [engines, setEngines] = useState<SearchEngine[]>([]);
  const [defaultSearch, setDefaultSearch] = useState("");
  // 展开的二级浮层（同屏只开一个入口）："search"/"translate"/"obsidian" 仅供 OCR
  // 结果窗口的动作行 chips 沿用（obsidian = 存入目标：笔记/任务/卡片）；浮动条用
  // overflow（收纳面板）/ chev:*（胶囊动作换渠道/存入目标）/
  // pmenu:*（收纳面板项换渠道/存入目标），二级一律窄单列浮出菜单（形式全局统一）
  const [menu, setMenu] = useState<MenuState | null>(null);
  // 二级菜单当前选中的服务：初始跟随默认服务，点谁谁选中；
  // 点主菜单按钮（走默认服务）时置 null 回落到默认高亮
  const [usedTranslate, setUsedTranslate] = useState<string | null>(null);
  const [usedEngine, setUsedEngine] = useState<string | null>(null);
  // 提取列表（多值面板）的复制反馈
  const [copiedAll, setCopiedAll] = useState(false);
  // 提取列表行内复制的反馈（记录条目内容）
  const [copiedItem, setCopiedItem] = useState<string | null>(null);
  // OCR 面板复制的反馈（复制结果 / 复制识别文本）
  const [copiedOcr, setCopiedOcr] = useState(false);
  // OCR 面板「钉图」成功的反馈（图标短暂变对勾）
  const [pinOk, setPinOk] = useState(false);
  // 结果窗口完成闪烁：流式结束瞬间呼吸点变绿，2s 后消失（比单纯延迟消失语义清晰）
  const [doneFlash, setDoneFlash] = useState(false);
  // 弹出瞬间挂起 hover 样式：胶囊常压在光标下，hover 残留会被误认为「选中」；
  // 首次 mousemove 即恢复（非 key 窗口下由 hover://move 合成事件解除，见下）
  const [hoverSuppress, setHoverSuppress] = useState(false);
  // Obsidian 接入配置：vaultPath 非空 = 「存入 Obsidian」动作可用
  const [obsidianCfg, setObsidianCfg] = useState<ObsidianConfig | null>(null);
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
  const [fading, setFading] = useState<MenuState | null>(null);
  const fadeTimerRef = useRef(0);
  // 菜单纯收起/切换的统一入口（替代直接 setMenu）：事件闭包经 menuStateRef
  // 读最新值，渲染期回调经渲染闭包——两条路径都取到当前菜单；同值调用无副作用
  const switchMenu = useCallback((next: MenuState | null) => {
    const cur = menuStateRef.current;
    if (cur !== null && cur !== next) {
      setFading(cur);
      window.clearTimeout(fadeTimerRef.current);
      fadeTimerRef.current = window.setTimeout(() => setFading(null), MENU_FADE_MS);
    }
    setMenu(next);
  }, []);
  const hoverLeftAtRef = useRef<number | null>(null);
  // 子菜单级划出时刻：chips 开着时光标离开「胶囊堆 ∪ chips」区域即计时，
  // 150ms 后只收回 chips（回 overflow 态，主堆保留）；窗口级离开仍走 hoverLeft
  const subLeftAtRef = useRef<number | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);
  // 分离卡几何基准：屏幕矩形（贴边翻转判定）、窗口上次落位、bar 在窗口内偏移。
  // 卡片屏幕坐标 = 窗口位置 + 窗口内偏移；winPos 由 show/resize 返回值与
  // 拖拽结束回读（floating_window_pos）维持，见布局 effect 与 onStageMouseUp
  const screenRef = useRef<ScreenRect | null>(null);
  const winPosRef = useRef<WindowPos | null>(null);
  const barInWinRef = useRef({ x: FLOAT_PAD, y: FLOAT_PAD });
  const overflowRef = useRef<HTMLDivElement | null>(null);
  // 结果窗「更多」浮层（§B.5）：胶囊堆挂 .panel 下（CSS 定位）；横向 chips
  // 需按触发胶囊实测坐标级联，面板与 chips 各持一个 ref（见定位 effect）
  const ocrPanelRef = useRef<HTMLDivElement | null>(null);
  const railChipsRef = useRef<HTMLDivElement | null>(null);
  // 全关守卫镜像（见 captured 分支注释）：监听只注册一次，闭包拿不到渲染期
  // 状态——常驻动作存活性与动作开关的最新值经 ref 每次渲染刷新
  const barLiveRef = useRef(true);
  const actionsRef = useRef(actions);
  const menuPopRef = useRef<HTMLDivElement | null>(null);
  // 钉图失败的反馈（图标变红 + title 显示具体原因，直到下次重试）
  const [pinErr, setPinErr] = useState<string | null>(null);
  const copiedAllTimerRef = useRef<number | undefined>(undefined);
  const copiedItemTimerRef = useRef<number | undefined>(undefined);
  const copiedOcrTimerRef = useRef<number | undefined>(undefined);
  const pinOkTimerRef = useRef<number | undefined>(undefined);
  const flashTimerRef = useRef<number | undefined>(undefined);
  // OCR 结果区：同一套智能跟随（默认贴底；用户上翻即暂停 + 回到底部圆钮）
  const ocrBodyRef = useRef<HTMLDivElement | null>(null);
  // 面板主体：菜单溢出量 = 槽位底边相对它的超出部分
  // 二级菜单槽位（动作行正下方）：开合状态机按它量菜单高度
  const ocrStickRef = useRef(true);
  const [ocrStick, setOcrStick] = useState(true);

  const onOcrResultScroll = () => {
    const el = ocrBodyRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    ocrStickRef.current = atBottom;
    setOcrStick(atBottom);
  };

  const ocrJumpToBottom = () => {
    const el = ocrBodyRef.current;
    if (!el) return;
    ocrStickRef.current = true;
    setOcrStick(true);
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };

  const enabledEngines = engines.filter((e) => e.enabled);
  const defaultEngine =
    enabledEngines.find((e) => e.name === defaultSearch) ?? enabledEngines[0] ?? null;
  // 浮动条展开顺序 = 设置页拖拽排序（order），缺省 id 按注册表顺序排后
  const enabledTranslates = TRANSLATE_SERVICES.filter((s) => translateEnabled.includes(s.id)).sort(
    (a, b) => {
      const ia = translateOrder.indexOf(a.id);
      const ib = translateOrder.indexOf(b.id);
      return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
    },
  );
  const defaultTranslate =
    enabledTranslates.find((s) => s.id === translateDefault) ?? enabledTranslates[0] ?? null;
  // 默认模型服务是否可用（密钥与模型名齐备）：解释/总结等 AI 动作的显示闸——
  // 与动作开关共同决定动作是否出现，用不了的动作不占位（翻译走自有服务列表闸）
  const hasUsableModel = providers.some(
    (p) => p.id === defaultProviderId && p.apiKey.trim() !== "" && p.model.trim() !== "",
  );

  const openEngine = (engine: SearchEngine, q = text.trim()) => {
    const tpl = engine.url.includes("{q}") ? engine.url : `${engine.url}{q}`;
    invoke("open_url", { url: tpl.replace("{q}", encodeURIComponent(q)) })
      .then(() => flash("search", "已打开"))
      .catch(() => flash("search", "打开失败"));
  };
  const [phase, setPhase] = useState<Phase>({ kind: "bar" });
  // 流式增量渲染后：贴底状态才跟随滚动（用户上翻阅读时不打扰）；新一轮结果从贴底开始跟随
  useLayoutEffect(() => {
    const ocrEl = ocrBodyRef.current;
    if (ocrEl && ocrStickRef.current) ocrEl.scrollTop = ocrEl.scrollHeight;
  }, [phase]);

  useEffect(() => {
    // 仅在新一轮开始（输出为空）时重置跟随；流式进行中重置会覆盖用户的上翻暂停
    if (phase.kind === "ocr" && phase.output === "") {
      ocrStickRef.current = true;
      setOcrStick(true);
    }
  }, [phase]);

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
  }, [menu]);

  // 完成闪烁：streaming true→false 且已有输出（出错不闪绿，错误有自己的提示）
  useEffect(() => {
    if (phase.kind !== "ocr" || phase.streaming || !phase.output || phase.error) {
      setDoneFlash(false);
      return;
    }
    setDoneFlash(true);
    const t = window.setTimeout(() => setDoneFlash(false), 2000);
    return () => window.clearTimeout(t);
  }, [phase]);

  const runIdRef = useRef(0);
  const streamingRef = useRef(false);
  // OCR 窗口显示链路状态：新识别结果到来时重置（强制重测量 + 重新显示）
  const lastSizeRef = useRef("");
  const ocrReadyRef = useRef(false);
  // 结果窗动作行溢出收纳（方案 A）：一行放不下时尾部动作收进行尾「更多 ⌃」，
  // 点开在菜单槽位以 chips 呈现（点击即执行）。overflowCount = 收进的数量；
  // tick = 窗口/内容尺寸变化的重新测量信号
  const [ocrOverflow, setOcrOverflow] = useState(0);
  const [, setOcrTick] = useState(0);
  const actionsRowRef = useRef<HTMLDivElement | null>(null);
  // 识别原文是否超长（超 3 行折叠高度）——决定展开/收起按钮是否显示
  const sourceRef = useRef<HTMLDivElement | null>(null);
  // 选中发生时来源应用的进程路径（captured 事件带上），供摘录模板 {source} 使用
  const sourceAppRef = useRef("");
  const [sourceOverflow, setSourceOverflow] = useState(false);
  // 上次下发的窗口位置目标（去重：尺寸与位置都没变就不重复调 resize）
  const lastPosKeyRef = useRef("");

  const loadSettings = () => {
    invoke<Settings>("get_settings")
      .then((s) => {
        setActions({ ...s.actions });
        setActionOrder(s.actionOrder ?? []);
        setCustomActions(s.customActions ?? []);
        liveRef.current = {
          registry: actionRegistry((s.customActions ?? []).filter((c) => c.enabled)),
          prompts: s.actionPrompts ?? {},
        };
        setCapsuleMax(Math.max(2, Math.min(8, s.capsuleShowCount ?? 4)));
        setEngines(s.searchEngines ?? []);
        setDefaultSearch(s.defaultSearch ?? "");
        setTranslateEnabled(s.translate?.enabled ?? ["ai"]);
        setTranslateDefault(s.translate?.default ?? "ai");
        setTranslateOrder(s.translate?.order ?? []);
        setTranslateCfg(s.translate ?? null);
        setProviders(s.providers ?? []);
        setDefaultProviderId(s.defaultProviderId ?? "");
        setObsidianCfg(s.obsidian ?? null);
      })
      .catch(() => undefined);
  };

  // 按用户自定义顺序渲染（未配置的按注册表顺序排在后面）。
  // 实体提取与胶囊分流：
  // 无实体 → 不出现；恰好 1 个实体 → 对应动作一键直达；
  // ≥2 个实体（同类型多个或混合类型）→ 单一「提取信息」按钮，点击进分组面板。
  // 动态上下文按钮置顶、不占常驻名额（见 barEntries / ctxEntry 处注释）。
  // 各类动作均可在主界面动作卡片关闭（关闭的类型不提取、不计数）。
  // 日期/地点是异步识别（Rust 命令：NSDataDetector 日期 + NLTagger 地名 NER，µs 级）：
  // text 到达后胶囊先出，命中随即补进分组——晚几十毫秒的渐进出现，换来热路径零负担
  const [dateHits, setDateHits] = useState<DateHit[]>([]);
  const [placeHits, setPlaceHits] = useState<string[]>([]);
  useEffect(() => {
    if (IS_OCR || IS_PIN) return; // OCR 窗口的实体在提取面板 effect 里拉
    if (!text.trim()) {
      setDateHits([]);
      setPlaceHits([]);
      return;
    }
    let cancelled = false;
    Promise.all([
      invoke<DateHit[]>("detect_dates", { text }).catch(() => []),
      invoke<string[]>("detect_places", { text }).catch(() => []),
    ]).then(([dates, places]) => {
      if (cancelled) return;
      setDateHits(dates ?? []);
      setPlaceHits(places ?? []);
    });
    return () => {
      cancelled = true;
    };
  }, [text]);

  // OCR 窗口：提取面板的日期/地点组异步补齐（划词导流的多实体面板在此渲染）。
  // 只在两组都为空时拉取——合并后 effect 重入会提前返回，不会循环
  useEffect(() => {
    if (!IS_OCR || phase.kind !== "extract" || !phase.text) return;
    if (phase.groups.date.length > 0 || phase.groups.addr.length > 0) return;
    const t = phase.text;
    Promise.all([
      invoke<DateHit[]>("detect_dates", { text: t }).catch(() => []),
      invoke<string[]>("detect_places", { text: t }).catch(() => []),
    ]).then(([dates, places]) => {
      if (!dates?.length && !places?.length) return;
      setPhase((p) =>
        p.kind === "extract" && p.text === t
          ? {
              ...p,
              groups: {
                ...p.groups,
                date: (dates ?? []).map(formatDateLabel),
                addr: places ?? [],
              },
            }
          : p,
      );
    });
  }, [phase]);

  const extracted = useMemo(() => {
    const all = extractAll(text);
    const groups: ExtractGroups = {
      tel: actions.tel !== false ? all.tels : [],
      email: actions.email !== false ? all.emails : [],
      link: actions.link !== false ? all.urls : [],
      code: actions.code !== false ? all.codes : [],
      date: actions.date !== false ? dateHits.map(formatDateLabel) : [],
      addr: actions.addr !== false ? placeHits : [],
    };
    const total =
      groups.tel.length +
      groups.email.length +
      groups.link.length +
      groups.code.length +
      groups.date.length +
      groups.addr.length;
    return { groups, total };
  }, [text, actions, dateHits, placeHits]);

  // 消费端注册表 = 内置动作 + 已启用的自定义动作。
  // 停用与否在这里一次性筛掉，下游（胶囊条 / 结果窗动作条 / runAction）不再判开关
  const registry = useMemo(
    () => actionRegistry(customActions.filter((c) => c.enabled)),
    [customActions],
  );
  const byId = (id: string) => registry.find((a) => a.id === id);

  const searchIdx = actionOrder.indexOf("search");
  const orderKey = (id: string) => {
    const i = actionOrder.indexOf(id);
    return i >= 0 ? i : id === "__ctx" ? searchIdx : 999;
  };

  // 结果窗动作行清单：与胶囊同一套闸（开关 + 配置可用性：服务列表/默认模型/vault）
  // + 同一排序规则（settings.actionOrder 混排序）——行序与设置页/胶囊条一致
  const rowActions = registry
    .filter((a) => {
      if (actions[a.id] === false) return false;
      if (a.id === "obsidian") return Boolean(obsidianCfg?.vaultPath);
      if (a.id === "translate") return enabledTranslates.length > 0;
      if (a.id === "search") return enabledEngines.length > 0;
      return a.kind === "ai" && hasUsableModel;
    })
    .sort((a, b) => orderKey(a.id) - orderKey(b.id));

  type BarEntry = { id: string; label: string; icon?: string; hasMenu?: boolean; onClick: () => void };

  // 常驻动作列表：上下文动作不在其中——它们由本次选中的内容触发，是动态附加层，
  // 置顶显示、不占「胶囊显示数量」名额、不替换（含隐藏）任何常驻动作
  const barEntries = (() => {
    const entries: BarEntry[] = [];
    for (const a of registry) {
      if (isContextAction(a.id)) continue;
      if (actions[a.id] === false) continue;
      // 动作开关之外的配置闸（与开关共同决定显示，用不了的动作不占位）：
      // 翻译看启用服务列表、搜索看启用引擎列表、其余 AI 动作看默认模型可用性
      if (a.id === "translate" && enabledTranslates.length === 0) continue;
      if (a.id === "search" && enabledEngines.length === 0) continue;
      if (a.kind === "ai" && a.id !== "translate" && !hasUsableModel) continue;
      // 「存入 Obsidian」只在已配置 vault 时出现（与结果窗动作行、设置页口径一致）
      if (a.id === "obsidian" && !obsidianCfg?.vaultPath) continue;
      entries.push({
        id: a.id,
        label: a.label,
        icon: a.icon,
        // 存入 Obsidian 的 ⌄ 目标菜单（笔记/任务/卡片），vault 未配置时不出现
        hasMenu: a.id === "obsidian",
        onClick: () => {
          setMenu(null);
          runAction(a.id);
        },
      });
    }
    entries.sort((a, b) => orderKey(a.id) - orderKey(b.id));
    return entries;
  })();

  // 守卫镜像：每次渲染刷新（captured 监听的闭包由此读取最新值）
  barLiveRef.current = barEntries.length > 0;
  actionsRef.current = actions;

  // 动态上下文按钮：检测到实体才出现，渲染在胶囊最前（对本条选中内容而言，
  // 它比常驻动作更相关）；与常驻动作互不挤占——8 个常驻 + 1 个上下文 = 9 个可见
  const ctxEntry: BarEntry | null = (() => {
    if (extracted.total === 1) {
      const g = extracted.groups;
      const single =
        g.link.length === 1
          ? { id: "link", label: "打开链接" }
          : g.email.length === 1
            ? { id: "email", label: "写邮件" }
            : g.date.length === 1
              ? { id: "date", label: "加入日历" }
              : g.addr.length === 1
                ? { id: "addr", label: "打开地图" }
                : g.tel.length === 1
                  ? { id: "tel", label: "复制号码" }
                  : { id: "code", label: "复制验证码" };
      return {
        id: single.id,
        label: single.label,
        onClick: () => {
          setMenu(null);
          runAction(single.id);
        },
      };
    }
    if (extracted.total > 1) {
      return {
        id: "__extract",
        label: "提取信息",
        onClick: () => {
          setMenu(null);
          // 导流到独立结果窗口（__extract = 结果窗口自行从文本计算分组）
          invoke("push_selection_result", {
            text: text,
            actionId: "__extract",
            service: null,
          }).catch(() => undefined);
          invoke("hide_floating_bar").catch(() => undefined);
          setPhase({ kind: "bar" });
        },
      };
    }
    return null;
  })();

  // 胶囊固定显示前 4 个动作（顺序 = 设置页 actionOrder），其余收进最右 ⌄N；
  // 不足 5 个时无收纳入口，胶囊自然收窄
  const CAPSULE_MAX = Math.max(2, Math.min(8, capsuleMax));
  const topEntries = barEntries.slice(0, CAPSULE_MAX);
  const restEntries = barEntries.slice(CAPSULE_MAX);

  // OCR 子菜单渲染值：活动菜单优先；纯收起的退场窗口（menu=null）用 fading
  // 续挂旧内容淡出（.m-out + .mflow.still）。切换（menu 已是新值）不续挂
  // 旧内容——新旧同容器叠放会打架，新菜单的入场动画即是切换过渡
  const slotVal: MenuState | null =
    menu === "translate" || menu === "search" || menu === "obsidian"
      ? menu
      : menu === null &&
          (fading === "translate" || fading === "search" || fading === "obsidian")
        ? fading
        : null;
  const slotGhost = menu === null && slotVal !== null;
  const railLive = menu === "overflow" || !!menu?.startsWith("pmenu:");
  const railGhost =
    !railLive && (fading === "overflow" || !!fading?.startsWith("pmenu:"));
  const pmenuVal =
    menu !== null && menu.startsWith("pmenu:")
      ? menu
      : fading !== null && fading.startsWith("pmenu:")
        ? fading
        : null;
  const pmenuGhost = !(menu !== null && menu.startsWith("pmenu:")) && pmenuVal !== null;

  useEffect(() => {
    loadSettings();
    invoke("ui_debug_log", { msg: "floating webview 就绪" }).catch(() => undefined);
    // 用户强制外观（亮/暗）：html 挂 theme class 切 CSS 变量；
    // 广播早于挂载会漏听，启动时主动读一次设置
    const applyTheme = (t: string) => {
      document.documentElement.classList.toggle("theme-light", t === "light");
      document.documentElement.classList.toggle("theme-dark", t === "dark");
    };
    invoke<{ appearance?: string }>("get_settings")
      .then((s) => applyTheme(s.appearance ?? "auto"))
      .catch(() => undefined);
    listen<string>("theme://appearance", (e) => applyTheme(e.payload)).catch(() => undefined);
    // OCR 独立窗口：取走 Rust 侧存好的识别文本（推送可能早于 webview 挂载）
    if (IS_OCR) {
      invoke<PendingView | null>("ocr_take_pending")
        .then((p) => {
          if (!p) return;
          // 新结果：重置测量/显示状态，确保面板必然重新显示
          ocrReadyRef.current = false;
          setOcrPinnedState(p.pinned);
          setMenu(null); // 新结果回收展开中的二级菜单（防陈旧菜单泄漏进新面板）
          setUsedTranslate(null); // 选中态回落到默认服务
          setUsedEngine(null);
          setHoverSuppress(true);
          setPhase({
            kind: "ocr",
            text: p.text,
            fromOcr: p.fromOcr,
            actionId: p.run?.id ?? null,
            output: "",
            streaming: false,
            error: null,
            expanded: false,
          });
          if (p.run?.id === "__extract") {
            // 提取信息：结果窗口本地从文本计算分组（日期组异步补齐，见 extract effect）
            const all = extractAll(p.text);
            const groups: ExtractGroups = {
              tel: all.tels,
              email: all.emails,
              link: all.urls,
              code: all.codes,
              date: [],
              addr: [],
            };
            setPhase({
              kind: "extract",
              actionId: dominantGroup(groups),
              label: "提取结果",
              groups,
              text: p.text,
            });
          } else {
            setPhase({
              kind: "ocr",
              text: p.text,
              fromOcr: p.fromOcr,
              actionId: p.run?.id ?? null,
              output: "",
              streaming: false,
              error: null,
              expanded: false,
            });
            if (p.run) runAction(p.run.id, p.run.service ?? undefined, p.text);
          }
        })
        .catch(() => undefined);
    }

    // hover/active 粘连修复：鼠标离开窗口时 webview 收不到 mouseout，
    // 短暂挂起 pointer-events 强制浏览器丢弃悬停/按压态；重新弹出时也复位一次。
    const root = document.documentElement;
    const suspendPointer = () => {
      root.style.pointerEvents = "none";
    };
    const restorePointer = () => {
      root.style.pointerEvents = "";
    };
    const resetGhostStates = () => {
      suspendPointer();
      requestAnimationFrame(() => requestAnimationFrame(restorePointer));
      setHoverSuppress(true);
    };

    const unlisteners: Array<() => void> = [];
    // StrictMode（dev 双挂载）/ 快速重挂防护：cleanup 先于 listen().then 执行时，
    // 旧监听的 unlisten 永远进不了 unlisteners → 泄漏，事件回调从此跑两遍
    // （症状：captured 日志双份、show_floating_bar 双 invoke）。下方各 listen 的
    // then 里检查 cancelled：已清理则立即自行解绑。
    let listenCancelled = false;

    listen<{ text: string; x: number; y: number; app?: string }>("selection://captured", (e) => {
      // 钉图窗口与划词流无关：忽略广播（防止误触发浮动条弹出/窗口移动）
      if (IS_PIN) return;
      // app=ocr 是 OCR/结果流的内部合成事件（len=0、坐标 -1），由下方 OCR 分支消费；
      // 结果窗（IS_OCR）靠这些事件显示结果面板——两者都只是不记日志，流程照常
      if (e.payload.app !== "ocr" && !IS_OCR) {
        invoke("ui_debug_log", {
          msg: `收到 captured 事件：len=${e.payload.text.length} (${e.payload.x.toFixed(0)},${e.payload.y.toFixed(0)}) app=${e.payload.app ?? "-"}`,
        }).catch(() => undefined);
      }
      capturedAtRef.current = performance.now();
      resetGhostStates();
      // 清除上一个操作可能残留的焦点态（避免新胶囊里按钮呈现选中样式）
      (document.activeElement as HTMLElement | null)?.blur?.();
      // 新选区使进行中的流失效（否则 streamingRef 卡住，dismiss 会被误拦）
      runIdRef.current++;
      streamingRef.current = false;
      setMenu(null);
      // 驻留计时一并作废：残留的 since 会让新胶囊的同一动作「一碰就开」
      dwellRef.current = null;
      hoverLeftAtRef.current = null;
      // OCR 来源事件：仅 OCR 独立窗口消费（浮动条抢走 pending 会与之竞争）
      if (e.payload.app === "ocr") {
        if (!IS_OCR) return;
        invoke<PendingView | null>("ocr_take_pending")
          .then((p) => {
            if (!p) return;
            // 新结果：重置测量/显示状态——若尺寸与上次相同也必须重新显示窗口
            ocrReadyRef.current = false;
            setOcrPinnedState(p.pinned);
            setMenu(null); // 新结果回收展开中的二级菜单（防陈旧菜单泄漏进新面板）
            setUsedTranslate(null); // 选中态回落到默认服务
            setUsedEngine(null);
              setHoverSuppress(true);
            setPhase({
              kind: "ocr",
              text: p.text,
              fromOcr: p.fromOcr,
              actionId: p.run?.id ?? null,
              output: "",
              streaming: false,
              error: null,
              expanded: false,
            });
            if (p.run?.id === "__extract") {
              const all = extractAll(p.text);
              const groups: ExtractGroups = {
                tel: all.tels,
                email: all.emails,
                link: all.urls,
                code: all.codes,
                date: [],
                addr: [],
              };
              setPhase({
                kind: "extract",
                actionId: dominantGroup(groups),
                label: "提取结果",
                groups,
                text: p.text,
              });
            } else {
              setPhase({
                kind: "ocr",
                text: p.text,
                fromOcr: p.fromOcr,
                actionId: p.run?.id ?? null,
                output: "",
                streaming: false,
                error: null,
                expanded: false,
              });
              if (p.run) runAction(p.run.id, p.run.service ?? undefined, p.text);
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
      const acts = actionsRef.current;
      const syncCtx =
        (acts.link !== false && all.urls.length > 0) ||
        (acts.email !== false && all.emails.length > 0) ||
        (acts.code !== false && all.codes.length > 0) ||
        (acts.tel !== false && all.tels.length > 0);
      if (!barLiveRef.current && !syncCtx && acts.date === false && acts.addr === false) {
        invoke("hide_floating_bar").catch(() => undefined);
        return;
      }
      // 普通划词：浮动条在鼠标位置弹出（x/y 来自选区）
      // 新划词 = 新胶囊：清掉上一轮残留的合成 hover 类（否则旧高亮在挂起解除后显形，
      // 表现为"没碰到任何动作却有个动作是 hover 态"）
      synHoverRef.current?.classList.remove("syn-hover");
      synHoverRef.current = null;
      sourceAppRef.current = e.payload.app ?? "";
      setPending({ x: e.payload.x, y: e.payload.y });
      // 屏幕矩形：二级浮层贴边翻转的判定基准（跨屏拖动后由拖拽结束回读刷新）
      invoke<ScreenRect>("screen_rect_at", { x: e.payload.x, y: e.payload.y })
        .then((r) => (screenRef.current = r))
        .catch(() => undefined);
      setText(e.payload.text);
      setPhase({ kind: "bar" });
    }).then((un) => {
      if (listenCancelled) un();
      else unlisteners.push(un);
    });

    listen("selection://dismiss", () => {
      // 钉图窗口不受划词 dismiss 影响
      if (IS_PIN) return;
      // OCR 窗口钉住：忽略 dismiss（Rust 侧同样不会隐藏窗口）
      if (IS_OCR && ocrPinnedRef.current) {
        invoke("ui_debug_log", { msg: "忽略 dismiss：OCR 已钉住" }).catch(() => undefined);
        return;
      }
      // 任务流式进行中不打断；其余点击空白即隐藏
      if (streamingRef.current) {
        invoke("ui_debug_log", { msg: "忽略 dismiss：任务进行中" }).catch(() => undefined);
        return;
      }
      invoke("hide_floating_bar").catch(() => undefined);
      // Windows 分离卡：弹层窗口已随 hide_pops 隐藏，菜单状态同步复位，
      // 否则胶囊下次弹出时「更多」钮残留点亮态
      if (POPS_EXTERNAL) setMenu(null);
      if (IS_OCR) invoke("hide_ocr_window").catch(() => undefined);
    }).then((un) => unlisteners.push(un));

    listen("settings://changed", () => loadSettings()).then((un) => {
      if (listenCancelled) un();
      else unlisteners.push(un);
    });

    // Windows 分离卡：弹层窗口的点击回传（动作执行统一在胶囊窗口）。
    // 事件经 emit_to 定向到本窗口，监听必须用窗口作用域——全局 listen()
    // 注册在 Any 上，连别的窗口的定向事件也会收到
    if (POPS_EXTERNAL) {
      getCurrentWebviewWindow()
        .listen<{ kind: string; key: string; rowY: number | null }>("floating://pick", (e) =>
          pickRef.current(e.payload),
        )
        .then((un) => {
          if (listenCancelled) un();
          else unlisteners.push(un);
        });
    }

    // 主窗口的动作开关/顺序/搜索引擎实时推送（无需保存即时生效）
    listen<{
      actions: Record<string, boolean>;
      actionOrder: string[];
      capsuleShowCount?: number;
      searchEngines?: SearchEngine[];
      defaultSearch?: string;
      translateEnabled?: string[];
      translateDefault?: string;
      translateOrder?: string[];
    }>("settings://live", (e) => {
      setActions({ ...e.payload.actions });
      setActionOrder(e.payload.actionOrder ?? []);
      if (e.payload.capsuleShowCount)
        setCapsuleMax(Math.max(2, Math.min(8, e.payload.capsuleShowCount)));
      if (e.payload.searchEngines) setEngines(e.payload.searchEngines);
      if (e.payload.defaultSearch) setDefaultSearch(e.payload.defaultSearch);
      if (e.payload.translateEnabled) setTranslateEnabled(e.payload.translateEnabled);
      if (e.payload.translateDefault) setTranslateDefault(e.payload.translateDefault);
      if (e.payload.translateOrder) setTranslateOrder(e.payload.translateOrder);
    }).then((un) => {
      if (listenCancelled) un();
      else unlisteners.push(un);
    });

    // 合成 hover：Rust 侧 CGEventTap 把全局鼠标位置按光标落点路由到本窗口，
    // 并已换算成本窗口视口坐标（~60Hz 节流），elementFromPoint 找到光标下的
    // 动作手动加 hover 类——非 key 窗口收不到 mouseMoved、WebKit 只给活动
    // 页面渲染 :hover，两者都绕开
    listen<{ x: number; y: number }>("hover://move", (e) => {
      const cx = e.payload.x;
      const cy = e.payload.y;
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
        } else if (dwellRef.current?.trig !== trig) {
          dwellRef.current = { trig, since: now };
        } else if (now - dwellRef.current.since >= HOVER_OPEN_MS) {
          dwellRef.current = null;
          switchMenu(trig);
        }
      }
      const btn =
        el?.closest<HTMLElement>(".action") ??
        // 光标落在 ⌄ 上时点亮同项主按钮：⌄ 太小，单独反馈没有「这一项悬停」感
        (el?.closest<HTMLElement>(".chev")?.closest<HTMLElement>(".action-slot") ??
          el?.closest<HTMLElement>(".pchev")?.closest<HTMLElement>(".pitem")
        )?.querySelector<HTMLElement>(".action") ?? null;
      if (btn !== synHoverRef.current) {
        // 诊断：仅在 hover 目标变化（进入/离开动作）时记录——稳态移动 60Hz
        // 逐事件记录会每秒刷数十行，淹没真正有用的日志
        invoke("ui_debug_log", {
          msg: `SYN ${btn ? `进入 ${(btn.textContent ?? "?").slice(0, 6)}` : "离开动作"}`,
        }).catch(() => undefined);
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

    document.addEventListener("mouseleave", suspendPointer);
    document.addEventListener("mouseenter", restorePointer);
    // 收起判定的离开/回归边沿：离开窗口记时刻（心跳到点收起浮层，清驻留计时），
    // 回到窗口即撤销——与 suspendPointer 同用一对 document 级事件
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
      document.removeEventListener("mouseleave", suspendPointer);
      document.removeEventListener("mouseenter", restorePointer);
      document.removeEventListener("mouseleave", markHoverLeft);
      document.removeEventListener("mouseenter", markHoverInside);
    };
  }, []);

  // （OCR 窗口的定位+显示已改由尺寸测量 effect 在 resize 完成后链式触发，见下）

  // 识别原文是否超过折叠高度：决定展开/收起按钮显示与否。
  // 基准是折叠高度常量（75px，3 行 13px×1.8 + 上下 padding，与 CSS 的折叠基数一致）而非 clientHeight——
  // flex-basis 有 240ms 过渡，展开→收起瞬间测 clientHeight 仍是动画中间值，
  // 会把「有溢出」误判成「无溢出」导致切换按钮消失
  useLayoutEffect(() => {
    if (phase.kind !== "ocr") return;
    const el = sourceRef.current;
    if (!el) return;
    setSourceOverflow(el.scrollHeight > 75 + 1);
  }, [phase]);

  // 结果窗口尺寸模型（产品规范，与 floating.rs::apply_result_window_size 同一条规则）：
  // 宽高只有两个变化来源——用户拖动（记住尺寸）/ 外观配置预设；切换动作、
  // 流式输出、菜单开合均不改窗口大小位置；长结果在固定窗口内滚动。
  // 唯一例外是二级菜单展开——窗口向下生长「菜单高度」，收起即收回。
  // 窗口就绪链路：pending 消费后触发 ocr_window_ready（Rust 侧先落用户尺寸再定位显示）
  useEffect(() => {
    if (!IS_OCR) return;
    if (phase.kind !== "ocr" && phase.kind !== "extract") return;
    if (ocrReadyRef.current) return;
    ocrReadyRef.current = true;
    invoke("ocr_window_ready").catch(() => undefined);
  }, [phase]);

  // 溢出收纳计算（§B.5.1）：在隐形测算行上逐项量宽，一次求出「恰好放得下」
  // 的可见数——确定性求解，幂等无循环。此前的 ±1 迭代在临界宽度遇上宽胶囊
  // （放回后仍溢出 → 收纳 → 再放回）会互振，触发 React 嵌套更新上限
  // （Maximum update depth exceeded）。注意不能用 scrollWidth 判富余——
  // 内容放得下时恒等于 clientWidth，必须逐项量宽
  useLayoutEffect(() => {
    const row = actionsRowRef.current;
    const measure = measureRowRef.current;
    if (!row || !measure) return;
    const rowW = row.clientWidth;
    if (rowW <= 0) return;
    const widths = Array.from(measure.children).map(
      (c) => (c as HTMLElement).getBoundingClientRect().width,
    );
    const n = rowActions.length;
    const moreW = widths[n] ?? 0; // 测算行末位 = 「更多」钮占位（宽度常数）
    let acc = 0;
    let fit = 0;
    for (let i = 0; i < n; i++) {
      const extra = i < n - 1 ? moreW : 0; // 非末项需要给「更多」钮留位
      if (acc + widths[i] + extra <= rowW - 2) {
        acc += widths[i];
        fit = i + 1;
      } else break;
    }
    const target = n - fit;
    if (target !== ocrOverflow) setOcrOverflow(target);
  });
  // 溢出重测的触发源：RO 必须观察「当前」行节点——phase 重挂载会换新节点，
  // 挂载期一次性 observe 会在第一次收起/重开后观察已卸载的旧节点，此后窗口
  // 缩放永远不再触发重测（症状：拖小窗口动作被截断，划一下鼠标才收进「更多」），
  // 故用 ref 回调随节点重挂观察器；窗口 resize 监听再兜一层
  const actionsRowRoRef = useRef<ResizeObserver | null>(null);
  const measureRowRef = useRef<HTMLDivElement | null>(null);
  const attachActionsRow = useCallback((node: HTMLDivElement | null) => {
    actionsRowRef.current = node;
    actionsRowRoRef.current?.disconnect();
    actionsRowRoRef.current = null;
    if (node) {
      const ro = new ResizeObserver(() => setOcrTick((t) => t + 1));
      ro.observe(node);
      actionsRowRoRef.current = ro;
    }
  }, []);

  useEffect(() => {
    const onResize = () => setOcrTick((t) => t + 1);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // 行侧横向 chips 定位（§B.5.3）：右缘距触发胶囊左缘 6px、与胶囊垂直居中；
  // 限宽 = 胶囊左缘 − 面板左缘 − 14px（左呼吸 8 + 缝 6），超限换行、行右对齐；
  // 不压动作行（限位 = 面板高 − 行高 31.5 − 呼吸）、不顶出面板上缘。
  // 胶囊堆是底部锚定——面板高度一变，胶囊相对面板顶部就会移位，chips 必须跟着
  // 重摆，故除状态依赖外还挂面板 RO + 窗口 resize（抽成函数供多处触发）
  const placeRailChips = () => {
    if (!IS_OCR || !menu?.startsWith("pmenu:") || ocrOverflow <= 0) return;
    const panel = ocrPanelRef.current;
    const chips = railChipsRef.current;
    if (!panel || !chips) return;
    const pill = panel.querySelector<HTMLElement>(`.rail [data-pill="${menu.slice(6)}"]`);
    if (!pill) return;
    const pn = panel.getBoundingClientRect();
    const pr = pill.getBoundingClientRect();
    chips.style.maxWidth = Math.max(120, pr.left - pn.left - 14) + "px";
    const ch = chips.offsetHeight;
    chips.style.right = pn.right - pr.left + 6 + "px";
    let top = pr.top - pn.top + pr.height / 2 - ch / 2;
    const maxBottom = pn.height - 44;
    if (top + ch > maxBottom) top = maxBottom - ch;
    if (top < 8) top = 8;
    chips.style.top = top + "px";
    chips.style.left = "";
    chips.style.bottom = "";
  };

  // ⌄ 槽位子菜单摆位（§B.5.3 同规则）：左缘对齐触发槽位（越界右缘钳回内容区）、
  // 底边距动作行上缘 8px；限宽换行向上生长，限高内滚兜底
  const placeMenuSlotChips = () => {
    if (!IS_OCR) return;
    if (menu !== "translate" && menu !== "search" && menu !== "obsidian") return;
    const panel = ocrPanelRef.current;
    const slot = panel?.querySelector<HTMLElement>(".ocr-menu-slot") ?? null;
    const trigSlot =
      panel
        ?.querySelector(`.ocr-actions [data-trig="${menu}"]`)
        ?.closest<HTMLElement>(".action-slot") ?? null;
    const row = actionsRowRef.current;
    if (!panel || !slot || !trigSlot || !row) return;
    const pn = panel.getBoundingClientRect();
    const tr = trigSlot.getBoundingClientRect();
    const rr = row.getBoundingClientRect();
    slot.style.maxWidth = Math.max(160, pn.width - 26) + "px";
    slot.style.maxHeight = Math.max(120, rr.top - pn.top - 16) + "px";
    const cw = slot.offsetWidth;
    const ch = slot.offsetHeight;
    let left = tr.left - pn.left;
    left = Math.min(Math.max(13, left), Math.max(13, pn.width - 13 - cw));
    slot.style.left = left + "px";
    slot.style.top = Math.max(8, rr.top - pn.top - 8 - ch) + "px";
    slot.style.right = "";
    slot.style.bottom = "";
  };

  useLayoutEffect(() => {
    if (!IS_OCR || menu === null) return;
    if (menu.startsWith("pmenu:")) subLeftAtRef.current = null; // 子菜单重新展开：划出计时作废
    placeRailChips();
    placeMenuSlotChips();
    const placeAll = () => {
      placeRailChips();
      placeMenuSlotChips();
    };
    const panel = ocrPanelRef.current;
    const ro = panel ? new ResizeObserver(placeAll) : null;
    if (panel && ro) ro.observe(panel);
    window.addEventListener("resize", placeAll);
    // 胶囊堆入场动画收尾时复核摆位：入场位移进行中量触发胶囊会带上 ≤3px
    // 偏移，而 hover「已开即切」能在 150ms 内就开出 pmenu，不能赌用户手速
    const rail = panel?.querySelector<HTMLElement>(".pop.overflow.rail") ?? null;
    rail?.addEventListener("animationend", placeAll);
    return () => {
      rail?.removeEventListener("animationend", placeAll);
      ro?.disconnect();
      window.removeEventListener("resize", placeAll);
    };
  }, [menu, phase, ocrOverflow, ocrStick]);

  // 分离卡布局：窗口 = 胶囊与已展开二级卡片的并集 + 四周 FLOAT_PAD 透明留白。
  // 二级卡片锚在触发点左缘/左下向右生长，贴屏幕右缘翻转为右对齐触发点；
  // 翻转时窗口向左扩展，bar 的 margin-left 随之补偿——胶囊像素不动。
  // 落位以 show/resize 返回的实际窗口位置为准（Rust 钳制可能改写目标值）。
  // 依赖含实体识别结果（dateHits/placeHits）：上下文按钮是「胶囊先出、命中补进」
  // 的渐进出现，会改变胶囊宽度——不重测窗口的话新按钮会被顶出窗口右边界（缺一半）
  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar) return;

    // 先重置为「胶囊单独在窗口 (FLOAT_PAD,FLOAT_PAD)」量自然尺寸
    bar.style.marginLeft = `${FLOAT_PAD}px`;
    bar.style.width = "max-content";
    bar.style.flex = "0 0 auto";
    bar.style.height = "auto";
    const barRect = bar.getBoundingClientRect();
    const barW = Math.ceil(barRect.width);
    const barH = Math.ceil(barRect.height);

    type Card = { el: HTMLElement; x: number; y: number; w: number; h: number };
    const cards: Card[] = [];
    const measure = (el: HTMLElement) => {
      el.style.width = "max-content";
      const r = el.getBoundingClientRect();
      return { w: Math.ceil(r.width), h: Math.ceil(r.height) };
    };

    // bar 当前屏幕坐标 = 上次窗口落位 + 上次 bar 窗口内偏移；
    // 屏幕矩形缺失（尚未回读/拖拽跨屏未刷新）时不翻转，退化向右/向下生长
    const barScreen = winPosRef.current
      ? {
          x: winPosRef.current.x + barInWinRef.current.x,
          y: winPosRef.current.y + barInWinRef.current.y,
        }
      : null;
    const scr = screenRef.current;
    const anchored = (trigL: number, trigR: number, w: number) => {
      let x = trigL;
      if (barScreen && scr && barScreen.x + x + w > scr.right - 8) {
        x = trigR - w; // 贴右缘：翻转为右对齐触发点，向左生长
      }
      return x;
    };

    const panelOpen = menu === "overflow" || !!menu?.startsWith("pmenu:");
    const panel = panelOpen ? overflowRef.current : null;
    const drop = menu && menu !== "overflow" ? menuPopRef.current : null;

    if (panel) {
      const { w, h } = measure(panel);
      const trig = document.querySelector<HTMLElement>('[data-trig="overflow"]');
      const tl = trig ? trig.getBoundingClientRect().left - barRect.left : 0;
      const trR = trig ? trig.getBoundingClientRect().right - barRect.left : barW;
      cards.push({ el: panel, x: anchored(tl, trR, w), y: barH + CARD_GAP, w, h });
    }
    if (drop && menu) {
      const { w, h } = measure(drop);
      const trig = document.querySelector<HTMLElement>(`[data-trig="${menu}"]`);
      if (trig) {
        // 锚「整个动作项」而非 16px 的 ⌄ 按钮——否则菜单会偏右，不是「一级菜单正下方」
        const item =
          trig.closest<HTMLElement>(".action-slot") ?? trig.closest<HTMLElement>(".pitem") ?? trig;
        const tr = item.getBoundingClientRect();
        if (menu.startsWith("pmenu:") && panel) {
          // 行内二级 = 行侧弹出（NSMenu 心智）：默认从面板右缘向右弹，
          // 窗口右缘放不下则向左弹回面板左缘（面板贴右缘翻转后必走此支）。
          // 起算点必须用面板边缘而非行矩形——行两侧内缩着面板 padding，
          // 按行算会把 CARD_GAP 吃掉、二级与面板贴死甚至叠 1px。
          // 也不能级联在面板下方——竖排面板限高内滚（overflow-y），子卡若是
          // 面板的 DOM 子元素会被裁切，故提升到窗口层级、按行坐标横向定位
          const pr = panel.getBoundingClientRect();
          const base = cards[0];
          const panelL = base.x;
          const panelR = base.x + (pr.right - pr.left);
          const rowT = base.y + (tr.top - pr.top);
          const isChips = drop.classList.contains("hchips"); // 固定小集合（Obsidian 目标）用横排 chips
          const gap = isChips ? 6 : CARD_GAP;
          let x = panelR + gap;
          let mirrored = false;
          if (barScreen && scr && barScreen.x + x + w > scr.right - 8) {
            x = panelL - gap - w;
            mirrored = true;
          }
          // 方向示能（§B.2.4）：行侧触发符跟随实际弹出方向 ›/‹
          const trigBtn = document.querySelector<HTMLElement>(`[data-trig="${menu}"]`);
          if (trigBtn) trigBtn.dataset.flip = mirrored ? "1" : "0";
          // chips 与所在行垂直居中；竖排菜单保持行顶对齐
          cards.push({
            el: drop,
            x,
            y: isChips ? rowT + tr.height / 2 - h / 2 : rowT,
            w,
            h,
          });
        } else {
          cards.push({
            el: drop,
            x: anchored(tr.left - barRect.left, tr.right - barRect.left, w),
            y: barH + CARD_GAP,
            w,
            h,
          });
        }
      }
    }

    const minX = Math.min(0, ...cards.map((c) => c.x));
    const maxR = Math.max(barW, ...cards.map((c) => c.x + c.w));
    const maxB = Math.max(barH, ...cards.map((c) => c.y + c.h));
    const tw = Math.ceil(maxR - minX) + 2 * FLOAT_PAD;
    const th = Math.ceil(maxB) + 2 * FLOAT_PAD; // 卡片恒在胶囊下方（minY = 0）

    // 窗口内偏移：翻转（minX < 0）时胶囊右移补偿，屏幕坐标不变
    bar.style.marginLeft = `${FLOAT_PAD - minX}px`;
    for (const c of cards) {
      c.el.style.left = `${c.x - minX + FLOAT_PAD}px`;
      c.el.style.top = `${c.y + FLOAT_PAD}px`;
    }

    // 窗口目标位置：保持胶囊屏幕坐标不变；面板贴屏底放不下时整窗上移
    let wx: number | null = null;
    let wy: number | null = null;
    if (barScreen && scr) {
      wx = barScreen.x - (FLOAT_PAD - minX);
      wy = barScreen.y - FLOAT_PAD;
      if (wy + th > scr.bottom - 8) wy = scr.bottom - 8 - th;
      if (wy < scr.top + 8) wy = scr.top + 8;
    }

    const settle = (pos: WindowPos) => {
      winPosRef.current = pos;
      barInWinRef.current = { x: FLOAT_PAD - minX, y: FLOAT_PAD };
    };
    const sizeKey = `${tw}x${th}`;
    const posKey = wx == null || wy == null ? "anchor" : `${Math.round(wx)}:${Math.round(wy)}`;
    if (pending) {
      lastSizeRef.current = sizeKey;
      invoke<WindowPos>("show_floating_bar", { x: pending.x, y: pending.y, width: tw, height: th })
        .then((pos) => {
          if (capturedAtRef.current > 0) {
            invoke("ui_debug_log", {
              msg: `⏱ 前端段（事件→窗口已显示）：${(performance.now() - capturedAtRef.current).toFixed(0)}ms`,
            }).catch(() => undefined);
            capturedAtRef.current = 0;
          }
          settle(pos);
        })
        .catch(() => undefined)
        .finally(() => setPending(null));
    } else if (sizeKey !== lastSizeRef.current || posKey !== lastPosKeyRef.current) {
      lastSizeRef.current = sizeKey;
      lastPosKeyRef.current = posKey;
      invoke<WindowPos>("resize_floating", { width: tw, height: th, x: wx, y: wy })
        .then(settle)
        .catch(() => undefined);
    }
  }, [phase, pending, menu, flashId, dateHits, placeHits]);

  // 底边拖拽：仅调高度（单独的向下/向上拖动）
  const startResultResizeV = (e: ReactMouseEvent) => {
    if (!IS_OCR) return;
    e.preventDefault();
    e.stopPropagation();
    const sh = window.innerHeight;
    const sy = e.clientY;
    const onMove = (ev: MouseEvent) => {
      const h = Math.max(200, Math.min(800, sh + ev.clientY - sy));
      invoke("set_result_window_size", {
        width: window.innerWidth,
        height: h,
      }).catch(() => undefined);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      invoke("persist_result_window_state").catch(() => undefined);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const startResultResize = (e: ReactMouseEvent) => {
    if (!IS_OCR) return;
    e.preventDefault();
    e.stopPropagation();
    // 立即进入手动尺寸模式：stage 铺满窗口、内容随窗口重排
    //（若等下次 pending 同步才生效，拖拽期间表面不跟随，四角呈直角）
    const sw = window.innerWidth;
    const sh = window.innerHeight;
    const sx = e.clientX;
    const sy = e.clientY;
    const onMove = (ev: MouseEvent) => {
      const w = Math.max(320, Math.min(560, sw + ev.clientX - sx));
      const h = Math.max(200, Math.min(800, sh + ev.clientY - sy));
      invoke("set_result_window_size", { width: w, height: h }).catch(() => undefined);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      invoke("persist_result_window_state").catch(() => undefined);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // 关闭结果窗口：隐藏（划词/识图结果窗口共用），保留钉住偏好
  const closeResultWindow = () => {
    // 收起只关窗：钉住是用户的长期偏好（点钉按钮才改），不因收起被抹掉
    invoke("hide_ocr_window").catch(() => undefined);
    setPhase({ kind: "bar" });
  };

  // 结果窗口键盘闭环：Esc 关窗、⌘P 切换钉住、⌘W 关窗（Bob 同款）。
  // 窗口默认不抢焦点，点击面板任意处即聚焦，之后快捷键生效
  useEffect(() => {
    if (!IS_OCR) return;
    const onKey = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (e.key === "Escape") {
        closeResultWindow();
      } else if (meta && e.key.toLowerCase() === "p") {
        e.preventDefault();
        const next = !ocrPinnedRef.current;
        setOcrPinnedState(next);
        invoke("set_ocr_pinned", { pinned: next }).catch(() => undefined);
      } else if (meta && e.key.toLowerCase() === "w") {
        e.preventDefault();
        closeResultWindow();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ---- OCR 面板拖拽：面板任意空白处按住即可拖动（标题栏/动作行/留白区）。
  //      文本区（原文/结果）保留文字选择复制；按钮/开关/尺寸手柄不作为拖拽起点；
  //      位移 >5px 判定为拖并吞掉结束后的残余 click。move_ocr 落位时钳制在屏幕内 ----
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
  }, []);

  // 动作按钮的短暂文字反馈（已复制 / 已打开 / 不支持…）
  const flash = (id: string, msg: string) => {
    setFlashId(id);
    setFlashMsg(msg);
    if (flashTimerRef.current) window.clearTimeout(flashTimerRef.current);
    flashTimerRef.current = window.setTimeout(() => setFlashId(null), 1200);
  };

    const runAction = (
      id: string,
      serviceOverride?: string,
      sourceOverride?: string,
      targetOverride?: string,
    ) => {
    const action = liveRef.current.registry.find((a) => a.id === id);
    if (!action) return;
    // 动作文本源：显式指定（划词结果导流时由 pending 带入）> OCR 面板用识别文本 > 普通划词用选中文本
    const source = sourceOverride ?? (phase.kind === "ocr" ? phase.text : text);
    if (!source.trim()) return;


    // 本地动作：不经 AI，前端即时完成
    if (action.kind === "local") {
      const t = source.trim();

      if (id === "copy") {
        navigator.clipboard.writeText(t).catch(() => undefined);
        flash(id, "已复制");
        return;
      }

      if (id === "search") {
        if (!defaultEngine) {
          flash(id, "未配置引擎");
          return;
        }
        openEngine(defaultEngine, t);
        return;
      }

      if (id === "link") {
        const url = extractUrl(t);
        if (!url) return;
        invoke("open_url", { url })
          .then(() => flash(id, "已打开"))
          .catch(() => flash(id, "打开失败"));
        return;
      }

      if (id === "email") {
        const addr = extractEmail(t);
        if (!addr) return;
        invoke("open_url", { url: `mailto:${addr}` })
          .then(() => flash(id, "已打开邮件客户端"))
          .catch(() => flash(id, "打开失败"));
        return;
      }

      if (id === "tel") {
        const num = extractTel(t);
        if (!num) return;
        navigator.clipboard.writeText(num).catch(() => undefined);
        flash(id, `已复制 ${num}`);
        return;
      }

      if (id === "code") {
        const code = extractCode(t);
        if (!code) return;
        navigator.clipboard.writeText(code).catch(() => undefined);
        flash(id, `已复制 ${code}`);
        return;
      }

      if (id === "date") {
        const hit = dateHits[0];
        if (!hit) return;
        openInCalendar(hit, t, (ok) => flash(id, ok ? "已打开日历" : "打开失败"));
        return;
      }

      if (id === "addr") {
        const place = placeHits[0];
        if (!place) return;
        invoke("open_url", { url: `maps://?q=${encodeURIComponent(place)}` })
          .then(() => flash(id, "已在地图打开"))
          .catch(() => flash(id, "打开失败"));
        return;
      }

      if (id === "obsidian") {
        const cfg = obsidianCfg;
        // 反馈走全局 toast 而非按钮 flash：从收纳面板发起时面板先收起，
        // flash 挂在已卸载的按钮上等于无提示（全局 toast 窗口不受影响）
        if (!cfg?.vaultPath) {
          toast("未配置 Obsidian vault，请在设置页选择", "err");
          return;
        }
        const target = targetOverride ?? "note";
        const now = new Date();
        const p2 = (n: number) => String(n).padStart(2, "0");
        const date = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`;
        const time = `${p2(now.getHours())}:${p2(now.getMinutes())}`;
        const src = appNameFrom(sourceAppRef.current);
        // 日记文件名按用户配置的 Daily Notes 格式展开（yyyy/YYYY・MM・dd/DD），缺 .md 后缀补上
        const base = (cfg.dailyFileName || "yyyy-MM-DD")
          .replaceAll(/yyyy/gi, String(now.getFullYear()))
          .replaceAll("MM", p2(now.getMonth() + 1))
          .replaceAll(/dd/gi, p2(now.getDate()));
        const fname = base.endsWith(".md") ? base : `${base}.md`;
        const dailyRel = [cfg.dailyFolder.replace(/^\/+|\/+$/g, ""), fname]
          .filter(Boolean)
          .join("/");
        // 保存内容择优：结果窗里已有 AI 结果时存结果，否则存原文
        const body =
          phase.kind === "ocr" && phase.actionId && phase.output && !phase.error
            ? phase.output
            : source;

        // 存任务：写入任务目标文件（空 = 当日日记）。{due} 取选中文本里的日期实体
        //（detect_dates µs 级，用时重检——与「提取信息」面板同一模式，不跨窗口传状态）；
        // {dueTag} = "📅 日期" 或空，模板用它占位即可在无日期时整段省略
        if (target === "task") {
          const rel = cfg.taskFile.trim() ? cfg.taskFile.trim() : dailyRel;
          const oneLine = body.replace(/\s*\n\s*/g, " ").trim();
          invoke<DateHit[]>("detect_dates", { text: oneLine })
            .then((hits) => {
              const h = (hits ?? [])[0];
              const d = h ? new Date(h.unix * 1000) : null;
              const due = d
                ? `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
                : "";
              const dueTag = d ? `📅 ${due}` : "";
              const line = cfg.taskTemplate
                .replaceAll("{text}", oneLine)
                .replaceAll("{due}", due)
                .replaceAll("{dueTag}", dueTag);
              invoke("obsidian_append", { relPath: rel, content: line })
                .then(() => toast("已存入任务"))
                .catch(() => toast("存入 Obsidian 失败", "err"));
            })
            .catch(() => toast("存入 Obsidian 失败", "err"));
          return;
        }

        // 存卡片：一卡一文件写入知识卡目录，文件名 = 选中文本首行清理后截 20 字
        //（非法文件名字符剔除，超长截断，空选区回退时间戳命名）
        if (target === "card") {
          const first = body.split("\n").map((s) => s.trim()).find(Boolean) ?? "";
          const safe = first
            .replace(/[/\\:*?"<>|#^[\]]/g, " ")
            .replace(/\s+/g, " ")
            .trim();
          const title =
            Array.from(safe).slice(0, 20).join("") || `卡片 ${date} ${time.replace(":", "")}`;
          const rel = [cfg.cardFolder.replace(/^\/+|\/+$/g, ""), `${title}.md`]
            .filter(Boolean)
            .join("/");
          const content = cfg.cardTemplate
            .replaceAll("{date}", date)
            .replaceAll("{time}", time)
            .replaceAll("{source}", src)
            .replaceAll("{text}", body.split("\n").join("\n> "));
          invoke("obsidian_append", { relPath: rel, content: content })
            .then(() => toast(`已存入卡片：${title}`))
            .catch(() => toast("存入 Obsidian 失败", "err"));
          return;
        }

        // 存笔记（默认）：摘录块追加当日日记，多行文本逐行补引用前缀保持 markdown 形态
        const excerpt = cfg.excerptTemplate
          .replaceAll("{date}", date)
          .replaceAll("{time}", time)
          .replaceAll("{source}", src)
          .replaceAll("{text}", body.split("\n").join("\n> "));
        invoke("obsidian_append", { relPath: dailyRel, content: excerpt })
          .then(() => toast(`已存入 ${fname}`))
          .catch(() => toast("存入 Obsidian 失败", "err"));
        return;
      }
      return;
    }

    // 翻译服务路由：显式指定（chips）或默认服务；注册表命中的机器翻译服务直达，
    // "ai" 落空 → 走下方通用模型流式
    if (id === "translate") {
      const svc = serviceOverride ?? defaultTranslate?.id;
      if (!svc) {
        flash(id, "未启用翻译服务");
        return;
      }
      // 使用时兜底提醒（唯一一层校验）：启用了但没配密钥的服务，触发时
      // 告知用户去哪配置——文案与判据同 shared/translate.ts，不区分平台
      if (translateCfg) {
        const missing = translateMissingReason(translateCfg, providers, defaultProviderId, svc);
        if (missing) {
          toast(missing, "err");
          return;
        }
      }
      const entry = translateService(svc);
      if (entry && entry.auth !== "ai" && entry.rustCmd) {
        const trimmed = source.trim();
        const cacheKey = `${id}:${svc}:${trimmed}`;
        const cachedOut = cacheGet(cacheKey);
        if (cachedOut !== null && (phase.kind === "ocr" || sourceOverride !== undefined)) {
          // 缓存命中：跳过请求直接展示
          setPhase((p) =>
            p.kind === "ocr"
              ? { ...p, actionId: id, output: cachedOut, streaming: false, error: null, plain: true }
              : p,
          );
          return;
        }
        const runId = ++runIdRef.current;
        streamingRef.current = true;
        if (phase.kind === "ocr" || sourceOverride !== undefined) {
          // 函数式更新：紧随 pending 消费的 auto-run 不会读到旧 phase
          setPhase((p) =>
            p.kind === "ocr" ? { ...p, actionId: id, output: "", streaming: true, error: null } : p,
          );
        } else {
          // 划词导流：当场解析默认服务随 pending 传递
          //（结果窗口的设置可能尚未加载完，不能依赖它自行解析默认值）
          invoke("push_selection_result", {
            text: source,
            actionId: id,
            service: svc,
          }).catch(() => undefined);
          invoke("hide_floating_bar").catch(() => undefined);
          setPhase({ kind: "bar" });
          return;
        }
        // 中文→英文，其他→中文；各厂商语言码差异（EN/ZH/zh-CN…）由注册表映射
        const to = entry.langOf!(/[一-鿿]/.test(trimmed) ? "en" : "zh");
        invoke<string>(entry.rustCmd, { text: trimmed, to })
          .then((out) => {
            if (runIdRef.current !== runId) return;
            streamingRef.current = false;
            cachePut(cacheKey, out);
            setPhase((p) =>
              p.kind === "ocr" ? { ...p, output: out, streaming: false, plain: true } : p,
            );
          })
          .catch((e) => {
            if (runIdRef.current !== runId) return;
            streamingRef.current = false;
            setPhase((p) =>
              p.kind === "ocr"
                ? { ...p, streaming: false, error: String(e) }
                : p,
            );
          });
        return;
      }
    }

    const runId = ++runIdRef.current;
    if (action.kind !== "ai") return;
    const system = actionPrompt(action, liveRef.current.prompts);
    // 自定义动作新建后 prompt 还是空的：直接拒，别把空 system 发出去
    if (!system.trim()) {
      flash(id, "未填提示词");
      return;
    }
    // 生效提示词进缓存 key：改了 prompt 的同一选区不再命中旧结果
    const cacheKey = `${id}:${serviceOverride ?? ""}:${system}:${source}`;
    const cached = cacheGet(cacheKey);
    if (cached !== null && (phase.kind === "ocr" || sourceOverride !== undefined)) {
      // 缓存命中：跳过请求直接展示
      setPhase((p) =>
        p.kind === "ocr"
          ? { ...p, actionId: id, output: cached, streaming: false, error: null }
          : p,
      );
      return;
    }
    streamingRef.current = true;
    // 结果窗口（识图/划词导流共用）：结果直接渲染在面板内，动作可反复切换。
    // 函数式更新：紧随 pending 消费的 auto-run 不会读到旧 phase
    if (phase.kind === "ocr" || sourceOverride !== undefined) {
      setPhase((p) =>
        p.kind === "ocr" ? { ...p, actionId: id, output: "", streaming: true, error: null } : p,
      );
    } else {
      // 划词 AI 结果导流到独立结果窗口（默认钉住，胶囊下方弹出）。
      // 翻译动作把当场解析的服务一并传递（ai 或 baidu/deepl），保证与默认配置一致
      const pushedSvc =
        id === "translate" ? (serviceOverride ?? defaultTranslate?.id ?? null) : (serviceOverride ?? null);
      invoke("push_selection_result", {
        text: source,
        actionId: id,
        service: pushedSvc,
      }).catch(() => undefined);
      invoke("hide_floating_bar").catch(() => undefined);
      setPhase({ kind: "bar" });
      return;
    }

    // 流式渲染节流：chunk 累积进 full，60ms 合帧批量刷新（长文流式不再逐字重渲染）
    let full = "";
    let deltaTimer: number | undefined;
    const flushDelta = () => {
      if (deltaTimer) {
        window.clearTimeout(deltaTimer);
        deltaTimer = undefined;
      }
      if (runIdRef.current !== runId) return;
      setPhase((p) => (p.kind === "ocr" ? { ...p, output: full } : p));
    };

    aiChat([{ role: "system", content: system }, { role: "user", content: source }], null, {
      onDelta: (chunk) => {
        if (runIdRef.current !== runId) return;
        full += chunk;
        if (deltaTimer === undefined) {
          deltaTimer = window.setTimeout(flushDelta, 60);
        }
      },
      onDone: () => {
        if (runIdRef.current !== runId) return;
        if (deltaTimer) {
          window.clearTimeout(deltaTimer);
          deltaTimer = undefined;
        }
        streamingRef.current = false;
        setPhase((p) => (p.kind === "ocr" ? { ...p, output: full, streaming: false } : p));
        cachePut(cacheKey, full);
      },
      onError: (message) => {
        if (runIdRef.current !== runId) return;
        if (deltaTimer) {
          window.clearTimeout(deltaTimer);
          deltaTimer = undefined;
        }
        streamingRef.current = false;
        setPhase((p) =>
          p.kind === "ocr" ? { ...p, output: full, streaming: false, error: message } : p,
        );
      },
    });
  };

  // ---- Windows 分离卡（一卡一窗）：二级浮层的渲染数据与状态同步 ----
  // 弹层窗口（floating-panel / floating-menu）是哑渲染端：这里按当前状态组装
  // payload，经 set_floating_pops 推给 Rust（payload 变化即重发——实体渐进补进
  // 胶囊、设置实时推送改了收纳清单，弹层内容都须跟上）；弹层量尺寸回传
  // pop_ready 后由 Rust 定位显示。pmenu:* 的行侧锚点只有面板窗口知道，
  // 不经此 effect，由 floating://pick(menu-toggle) 直接下发（见 pickRef）
  const menuItemsFor = (kind: string) =>
    kind === "translate"
      ? enabledTranslates.map((s) => ({
          key: s.id,
          label: s.label,
          on: s.id === (usedTranslate ?? defaultTranslate?.id ?? null),
        }))
      : kind === "search"
        ? enabledEngines.map((en) => ({
            key: en.name,
            label: en.name,
            on: en.name === (usedEngine ?? defaultEngine?.name ?? null),
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
    (id === "obsidian" && Boolean(obsidianCfg?.vaultPath));
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
      return el ? Math.round(el.getBoundingClientRect().left) : null;
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
  }, [menu, panelSig, translateSig, enginesSig, usedTranslate, usedEngine, defaultTranslate?.id, defaultEngine?.name]);

  // 弹层窗口点击回传（floating://pick）：动作语义、选区上下文、服务选择与
  // 反馈全在本窗口执行（弹层是哑渲染端）。监听只注册一次，经 ref 读最新渲染
  const pickRef = useRef<(p: { kind: string; key: string; rowY: number | null }) => void>(
    () => undefined,
  );
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
  pickRef.current = (p) => {
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

  const backToBar = () => {
    runIdRef.current++;
    streamingRef.current = false;
    setPhase({ kind: "bar" });
  };

  // ---- 拖拽：整条任意位置可拖（含按钮上），按下后位移 > 5px 判定为拖，吞掉其 click ----
  const dragStartRef = useRef<{ sx: number; sy: number } | null>(null);
  const dragActiveRef = useRef(false);
  const suppressClickRef = useRef(false);

  const onStageMouseDown = (e: ReactMouseEvent) => {
    const t = e.target as HTMLElement;
    // 结果窗：点浮层与动作行之外收起展开中的浮层（与胶囊条同规则）；
    // 不参与浮动条拖拽（结果窗拖拽走 onOcrPanelDown 一条链）
    if (IS_OCR) {
      // .ocr-menu-slot 同样豁免：点子菜单 chip 是要执行动作的点击，mousedown
      // 若抢先收起，click 会落在退场态（pointer-events:none）容器上丢失——
      // 表现为「点了没反应」；chip 的 click 自己负责执行并收起（与 .pop 同理）
      if (
        menu !== null &&
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
    if (menu !== null && !t.closest(".bar") && !t.closest(".pop")) {
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

  const guarded = (fn: () => void) => () => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    // 点击终结驻留计时：点主按钮执行动作后光标仍停在动作项上，
    // 残留的计时会让二级浮层在动作执行后「自己弹开」
    dwellRef.current = null;
    fn();
  };

  // 动作行槽位渲染：真实行与溢出测算行共用同一构型（测算行 interactive=false，
  // 不挂交互、不参与 hover 定位，仅用于逐项量宽——宽度与真实槽位一致）
  const renderRowSlot = (a: (typeof rowActions)[number], interactive: boolean) => {
    const active = phase.kind === "ocr" ? phase.actionId : null;
    return (
      <span key={a.id} className="action-slot">
      <button
        type="button"
        className={`action sm ${active === a.id ? "active" : ""}`}
        onClick={
          interactive
            ? guarded(() => {
                setMenu(null); // 切换/执行动作即收起已展开的子菜单（选择器只属于当前动作）
                if (a.id === "translate") setUsedTranslate(null);
                if (a.id === "search") setUsedEngine(null);
                runAction(a.id);
              })
            : undefined
        }
      >
        <span className="ic">{iconOf(a.id, a.icon)}</span>
        <span>{a.label}</span>
      </button>
      {(a.id === "translate" || a.id === "search" || a.id === "obsidian") &&
        (a.id === "translate"
          ? enabledTranslates.length > 1
          : a.id === "obsidian"
            ? true
            : enabledEngines.length > 1) && (
        <button
          type="button"
          className="chev"
          data-trig={interactive ? a.id : undefined}
          aria-label={
            a.id === "translate"
              ? "更多翻译服务"
              : a.id === "obsidian"
                ? "存入目标"
                : "更多搜索引擎"
          }
          onClick={
            interactive
              ? guarded(() =>
                  switchMenu(
                    menu === a.id ? null : (a.id as "search" | "translate" | "obsidian"),
                  ),
                )
              : undefined
          }
        >
          <ChevronDown
            size={13}
            strokeWidth={2}
            className={`chev-svg ${interactive && menu === a.id ? "open" : ""}`}
          />
        </button>
      )}
      </span>
    );
  };

  return (
    <div
      className={`stage ${hoverSuppress ? "suppress-hover" : ""}`}
      onMouseDown={onStageMouseDown}
      onMouseMove={onStageMouseMove}
      onMouseUp={onStageMouseUp}
    >
      {/* 划词胶囊条：仅主浮动窗口渲染（OCR 独立窗口只显示识别面板） */}
      {!IS_OCR && (
      <div className="bar" role="toolbar" ref={barRef}>
        {/* 动态上下文按钮置顶：检测到实体才出现，附加层不占常驻名额 */}
        {ctxEntry && (
          <span className="action-slot">
            <button
              className="action"
              onClick={guarded(() => {
                setMenu(null);
                ctxEntry.onClick();
              })}
            >
              <span className="ic">{iconOf(ctxEntry.id)}</span>
              <span>{flashId === ctxEntry.id ? flashMsg : ctxEntry.label}</span>
            </button>
          </span>
        )}
        {topEntries.map((e) => (
          <span key={e.id} className="action-slot">
            <button
              className="action"
              onClick={guarded(() => {
                setMenu(null); // 执行动作即收起展开中的浮层
                e.onClick();
              })}
            >
              <span className="ic">{iconOf(e.id, e.icon)}</span>
              <span>{flashId === e.id ? flashMsg : e.label}</span>
            </button>
            {((e.id === "search" && enabledEngines.length > 1) ||
              (e.id === "translate" && enabledTranslates.length > 1) ||
              (e.id === "obsidian" && e.hasMenu)) && (
                <button
                  className="chev"
                  data-trig={`chev:${e.id}`}
                  aria-label={e.id === "search" ? "更多搜索引擎" : e.id === "translate" ? "更多翻译服务" : "存入目标"}
                  onClick={guarded(() =>
                    setMenu((m) =>
                      m === `chev:${e.id}`
                        ? null
                        : (`chev:${e.id}` as "chev:translate" | "chev:search" | "chev:obsidian"),
                    ),
                  )}
                >
                  <ChevronDown
                    size={13}
                    strokeWidth={2}
                    className={`chev-svg ${menu === `chev:${e.id}` ? "open" : ""}`}
                  />
                </button>
              )}
          </span>
        ))}
        {restEntries.length > 0 && (
          <span className="action-slot">
            <button
              className={`action more ${menu === "overflow" || menu?.startsWith("pmenu:") ? "open" : ""}`}
              data-trig="overflow"
              aria-label={`还有 ${restEntries.length} 个动作`}
              onClick={guarded(() =>
                setMenu((m) => (m === "overflow" || m?.startsWith("pmenu:") ? null : "overflow")),
              )}
            >
              <ChevronDown
                size={13}
                strokeWidth={2}
                className={`chev-svg ${
                  menu === "overflow" || menu?.startsWith("pmenu:") ? "open" : ""
                }`}
              />
              <b>{restEntries.length}</b>
            </button>
          </span>
        )}
      </div>
      )}

      {/* 收纳面板：单行平铺、宽度随内容（分离卡，覆盖在正文上，胶囊不动）。
          项主体点击 = 默认服务执行；⌄ 才弹换渠道/引擎的浮出菜单。
          Windows 分离卡：收纳面板渲染在独立窗口（floating-panel），不在此渲染 */}
      {!IS_OCR && !POPS_EXTERNAL && (menu === "overflow" || menu?.startsWith("pmenu:")) && (
        <div className="pop overflow" ref={overflowRef}>
          {restEntries.map((e) => {
            const hasMenu = entryHasMenu(e.id);
            return (
              <span key={e.id} className="pitem">
                <button
                  className="action"
                  onClick={guarded(() => {
                    setMenu(null);
                    e.onClick();
                  })}
                >
                  <span className="ic">{iconOf(e.id, e.icon)}</span>
                  <span>{flashId === e.id ? flashMsg : e.label}</span>
                </button>
                {hasMenu && (
                    <button
                      className={`pchev ${menu === `pmenu:${e.id}` ? "open" : ""}`}
                      data-trig={`pmenu:${e.id}`}
                      aria-label={e.id === "translate" ? "更多翻译服务" : e.id === "obsidian" ? "存入目标" : "更多搜索引擎"}
                      onClick={guarded(() =>
                      setMenu((m) =>
                        // 二级收起 = 回到父级（面板保持展开），置 null 会把收纳面板一起收掉
                        m === `pmenu:${e.id}` ? "overflow" : (`pmenu:${e.id}` as "pmenu:translate" | "pmenu:search" | "pmenu:obsidian"),
                      ),
                    )}
                  >
                    {/* 行侧子菜单方向示能（§B.2.4）：› 指向实际弹出方向，
                        贴屏幕右缘翻左弹时由布局 effect 置 data-flip 旋转成 ‹ */}
                    <ChevronRight size={13} strokeWidth={2} />
                  </button>
                )}
              </span>
            );
          })}
        </div>
      )}

      {/* 窄单列浮出菜单：胶囊动作 ⌄ 与收纳面板项 ⌄ 共用同一形式（全局统一）——
          行侧级联与 ⌄ 下开同一形态，弹向按屏幕空间自动翻转。
          Windows 分离卡：渲染在独立窗口（floating-menu），不在此渲染 */}
      {!IS_OCR && !POPS_EXTERNAL && !!menu && menu !== "overflow" && menu !== "search" && menu !== "translate" && (
        (() => {
          const kind = menu.split(":")[1] as "translate" | "search" | "obsidian";
          // 存入 Obsidian 的目标菜单：主按钮 = 存笔记（默认项打点）。
          // 项名只写目标名词——菜单挂在「存入 Obsidian」的 ⌄ 下，"存入"动词不必逐行重复
          const items =
            kind === "obsidian"
              ? [
                  { key: "note", label: "笔记" },
                  { key: "task", label: "任务" },
                  { key: "card", label: "卡片" },
                ]
              : kind === "translate"
                ? enabledTranslates.map((s) => ({ key: s.id, label: s.label }))
                : enabledEngines.map((en) => ({ key: en.name, label: en.name }));
          const cur = kind === "obsidian" ? "note" : kind === "translate" ? defaultTranslate?.id : defaultEngine?.name;
          return (
            <div className="pop menu" ref={menuPopRef}>
              {items.map((it) => (
                <button
                  key={it.key}
                  className={`mitem ${cur === it.key ? "on" : ""}`}
                  onClick={guarded(() => {
                    setMenu(null);
                    if (kind === "obsidian") {
                      runAction("obsidian", undefined, undefined, it.key);
                    } else if (kind === "translate") {
                      runAction("translate", it.key);
                    } else {
                      const en = enabledEngines.find((x) => x.name === it.key);
                      if (en) openEngine(en);
                    }
                  })}
                >
                  <span className="dot" />
                  <span>{it.label}</span>
                </button>
              ))}
            </div>
          );
        })()
      )}

      {phase.kind === "extract" && (
        <div
          className="panel"
          onMouseDown={IS_OCR ? onOcrPanelDown : undefined}
        >
          <header className="panel-head">
            <span className="panel-title">
              <span className="ic">
                <ScanSearch size={14} strokeWidth={1.75} />
              </span>
              {phase.label}
            </span>
            <span className="panel-tools">
              <button
                className="tool"
                onClick={guarded(() => {
                  const all = EXTRACT_GROUPS.flatMap((g) => phase.groups[g.id]);
                  navigator.clipboard.writeText(all.join("\n")).catch(() => undefined);
                  setCopiedAll(true);
                  if (copiedAllTimerRef.current) window.clearTimeout(copiedAllTimerRef.current);
                  copiedAllTimerRef.current = window.setTimeout(() => setCopiedAll(false), 1200);
                })}
                aria-label="复制全部"
              >
                {copiedAll ? CheckIcon : CopyIcon}
              </button>
              <button
                className="tool"
                onClick={guarded(() => (IS_OCR ? closeResultWindow() : backToBar()))}
                aria-label="收起"
              >
                {CloseIcon}
              </button>
            </span>
          </header>
          <div className="panel-body extract-list">
            {EXTRACT_GROUPS.filter((g) => phase.groups[g.id].length > 0).map((g) => (
              <div key={g.id}>
                <div className="extract-group">
                  {g.label}
                  {/* 计数徽标：一眼知道该组提取了几条，不必逐行数 */}
                  <span className="extract-count">{phase.groups[g.id].length}</span>
                </div>
                {phase.groups[g.id].map((item, i) => (
                  <div className="extract-item" key={`${item}-${i}`}>
                    <span className="extract-text">
                      {g.id === "link" ? renderUrl(item) : item}
                    </span>
                    <span className="extract-acts">
                      {g.id === "link" && (
                        <button
                          onClick={guarded(() =>
                            invoke("open_url", { url: item }).catch(() => undefined),
                          )}
                        >
                          打开
                        </button>
                      )}
                      {g.id === "email" && (
                        <button
                          onClick={guarded(() =>
                            invoke("open_url", { url: `mailto:${item}` }).catch(() => undefined),
                          )}
                        >
                          邮件
                        </button>
                      )}
                      {g.id === "date" && (
                        <button
                          onClick={guarded(() => {
                            if (!phase.text) return;
                            detectAndOpenCalendar(phase.text, item, (ok) => {
                              if (!ok) flash("date", "打开失败");
                            });
                          })}
                        >
                          日历
                        </button>
                      )}
                      {g.id === "addr" && (
                        <button
                          onClick={guarded(() =>
                            invoke("open_url", {
                              url: `maps://?q=${encodeURIComponent(item)}`,
                            }).catch(() => undefined),
                          )}
                        >
                          地图
                        </button>
                      )}
                      <button
                        onClick={guarded(() => {
                          navigator.clipboard.writeText(item).catch(() => undefined);
                          setCopiedItem(item);
                          if (copiedItemTimerRef.current)
                            window.clearTimeout(copiedItemTimerRef.current);
                          copiedItemTimerRef.current = window.setTimeout(
                            () => setCopiedItem(null),
                            1200,
                          );
                        })}
                      >
                        {copiedItem === item ? "已复制" : "复制"}
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            ))}
          </div>
          {IS_OCR && (
            <>
              <div className="resize-handle" onMouseDown={startResultResize} />
              <div className="resize-handle-v" onMouseDown={startResultResizeV} />
            </>
          )}
        </div>
      )}

      {phase.kind === "ocr" && (
        <div
          className="panel"
          ref={ocrPanelRef}
          onMouseDown={IS_OCR ? onOcrPanelDown : undefined}
        >
          <header className={`panel-head ${IS_OCR ? "grab" : ""}`}>
            <span className="panel-title">
              <span className="ic">
                {phase.fromOcr && !phase.actionId ? (
                  <ScanSearch size={14} strokeWidth={1.75} />
                ) : (
                  iconOf(phase.actionId ?? "", byId(phase.actionId ?? "")?.icon)
                )}
              </span>
              {/* 识图流：一步式动作（快捷键识图翻译/解释/总结）标题跟随动作；
                  纯取字（无自动动作）才是「识图取字」。用户在动作条切换动作后
                  actionId 随之变化，标题跟随当前内容 */}
              {phase.fromOcr
                ? phase.actionId
                  ? `识图${byId(phase.actionId)?.label ?? "结果"}`
                  : "识图取字"
                : (byId(phase.actionId ?? "")?.label ?? "结果")}
              {(phase.streaming || doneFlash) && (
                <span className={`dot ${doneFlash ? "done" : ""}`} />
              )}
            </span>
            <span className="panel-tools">
              {IS_OCR && phase.fromOcr && (
                <button
                  className={`tool ${pinErr ? "err" : ""}`}
                    onClick={guarded(() => {
                      setPinErr(null);
                      invoke("pin_from_ocr").then(
                        () => {
                          setPinOk(true);
                          if (pinOkTimerRef.current) window.clearTimeout(pinOkTimerRef.current);
                          pinOkTimerRef.current = window.setTimeout(() => setPinOk(false), 1200);
                        },
                        (e) => setPinErr(String(e)),
                      );
                    })}
                    aria-label="钉图"
                  >
                  {pinOk ? CheckIcon : <ImagePlus size={13} strokeWidth={1.75} />}
                </button>
              )}
              {IS_OCR && (
                <button
                  className={`tool ${ocrPinned ? "active" : ""}`}
                    onClick={guarded(() => {
                      const next = !ocrPinnedRef.current;
                      setOcrPinnedState(next);
                      invoke("set_ocr_pinned", { pinned: next }).catch(() => undefined);
                    })}
                    aria-label="钉住面板"
                  >
                  {ocrPinned ? <PinOff size={13} strokeWidth={1.75} /> : <Pin size={13} strokeWidth={1.75} />}
                </button>
              )}
              <button
                className="tool"
                disabled={!phase.output && !phase.text}
                onClick={guarded(() => {
                  const payload = phase.output
                    ? phase.actionId === "translate"
                      ? splitTranslate(phase.output).main
                      : phase.output
                    : phase.text;
                  navigator.clipboard.writeText(payload).catch(() => undefined);
                  setCopiedOcr(true);
                  if (copiedOcrTimerRef.current)
                    window.clearTimeout(copiedOcrTimerRef.current);
                  copiedOcrTimerRef.current = window.setTimeout(() => setCopiedOcr(false), 1200);
                })}
                aria-label="复制"
              >
                {copiedOcr ? CheckIcon : CopyIcon}
              </button>
              <button
                className="tool"
                onClick={guarded(closeResultWindow)}
                aria-label="收起"
              >
                {CloseIcon}
              </button>
            </span>
          </header>
          <div className="ocr-main">
            {/* 原文区两种模式（class 切换由 CSS flex 过渡出动画）：
                原文模式（!actionId）：撑满面板全量展示，超长滚动；
                结果模式（actionId）：折叠 3 行，可展开至 220px，让位结果区。
                仅截图/钉图识别（fromOcr）展示；划词导流的原文在用户屏幕上，
                phase.text 仍保留作为动作源 */}
            {phase.fromOcr && (
            <div
              className={`ocr-source-wrap ${
                phase.actionId ? "has-result" : "full"
              } ${phase.actionId && phase.expanded ? "expanded" : ""}`}
            >
              <EditableSource
                text={phase.text}
                sourceRef={sourceRef}
                onEdit={(t) =>
                  setPhase((p) => (p.kind === "ocr" ? { ...p, text: t } : p))
                }
              />
              {/* 仅结果模式显示折叠切换；原文模式本就是全量，无需切换 */}
              {phase.actionId && (sourceOverflow || phase.expanded) && (
                <button
                  className="ocr-toggle"
                  onClick={guarded(() =>
                    setPhase((p) => (p.kind === "ocr" ? { ...p, expanded: !p.expanded } : p)),
                  )}
                  aria-label="展开或收起原文"
                >
                  <ChevronDown
                    size={13}
                    strokeWidth={2}
                    className={`chev-svg ${phase.expanded ? "open" : ""}`}
                  />
                </button>
              )}
            </div>
            )}
            {phase.actionId && (
              <div className="ocr-result-scroll" ref={ocrBodyRef} onScroll={onOcrResultScroll}>
                <div className="ocr-result md">
                {phase.output ? (
                  phase.plain ? (
                    // 机器翻译：API 返回即纯文本，按原样渲染（保留换行，不做 markdown 解释）
                    <div className="plain-text">{phase.output}</div>
                  ) : (
                    <>
                      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={mdComponents}>
                        {(phase.actionId === "translate"
                          ? splitTranslate(phase.output).main
                          : phase.output) + (phase.streaming ? " ▍" : "")}
                      </ReactMarkdown>
                      {phase.actionId === "translate" &&
                        splitTranslate(phase.output).notes &&
                        !phase.streaming && (
                          <div className="notes md">
                            <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={mdComponents}>
                              {splitTranslate(phase.output).notes}
                            </ReactMarkdown>
                          </div>
                        )}
                    </>
                  )
                ) : phase.error ? null : (
                  <div className="placeholder">正在思考…</div>
                )}
                {phase.error && (
                  <div className="error">
                    <p>{phase.error}</p>
                    <button
                      className="retry"
                      onClick={() => phase.actionId && runAction(phase.actionId)}
                    >
                      重试
                    </button>
                  </div>
                )}
                </div>
              </div>
            )}
            {/* 动作行：常规流内布局排在结果区之后、面板最底部（不随结果滚动）。
                单行不折行（overflow:hidden），放不下的尾部动作收进行尾「更多 ⌃」，
                点开在菜单槽位以 chips 呈现——窄窗不挤成多行。
                AI 动作（翻译/解释/总结 + 用户的自定义动作）结果内嵌滚动区；搜索为本地动作，
                用识别文本直接打开默认引擎——对识别出的书名/术语等尤其实用 */}
            <div className="ocr-actions" ref={attachActionsRow}>
              {/* 溢出测算行：全量动作的隐形副本，覆在真实行上逐项量宽 */}
              <div className="ocr-measure" ref={measureRowRef} aria-hidden="true">
                {rowActions.map((a) => renderRowSlot(a, false))}
                <span className="action-slot">
                  <button type="button" className="action more" tabIndex={-1}>
                    <ChevronDown size={13} strokeWidth={2} />
                    <b>{ocrOverflow}</b>
                  </button>
                </span>
              </div>
              {rowActions.slice(0, rowActions.length - ocrOverflow).map((a) => renderRowSlot(a, true))}
              {/* 溢出收纳钮：hover 驻留自动展开（data-trig 接入 §B.2 驻留机制，
                  与胶囊条同款），点按切换；命中区经 .more-slot 外扩更好命中 */}
              {ocrOverflow > 0 && (
                <span className="action-slot more-slot">
                  <button
                    className={`action more ${menu === "overflow" || menu?.startsWith("pmenu:") ? "open" : ""}`}
                    data-trig="overflow"
                    aria-label={`还有 ${ocrOverflow} 个动作`}
                    onClick={guarded(() =>
                      switchMenu(
                        menu === "overflow" || menu?.startsWith("pmenu:")
                          ? null
                          : "overflow",
                      ),
                    )}
                  >
                    <ChevronDown
                      size={13}
                      strokeWidth={2}
                      className={`chev-svg ${menu === "overflow" || menu?.startsWith("pmenu:") ? "open" : ""}`}
                    />
                    <b>{ocrOverflow}</b>
                  </button>
                </span>
              )}
              {/* 回到底部：悬浮于结果区右下、动作行上方（流式 + 用户上翻时出现） */}
              {phase.streaming && !ocrStick && (
                <button
                  className="jump-down"
                  onClick={guarded(ocrJumpToBottom)}
                  aria-label="回到底部"
                >
                  <ChevronDown size={13} strokeWidth={2} />
                </button>
              )}
            </div>
          </div>
          {/* ⌄ 槽位子菜单（§B.5.3 行 ⌄ 同规则）：绝对定位浮层——锚在动作行上方，
              左缘对齐触发槽位（定位 effect 摆位）、底边距行上缘 8px；限宽换行
              向上生长、限高内滚；临时遮盖正文属浮层语义。窗口生长机制
              （RESULT_MENU_GROW + 冻结/解冻）随之退役——尺寸模型回到
              「只由拖动/预设改变」。chips 跟面板配色，悬停/选中只变文字色。
              动效（2026-10-20 定稿）：入场在内层 .mflow（key=菜单值，兄弟切换
              重放），纯收起时容器挂 .m-out 淡出（fading 快照续挂旧内容） */}
          <div className={`ocr-menu-slot ${slotGhost ? "m-out" : ""}`}>
            {slotVal === "translate" && enabledTranslates.length > 1 && (
              <div key="translate" className={`mflow ${slotGhost ? "still" : ""}`}>
                {enabledTranslates.map((s) => (
                  <button
                    key={s.id}
                    className="chip"
                    onClick={guarded(() => {
                      setUsedTranslate(s.id); // 点击哪个哪个选中
                      setMenu(null);
                      runAction("translate", s.id);
                    })}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            )}
            {slotVal === "search" && enabledEngines.length > 1 && (
              <div key="search" className={`mflow ${slotGhost ? "still" : ""}`}>
                {enabledEngines.map((e) => (
                  <button
                    key={e.name}
                    className="chip"
                    onClick={guarded(() => {
                      setUsedEngine(e.name); // 点击哪个哪个选中
                      setMenu(null);
                      openEngine(e, phase.text);
                    })}
                  >
                    {e.name}
                  </button>
                ))}
              </div>
            )}
            {slotVal === "obsidian" && (
              <div key="obsidian" className={`mflow ${slotGhost ? "still" : ""}`}>
                {(
                  [
                    ["note", "笔记"],
                    ["task", "任务"],
                    ["card", "卡片"],
                  ] as Array<[string, string]>
                ).map(([key, label]) => (
                  <button
                    key={key}
                    className="chip"
                    onClick={guarded(() => {
                      setMenu(null);
                      runAction("obsidian", undefined, undefined, key);
                    })}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
          </div>
          {/* 溢出收纳浮层：竖排胶囊堆（§B.5.2 定稿）——无容器卡，每颗胶囊
              独立浮层（实底+发丝+投影，CSS .rail），堆内右对齐成列，右缘贴
              内容区、底边让出「回到底部」带；带子操作的胶囊尾部 ‹ 指向横向
              chips 的弹出方向。DOM 挂在 .panel 下：.ocr-actions（单行收纳
              裁切）与 .ocr-main（菜单生长兜底）都 overflow:hidden，向上出界
              必被裁切，面板是第一个不裁切的定位锚。点胶囊执行并收起 */}
          {(railLive || railGhost) && ocrOverflow > 0 && (
            <div
              className={`pop overflow rail ${
                phase.streaming && !ocrStick ? "rail-lift" : ""
              } ${railGhost ? "m-out" : ""}`}
            >
              {rowActions.slice(rowActions.length - ocrOverflow).map((a) => (
                <span
                  key={a.id}
                  className={`pitem ${menu === `pmenu:${a.id}` ? "open" : ""}`}
                  data-pill={a.id}
                >
                  <button
                    className="action"
                    onClick={guarded(() => {
                      setMenu(null);
                      if (a.id === "translate") setUsedTranslate(null);
                      if (a.id === "search") setUsedEngine(null);
                      runAction(a.id);
                    })}
                  >
                    <span className="ic">{iconOf(a.id, a.icon)}</span>
                    <span>{a.label}</span>
                  </button>
                  {entryHasMenu(a.id) && (
                    <button
                      className={`pchev ${menu === `pmenu:${a.id}` ? "open" : ""}`}
                      data-trig={`pmenu:${a.id}`}
                      aria-label={
                        a.id === "translate"
                          ? "更多翻译服务"
                          : a.id === "search"
                            ? "更多搜索引擎"
                            : "存入目标"
                      }
                      onClick={guarded(() =>
                        switchMenu(
                          menu === `pmenu:${a.id}`
                            ? "overflow"
                            : (`pmenu:${a.id}` as
                                | "pmenu:translate"
                                | "pmenu:search"
                                | "pmenu:obsidian"),
                        ),
                      )}
                    >
                      {/* ‹ 指向 chips 实际弹出方向（左侧级联，§B.5.3） */}
                      <ChevronLeft size={14} strokeWidth={2} />
                    </button>
                  )}
                </span>
              ))}
            </div>
          )}
          {/* 子菜单：横向 chips 行侧级联（§B.5.3）——独立浮层无容器，定位
              effect 摆到触发胶囊左侧（右缘距 6px、垂直居中）；限宽换行、
              行右对齐；点 chip 执行并收起全部。带 .pop 类：纳入「点外收起」
              的浮层判定，避免 mousedown 收起导致 click 丢失。入场在内层
              .mflow（key=菜单值，pmenu 兄弟切换重放），纯收起/收回主堆时
              容器挂 .m-out 淡出（fading 快照续挂，定位 effect 对 menu=null
              早退、inline 摆位原样保留） */}
          {pmenuVal !== null && ocrOverflow > 0 && (
            <div className={`pop hchips ${pmenuGhost ? "m-out" : ""}`} ref={railChipsRef}>
              <div key={pmenuVal} className={`mflow ${pmenuGhost ? "still" : ""}`}>
                {pmenuVal === "pmenu:translate" &&
                  enabledTranslates.map((s) => (
                    <button
                      key={s.id}
                      className="chip"
                      onClick={guarded(() => {
                        setUsedTranslate(s.id);
                        setMenu(null);
                        runAction("translate", s.id);
                      })}
                    >
                      {s.label}
                    </button>
                  ))}
                {pmenuVal === "pmenu:search" &&
                  enabledEngines.map((e) => (
                    <button
                      key={e.name}
                      className="chip"
                      onClick={guarded(() => {
                        setUsedEngine(e.name);
                        setMenu(null);
                        openEngine(e, phase.text);
                      })}
                    >
                      {e.name}
                    </button>
                  ))}
                {pmenuVal === "pmenu:obsidian" &&
                  ([["note", "笔记"], ["task", "任务"], ["card", "卡片"]] as Array<[string, string]>).map(
                    ([key, label]) => (
                      <button
                        key={key}
                        className="chip"
                        onClick={guarded(() => {
                          setMenu(null);
                          runAction("obsidian", undefined, undefined, key);
                        })}
                      >
                        {label}
                      </button>
                    ),
                  )}
              </div>
            </div>
          )}
          {IS_OCR && (
            <>
              <div className="resize-handle" onMouseDown={startResultResize} />
              <div className="resize-handle-v" onMouseDown={startResultResizeV} />
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** 进程路径 → 应用名（取末段、去 .app 后缀）："…/Safari.app/Contents/…" → Safari */
function appNameFrom(path: string): string {
  const last = path.split("/").filter(Boolean).pop() ?? "";
  return last.replace(/\.app$/i, "") || "未知应用";
}
