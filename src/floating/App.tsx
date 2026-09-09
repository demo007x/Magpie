import { useEffect, useLayoutEffect, useRef, useState } from "react";
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
  Copy,
  Languages,
  Lightbulb,
  Search,
  X,
} from "lucide-react";
import { ACTIONS, actionById } from "../shared/actions";
import { aiChat } from "../shared/ai";
import type { SearchEngine, Settings } from "../shared/types";

// ---- 图标（lucide-react 图标库，统一 15px / 1.75 描边，随文字色） ----
const ICONS: Record<string, React.ReactNode> = {
  copy: <Copy size={15} strokeWidth={1.75} />,
  search: <Search size={15} strokeWidth={1.75} />,
  translate: <Languages size={15} strokeWidth={1.75} />,
  explain: <Lightbulb size={15} strokeWidth={1.75} />,
  summarize: <AlignLeft size={15} strokeWidth={1.75} />,
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

// 状态机：Bar（胶囊） → Result（流式面板）；dismiss/新选区回收
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
  const copiedTimerRef = useRef<number | undefined>(undefined);
  const flashTimerRef = useRef<number | undefined>(undefined);

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

  // 按用户自定义顺序渲染（未配置的按注册表顺序排在后面）
  const visibleActions = ACTIONS.filter((a) => actions[a.id] !== false).sort((a, b) => {
    const ia = actionOrder.indexOf(a.id);
    const ib = actionOrder.indexOf(b.id);
    return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
  });

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
        {visibleActions.map((a) => (
          <span key={a.id} className="action-slot">
            <button
              className="action"
              title={
                a.id === "search" && defaultEngine
                  ? `用${defaultEngine.name}搜索`
                  : a.id === "translate" && defaultTranslate
                    ? `当前默认：${defaultTranslate.label}`
                    : undefined
              }
              onClick={guarded(() => {
                setMenu(null); // 执行动作即收起展开中的菜单（chips 不滞留在主条与结果面板之间）
                runAction(a.id);
              })}
            >
              <span className="ic">{ICONS[a.id]}</span>
              <span>{flashId === a.id ? flashMsg : a.label}</span>
            </button>
            {((a.id === "search" && enabledEngines.length > 1) ||
              (a.id === "translate" && enabledTranslates.length > 1)) && (
                <button
                  className="chev"
                  title={a.id === "search" ? "更多搜索引擎" : "更多翻译服务"}
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
          <div className="panel-body">
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
    </div>
  );
}
