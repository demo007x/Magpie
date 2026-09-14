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
    kind: "result";
    actionId: string;
    output: string;
    streaming: boolean;
    error: string | null;
    /** 本次结果使用的翻译服务（重试保持同一服务） */
    service?: string;
  }
  | {
    kind: "extract";
    /** 主要实体类型（决定面板图标） */
    actionId: string;
    label: string;
    groups: ExtractGroups;
  }
  | {
    /** OCR 文本识别：合并面板（文本可见 + 动作内嵌 + 结果流式） */
    kind: "ocr";
    text: string;
    actionId: string | null;
    output: string;
    streaming: boolean;
    error: string | null;
    expanded: boolean;
  };

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
  // 结果面板复制成功的短暂反馈（图标变对勾）
  const [copied, setCopied] = useState(false);
  // 提取列表（多值面板）的复制反馈
  const [copiedAll, setCopiedAll] = useState(false);
  // 提取列表行内复制的反馈（记录条目内容）
  const [copiedItem, setCopiedItem] = useState<string | null>(null);
  // OCR 面板复制的反馈（复制结果 / 复制识别文本）
  const [copiedOcr, setCopiedOcr] = useState(false);
  // OCR 面板「钉图」成功的反馈（图标短暂变对勾）
  const [pinOk, setPinOk] = useState(false);
  // 钉图失败的反馈（图标变红 + title 显示具体原因，直到下次重试）
  const [pinErr, setPinErr] = useState<string | null>(null);
  const copiedTimerRef = useRef<number | undefined>(undefined);
  const copiedAllTimerRef = useRef<number | undefined>(undefined);
  const copiedItemTimerRef = useRef<number | undefined>(undefined);
  const copiedOcrTimerRef = useRef<number | undefined>(undefined);
  const pinOkTimerRef = useRef<number | undefined>(undefined);
  const flashTimerRef = useRef<number | undefined>(undefined);
  // 流式输出跟随：默认贴底自动滚动；用户向上滚动离开底部则冻结，滚回底部恢复
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);
  const [stick, setStick] = useState(true);

  const onBodyScroll = () => {
    const el = bodyRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    stickRef.current = atBottom;
    setStick(atBottom);
  };

  const jumpToBottom = () => {
    const el = bodyRef.current;
    if (!el) return;
    stickRef.current = true;
    setStick(true);
    // 平滑滚动到底（跟随期间的增量滚动保持瞬时，避免追逐感）
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };

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
    const el = bodyRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
    const ocrEl = ocrBodyRef.current;
    if (ocrEl && ocrStickRef.current) ocrEl.scrollTop = ocrEl.scrollHeight;
  }, [phase]);

  useEffect(() => {
    if (phase.kind === "result" && phase.output === "") {
      stickRef.current = true;
      setStick(true);
    }
    if (phase.kind === "ocr") {
      ocrStickRef.current = true;
      setOcrStick(true);
    }
  }, [phase]);

  const stageRef = useRef<HTMLDivElement>(null);
  const runIdRef = useRef(0);
  const streamingRef = useRef(false);
  // 划词结果面板宽度：跟随触发时的胶囊宽度（宽度切换不跳变）
  const [panelW, setPanelW] = useState(396);
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
          // actionId 取数量最多的实体类型（决定面板图标）
          setPhase({
            kind: "extract",
            actionId: dominantGroup(extracted.groups),
            label: "提取信息",
            groups: extracted.groups,
          });
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
      invoke<string | null>("ocr_take_pending")
        .then((t) => {
          if (t) {
            // 新结果：重置测量/显示状态，确保面板必然重新显示
            lastSizeRef.current = "";
            ocrReadyRef.current = false;
            setPhase({
              kind: "ocr",
              text: t,
              actionId: null,
              output: "",
              streaming: false,
              error: null,
              expanded: false,
            });
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
        invoke<string | null>("ocr_take_pending")
          .then((t) => {
            if (t) {
              // 新结果：重置测量/显示状态——若尺寸与上次相同也必须重新显示窗口
              lastSizeRef.current = "";
              ocrReadyRef.current = false;
              setPhase({
                kind: "ocr",
                text: t,
                actionId: null,
                output: "",
                streaming: false,
                error: null,
                expanded: false,
              });
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
    if (IS_OCR && phase.kind === "ocr" && sizeKey !== lastSizeRef.current) {
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

  const runAction = (id: string, serviceOverride?: string) => {
    const action = actionById(id);
    if (!action) return;
    // 动作文本源：OCR 面板用识别文本，普通划词用选中文本
    const source = phase.kind === "ocr" ? phase.text : text;
    if (!source.trim()) return;

    // 结果面板宽度跟随胶囊当前宽度（300–560 夹取）：
    // 胶囊 → 面板切换时窗口宽度无缝衔接，不会突然变宽
    const snapPanelW = () => {
      const w = document.querySelector(".bar")?.getBoundingClientRect().width ?? 0;
      setPanelW(Math.min(560, Math.max(300, Math.ceil(w))));
    };

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
        const runId = ++runIdRef.current;
        streamingRef.current = true;
        if (phase.kind === "ocr") {
          setPhase({ ...phase, actionId: id, output: "", streaming: true, error: null });
        } else {
          snapPanelW();
          setPhase({
            kind: "result",
            actionId: id,
            output: "",
            streaming: true,
            error: null,
            service: svc,
          });
        }
        const trimmed = source.trim();
        const isDeepl = svc === "deepl";
        // 中文→英文，其他→中文；目标语言代码 DeepL 用大写（EN/ZH）
        const to = /[一-鿿]/.test(trimmed) ? (isDeepl ? "EN" : "en") : (isDeepl ? "ZH" : "zh");
        invoke<string>(isDeepl ? "deepl_translate" : "baidu_translate", { text: trimmed, to })
          .then((out) => {
            if (runIdRef.current !== runId) return;
            streamingRef.current = false;
            setPhase((p) =>
              p.kind === "result" || p.kind === "ocr" ? { ...p, output: out, streaming: false } : p,
            );
          })
          .catch((e) => {
            if (runIdRef.current !== runId) return;
            streamingRef.current = false;
            setPhase((p) =>
              p.kind === "result" || p.kind === "ocr"
                ? { ...p, streaming: false, error: String(e) }
                : p,
            );
          });
        return;
      }
    }

    const runId = ++runIdRef.current;
    if (!action.buildMessages) return;
    streamingRef.current = true;
    // OCR 合并面板：结果直接渲染在面板内（原文区下方），动作可反复切换
    if (phase.kind === "ocr") {
      setPhase({ ...phase, actionId: id, output: "", streaming: true, error: null });
    } else {
      snapPanelW();
      setPhase({
        kind: "result",
        actionId: id,
        output: "",
        streaming: true,
        error: null,
        service: serviceOverride,
      });
    }

    aiChat(action.buildMessages(source), null, {
      onDelta: (chunk) => {
        if (runIdRef.current !== runId) return;
        setPhase((p) =>
          p.kind === "result" || p.kind === "ocr" ? { ...p, output: p.output + chunk } : p,
        );
      },
      onDone: () => {
        if (runIdRef.current !== runId) return;
        streamingRef.current = false;
        setPhase((p) => (p.kind === "result" || p.kind === "ocr" ? { ...p, streaming: false } : p));
      },
      onError: (message) => {
        if (runIdRef.current !== runId) return;
        streamingRef.current = false;
        setPhase((p) =>
          p.kind === "result" || p.kind === "ocr" ? { ...p, streaming: false, error: message } : p,
        );
      },
    });
  };

  const backToBar = () => {
    runIdRef.current++;
    streamingRef.current = false;
    setPhase({ kind: "bar" });
  };

  const copyResult = () => {
    if (phase.kind === "result" && phase.output) {
      // 翻译只复制译文本体（要点为展示层的学习辅助，不进剪贴板）
      const payload =
        phase.actionId === "translate" ? splitTranslate(phase.output).main : phase.output;
      navigator.clipboard.writeText(payload).then(
        () => {
          setCopied(true);
          if (copiedTimerRef.current) window.clearTimeout(copiedTimerRef.current);
          copiedTimerRef.current = window.setTimeout(() => setCopied(false), 1200);
        },
        () => undefined,
      );
    }
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
      className="stage"
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

      {!IS_OCR && phase.kind === "result" && (
        <div className="panel" style={{ width: panelW }}>
          <header className="panel-head">
            <span className="panel-title">
              <span className="ic">{ICONS[phase.actionId]}</span>
              {actionById(phase.actionId)?.label}
            </span>
            <span className="panel-tools">
              {phase.streaming && <span className="dot" title="生成中" />}
              <button
                className="tool"
                onClick={guarded(copyResult)}
                title={copied ? "已复制" : "复制结果"}
              >
                {copied ? CheckIcon : CopyIcon}
              </button>
              <button className="tool" onClick={guarded(backToBar)} title="收起">
                {CloseIcon}
              </button>
            </span>
          </header>
          {phase.kind === "result" && phase.streaming && !stick && (
            <button className="jump-down" onClick={guarded(jumpToBottom)} title="回到底部">
              <ChevronDown size={13} strokeWidth={2} />
            </button>
          )}
          <div className="panel-body" ref={bodyRef} onScroll={onBodyScroll}>
            {phase.output ? (
              <>
                <div className="md output">
                  <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>
                    {(phase.actionId === "translate"
                      ? splitTranslate(phase.output).main
                      : phase.output) + (phase.streaming ? " ▍" : "")}
                  </ReactMarkdown>
                </div>
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
                <button className="retry" onClick={() => runAction(phase.actionId, phase.service)}>
                  重试
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {!IS_OCR && phase.kind === "extract" && (
        <div className="panel">
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
              <button className="tool" onClick={guarded(backToBar)} title="收起">
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
        </div>
      )}

      {phase.kind === "ocr" && (
        <div className="panel">
          <header className={`panel-head ${IS_OCR ? "grab" : ""}`} onMouseDown={IS_OCR ? onOcrHeadDown : undefined}>
            <span className="panel-title">
              <span className="ic">
                <ScanSearch size={14} strokeWidth={1.75} />
              </span>
              文本识别
            </span>
            <span className="panel-tools">
              {IS_OCR && (
                <>
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
                </>
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
                {phase.streaming && <span className="dot" title="生成中" />}
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
        </div>
      )}
    </div>
  );
}
