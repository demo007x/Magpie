import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import {
  AlignLeft,
  Check,
  ChevronDown,
  ClipboardCheck,
  Copy,
  ExternalLink,
  ImagePlus,
  Languages,
  Lightbulb,
  Mail,
  Phone,
  Pin,
  PinOff,
  ScanSearch,
  Search,
  X,
} from "lucide-react";
import { ACTIONS, actionById } from "../shared/actions";
import { aiChat } from "../shared/ai";
import {
  extractAll,
  extractCode,
  extractEmail,
  extractTel,
  extractUrl,
} from "../shared/textContext";
import type { SearchEngine, Settings } from "../shared/types";

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

// 上下文智能动作：由「提取信息」统一承载（多值/混合进面板），不再逐个上胶囊条
const CONTEXT_ACTION_IDS = new Set(["link", "email", "tel", "code"]);
const isContextAction = (id: string) => CONTEXT_ACTION_IDS.has(id);

type ExtractGroups = { tel: string[]; email: string[]; link: string[]; code: string[] };

const EXTRACT_GROUPS: Array<{ id: keyof ExtractGroups; label: string }> = [
  { id: "tel", label: "电话" },
  { id: "email", label: "邮箱" },
  { id: "link", label: "链接" },
  { id: "code", label: "验证码" },
];

/** 数量最多的实体类型（面板图标用） */
function dominantGroup(groups: ExtractGroups): string {
  let best: keyof ExtractGroups = "link";
  for (const g of EXTRACT_GROUPS) {
    if (groups[g.id].length > groups[best].length) best = g.id;
  }
  return best;
}

// ---- 图标（lucide-react 图标库，统一 15px / 1.75 描边，随文字色） ----
const ICONS: Record<string, React.ReactNode> = {
  copy: <Copy size={14} strokeWidth={1.75} />,
  search: <Search size={14} strokeWidth={1.75} />,
  translate: <Languages size={14} strokeWidth={1.75} />,
  explain: <Lightbulb size={14} strokeWidth={1.75} />,
  summarize: <AlignLeft size={14} strokeWidth={1.75} />,
  link: <ExternalLink size={14} strokeWidth={1.75} />,
  email: <Mail size={14} strokeWidth={1.75} />,
  code: <ClipboardCheck size={14} strokeWidth={1.75} />,
  tel: <Phone size={14} strokeWidth={1.75} />,
  __extract: <ScanSearch size={14} strokeWidth={1.75} />,
};
const CopyIcon = <Copy size={13} strokeWidth={1.75} />;
const CheckIcon = <Check size={13} strokeWidth={2} className="ok" />;
const CloseIcon = <X size={13} strokeWidth={1.75} />;

// 翻译服务注册表（id 与设置页/后端约定："ai" | "baidu" | "deepl"）
const TRANSLATE_SERVICES = [
  { id: "ai", label: "AI 翻译" },
  { id: "baidu", label: "百度翻译" },
  { id: "deepl", label: "DeepL" },
];

// 状态机：Bar（胶囊） → Result（流式面板）/ Extract（多值列表）；dismiss/新选区回收
type Phase =
  | { kind: "bar" }
  | {
    kind: "extract";
    /** 主要实体类型（决定面板图标） */
    actionId: string;
    label: string;
    groups: ExtractGroups;
  }
  | {
    /** OCR 文本识别：合并面板（文本可见 + 动作内嵌 + 结果流式）。
        fromOcr = 识别来源（显示钉图/文本识别标题）；false = 划词导流结果 */
    kind: "ocr";
    text: string;
    fromOcr: boolean;
    actionId: string | null;
    output: string;
    streaming: boolean;
    error: string | null;
    expanded: boolean;
  };

