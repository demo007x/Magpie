import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
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
  Languages,
  Lightbulb,
  Mail,
  Phone,
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
  copy: <Copy size={15} strokeWidth={1.75} />,
  search: <Search size={15} strokeWidth={1.75} />,
  translate: <Languages size={15} strokeWidth={1.75} />,
  explain: <Lightbulb size={15} strokeWidth={1.75} />,
  summarize: <AlignLeft size={15} strokeWidth={1.75} />,
  link: <ExternalLink size={15} strokeWidth={1.75} />,
  email: <Mail size={15} strokeWidth={1.75} />,
  code: <ClipboardCheck size={15} strokeWidth={1.75} />,
  tel: <Phone size={15} strokeWidth={1.75} />,
  __extract: <ScanSearch size={15} strokeWidth={1.75} />,
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
  };

// 翻译的富结果：译文主体 + 要点（学习辅助）。展示分层，复制只取译文。
function splitTranslate(output: string): { main: string; notes: string | null } {
  let s = output.trim();
  if (s.startsWith("【译文】")) s = s.slice(4).trim();
  const i = s.indexOf("【要点】");
  if (i < 0) return { main: s, notes: null };
  return { main: s.slice(0, i).trim(), notes: s.slice(i + 4).trim() || null };
}

export default function App() {
  const [text, setText] = useState("");
  const [pending, setPending] = useState<{ x: number; y: number } | null>(null);
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
  const copiedTimerRef = useRef<number | undefined>(undefined);
  const copiedAllTimerRef = useRef<number | undefined>(undefined);
  const copiedItemTimerRef = useRef<number | undefined>(undefined);
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

  const openEngine = (engine: SearchEngine) => {
    const tpl = engine.url.includes("{q}") ? engine.url : `${engine.url}{q}`;
    invoke("open_url", { url: tpl.replace("{q}", encodeURIComponent(text.trim())) })
      .then(() => flash("search", "已打开"))
      .catch(() => flash("search", "打开失败"));
  };
  const [phase, setPhase] = useState<Phase>({ kind: "bar" });
  // 流式增量渲染后：贴底状态才跟随滚动（用户上翻阅读时不打扰）；新一轮结果从贴底开始跟随
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [phase]);

  useEffect(() => {
    if (phase.kind === "result" && phase.output === "") {
      stickRef.current = true;
      setStick(true);
    }
  }, [phase]);

  const stageRef = useRef<HTMLDivElement>(null);
  const runIdRef = useRef(0);
  const streamingRef = useRef(false);

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

    listen<{ text: string; x: number; y: number }>("selection://captured", (e) => {
      invoke("ui_debug_log", {
        msg: `收到 captured 事件：len=${e.payload.text.length} (${e.payload.x.toFixed(0)},${e.payload.y.toFixed(0)})`,
      }).catch(() => undefined);
      resetGhostStates();
      // 新选区使进行中的流失效（否则 streamingRef 卡住，dismiss 会被误拦）
      runIdRef.current++;
      streamingRef.current = false;
      setMenu(null);
      setPending({ x: e.payload.x, y: e.payload.y });
      setText(e.payload.text);
      setPhase({ kind: "bar" });
    }).then((un) => unlisteners.push(un));

    listen("selection://dismiss", () => {
      // 任务流式进行中不打断；其余点击空白即隐藏
      if (streamingRef.current) {
        invoke("ui_debug_log", { msg: "忽略 dismiss：任务进行中" }).catch(() => undefined);
        return;
      }
      invoke("hide_floating_bar").catch(() => undefined);
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

  // 渲染后测量内容尺寸 → 按锚点定位/调整窗口（自适应）；尺寸不变时不重复调窗口
  const lastSizeRef = useRef("");
  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const w = Math.ceil(rect.width);
    const h = Math.ceil(rect.height);
    const sizeKey = `${w}x${h}`;
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

  // 动作按钮的短暂文字反馈（已复制 / 已打开 / 不支持…）
  const flash = (id: string, msg: string) => {
    setFlashId(id);
    setFlashMsg(msg);
    if (flashTimerRef.current) window.clearTimeout(flashTimerRef.current);
    flashTimerRef.current = window.setTimeout(() => setFlashId(null), 1200);
  };

  const runAction = (id: string, serviceOverride?: string) => {
    const action = actionById(id);
    if (!action || !text.trim()) return;

    // 本地动作：不经 AI，前端即时完成
    if (action.kind === "local") {
      const t = text.trim();

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
        openEngine(defaultEngine);
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
        setPhase({
          kind: "result",
          actionId: id,
          output: "",
          streaming: true,
          error: null,
          service: svc,
        });
        const trimmed = text.trim();
        const isDeepl = svc === "deepl";
        // 中文→英文，其他→中文；目标语言代码 DeepL 用大写（EN/ZH）
        const to = /[一-鿿]/.test(trimmed) ? (isDeepl ? "EN" : "en") : (isDeepl ? "ZH" : "zh");
        invoke<string>(isDeepl ? "deepl_translate" : "baidu_translate", { text: trimmed, to })
          .then((out) => {
            if (runIdRef.current !== runId) return;
            streamingRef.current = false;
            setPhase((p) => (p.kind === "result" ? { ...p, output: out, streaming: false } : p));
          })
          .catch((e) => {
            if (runIdRef.current !== runId) return;
            streamingRef.current = false;
            setPhase((p) =>
              p.kind === "result" ? { ...p, streaming: false, error: String(e) } : p,
            );
          });
        return;
      }
    }

    const runId = ++runIdRef.current;
    if (!action.buildMessages) return;
    streamingRef.current = true;
    setPhase({
      kind: "result",
      actionId: id,
      output: "",
      streaming: true,
      error: null,
      service: serviceOverride,
    });

    aiChat(action.buildMessages(text), null, {
      onDelta: (chunk) => {
        if (runIdRef.current !== runId) return;
        setPhase((p) => (p.kind === "result" ? { ...p, output: p.output + chunk } : p));
      },
      onDone: () => {
        if (runIdRef.current !== runId) return;
        streamingRef.current = false;
        setPhase((p) => (p.kind === "result" ? { ...p, streaming: false } : p));
      },
      onError: (message) => {
        if (runIdRef.current !== runId) return;
        streamingRef.current = false;
        setPhase((p) => (p.kind === "result" ? { ...p, streaming: false, error: message } : p));
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
    // 结果文本区保留文字选择/复制，不作为拖拽起点
    if ((e.target as HTMLElement).closest(".panel-body")) return;
    dragStartRef.current = { sx: e.screenX, sy: e.screenY };
  };

  const onStageMouseMove = (e: ReactMouseEvent) => {
    const s = dragStartRef.current;
    if (!s || dragActiveRef.current) return;
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

      {menu === "search" && enabledEngines.length > 1 && (
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

      {phase.kind === "result" && (
        <div className="panel">
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

      {phase.kind === "extract" && (
        <div className="panel">
          <header className="panel-head">
            <span className="panel-title">
              <span className="ic">
                <ScanSearch size={15} strokeWidth={1.75} />
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
    </div>
  );
}
