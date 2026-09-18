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
      title="识别原文（可编辑，改后重新执行动作）"
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
  // 首次 mousemove 即恢复
  const [hoverSuppress, setHoverSuppress] = useState(false);
  const barRef = useRef<HTMLDivElement | null>(null);
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
  const ocrMainRef = useRef<HTMLDivElement | null>(null);
  // 二级菜单槽位（动作行正下方）：开合状态机按它量菜单高度
  const menuSlotRef = useRef<HTMLDivElement | null>(null);
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

  // hover 挂起恢复：弹出后首次移动鼠标即恢复正常 hover 反馈
  useEffect(() => {
    if (!hoverSuppress) return;
    const onMove = () => setHoverSuppress(false);
    window.addEventListener("mousemove", onMove, { once: true });
    return () => window.removeEventListener("mousemove", onMove);
  }, [hoverSuppress]);

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
    // Liquid Glass（macOS 26）：生效则表面切半透明让玻璃透出；
    // 监听设置页开关的广播，运行时切换即时生效
    const applyGlass = (on: boolean) =>
      document.documentElement.classList.toggle("liquid-glass", on);
    invoke<boolean>("liquid_glass_enabled")
      .then(applyGlass)
      .catch(() => undefined);
    listen<boolean>("theme://liquid-glass", (e) => applyGlass(e.payload)).catch(() => undefined);
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
          forceUnfreezeMenu(); // 强制解冻结果区：面板重建，不允许残留冻结高度
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
      setHoverSuppress(true);
    };

    const unlisteners: Array<() => void> = [];

    listen<{ text: string; x: number; y: number; app?: string }>("selection://captured", (e) => {
      // 钉图窗口与划词流无关：忽略广播（防止误触发浮动条弹出/窗口移动）
      if (IS_PIN) return;
      invoke("ui_debug_log", {
        msg: `收到 captured 事件：len=${e.payload.text.length} (${e.payload.x.toFixed(0)},${e.payload.y.toFixed(0)}) app=${e.payload.app ?? "-"}`,
      }).catch(() => undefined);
      resetGhostStates();
      // 清除上一个操作可能残留的焦点态（避免新胶囊里按钮呈现选中样式）
      (document.activeElement as HTMLElement | null)?.blur?.();
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
            ocrReadyRef.current = false;
            setOcrPinnedState(p.pinned);
            setMenu(null); // 新结果回收展开中的二级菜单（防陈旧菜单泄漏进新面板）
            setUsedTranslate(null); // 选中态回落到默认服务
            setUsedEngine(null);
            forceUnfreezeMenu(); // 强制解冻结果区：面板重建，不允许残留冻结高度
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

  // 识别原文是否超过折叠高度：决定展开/收起按钮显示与否。
  // 基准是折叠高度常量（63px，与 CSS 的 flex-basis 折叠基数一致）而非 clientHeight——
  // flex-basis 有 240ms 过渡，展开→收起瞬间测 clientHeight 仍是动画中间值，
  // 会把「有溢出」误判成「无溢出」导致切换按钮消失
  useLayoutEffect(() => {
    if (phase.kind !== "ocr") return;
    const el = sourceRef.current;
    if (!el) return;
    setSourceOverflow(el.scrollHeight > 63 + 1);
  }, [phase]);

  // 结果窗口尺寸模型：宽高只由用户拖动决定（内容永不改变窗口尺寸），
  // 唯一例外是二级菜单展开——窗口向下生长「菜单高度」，见下方 menu effect。
  // 窗口就绪链路：pending 消费后触发 ocr_window_ready（Rust 侧先落用户尺寸再定位显示）
  useEffect(() => {
    if (!IS_OCR) return;
    if (phase.kind !== "ocr" && phase.kind !== "extract") return;
    if (ocrReadyRef.current) return;
    ocrReadyRef.current = true;
    invoke("ocr_window_ready").catch(() => undefined);
  }, [phase]);

  // 二级菜单开合（footer 模型 + 短命冻结）：
  // 布局 = [原文（仅 fromOcr 识别流）][结果区 flex:1][动作行][菜单槽位]。
  // 展开 = ①先把结果区当前高度读出并冻结（必须先读后写）②菜单进入流内。
  //   冻结期间列内容超出窗口的部分被 .ocr-main 裁切——主菜单/内容零位移；
  // 解冻有三重保障，冻结不可能长期残留（过期高度 → footer 悬空的根源）：
  //   ① resize 确认落位（无闪动的主路径）② invoke 返回后 400ms 超时兜底
  //   ③ 新结果到达强制解冻。解冻时弹性高度恰等于冻结值 → 零可见变化
  const menuFrozenRef = useRef(false);
  const menuGrowRef = useRef(0);
  const menuBaseHRef = useRef(0);
  const menuTargetHRef = useRef(0);
  const menuVerifyGenRef = useRef(0);
  const menuUnfreezeTimerRef = useRef<number | null>(null);
  const forceUnfreezeMenu = () => {
    if (menuUnfreezeTimerRef.current !== null) {
      window.clearTimeout(menuUnfreezeTimerRef.current);
      menuUnfreezeTimerRef.current = null;
    }
    if (!menuFrozenRef.current) return;
    menuFrozenRef.current = false;
    const scroll = ocrBodyRef.current;
    if (scroll) {
      scroll.style.flex = "";
      scroll.style.height = "";
    }
  };
  const verifyMenuGrow = (expected: number, attempt = 0) => {
    const gen = ++menuVerifyGenRef.current;
    const t0 = performance.now();
    const tick = () => {
      if (gen !== menuVerifyGenRef.current) return; // 已被更新的校验接管
      if (Math.abs(window.innerHeight - expected) <= 1) return; // 落位 ✓
      if (performance.now() - t0 < 500) {
        requestAnimationFrame(tick);
        return;
      }
      if (attempt >= 2) {
        invoke("ui_debug_log", {
          msg: `[menu-grow] 未落位 inner=${window.innerHeight.toFixed(1)} expected=${expected.toFixed(1)}`,
        }).catch(() => undefined);
        return;
      }
      invoke("ui_debug_log", {
        msg: `[menu-grow] 重试${attempt + 1} inner=${window.innerHeight.toFixed(1)} expected=${expected.toFixed(1)}`,
      }).catch(() => undefined);
      invoke("set_result_menu_grow", { grow: menuGrowRef.current }).catch(() => undefined);
      verifyMenuGrow(expected, attempt + 1);
    };
    requestAnimationFrame(tick);
  };

  // 解冻主路径：窗口尺寸落位（resize 确认）后恢复结果区弹性——
  // 此刻弹性高度恰等于冻结值，解除动作不产生任何可见变化
  useEffect(() => {
    if (!IS_OCR) return;
    const onResize = () => {
      if (!menuFrozenRef.current) return;
      if (Math.abs(window.innerHeight - menuTargetHRef.current) > 1) return;
      forceUnfreezeMenu();
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useLayoutEffect(() => {
    if (!IS_OCR || phase.kind !== "ocr") return;
    const main = ocrMainRef.current;
    const slot = menuSlotRef.current;
    const scroll = ocrBodyRef.current;
    if (!main || !slot) return;

    if (menu === null) {
      // 收起：只要有待收回的生长量就必须下发 grow=0（此时冻结多半已随
      // 展开落位解除——不能以冻结与否作为守卫，否则窗口永远缩不回去）
      if (menuGrowRef.current === 0 && !menuFrozenRef.current) return;
      menuGrowRef.current = 0;
      menuTargetHRef.current = menuBaseHRef.current;
      invoke("set_result_menu_grow", { grow: 0 })
        .then(() => verifyMenuGrow(menuTargetHRef.current))
        .catch((e) => {
          invoke("ui_debug_log", { msg: `[menu-grow] invoke 失败: ${String(e)}` }).catch(
            () => undefined,
          );
        });
      return;
    }

    if (!menuFrozenRef.current && scroll) {
      // 结果区存在时冻结它（只缩不涨的弹性区是唯一会被菜单挤压的元素）；
      // 无结果区（如文本识别尚未执行动作）则没有可挤压元素，无需冻结
      menuBaseHRef.current = window.innerHeight;
      const h = scroll.getBoundingClientRect().height; // 先读：当前视觉高度
      scroll.style.flex = "0 0 auto"; // 后写：按读到的高度冻结
      scroll.style.height = `${Math.ceil(h)}px`;
      menuFrozenRef.current = true;
    }
    const mainRect = main.getBoundingClientRect();
    const slotRect = slot.getBoundingClientRect();
    const grow = Math.max(0, Math.ceil(slotRect.bottom + 3 - mainRect.bottom));
    if (grow === menuGrowRef.current) return;
    menuGrowRef.current = grow;
    menuTargetHRef.current = menuBaseHRef.current + grow;
    const expected = menuTargetHRef.current;
    invoke("set_result_menu_grow", { grow })
      .then(() => {
        invoke("ui_debug_log", {
          msg: `[menu-grow] 已下发 grow=${grow} base=${menuBaseHRef.current.toFixed(1)} expected=${expected.toFixed(1)}`,
        }).catch(() => undefined);
        verifyMenuGrow(expected);
        // 超时兜底：resize 事件缺失/竞态时，冻结最多存活 400ms
        if (menuUnfreezeTimerRef.current !== null) {
          window.clearTimeout(menuUnfreezeTimerRef.current);
        }
        menuUnfreezeTimerRef.current = window.setTimeout(() => {
          menuUnfreezeTimerRef.current = null;
          if (menuFrozenRef.current) forceUnfreezeMenu();
        }, 400);
      })
      .catch((e) => {
        // 不再静默吞错：命令未注册/参数错误等都必须在日志里现形
        invoke("ui_debug_log", { msg: `[menu-grow] invoke 失败: ${String(e)}` }).catch(
          () => undefined,
        );
      });
  }, [menu, phase]);

  // 胶囊条：渲染后测量内容尺寸 → 通知窗口调整（自适应）；尺寸不变时不重复调
  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar) return;

    const clampNum = (v: number, lo: number, hi: number) =>
      Math.max(lo, Math.min(hi, v));

    // 胶囊：bar + 展开的二级菜单（chips）都要量进去，否则菜单会被窗口裁掉
    {
      const chips = document.querySelector<HTMLElement>(".chips");

      // 自然宽：bar 与 chips 均不折行
      bar.style.width = "max-content";
      bar.style.flex = "0 0 auto";
      bar.style.height = "auto";
      let chipsW = 0;
      if (chips) {
        chips.style.width = "max-content";
        chips.style.height = "auto";
        chipsW = Math.ceil(chips.getBoundingClientRect().width);
      }
      const natW = Math.max(
        Math.ceil(bar.getBoundingClientRect().width),
        chipsW,
      );
      const tw = clampNum(natW, 280, 640);

      // 定宽后量高（chips 超宽时折行）
      bar.style.width = `${tw}px`;
      if (chips) chips.style.width = `${tw}px`;
      const barH = Math.ceil(bar.getBoundingClientRect().height);
      const chipsH = chips ? Math.ceil(chips.getBoundingClientRect().height) : 0;
      const th = barH + (chips ? 6 + chipsH : 0); // 6 = stage gap

      bar.style.cssText = "";
      if (chips) chips.style.cssText = "";

      const sizeKey = `${tw}x${th}`;
      if (pending) {
        lastSizeRef.current = sizeKey;
        invoke("show_floating_bar", { x: pending.x, y: pending.y, width: tw, height: th })
          .catch(() => undefined)
          .finally(() => setPending(null));
      } else if (sizeKey !== lastSizeRef.current) {
        lastSizeRef.current = sizeKey;
        invoke("resize_floating", { width: tw, height: th }).catch(() => undefined);
      }
    }
  }, [phase, pending, menu, flashId]);

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
      className={`stage ${hoverSuppress ? "suppress-hover" : ""}`}
      onMouseDown={onStageMouseDown}
      onMouseMove={onStageMouseMove}
      onMouseUp={onStageMouseUp}
    >
      {/* 划词胶囊条：仅主浮动窗口渲染（OCR 独立窗口只显示识别面板） */}
      {!IS_OCR && (
      <div className="bar" role="toolbar" ref={barRef}>
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
          onMouseDown={IS_OCR ? onOcrPanelDown : undefined}
        >
          <header className={`panel-head ${IS_OCR ? "grab" : ""}`}>
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
          <div className="ocr-main" ref={ocrMainRef}>
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
            )}
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
              </div>
            )}
            {/* 动作行：常规流内布局排在结果区之后、面板最底部（不随结果滚动）。
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
                      setMenu(null); // 切换/执行动作即收起已展开的子菜单（选择器只属于当前动作）
                      if (a.id === "translate") setUsedTranslate(null); // 主按钮走默认服务
                      if (a.id === "search") setUsedEngine(null);
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
              {/* 回到底部：悬浮于结果区右下、动作行上方（流式 + 用户上翻时出现） */}
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
            {/* 二级菜单槽位：常规流内紧跟动作行（正下方），是 footer 的一部分。
                展开时结果区短暂冻结定高 + 窗口向下生长菜单高度——
                主菜单/内容零位移；选择服务后保持展开，再点 ⌄ 才收起 */}
            <div className="ocr-menu-slot" ref={menuSlotRef}>
              {menu === "translate" && enabledTranslates.length > 1 && (
                <div className="chips">
                  {enabledTranslates.map((s) => (
                    <button
                      key={s.id}
                      className={`chip ${(usedTranslate ?? defaultTranslate?.id) === s.id ? "primary" : ""}`}
                      onClick={guarded(() => {
                        setUsedTranslate(s.id); // 点击哪个哪个选中
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
                      className={`chip ${(usedEngine ?? defaultEngine?.name) === e.name ? "primary" : ""}`}
                      onClick={guarded(() => {
                        setUsedEngine(e.name); // 点击哪个哪个选中
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