// 重复查询缓存：同动作 + 同服务 + 同文本，5 分钟内直接复用结果
// （容量 50，LRU 淘汰；划词场景「反复选中同一段」很常见）
const resultCache = new Map<string, { output: string; at: number }>();
const CACHE_TTL = 5 * 60_000;
const CACHE_CAP = 50;

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
  manualSize: boolean;
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
  const [failed, setFailed] = useState(false);
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

  // 缩放（含首帧）后同步窗口尺寸；Rust 侧保持左上角并做屏内钳制
  useEffect(() => {
    if (logical) {
      invoke("resize_pin", { width: logical.w, height: logical.h }).catch(() => undefined);
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
    // 页面本身不可滚动（overflow hidden），滚轮纯粹驱动缩放
    setZoom((z) => Math.min(5, Math.max(0.25, z * (e.deltaY < 0 ? 1.1 : 1 / 1.1))));
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
    invoke("pin_to_ocr")
      .then(
        () => setFailed(false),
        () => setFailed(true), // 失败提示落在按钮 title（OCR 面板可能未弹出）
      )
      .finally(() => setBusy(false));
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
          title={failed ? "识别失败，请重试" : "识别文字"}
          disabled={busy}
          onClick={recognize}
        >
          <ScanSearch size={13} strokeWidth={1.75} />
        </button>
        <button className="tool" title={copied ? "已复制" : "复制图片"} onClick={copyImage}>
          {copied ? CheckIcon : CopyIcon}
        </button>
        <button
          className="tool"
          title="关闭 (Esc)"
          onClick={() => invoke("close_pin").catch(() => undefined)}
        >
          {CloseIcon}
        </button>
      </div>
    </div>
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
  const [translateEnabled, setTranslateEnabled] = useState<string[]>(["ai"]);
  const [translateDefault, setTranslateDefault] = useState("ai");
  const [translateOrder, setTranslateOrder] = useState<string[]>([]);
  const [flashId, setFlashId] = useState<string | null>(null);
  const [flashMsg, setFlashMsg] = useState("");
  const [engines, setEngines] = useState<SearchEngine[]>([]);
  const [defaultSearch, setDefaultSearch] = useState("");
  // 展开的 chips 菜单（搜索引擎 / 翻译服务，同屏只开一个）
  const [menu, setMenu] = useState<"search" | "translate" | null>(null);
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
  // 钉图失败的反馈（图标变红 + title 显示具体原因，直到下次重试）
  const [pinErr, setPinErr] = useState<string | null>(null);
  const copiedAllTimerRef = useRef<number | undefined>(undefined);
  const copiedItemTimerRef = useRef<number | undefined>(undefined);
  const copiedOcrTimerRef = useRef<number | undefined>(undefined);
  const pinOkTimerRef = useRef<number | undefined>(undefined);
  const flashTimerRef = useRef<number | undefined>(undefined);
  // OCR 结果区：同一套智能跟随（默认贴底；用户上翻即暂停 + 回到底部圆钮）
  const ocrBodyRef = useRef<HTMLDivElement | null>(null);
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

  const stageRef = useRef<HTMLDivElement>(null);
  const runIdRef = useRef(0);
  const streamingRef = useRef(false);
  // OCR 窗口显示链路状态：新识别结果到来时重置（强制重测量 + 重新显示）
  const lastSizeRef = useRef("");
  const ocrReadyRef = useRef(false);
  // 识别原文是否超长（超 3 行折叠高度）——决定展开/收起按钮是否显示
  const sourceRef = useRef<HTMLDivElement | null>(null);
  const [sourceOverflow, setSourceOverflow] = useState(false);

  const loadSettings = () => {
    invoke<Settings>("get_settings")
      .then((s) => {
        setActions({ ...s.actions });
        setActionOrder(s.actionOrder ?? []);
        setEngines(s.searchEngines ?? []);
        setDefaultSearch(s.defaultSearch ?? "");
        setTranslateEnabled(s.translate?.enabled ?? ["ai"]);
        setTranslateDefault(s.translate?.default ?? "ai");
        setTranslateOrder(s.translate?.order ?? []);
      })
      .catch(() => undefined);
  };

  // 按用户自定义顺序渲染（未配置的按注册表顺序排在后面）。
  // 实体提取与胶囊分流：
  // 无实体 → 现状；恰好 1 个实体 → 对应动作一键直达（占「搜索」位，搜索隐藏）；
  // ≥2 个实体（同类型多个或混合类型）→ 单一「提取信息」按钮，点击进分组面板。
  // 四类动作均可在主界面动作卡片关闭（关闭的类型不提取、不计数）。
  const extracted = useMemo(() => {
    const all = extractAll(text);
    const groups: ExtractGroups = {
      tel: actions.tel !== false ? all.tels : [],
      email: actions.email !== false ? all.emails : [],
      link: actions.link !== false ? all.urls : [],
      code: actions.code !== false ? all.codes : [],
    };
    const total = groups.tel.length + groups.email.length + groups.link.length + groups.code.length;
    return { groups, total };
  }, [text, actions]);

  const searchIdx = actionOrder.indexOf("search");
  const orderKey = (id: string) => {
    const i = actionOrder.indexOf(id);
    return i >= 0 ? i : id === "__ctx" ? searchIdx : 999;
  };

  type BarEntry = { id: string; label: string; onClick: () => void };

  const barEntries = (() => {
    const entries: BarEntry[] = [];
    for (const a of ACTIONS) {
      // 上下文动作不上胶囊条：由提取结果统一决定胶囊条上的上下文按钮
      if (isContextAction(a.id)) continue;
      if (actions[a.id] === false) continue;
      if (a.id === "search" && extracted.total > 0) continue; // 搜索位让给提取按钮
      entries.push({
        id: a.id,
        label: a.label,
        onClick: () => {
          setMenu(null);
          runAction(a.id);
        },
      });
    }
    if (extracted.total === 1) {
      const g = extracted.groups;
      const single =
        g.link.length === 1
          ? { id: "link", label: "打开链接" }
          : g.email.length === 1
            ? { id: "email", label: "写邮件" }
            : g.tel.length === 1
              ? { id: "tel", label: "复制号码" }
              : { id: "code", label: "复制验证码" };
      entries.push({
        id: single.id,
        label: single.label,
        onClick: () => {
          setMenu(null);
          runAction(single.id);
        },
      });
    } else if (extracted.total > 1) {
      entries.push({
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
      });
    }
    entries.sort((a, b) => orderKey(a.id) - orderKey(b.id));
    return entries;
  })();

  useEffect(() => {
    loadSettings();
    invoke("ui_debug_log", { msg: "floating webview 就绪" }).catch(() => undefined);
    // OCR 独立窗口：取走 Rust 侧存好的识别文本（推送可能早于 webview 挂载）
    if (IS_OCR) {
      invoke<PendingView | null>("ocr_take_pending")
        .then((p) => {
          if (!p) return;
          // 新结果：重置测量/显示状态，确保面板必然重新显示
          lastSizeRef.current = "";
          ocrReadyRef.current = false;
          setOcrPinnedState(p.pinned);
          setManualSize(p.manualSize);
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
            // 提取信息：结果窗口本地从文本计算分组
            const all = extractAll(p.text);
            const groups: ExtractGroups = {
              tel: all.tels,
              email: all.emails,
              link: all.urls,
              code: all.codes,
            };
            setPhase({
              kind: "extract",
              actionId: dominantGroup(groups),
              label: "提取结果",
              groups,
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
    };

    const unlisteners: Array<() => void> = [];

    listen<{ text: string; x: number; y: number; app?: string }>("selection://captured", (e) => {
      // 钉图窗口与划词流无关：忽略广播（防止误触发浮动条弹出/窗口移动）
      if (IS_PIN) return;
      invoke("ui_debug_log", {
        msg: `收到 captured 事件：len=${e.payload.text.length} (${e.payload.x.toFixed(0)},${e.payload.y.toFixed(0)}) app=${e.payload.app ?? "-"}`,
      }).catch(() => undefined);
      resetGhostStates();
      // 新选区使进行中的流失效（否则 streamingRef 卡住，dismiss 会被误拦）
      runIdRef.current++;
      streamingRef.current = false;
      setMenu(null);
      // OCR 来源事件：仅 OCR 独立窗口消费（浮动条抢走 pending 会与之竞争）
      if (e.payload.app === "ocr") {
        if (!IS_OCR) return;
        invoke<PendingView | null>("ocr_take_pending")
          .then((p) => {
            if (!p) return;
            // 新结果：重置测量/显示状态——若尺寸与上次相同也必须重新显示窗口
            lastSizeRef.current = "";
            ocrReadyRef.current = false;
            setOcrPinnedState(p.pinned);
            setManualSize(p.manualSize);
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
              };
              setPhase({
                kind: "extract",
                actionId: dominantGroup(groups),
                label: "提取结果",
                groups,
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
      // 普通划词：浮动条在鼠标位置弹出（x/y 来自选区）
      setPending({ x: e.payload.x, y: e.payload.y });
      setText(e.payload.text);
      setPhase({ kind: "bar" });
    }).then((un) => unlisteners.push(un));

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
      if (IS_OCR) invoke("hide_ocr_window").catch(() => undefined);
    }).then((un) => unlisteners.push(un));

    listen("settings://changed", () => loadSettings()).then((un) => unlisteners.push(un));

    // 主窗口的动作开关/顺序/搜索引擎实时推送（无需保存即时生效）
    listen<{
      actions: Record<string, boolean>;
      actionOrder: string[];
      searchEngines?: SearchEngine[];
      defaultSearch?: string;
      translateEnabled?: string[];
      translateDefault?: string;
      translateOrder?: string[];
    }>("settings://live", (e) => {
      setActions({ ...e.payload.actions });
      setActionOrder(e.payload.actionOrder ?? []);
      if (e.payload.searchEngines) setEngines(e.payload.searchEngines);
      if (e.payload.defaultSearch) setDefaultSearch(e.payload.defaultSearch);
      if (e.payload.translateEnabled) setTranslateEnabled(e.payload.translateEnabled);
      if (e.payload.translateDefault) setTranslateDefault(e.payload.translateDefault);
      if (e.payload.translateOrder) setTranslateOrder(e.payload.translateOrder);
    }).then((un) => unlisteners.push(un));

    document.addEventListener("mouseleave", suspendPointer);
    document.addEventListener("mouseenter", restorePointer);

    return () => {
      unlisteners.forEach((u) => u());
      document.removeEventListener("mouseleave", suspendPointer);
      document.removeEventListener("mouseenter", restorePointer);
    };
  }, []);

  // （OCR 窗口的定位+显示已改由尺寸测量 effect 在 resize 完成后链式触发，见下）

  // 识别原文是否溢出折叠高度（超 3 行）：决定展开/收起按钮显示与否
  useLayoutEffect(() => {
    if (phase.kind !== "ocr") return;
    const el = sourceRef.current;
    if (!el) return;
    // 收起态下 scrollHeight 为完整文本高度，clientHeight 被 max-height 钳在 3 行
    setSourceOverflow(el.scrollHeight > el.clientHeight + 1);
  }, [phase]);

  // 渲染后测量内容尺寸 → 按锚点定位/调整窗口（自适应）；尺寸不变时不重复调窗口
  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const w = Math.ceil(rect.width);
    const h = Math.ceil(rect.height);
    const sizeKey = `${w}x${h}`;
    // OCR 独立窗口：先按内容缩放窗口，就绪后再定位显示（避免旧尺寸下闪现大面板）；
    // 显示一次即可，后续内容变化只 resize，不重复定位
    if (
      IS_OCR &&
      (phase.kind === "ocr" || phase.kind === "extract") &&
      sizeKey !== lastSizeRef.current
    ) {
      lastSizeRef.current = sizeKey;
      invoke("resize_ocr", { width: w, height: h })
        .catch(() => undefined)
        .finally(() => {
          if (ocrReadyRef.current) return;
          ocrReadyRef.current = true;
          invoke("ocr_window_ready").catch(() => undefined);
        });
      return;
    }
    if (pending) {
      lastSizeRef.current = sizeKey;
      invoke("show_floating_bar", { x: pending.x, y: pending.y, width: w, height: h })
        .catch(() => undefined)
        .finally(() => setPending(null));
    } else if (sizeKey !== lastSizeRef.current) {
      lastSizeRef.current = sizeKey;
      invoke("resize_floating", { width: w, height: h }).catch(() => undefined);
    }
  }, [phase, pending, menu, flashId]);

  // 结果窗口手动尺寸：用户拖拽手柄后进入该模式（宽度固定、高度为自适应上限）
  const [manualSize, setManualSize] = useState(false);

  // 底边拖拽：仅调高度（单独的向下/向上拖动）
  const startResultResizeV = (e: ReactMouseEvent) => {
    if (!IS_OCR) return;
    e.preventDefault();
    e.stopPropagation();
    setManualSize(true);
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
    setManualSize(true);
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

  // 关闭结果窗口：解除钉住 + 隐藏（划词/识图结果窗口共用）
  const closeResultWindow = () => {
    setOcrPinnedState(false);
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

  // ---- OCR 面板拖拽：按住标题栏拖动（move_ocr 落位时钳制在屏幕内） ----
  const ocrDragRef = useRef<{ sx: number; sy: number; wx: number; wy: number } | null>(null);

  const onOcrHeadDown = (e: ReactMouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    invoke<{ x: number; y: number }>("ocr_window_pos")
      .then((p) => {
        if (!p) return;
        ocrDragRef.current = { sx: e.screenX, sy: e.screenY, wx: p.x, wy: p.y };
      })
      .catch(() => undefined);
  };

  useEffect(() => {
    if (!IS_OCR) return;
    const onMove = (e: MouseEvent) => {
      const d = ocrDragRef.current;
      if (!d) return;
      invoke("move_ocr", {
        x: d.wx + (e.screenX - d.sx),
        y: d.wy + (e.screenY - d.sy),
      }).catch(() => undefined);
    };
    const onUp = () => {
      ocrDragRef.current = null;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  // 动作按钮的短暂文字反馈（已复制 / 已打开 / 不支持…）
  const flash = (id: string, msg: string) => {
    setFlashId(id);
    setFlashMsg(msg);
    if (flashTimerRef.current) window.clearTimeout(flashTimerRef.current);
    flashTimerRef.current = window.setTimeout(() => setFlashId(null), 1200);
  };

  const runAction = (id: string, serviceOverride?: string, sourceOverride?: string) => {
    const action = actionById(id);
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
      return;
    }

    // 翻译服务路由：显式指定（chips）或默认服务；baidu/deepl = 机器翻译直达，ai 走下方通用模型流式
    if (id === "translate") {
      const svc = serviceOverride ?? defaultTranslate?.id;
      if (!svc) {
        flash(id, "未启用翻译服务");
        return;
      }
      if (svc === "baidu" || svc === "deepl") {
        const trimmed = source.trim();
        const cacheKey = `${id}:${svc}:${trimmed}`;
        const cachedOut = cacheGet(cacheKey);
        if (cachedOut !== null && (phase.kind === "ocr" || sourceOverride !== undefined)) {
          // 缓存命中：跳过请求直接展示
          setPhase((p) =>
            p.kind === "ocr"
              ? { ...p, actionId: id, output: cachedOut, streaming: false, error: null }
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
          // 划词 AI 结果导流到独立结果窗口（默认钉住，胶囊下方弹出）
          invoke("push_selection_result", {
            text: source,
            actionId: id,
            service: serviceOverride ?? null,
          }).catch(() => undefined);
          invoke("hide_floating_bar").catch(() => undefined);
          setPhase({ kind: "bar" });
          return;
        }
        const isDeepl = svc === "deepl";
        // 中文→英文，其他→中文；目标语言代码 DeepL 用大写（EN/ZH）
        const to = /[一-鿿]/.test(trimmed) ? (isDeepl ? "EN" : "en") : (isDeepl ? "ZH" : "zh");
        invoke<string>(isDeepl ? "deepl_translate" : "baidu_translate", { text: trimmed, to })
          .then((out) => {
            if (runIdRef.current !== runId) return;
            streamingRef.current = false;
            cachePut(cacheKey, out);
            setPhase((p) =>
              p.kind === "ocr" ? { ...p, output: out, streaming: false } : p,
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
    if (!action.buildMessages) return;
    const cacheKey = `${id}:${serviceOverride ?? ""}:${source}`;
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
      // 划词 AI 结果导流到独立结果窗口（默认钉住，胶囊下方弹出）
      invoke("push_selection_result", {
        text: source,
        actionId: id,
        service: serviceOverride ?? null,
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

    aiChat(action.buildMessages(source), null, {
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
    // OCR 独立窗口不参与浮动条拖拽
    if (IS_OCR) return;
    // 结果文本区保留文字选择/复制，不作为拖拽起点
    if ((e.target as HTMLElement).closest(".panel-body")) return;
    dragStartRef.current = { sx: e.screenX, sy: e.screenY };
  };

  const onStageMouseMove = (e: ReactMouseEvent) => {
    const s = dragStartRef.current;
    if (!s || dragActiveRef.current) return;
    if (IS_OCR) return;
    if (Math.hypot(e.screenX - s.sx, e.screenY - s.sy) > 5) {
      dragActiveRef.current = true;
      suppressClickRef.current = true;
      // 用按下时的全局坐标计算抓取偏移（此刻窗口尚未移动）
      invoke("begin_floating_drag", { x: s.sx, y: s.sy }).catch(() => undefined);
    }
  };

  const onStageMouseUp = () => {
    dragStartRef.current = null;
    if (dragActiveRef.current) {
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
    fn();
  };

  return (
    <div
      className={`stage ${IS_OCR && manualSize ? "manual-size" : ""}`}
      ref={stageRef}
      onMouseDown={onStageMouseDown}
      onMouseMove={onStageMouseMove}
      onMouseUp={onStageMouseUp}
    >
      {/* 划词胶囊条：仅主浮动窗口渲染（OCR 独立窗口只显示识别面板） */}
      {!IS_OCR && (
      <div className="bar" role="toolbar">
        {barEntries.map((e) => (
          <span key={e.id} className="action-slot">
            <button
              className="action"
              title={
                e.id === "search" && defaultEngine
                  ? `用${defaultEngine.name}搜索`
                  : e.id === "translate" && defaultTranslate
                    ? `当前默认：${defaultTranslate.label}`
                    : undefined
              }
              onClick={guarded(() => {
                setMenu(null); // 执行动作即收起展开中的菜单（chips 不滞留在主条与结果面板之间）
                e.onClick();
              })}
            >
              <span className="ic">{ICONS[e.id]}</span>
              <span>{flashId === e.id ? flashMsg : e.label}</span>
            </button>
            {((e.id === "search" && enabledEngines.length > 1) ||
              (e.id === "translate" && enabledTranslates.length > 1)) && (
                <button
                  className="chev"
                  title={e.id === "search" ? "更多搜索引擎" : "更多翻译服务"}
                  onClick={guarded(() =>
                    setMenu((m) => (m === e.id ? null : (e.id as "search" | "translate"))),
                  )}
                >
                  <ChevronDown
                    size={13}
                    strokeWidth={2}
                    className={`chev-svg ${menu === e.id ? "open" : ""}`}
                  />
                </button>
              )}
          </span>
        ))}
      </div>
      )}

      {menu === "search" && !IS_OCR && enabledEngines.length > 1 && (
        <div className="chips">
          {enabledEngines.map((e) => (
            <button
              key={e.name}
              className={`chip ${defaultEngine?.name === e.name ? "primary" : ""}`}
              onClick={guarded(() => {
                setMenu(null);
                openEngine(e);
              })}
            >
              {e.name}
            </button>
          ))}
        </div>
      )}

      {menu === "translate" && !IS_OCR && enabledTranslates.length > 1 && (
        <div className="chips">
          {enabledTranslates.map((s) => (
            <button
              key={s.id}
              className={`chip ${defaultTranslate?.id === s.id ? "primary" : ""}`}
              onClick={guarded(() => {
                setMenu(null);
                runAction("translate", s.id);
              })}
            >
              {s.label}
            </button>
          ))}
        </div>
      )}

      {phase.kind === "extract" && (
        <div
          className="panel"
          onMouseDown={IS_OCR ? () => invoke("focus_ocr_window").catch(() => undefined) : undefined}
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
                title="复制全部"
              >
                {copiedAll ? CheckIcon : CopyIcon}
              </button>
              <button
                className="tool"
                onClick={guarded(() => (IS_OCR ? closeResultWindow() : backToBar()))}
                title="收起"
              >
                {CloseIcon}
              </button>
            </span>
          </header>
          <div className="panel-body extract-list">
            {EXTRACT_GROUPS.filter((g) => phase.groups[g.id].length > 0).map((g) => (
              <div key={g.id}>
                <div className="extract-group">{g.label}</div>
                {phase.groups[g.id].map((item, i) => (
                  <div className="extract-item" key={`${item}-${i}`}>
                    <span className="extract-text">{item}</span>
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
          onMouseDown={
            IS_OCR
              ? () => invoke("focus_ocr_window").catch(() => undefined)
              : undefined
          }
        >
          <header className={`panel-head ${IS_OCR ? "grab" : ""}`} onMouseDown={IS_OCR ? onOcrHeadDown : undefined}>
            <span className="panel-title">
              <span className="ic">
                {phase.fromOcr ? (
                  <ScanSearch size={14} strokeWidth={1.75} />
                ) : (
                  ICONS[phase.actionId ?? ""]
                )}
              </span>
              {phase.fromOcr ? "文本识别" : (actionById(phase.actionId ?? "")?.label ?? "结果")}
              {(phase.streaming || doneFlash) && (
                <span className={`dot ${doneFlash ? "done" : ""}`} title={phase.streaming ? "生成中" : "已完成"} />
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
                    title={
                      pinErr
                        ? `钉图失败：${pinErr}（点击重试）`
                        : pinOk
                          ? "已钉图"
                          : "钉图：把本次截图钉在识别面板上方"
                    }
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
                    title={ocrPinned ? "取消钉住面板" : "钉住面板（点空白不关闭）"}
                  >
                  {ocrPinned ? <PinOff size={13} strokeWidth={1.75} /> : <Pin size={13} strokeWidth={1.75} />}
                </button>
              )}
              <button
                className="tool"
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
                title={phase.output ? "复制结果" : "复制识别文本"}
              >
                {copiedOcr ? CheckIcon : CopyIcon}
              </button>
              <button
                className="tool"
                onClick={guarded(() => {
                  // ✕ = 收起并解除钉住（下次识别不被钉住状态误保留）
                  setOcrPinnedState(false);
                  invoke("set_ocr_pinned", { pinned: false }).catch(() => undefined);
                  invoke("hide_ocr_window").catch(() => undefined);
                  setPhase({ kind: "bar" });
                })}
                title="收起"
              >
                {CloseIcon}
              </button>
            </span>
          </header>
          <div className="ocr-main">
            <div className={`ocr-source-wrap ${phase.actionId ? "has-result" : ""}`}>
              <div
                ref={sourceRef}
                className={`ocr-source ${phase.expanded ? "expanded" : ""}`}
              >
                {phase.text}
              </div>
              {/* 原文超 3 行（或已展开）才显示折叠切换，短文本不显示 */}
              {(sourceOverflow || phase.expanded) && (
                <button
                  className="ocr-toggle"
                  onClick={guarded(() =>
                    setPhase((p) => (p.kind === "ocr" ? { ...p, expanded: !p.expanded } : p)),
                  )}
                  title={phase.expanded ? "收起原文" : "展开原文"}
                >
                  <ChevronDown
                    size={13}
                    strokeWidth={2}
                    className={`chev-svg ${phase.expanded ? "open" : ""}`}
                  />
                </button>
              )}
            </div>
            {phase.actionId && (
              <div className="ocr-result-scroll" ref={ocrBodyRef} onScroll={onOcrResultScroll}>
                <div className="ocr-result md">
                {phase.output ? (
                  <>
                    <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>
                      {(phase.actionId === "translate"
                        ? splitTranslate(phase.output).main
                        : phase.output) + (phase.streaming ? " ▍" : "")}
                    </ReactMarkdown>
                    {phase.actionId === "translate" &&
                      splitTranslate(phase.output).notes &&
                      !phase.streaming && (
                        <div className="notes md">
                          <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>
                            {splitTranslate(phase.output).notes}
                          </ReactMarkdown>
                        </div>
                      )}
                  </>
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
                {phase.streaming && !ocrStick && (
                  <button
                    className="jump-down"
                    onClick={guarded(ocrJumpToBottom)}
                    title="回到底部"
                  >
                    <ChevronDown size={13} strokeWidth={2} />
                  </button>
                )}
              </div>
            )}
            {/* 动作行：固定在面板最底部（不随结果滚动）。
                AI 动作（翻译/解释/总结）结果内嵌滚动区；搜索为本地动作，
                用识别文本直接打开默认引擎——对识别出的书名/术语等尤其实用 */}
            <div className="ocr-actions">
              {ACTIONS.filter(
                (a) => (a.buildMessages || a.id === "search") && actions[a.id] !== false,
              ).map((a) => (
                <span key={a.id} className="action-slot">
                  <button
                    className={`action sm ${phase.actionId === a.id ? "active" : ""}`}
                    onClick={guarded(() => {
                      setMenu(null);
                      runAction(a.id);
                    })}
                  >
                    <span className="ic">{ICONS[a.id]}</span>
                    <span>{a.label}</span>
                  </button>
                  {(a.id === "translate" || a.id === "search") &&
                    (a.id === "translate"
                      ? enabledTranslates.length > 1
                      : enabledEngines.length > 1) && (
                      <button
                        className="chev"
                        title={a.id === "translate" ? "更多翻译服务" : "更多搜索引擎"}
                        onClick={guarded(() =>
                          setMenu((m) => (m === a.id ? null : (a.id as "search" | "translate"))),
                        )}
                      >
                        <ChevronDown
                          size={13}
                          strokeWidth={2}
                          className={`chev-svg ${menu === a.id ? "open" : ""}`}
                        />
                      </button>
                    )}
                </span>
              ))}
            </div>
            {/* 二级菜单：与划词行为一致，展开在动作行正下方 */}
            {menu === "translate" && enabledTranslates.length > 1 && (
              <div className="chips">
                {enabledTranslates.map((s) => (
                  <button
                    key={s.id}
                    className={`chip ${defaultTranslate?.id === s.id ? "primary" : ""}`}
                    onClick={guarded(() => {
                      setMenu(null);
                      runAction("translate", s.id);
                    })}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            )}
            {menu === "search" && enabledEngines.length > 1 && (
              <div className="chips">
                {enabledEngines.map((e) => (
                  <button
                    key={e.name}
                    className={`chip ${defaultEngine?.name === e.name ? "primary" : ""}`}
                    onClick={guarded(() => {
                      setMenu(null);
                      openEngine(e, phase.text);
                    })}
                  >
                    {e.name}
                  </button>
                ))}
              </div>
            )}
          </div>
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
