import { useCallback, useEffect, useRef, useState } from "react";
import { Fragment } from "react";
import { Confirm, Modal } from "../shared/Modal";
import { toast } from "../shared/toast";
import { CUSTOM_ICON_CHOICES, customIconNode } from "../shared/icons";
import type { MouseEvent as ReactMouseEvent } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import {
  Ban,
  ChevronDown,
  Cpu,
  GripVertical,
  Info,
  Keyboard,
  Palette,
  Plus,
  Languages,
  Search,
  ShieldCheck,
  Sparkles,
  SquarePen,
  TextCursorInput,
  Trash2,
} from "lucide-react";
import {
  ACTIONS,
  AI_ACTION_IDS,
  CONTEXT_ACTION_IDS,
  CUSTOM_ID_PREFIX,
  DEFAULT_PROMPTS,
  effectivePrompt,
  type AiActionId,
} from "../shared/actions";
import { aiChat } from "../shared/ai";
import markIcon from "./assets/mark.svg";
import type { CustomAction, Provider, SearchEngine, Settings } from "../shared/types";

type Page =
  | "model"
  | "prompts"
  | "capture"
  | "shortcuts"
  | "perms"
  | "translate"
  | "search"
  | "blocklist"
  | "appearance"
  | "about";

const NAV_ICONS: Record<Page, React.ReactNode> = {
  model: <Cpu size={15} strokeWidth={1.75} />,
  prompts: <Sparkles size={15} strokeWidth={1.75} />,
  capture: <TextCursorInput size={15} strokeWidth={1.75} />,
  shortcuts: <Keyboard size={15} strokeWidth={1.75} />,
  perms: <ShieldCheck size={15} strokeWidth={1.75} />,
  translate: <Languages size={15} strokeWidth={1.75} />,
  search: <Search size={15} strokeWidth={1.75} />,
  blocklist: <Ban size={15} strokeWidth={1.75} />,
  appearance: <Palette size={15} strokeWidth={1.75} />,
  about: <Info size={15} strokeWidth={1.75} />,
};

// 快捷键条目注册表：新增全局快捷键 = 加一行配置 + settings 加对应字段。
// desc 只描述「按下去会发生什么」（用户视角）；录制操作说明放在页面顶部 hint
const SHORTCUT_ITEMS: Array<{
  key:
    | "ocrShortcut"
    | "ocrTranslateShortcut"
    | "ocrExplainShortcut"
    | "ocrSummarizeShortcut";
  label: string;
  desc: string;
  /** 出厂默认键位：重置按钮的目标值 */
  default: string;
}> = [
  {
    key: "ocrShortcut",
    label: "识图取字",
    default: "Alt+S",
    desc: "框选屏幕任意区域，识别其中的文字，在结果面板中查看、复制、钉住原图，或继续翻译等后续操作。默认 ⌥S。",
  },
  {
    key: "ocrTranslateShortcut",
    label: "识图翻译",
    default: "Alt+T",
    desc: "框选截图，识别出的文字自动交给默认翻译服务，结果直接呈现在面板中。默认 ⌥T。",
  },
  {
    key: "ocrExplainShortcut",
    label: "识图解释",
    default: "Alt+E",
    desc: "框选截图，AI 自动解释识别出的内容——术语、代码、生僻概念一看就懂。默认 ⌥E。",
  },
  {
    key: "ocrSummarizeShortcut",
    label: "识图总结",
    default: "Alt+D",
    desc: "框选截图，AI 自动提炼识别出的文字要点，长文一眼抓住重点。默认 ⌥D。",
  },
];

// 快捷键录制框：点击聚焦后捕获用户按下的组合键，规范化为 Tauri Shortcut 格式。
// 只读（禁手输）；Esc 取消；无修饰键的单击提示不合法（避免吞掉单键全局快捷键）。
function ShortcutRecorder({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const [recording, setRecording] = useState(false);
  const [hint, setHint] = useState("");

  return (
    <input
      readOnly
      style={{ width: 180, flexShrink: 0, cursor: "pointer" }}
      className={recording ? "recording" : ""}
      value={recording ? hint || "按下组合键…" : value}
      placeholder="点击录制，如 Alt+S"
      onFocus={() => {
        setRecording(true);
        setHint("");
      }}
      onBlur={() => setRecording(false)}
      onKeyDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.key === "Escape") {
          e.currentTarget.blur();
          return;
        }
        // 修饰键：macOS ⌘ 与 Windows Ctrl 统一存为 CmdOrCtrl（跨平台语义等价）
        const mods: string[] = [];
        if (e.metaKey) mods.push("CmdOrCtrl");
        if (e.ctrlKey) mods.push("Ctrl");
        if (e.altKey) mods.push("Alt");
        if (e.shiftKey) mods.push("Shift");
        // 只按了修饰键：先给出已按下的提示，等待主键
        if (["Control", "Meta", "Alt", "Shift"].includes(e.key)) {
          setHint(mods.length ? `${mods.join("+")}+…` : "按下组合键…");
          return;
        }
        if (mods.length === 0) {
          setHint("需至少包含一个修饰键");
          return;
        }
        let key = e.key;
        if (/^[a-z]$/i.test(key)) key = key.toUpperCase();
        else if (/^F\d{1,2}$/.test(key)) key = key.toUpperCase();
        else if (!/^\d$/.test(key)) return; // 其他主键（符号/空格等）不支持，忽略
        onChange([...mods, key].join("+"));
        e.currentTarget.blur();
      }}
    />
  );
}

const NEW_PROVIDER = (): Provider => ({
  id: `p${Date.now()}`,
  name: "自定义服务",
  baseUrl: "https://api.deepseek.com",
  apiKey: "",
  model: "deepseek-chat",
});

const ACTION_LABELS: Record<string, string> = {
  translate: "翻译",
  explain: "解释",
  summarize: "总结",
  copy: "复制",
  search: "搜索",
  link: "打开链接",
  email: "写邮件",
  code: "复制验证码",
  tel: "复制号码",
  date: "加入日历",
  addr: "打开地图",
};

const ACTION_DESC: Record<string, string> = {
  translate: "中文译英文，其他译中文，附学习要点",
  explain: "解释选中内容是什么、为什么重要",
  summarize: "按内容体量提炼要点，长短自适应",
  copy: "复制选中的原文",
  search: "用默认搜索引擎搜索选中内容",
  link: "选中的是网址时，一键打开网页",
  email: "选中的是邮箱时，唤起邮件客户端",
  code: "选中含验证码时，一键复制纯数字",
  tel: "选中含电话号码时，一键复制号码",
  date: "选中含日期时间时（如“周四下午3点”），一键预填进日历",
  addr: "选中含地点时（如“国贸B座”），一键在地图打开",
};

const isAiAction = (id: string) => ACTIONS.find((a) => a.id === id)?.kind === "ai";

/** 动作行序的唯一真相：已排顺序 + 内置 + 自定义（未排过的追加末尾）。
    自定义动作 id 带 "c:" 前缀，与内置同池混排，胶囊按这份顺序取前 N 个。
    末尾过滤：只保留今天仍然存在的动作——手改配置或删动作后残留的 id 会渲染成空白行 */
const allActionIds = (s: Settings) =>
  [
    ...new Set([...s.actionOrder, ...Object.keys(s.actions), ...s.customActions.map((c) => c.id)]),
  ].filter((id) => id in s.actions || s.customActions.some((c) => c.id === id));

// 系统内置引擎（与 Rust default_engines 同名单）：不可删除，只可停用/排序
const BUILTIN_ENGINES = new Set(["百度AI", "百度", "GoogleAI", "Google", "必应", "GitHub"]);

const ENGINE_PRESETS: Array<[string, string]> = [
  ["百度AI", "https://wenxin.baidu.com/search?word={q}"],
  ["百度", "https://www.baidu.com/s?wd={q}"],
  ["GoogleAI", "https://www.google.com/search?q={q}&udm=50"],
  ["Google", "https://www.google.com/search?q={q}"],
  ["必应", "https://www.bing.com/search?q={q}"],
  ["GitHub", "https://github.com/search?q={q}"],
];

// 翻译服务注册表（id 与浮动条/后端约定）
const TRANSLATE_SERVICES: Array<[string, string, string]> = [
  ["ai", "AI 翻译", "由大模型翻译，措辞灵活，适合学习与精读等重质量场景。"],
  ["baidu", "百度翻译", "响应快，有每月免费额度，适合快速理解大意与日常查词；密钥需注册后在百度翻译控制台获取。"],
  ["deepl", "DeepL", "译文自然，适合正式文档等重质量场景；密钥需注册后在 DeepL 控制台获取。"],
];

/// Rust 侧 update::UpdateInfo 的镜像（status 见 src-tauri/src/update.rs）
type UpdateInfo = {
  status: "available" | "upToDate" | "cooldown" | "failed";
  current: string;
  latest?: string;
  url?: string;
  checkedAt: number;
};

/// 检查时刻：09/21 14:32
function fmtChecked(ts: number): string {
  return new Date(ts * 1000).toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/// 「检查新版本」行的说明文案：只描述用户能看见的行为，不暴露接口细节。
/// 「已是最新」必须带检查时刻，否则手动点「检查更新」前后这一行一字不差，
/// 看起来就像按钮没反应（提示只做文案级，不弹 toast——重）。
function updateHint(upd: UpdateInfo | null): string {
  switch (upd?.status) {
    case "available":
      return `发现新版本 v${upd.latest}（当前 v${upd.current}），点「下载」前往发布页获取安装包。`;
    case "upToDate":
      return `已是最新版本（v${upd.current}），检查于 ${fmtChecked(upd.checkedAt)}。拾趣每天自动检查一次，也可随时手动检查。`;
    case "cooldown":
      return `上次检查（${fmtChecked(upd.checkedAt)}）未发现新版本，24 小时后再自动检查；点「检查更新」可立即重查。`;
    case "failed":
      return "这次没检查成（网络不通或 GitHub 暂时访问不了），下次启动会自动重试。";
    default:
      return "启动后自动检查一次，发现新版本时在菜单栏下方轻提示；检查只读取公开版本信息，不发送任何本机数据。";
  }
}

export default function App() {
  const [page, setPage] = useState<Page>("model");
  // 应用版本：运行时读取 tauri.conf.json 的权威值（不再手写，避免与配置漂移）
  const [appVersion, setAppVersion] = useState("");

  useEffect(() => {
    getVersion().then(setAppVersion).catch(() => undefined);
  }, []);

  // 版本更新检测：查 GitHub Releases（无自建服务器）
  const [upd, setUpd] = useState<UpdateInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const runUpdateCheck = (force: boolean) => {
    setChecking(true);
    invoke<UpdateInfo>("check_update", { force })
      .then(setUpd)
      .catch(() => setUpd(null))
      .finally(() => setChecking(false));
  };
  // 进入关于页即读取最近一次结果（24h 内不重复请求，见 update.rs）
  useEffect(() => {
    if (page === "about") runUpdateCheck(false);
  }, [page]);

  // 应用外观（auto=跟随系统 | light | dark）：主窗口自身也要应用
  const [appearance, setAppearance] = useState<string>("auto");

  const applyAppearance = (t: string) => {
    const el = document.documentElement;
    el.classList.toggle("theme-light", t === "light");
    el.classList.toggle("theme-dark", t === "dark");
  };

  useEffect(() => {
    invoke<{ appearance?: string }>("get_settings")
      .then((s) => {
        setAppearance(s.appearance ?? "auto");
        applyAppearance(s.appearance ?? "auto");
      })
      .catch(() => undefined);
    const unTheme = listen<string>("theme://appearance", (e) => {
      setAppearance(e.payload);
      applyAppearance(e.payload);
    });
    return () => {
      unTheme.then((f) => f()).catch(() => undefined);
    };
  }, []);

  const setAppearanceMode = (mode: string) => {
    setAppearance(mode); // 主窗口即时反馈（Rust 广播回来值相同，幂等）
    applyAppearance(mode);
    invoke("set_appearance", { theme: mode }).catch(() => undefined);
  };
  const [settings, setSettings] = useState<Settings | null>(null);
  const [saved, setSaved] = useState(false);
  const [granted, setGranted] = useState<boolean | null>(null);
  const [listenAccess, setListenAccess] = useState<boolean | null>(null);
  const [axServiceOk, setAxServiceOk] = useState<boolean | null>(null);
  const [screenAccess, setScreenAccess] = useState<boolean | null>(null);
  // 截图/识别失败等全局提示改由独立 toast 窗口展示（主窗口隐藏时也可见）

  useEffect(() => {
    invoke<Settings>("get_settings").then(setSettings).catch(() => undefined);
  }, []);

  // 状态栏菜单「功能设置」→ 打开主窗口并跳到对应页
  useEffect(() => {
    const un = listen<string>("nav://page", (e) => {
      const p = e.payload as Page;
      if (p === "model" || p === "capture" || p === "about") setPage(p);
    });
    return () => {
      un.then((f) => f());
    };
  }, []);

  // 权限页轮询权限状态（授权后自动刷新）
  useEffect(() => {
    if (page !== "perms") return;
    let stop = false;
    let t: number | undefined;
    const poll = () => {
      invoke<{
        granted: boolean;
        axServiceOk: boolean;
        listenEventAccess: boolean;
        screenCaptureAccess: boolean;
      }>("capture_status")
        .then((s) => {
          if (stop) return;
          setGranted(s.granted);
          setAxServiceOk(s.axServiceOk);
          setListenAccess(s.listenEventAccess);
          setScreenAccess(s.screenCaptureAccess);
          // 三项全就绪即停止轮询：常驻 IPC 会放大 wry 上游 nil-URL 崩溃（#1752）的触发面
          // （屏幕录制不参与停止判定：未授权时保留引导入口）
          if (s.granted && s.axServiceOk && s.listenEventAccess && s.screenCaptureAccess) return;
          t = window.setTimeout(poll, 2000);
        })
        .catch(() => undefined);
    };
    poll();
    return () => {
      stop = true;
      if (t !== undefined) window.clearTimeout(t);
    };
  }, [page]);

  const patch = useCallback((p: Partial<Settings>) => {
    setSettings((s) => (s ? { ...s, ...p } : s));
    setSaved(false);
  }, []);

  // 动作开关/顺序/搜索引擎变更实时推送到浮动条（无需等保存）
  useEffect(() => {
    if (!settings) return;
    emit("settings://live", {
      actions: settings.actions,
      actionOrder: settings.actionOrder,
      capsuleShowCount: settings.capsuleShowCount,
      searchEngines: settings.searchEngines,
      defaultSearch: settings.defaultSearch,
      translateEnabled: settings.translate.enabled,
      translateDefault: settings.translate.default,
      translateOrder: settings.translate.order,
    }).catch(() => undefined);
  }, [
    settings?.actions,
    settings?.actionOrder,
    settings?.capsuleShowCount,
    settings?.searchEngines,
    settings?.defaultSearch,
    settings?.translate,
  ]);

  const save = () => {
    if (!settings) return;
    invoke("save_settings", { settings })
      .then(() => {
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      })
      .catch((e) => toast(`保存失败：${e}`, "err"));
  };

  const patchProvider = (id: string, p: Partial<Provider>) => {
    if (!settings) return;
    patch({ providers: settings.providers.map((x) => (x.id === id ? { ...x, ...p } : x)) });
  };

  // 翻译服务多选开关；默认项被关闭时顺延到首个启用项
  const toggleTranslate = (id: string, on: boolean) => {
    if (!settings) return;
    const cur = settings.translate;
    if (!on && cur.enabled.length <= 1) {
      toast("至少保留一个翻译服务", "err");
      return;
    }
    const enabled = on
      ? cur.enabled.includes(id)
        ? cur.enabled
        : [...cur.enabled, id]
      : cur.enabled.filter((x) => x !== id);
    if (on) setSvcOpen((m) => ({ ...m, [id]: true })); // 启用即自动展开该服务的配置
    patch({
      translate: {
        ...cur,
        enabled,
        default: enabled.includes(cur.default) ? cur.default : (enabled[0] ?? ""),
      },
    });
  };

  // 动作顺序：已配置顺序 + 注册表中新增动作（追加末尾）
  const orderedActionIds = settings ? allActionIds(settings) : [];
  // 常驻动作（含用户自定义）与上下文动作分两张卡：后者只在选中内容含实体时出现，
  // 且同时最多上一个胶囊，四者之间排序对浮动条没有意义——混在常驻列表里反而误导"可排"
  const residentIds = orderedActionIds.filter((id) => !CONTEXT_ACTION_IDS.has(id));
  const contextIds = orderedActionIds.filter((id) => CONTEXT_ACTION_IDS.has(id));

  // 翻译服务展示顺序：已配置顺序 + 注册表新增（追加末尾）
  const translateRows = settings
    ? [
        ...new Set([...settings.translate.order, ...TRANSLATE_SERVICES.map(([id]) => id)]),
      ]
        .map((id) => TRANSLATE_SERVICES.find(([sid]) => sid === id))
        .filter((r): r is [string, string, string] => !!r)
    : [];

  // 拖拽排序（指针事件实现，不依赖 WKWebView 残缺的 HTML5 DnD）：
  // 按住把手 → document 级 mousemove 做行命中检测 → 松手落位
  const rowEls = useRef<Map<string, HTMLDivElement>>(new Map());
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const overIdRef = useRef<string | null>(null);

  const onGripDown = (e: ReactMouseEvent, id: string) => {
    e.preventDefault();
    setDragId(id);
    const onMove = (ev: MouseEvent) => {
      let hit: string | null = null;
      rowEls.current.forEach((el, key) => {
        const r = el.getBoundingClientRect();
        if (ev.clientY >= r.top && ev.clientY <= r.bottom) hit = key;
      });
      overIdRef.current = hit;
      setOverId(hit);
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      const target = overIdRef.current;
      setDragId(null);
      setOverId(null);
      overIdRef.current = null;
      if (!target || target === id) return;
      // 落位：从原位置移除后插入目标位置
      setSettings((s) => {
        if (!s) return s;
        const order = allActionIds(s);
        const from = order.indexOf(id);
        const to = order.indexOf(target);
        if (from < 0 || to < 0) return s;
        order.splice(from, 1);
        order.splice(to, 0, id);
        return { ...s, actionOrder: order };
      });
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  // ---- 搜索引擎列表管理（拖拽排序用指针事件，同上） ----
  const engRowEls = useRef<Map<string, HTMLDivElement>>(new Map());
  const [engDragId, setEngDragId] = useState<string | null>(null);
  const [engOverId, setEngOverId] = useState<string | null>(null);
  const engOverRef = useRef<string | null>(null);

  const updateEngine = (idx: number, p: Partial<SearchEngine>) => {
    if (!settings) return;
    const old = settings.searchEngines[idx];
    let next = settings.searchEngines.map((x, i) => (i === idx ? { ...x, ...p } : x));
    let defaultSearch = settings.defaultSearch;

    // 重命名默认引擎时同步默认项
    if (p.name && old.name === defaultSearch) {
      defaultSearch = p.name;
    }
    if (p.enabled === false) {
      // 至少保留一个启用的引擎，保证「搜索」按钮始终可用
      if (settings.searchEngines.filter((x) => x.enabled).length <= 1) {
        toast("至少保留一个启用的搜索引擎", "err");
        return;
      }
      // 停用的是默认引擎：默认顺延到首个启用引擎（默认 ⊆ 启用）
      if (defaultSearch === old.name) {
        defaultSearch = next.find((x) => x.enabled)?.name ?? "";
      }
    }
    patch({ searchEngines: next, defaultSearch });
  };

  const patchEngines = (engines: SearchEngine[]) => patch({ searchEngines: engines });

  const addEngine = (name: string, url: string) => {
    if (!settings) return;
    if (settings.searchEngines.some((e) => e.name === name)) return;
    patchEngines([...settings.searchEngines, { name, url, enabled: true }]);
  };

  const removeEngine = (idx: number) => {
    if (!settings) return;
    const eng = settings.searchEngines[idx];
    if (BUILTIN_ENGINES.has(eng.name)) return; // 内置引擎不可删（按钮也不渲染，双保险）
    // 至少保留一个启用的引擎，保证「搜索」按钮始终可用（与停用守卫一致）
    if (eng.enabled && settings.searchEngines.filter((x) => x.enabled).length <= 1) {
      toast("至少保留一个启用的搜索引擎", "err");
      return;
    }
    const rest = settings.searchEngines.filter((_, i) => i !== idx);
    // 删除的是默认引擎：默认顺延到首个启用引擎
    const defaultSearch =
      settings.defaultSearch === eng.name
        ? (rest.find((x) => x.enabled)?.name ?? "")
        : settings.defaultSearch;
    patch({ searchEngines: rest, defaultSearch });
  };

  const onEngineGripDown = (e: ReactMouseEvent, id: string) => {
    e.preventDefault();
    setEngDragId(id);
    const onMove = (ev: MouseEvent) => {
      let hit: string | null = null;
      engRowEls.current.forEach((el, key) => {
        const r = el.getBoundingClientRect();
        if (ev.clientY >= r.top && ev.clientY <= r.bottom) hit = key;
      });
      engOverRef.current = hit;
      setEngOverId(hit);
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      const target = engOverRef.current;
      setEngDragId(null);
      setEngOverId(null);
      engOverRef.current = null;
      if (!settings || !target || target === id) return;
      const order = settings.searchEngines.map((x) => x.name);
      const from = order.indexOf(id);
      const to = order.indexOf(target);
      if (from < 0 || to < 0) return;
      order.splice(from, 1);
      order.splice(to, 0, id);
      const byName = new Map(settings.searchEngines.map((x) => [x.name, x]));
      patchEngines(order.map((n) => byName.get(n)).filter((x): x is SearchEngine => !!x));
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  // ---- 翻译服务排序（拖拽，同引擎列表） ----
  const svcRowEls = useRef<Map<string, HTMLDivElement>>(new Map());
  const [svcDragId, setSvcDragId] = useState<string | null>(null);
  const [svcOverId, setSvcOverId] = useState<string | null>(null);
  const svcOverRef = useRef<string | null>(null);
  // 翻译服务凭据折叠态；启用服务时自动展开一次（见 toggleTranslate）
  const [svcOpen, setSvcOpen] = useState<Record<string, boolean>>({});

  // 提示词卡手风琴：同时只展开一个（三张卡全展开要滚三屏，而这页的用法就是一次调一个动作）。
  // 编辑框始终是「当前生效内容」，内容与默认一致时不落覆盖项——恢复默认因此是删 key，
  // 而不是回写一份当时的默认文本
  const [promptOpen, setPromptOpen] = useState<AiActionId | null>(null);

  const setPrompt = (id: AiActionId, value: string) => {
    if (!settings) return;
    const next = { ...settings.actionPrompts };
    if (value.trim() === DEFAULT_PROMPTS[id].trim()) delete next[id];
    else next[id] = value;
    patch({ actionPrompts: next });
  };

  const resetPrompt = (id: AiActionId) => {
    if (!settings) return;
    const next = { ...settings.actionPrompts };
    delete next[id];
    patch({ actionPrompts: next });
  };

  // ---- 自定义 AI 动作 ----
  // 与内置动作混排在同一张「动作」卡里：胶囊顺序 = 这张卡的行序（actionOrder 是唯一真相），
  // 分成两张卡会让用户自造的动作永远排在内置之后，前 4 个可见位就轮不到它了
  const CUSTOM_MAX = 10;
  /** 打开编辑模态的自定义动作 id（名称/图标/提示词/试跑/删除都在模态里完成，
      列表行只留展示与开关——就地展开塞整个表单太拥挤） */
  const [actionModal, setActionModal] = useState<string | null>(null);
  /** 试跑样例文本：按动作 id 存在组件内，不落盘——它是预览输入，不是配置 */
  const [trySample, setTrySample] = useState<Record<string, string>>({});
  /** 试跑结果留在父组件：关掉模态不该打断正在流的输出 */
  const [tryRun, setTryRun] = useState<{
    id: string;
    out: string;
    running: boolean;
    error?: string;
  } | null>(null);
  const tryRunRef = useRef(0);
  /** 编辑模态里删除按钮的二次确认态（模态上不再叠 Confirm，避免两层 Esc） */
  const [delArm, setDelArm] = useState(false);
  /** 图标选择的当前 tab（组名）：打开模态时定位到动作图标所在组 */
  const [iconTab, setIconTab] = useState<string>(CUSTOM_ICON_CHOICES[0].group);

  const customActions = settings?.customActions ?? [];
  const customById = (id: string) => customActions.find((c) => c.id === id);

  /** 打开编辑模态：清掉上一次的试跑流与删除确认态，图标 tab 定位到动作图标所在组
   *  （没设图标则停在「默认」组），用户打开即见当前选中态 */
  const openActionModal = (id: string) => {
    const c = customById(id);
    setIconTab(
      c?.icon
        ? (CUSTOM_ICON_CHOICES.find((g) => g.names.includes(c.icon!))?.group ??
            CUSTOM_ICON_CHOICES[0].group)
        : CUSTOM_ICON_CHOICES[0].group,
    );
    tryRunRef.current++;
    setTryRun(null);
    setDelArm(false);
    setActionModal(id);
  };

  const updateCustom = (id: string, p: Partial<CustomAction>) => {
    if (!settings) return;
    patch({
      customActions: settings.customActions.map((c) => (c.id === id ? { ...c, ...p } : c)),
    });
  };

  const addCustom = () => {
    if (!settings || customActions.length >= CUSTOM_MAX) return;
    const id = `${CUSTOM_ID_PREFIX}${Date.now().toString(36)}`;
    patch({
      customActions: [
        ...settings.customActions,
        { id, name: "新动作", prompt: "", enabled: true },
      ],
      // 行序表补上新 id：追加在末尾，用户拖把手调整（与搜索引擎「添加」一致）
      actionOrder: [...allActionIds(settings), id],
    });
    openActionModal(id);
  };

  /** 待删除条目的确认框（模型服务）：确认走 Modal
   *  （confirm() 在 WKWebView 里恒为 false，用它等于删不掉） */
  const [confirmDelProvider, setConfirmDelProvider] = useState<string | null>(null);

  const removeProvider = (id: string) => {
    if (!settings) return;
    const rest = settings.providers.filter((x) => x.id !== id);
    patch({
      providers: rest,
      defaultProviderId:
        settings.defaultProviderId === id ? rest[0].id : settings.defaultProviderId,
    });
    setConfirmDelProvider(null);
  };

  const removeCustom = (id: string) => {
    if (!settings) return;
    patch({
      customActions: settings.customActions.filter((c) => c.id !== id),
      actionOrder: settings.actionOrder.filter((x) => x !== id),
    });
    tryRunRef.current++;
    setTryRun(null);
    setDelArm(false);
    setActionModal(null);
  };

  /** 试跑：走默认模型服务（Rust 读的是已落盘的配置，未保存的改动不生效） */
  const runTry = (c: CustomAction) => {
    if (!c.prompt.trim()) {
      setTryRun({ id: c.id, out: "", running: false, error: "先填提示词" });
      return;
    }
    const sample = (trySample[c.id] ?? "").trim();
    if (!sample) {
      setTryRun({ id: c.id, out: "", running: false, error: "先填试跑样例" });
      return;
    }
    const runId = ++tryRunRef.current;
    let full = "";
    setTryRun({ id: c.id, out: "", running: true });
    aiChat(
      [
        { role: "system", content: c.prompt },
        { role: "user", content: sample },
      ],
      null,
      {
        onDelta: (chunk) => {
          if (tryRunRef.current !== runId) return;
          full += chunk;
          setTryRun((t) => (t && t.id === c.id ? { ...t, out: full } : t));
        },
        onDone: () => {
          if (tryRunRef.current !== runId) return;
          setTryRun((t) => (t && t.id === c.id ? { ...t, running: false } : t));
        },
        onError: (message) => {
          if (tryRunRef.current !== runId) return;
          setTryRun({ id: c.id, out: full, running: false, error: message });
        },
      },
    );
  };

  const onSvcGripDown = (e: ReactMouseEvent, id: string) => {
    e.preventDefault();
    setSvcDragId(id);
    const onMove = (ev: MouseEvent) => {
      let hit: string | null = null;
      svcRowEls.current.forEach((el, key) => {
        const r = el.getBoundingClientRect();
        if (ev.clientY >= r.top && ev.clientY <= r.bottom) hit = key;
      });
      svcOverRef.current = hit;
      setSvcOverId(hit);
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      const target = svcOverRef.current;
      setSvcDragId(null);
      setSvcOverId(null);
      svcOverRef.current = null;
      if (!settings || !target || target === id) return;
      const order = [
        ...new Set([...settings.translate.order, ...TRANSLATE_SERVICES.map(([sid]) => sid)]),
      ];
      const from = order.indexOf(id);
      const to = order.indexOf(target);
      if (from < 0 || to < 0) return;
      order.splice(from, 1);
      order.splice(to, 0, id);
      patch({ translate: { ...settings.translate, order } });
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  if (!settings) return <div className="loading">正在载入…</div>;

  return (
    <div className="shell">
      <aside className="side">
        <div className="brand">
          <img className="mark" src={markIcon} alt="拾趣" />
          <div className="brand-text">
            <div className="brand-name">拾趣</div>
            <div className="brand-ver">{appVersion || "—"}</div>
          </div>
        </div>
        <nav className="nav">
          {(
            [
              ["capture", "划词"],
              ["shortcuts", "快捷键"],
              ["model", "模型服务"],
              ["prompts", "Prompt 设置"],
              ["translate", "翻译"],
              ["search", "搜索引擎"],
              ["blocklist", "禁用应用"],
              ["appearance", "外观"],
              ["perms", "权限"],
              ["about", "关于"],
            ] as Array<[Page, string]>
          ).map(([id, label]) => (
            <button
              key={id}
              className={`nav-item ${page === id ? "active" : ""}`}
              onClick={() => setPage(id)}
            >
              <span className="nav-ic">{NAV_ICONS[id]}</span>
              {label}
            </button>
          ))}
        </nav>
      </aside>

      <main className="content">
        {page === "model" && (
          <>
            <h1>模型服务</h1>
            <p className="page-hint">
              添加 OpenAI 协议兼容的模型服务，设为默认的一项供全部划词动作调用。密钥仅保存在本机。更改需保存后生效。
            </p>

            <h2 className="sec">服务</h2>
            {settings.providers.map((p) => (
              <div className="card" key={p.id}>
                <div className="grid">
                  <label className="field">
                    <span>名称</span>
                    <input value={p.name} onChange={(e) => patchProvider(p.id, { name: e.target.value })} />
                  </label>
                  <label className="field">
                    <span>模型</span>
                    <input value={p.model} onChange={(e) => patchProvider(p.id, { model: e.target.value })} />
                  </label>
                  <label className="field wide">
                    <span>服务地址</span>
                    <input value={p.baseUrl} onChange={(e) => patchProvider(p.id, { baseUrl: e.target.value })} />
                  </label>
                  <label className="field wide">
                    <span>API 密钥</span>
                    <input
                      type="password"
                      value={p.apiKey}
                      placeholder="sk-…"
                      onChange={(e) => patchProvider(p.id, { apiKey: e.target.value })}
                    />
                  </label>
                </div>
                <div className="card-foot">
                  <label className="radio">
                    <input
                      type="radio"
                      name="defaultProvider"
                      checked={settings.defaultProviderId === p.id}
                      onChange={() => patch({ defaultProviderId: p.id })}
                    />
                    设为默认
                  </label>
                  <button
                    className="row-del"
                    title="删除该服务"
                    aria-label="删除该服务"
                    onClick={() => {
                      if (settings.providers.length <= 1) {
                        toast("至少保留一个模型服务", "err");
                        return;
                      }
                      setConfirmDelProvider(p.id);
                    }}
                  >
                    <Trash2 size={13} strokeWidth={1.75} />
                  </button>
                </div>
              </div>
            ))}
            <button
              className="btn"
              onClick={() => {
                const p = NEW_PROVIDER();
                patch({
                  providers: [...settings.providers, p],
                  defaultProviderId: settings.providers.length === 0 ? p.id : settings.defaultProviderId,
                });
              }}
            >
              ＋ 添加服务
            </button>

            <div className="save-bar">
              <button className="btn primary" onClick={save}>
                {saved ? "已保存" : "保存更改"}
              </button>
            </div>

            {confirmDelProvider &&
              (() => {
                const p = settings.providers.find((x) => x.id === confirmDelProvider);
                if (!p) return null;
                return (
                  <Confirm
                    title="删除服务"
                    text={`删除「${p.name || "未命名服务"}」？模型名、服务地址与 API 密钥会一并移除。`}
                    onCancel={() => setConfirmDelProvider(null)}
                    onConfirm={() => removeProvider(confirmDelProvider)}
                  />
                );
              })()}
          </>
        )}

        {page === "prompts" && (
          <>
            <h1>Prompt 设置</h1>
            <p className="page-hint">
              编辑各动作发给模型的指令，输入框内即实际发送的内容，所选文字随后附带。更改需保存后生效。
            </p>
            {AI_ACTION_IDS.map((id) => {
              const custom = Boolean(settings.actionPrompts[id]?.trim());
              const open = promptOpen === id;
              return (
                <div className="card" key={id}>
                  <div
                    className="prompt-head"
                    onClick={() => setPromptOpen(open ? null : id)}
                  >
                    <div className="row-title">
                      {ACTION_LABELS[id]}
                      <span className="tag ai">AI</span>
                      <span className="action-desc">
                        {custom ? "已自定义" : "使用系统默认"}
                      </span>
                    </div>
                    {/* 不持 onClick：点把手冒泡到卡片头统一切换，避免双重 toggle */}
                    <button className={`svc-chev ${open ? "open" : ""}`} title={open ? "收起" : "展开编辑"}>
                      <ChevronDown size={13} strokeWidth={2} />
                    </button>
                  </div>
                  <div className={`svc-body ${open ? "open" : ""}`}>
                    <div>
                      <textarea
                        className="prompt-input"
                        spellCheck={false}
                        value={effectivePrompt(id, settings.actionPrompts)}
                        onChange={(e) => setPrompt(id, e.target.value)}
                      />
                      <div className="prompt-foot">
                        {/* 内置默认不常驻展示，但必须按需可查：翻译的【译文】/【要点】
                            是结果窗解析依据，看不到原版用户改坏格式还查不出原因 */}
                        <details className="prompt-src">
                          <summary>查看系统默认</summary>
                          <pre className="prompt-default">{DEFAULT_PROMPTS[id]}</pre>
                        </details>
                        <button
                          className="btn sm"
                          disabled={!custom}
                          title="清除自定义，恢复系统默认提示词"
                          onClick={() => resetPrompt(id)}
                        >
                          恢复默认
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
            <div className="save-bar">
              <button className="btn primary" onClick={save}>
                {saved ? "已保存" : "保存更改"}
              </button>
            </div>
          </>
        )}

        {page === "capture" && (
          <>
            <h1>划词</h1>
            <p className="page-hint">
              设定浮动条显示哪些动作及其排列顺序：拖动把手调序，开关停用某项。开关与顺序即时反映到浮动条；新增动作及其名称、提示词需保存后生效。
              <br />
              「提取信息」仅在所选文字含网址 / 邮箱 / 电话 / 验证码时出现。
            </p>

            <h2 className="sec">胶囊</h2>
            <div className="card">
              <div className="row-between">
                <div className="row-title">
                  显示动作数
                  <span className="action-desc">默认 4（可设 2–8）</span>
                </div>
                <div className="row-ctl">
                  <button
                    className="btn sm"
                    disabled={settings.capsuleShowCount <= 2}
                    onClick={() => patch({ capsuleShowCount: settings.capsuleShowCount - 1 })}
                  >
                    −
                  </button>
                  <span style={{ minWidth: 16, textAlign: "center" }}>
                    {settings.capsuleShowCount}
                  </span>
                  <button
                    className="btn sm"
                    disabled={settings.capsuleShowCount >= 8}
                    onClick={() => patch({ capsuleShowCount: settings.capsuleShowCount + 1 })}
                  >
                    +
                  </button>
                </div>
              </div>
            </div>

            <h2 className="sec">动作</h2>
            <div className="card">
              {residentIds.map((k) => {
                const c = customById(k);
                return (
                  <Fragment key={k}>
                    <div
                      ref={(el) => {
                        if (el) rowEls.current.set(k, el);
                        else rowEls.current.delete(k);
                      }}
                      className={`row-between sep action-row ${dragId === k ? "dragging" : ""} ${
                        overId === k && dragId && dragId !== k ? "drop-target" : ""
                      }`}
                    >
                      <div className="row-title">
                        <span
                          className="grip"
                          title="拖动排序"
                          onMouseDown={(e) => onGripDown(e, k)}
                        >
                          <GripVertical size={13} strokeWidth={1.75} />
                        </span>
                        {c && (
                          <span className="row-ic" title="动作图标">
                            {customIconNode(c.icon, 14) ?? <Sparkles size={14} strokeWidth={1.75} />}
                          </span>
                        )}
                        {c ? c.name || "未命名" : ACTION_LABELS[k]}
                        {c ? (
                          <span className="tag mine">我的</span>
                        ) : (
                          isAiAction(k) && <span className="tag ai">AI</span>
                        )}
                        <span className="action-desc">
                          {c ? (c.prompt.trim() ? "" : "未填提示词") : ACTION_DESC[k]}
                        </span>
                      </div>
                      <div className="row-ctl">
                        {c && (
                          <button
                            className="svc-chev"
                            title="编辑动作（名称、图标、提示词、试跑）"
                            onClick={() => openActionModal(k)}
                          >
                            <SquarePen size={13} strokeWidth={2} />
                          </button>
                        )}
                        <label className="switch">
                          <input
                            type="checkbox"
                            checked={
                              c
                                ? c.enabled
                                : (settings.actions[k as keyof typeof settings.actions] ?? false)
                            }
                            onChange={(e) => {
                              if (c) {
                                updateCustom(c.id, { enabled: e.target.checked });
                                return;
                              }
                              // 至少保留一个开启的动作，避免浮动条变空白
                              if (
                                !e.target.checked &&
                                Object.values(settings.actions).filter(Boolean).length <= 1
                              ) {
                                toast("至少保留一个动作", "err");
                                return;
                              }
                              patch({
                                actions: { ...settings.actions, [k]: e.target.checked },
                              });
                            }}
                          />
                          <span className="knob" />
                        </label>
                      </div>
                    </div>

                    {/* 编辑/试跑/删除已整体移入编辑模态（见 actionModal）——
                        就地展开塞下名称+图标网格+提示词+试跑太拥挤 */}
                  </Fragment>
                );
              })}
              <button
                className="act-add"
                disabled={customActions.length >= CUSTOM_MAX}
                title={
                  customActions.length >= CUSTOM_MAX
                    ? `最多 ${CUSTOM_MAX} 个自定义动作`
                    : "新建一个自定义 AI 动作"
                }
                onClick={addCustom}
              >
                <Plus size={13} strokeWidth={2} />
                新建 AI 动作
              </button>
            </div>

            <h2 className="sec">提取信息</h2>
            <div className="card">
              {contextIds.map((k) => (
                <div key={k} className="row-between sep action-row context-row">
                  <div className="row-title">
                    {ACTION_LABELS[k]}
                    <span className="action-desc">{ACTION_DESC[k]}</span>
                  </div>
                  <div className="row-ctl">
                    <label className="switch">
                      <input
                        type="checkbox"
                        checked={
                          settings.actions[k as keyof typeof settings.actions] ?? false
                        }
                        onChange={(e) =>
                          patch({ actions: { ...settings.actions, [k]: e.target.checked } })
                        }
                      />
                      <span className="knob" />
                    </label>
                  </div>
                </div>
              ))}
            </div>

            <div className="save-bar">
              <button className="btn primary" onClick={save}>
                {saved ? "已保存" : "保存更改"}
              </button>
            </div>

            {/* 编辑模态：名称/提示词/图标 + 试跑 + 删除在一个面板里完成——
                写提示词 → 就地试跑 → 改，闭环不再跨两个 UI 层。
                提示词取当前编辑内容；模型服务读已落盘配置（试跑前先保存） */}
            {(() => {
              const c = actionModal ? customById(actionModal) : null;
              if (!c) return null;
              const running = tryRun?.id === c.id && tryRun.running;
              return (
                <Modal
                  title={`自定义动作「${c.name || "未命名"}」`}
                  onClose={() => {
                    setActionModal(null);
                    setDelArm(false);
                  }}
                  footer={
                    <>
                      <button
                        className={`btn sm ${delArm ? "danger" : ""}`}
                        onClick={() => {
                          if (!delArm) {
                            setDelArm(true);
                            return;
                          }
                          removeCustom(c.id);
                        }}
                      >
                        {delArm ? "确认删除？" : "删除"}
                      </button>
                      <button className="btn primary sm" onClick={() => setActionModal(null)}>
                        完成
                      </button>
                    </>
                  }
                >
                  <label className="field">
                    <span>名称（显示在胶囊按钮上，建议不超过 6 字）</span>
                    <input
                      value={c.name}
                      maxLength={8}
                      placeholder="如：术语直译"
                      onChange={(e) => updateCustom(c.id, { name: e.target.value })}
                    />
                  </label>
                  <label className="field">
                    <span>提示词（发给模型的指令，所选文字随后附带，无需占位符）</span>
                    <textarea
                      className="prompt-input in-field"
                      spellCheck={false}
                      rows={5}
                      placeholder="例：把下面的文本译成中文，保留英文术语并在括号内附原文，只输出译文。"
                      value={c.prompt}
                      onChange={(e) => updateCustom(c.id, { prompt: e.target.value })}
                    />
                  </label>
                  <div className="field">
                    <span>图标（显示在胶囊按钮左侧）</span>
                    <div className="icon-tabs" role="tablist" aria-label="图标分组">
                      {CUSTOM_ICON_CHOICES.map((g) => (
                        <button
                          key={g.group}
                          role="tab"
                          aria-selected={iconTab === g.group}
                          className={`icon-tab ${iconTab === g.group ? "on" : ""}`}
                          onClick={() => setIconTab(g.group)}
                        >
                          {g.group}
                        </button>
                      ))}
                    </div>
                    {(() => {
                      const group = CUSTOM_ICON_CHOICES.find((g) => g.group === iconTab);
                      if (!group) return null;
                      return (
                        <div className="icon-grid" role="radiogroup" aria-label={`图标 · ${group.group}`}>
                          {group.group === CUSTOM_ICON_CHOICES[0].group && (
                            <button
                              type="button"
                              className={`icon-cell ${!c.icon ? "on" : ""}`}
                              title="默认"
                              aria-label="默认图标"
                              onClick={() => updateCustom(c.id, { icon: undefined })}
                            >
                              <Sparkles size={16} strokeWidth={1.75} />
                            </button>
                          )}
                          {group.names.map((n) => (
                            <button
                              key={n}
                              type="button"
                              className={`icon-cell ${c.icon === n ? "on" : ""}`}
                              title={n}
                              aria-label={`${group.group} ${n}`}
                              onClick={() => updateCustom(c.id, { icon: n })}
                            >
                              {customIconNode(n, 16)}
                            </button>
                          ))}
                        </div>
                      );
                    })()}
                  </div>
                  <div className="try-block">
                    <label className="field">
                      <span>试跑：样例（作为所选文字发给模型，不保存）</span>
                      <textarea
                        className="prompt-input in-field try-sample"
                        spellCheck={false}
                        placeholder="粘贴一段待处理的文字，例如：The committee deferred the decision pending further audit evidence."
                        value={trySample[c.id] ?? ""}
                        onChange={(e) => setTrySample((m) => ({ ...m, [c.id]: e.target.value }))}
                      />
                    </label>
                    {tryRun?.id === c.id && (tryRun.out || tryRun.error) && (
                      <pre className={`act-out ${tryRun.error ? "bad" : ""}`}>
                        {tryRun.error ?? tryRun.out}
                      </pre>
                    )}
                    <button className="btn sm" disabled={running} onClick={() => runTry(c)}>
                      {running ? "生成中…" : "试跑"}
                    </button>
                  </div>
                </Modal>
              );
            })()}
          </>
        )}

        {page === "shortcuts" && (
          <>
            <h1>快捷键</h1>
            <p className="page-hint">
              点按输入框后按下新组合键完成设置，需含 ⌘ / Ctrl / Alt / Shift 之一，Esc 取消。组合键已被其他应用占用时不生效。更改需保存后生效。
            </p>
            <div className="card">
              {SHORTCUT_ITEMS.map((item, i) => (
                <div className={`row-between${i > 0 ? " sep" : ""}`} key={item.key}>
                  <div>
                    <div className="row-title">{item.label}</div>
                    <div className="row-sub">{item.desc}</div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                    <ShortcutRecorder
                      value={settings[item.key]}
                      onChange={(v) => patch({ [item.key]: v } as Partial<Settings>)}
                    />
                    {settings[item.key] !== item.default && (
                      <button
                        className="btn sm"
                        title="重置为默认快捷键"
                        onClick={() =>
                          patch({ [item.key]: item.default } as Partial<Settings>)
                        }
                      >
                        重置
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>

            <div className="save-bar">
              <button className="btn primary" onClick={save}>
                {saved ? "已保存" : "保存更改"}
              </button>
            </div>
          </>
        )}

        {page === "perms" && (
          <>
            <h1>权限</h1>
            <p className="page-hint">
              划词需「辅助功能」与「输入监控」，识图需「屏幕录制」。按条目提示完成授权，返回后状态自动刷新。
            </p>
            <div className="card">
              <div className="row-between">
                <div>
                  <div className="row-title">辅助功能</div>
                  <div className="row-sub">
                    读取所选文字，供翻译、解释、总结使用。未授权时划词无响应，点下方「授权划词」开启。
                  </div>
                </div>
                <span className={`pill ${granted ? "ok" : granted === false ? "bad" : ""}`}>
                  {granted === null ? "检测中" : granted ? "已授权" : "未授权"}
                </span>
              </div>
              {granted === false && (
                <div className="card-foot">
                  <button
                    className="btn primary"
                    onClick={() =>
                      invoke<boolean>("prompt_accessibility")
                        .then((grantedNow) => {
                          if (!grantedNow)
                            invoke("open_accessibility_settings").catch(() => undefined);
                        })
                        .catch(() =>
                          invoke("open_accessibility_settings").catch(() => undefined),
                        )
                    }
                  >
                    授权划词
                  </button>
                </div>
              )}
              <div className="row-between sep">
                <div>
                  <div className="row-title">输入监控</div>
                  <div className="row-sub">
                    监听选择动作，选完文字即弹出浮动条。未授权时不会有响应，点下方「授权输入监控」开启。
                  </div>
                </div>
                <span className={`pill ${listenAccess ? "ok" : listenAccess === false ? "bad" : ""}`}>
                  {listenAccess === null ? "检测中" : listenAccess ? "已授权" : "未授权"}
                </span>
              </div>
              {listenAccess === false && (
                <div className="card-foot">
                  <button
                    className="btn primary"
                    onClick={() => invoke<boolean>("request_listen_access").catch(() => undefined)}
                  >
                    授权输入监控
                  </button>
                </div>
              )}
              <div className="row-between sep">
                <div>
                  <div className="row-title">屏幕录制</div>
                  <div className="row-sub">
                    框选屏幕区域并识别文字的前提，识别全程在本机完成，画面不上传。未授权时点下方「授权屏幕录制」开启。
                  </div>
                </div>
                <span className={`pill ${screenAccess ? "ok" : screenAccess === false ? "bad" : ""}`}>
                  {screenAccess === null ? "检测中" : screenAccess ? "已授权" : "未授权"}
                </span>
              </div>
              {screenAccess === false && (
                <div className="card-foot">
                  <button
                    className="btn primary"
                    onClick={() =>
                      invoke<boolean>("request_screen_capture_access").catch(() => undefined)
                    }
                  >
                    授权屏幕录制
                  </button>
                </div>
              )}
              <div className="row-between sep">
                <div>
                  <div className="row-title">取词健康自检</div>
                  <div className="row-sub">
                    划词失灵时的诊断。权限均已授权却无浮动条，通常是系统权限状态失效：到系统设置「辅助功能」取消勾选拾趣后重新勾选，重启应用恢复。
                  </div>
                </div>
                <span className={`pill ${axServiceOk ? "ok" : axServiceOk === false ? "bad" : ""}`}>
                  {axServiceOk === null ? "检测中" : axServiceOk ? "正常" : "异常"}
                </span>
              </div>
            </div>
          </>
        )}

        {page === "translate" && (
          <>
            <h1>翻译</h1>
            <p className="page-hint">
              开关决定该服务是否进入「翻译」展开列表，拖动把手调整顺序，「默认」为单击直达项；译文方向自动识别。改动即时反映到浮动条，点「保存更改」持久化。
            </p>

            <h2 className="sec">服务</h2>
            <div className="card">
              {translateRows.map(([id, name, desc]) => (
                <div
                  key={id}
                  ref={(el) => {
                    if (el) svcRowEls.current.set(id, el);
                    else svcRowEls.current.delete(id);
                  }}
                  className={`svc ${svcDragId === id ? "dragging" : ""} ${
                    svcOverId === id && svcDragId && svcDragId !== id ? "drop-target" : ""
                  }`}
                >
                  <div className="svc-main">
                    <span
                      className="grip"
                      title="拖动排序"
                      onMouseDown={(e) => onSvcGripDown(e, id)}
                    >
                      <GripVertical size={13} strokeWidth={1.75} />
                    </span>
                    <div className="svc-content">
                      <div className="svc-head">
                        <div className="row-title">{name}</div>
                        <div className="row-ctl">
                          <label
                            className="radio sm"
                            title={
                              settings.translate.enabled.includes(id)
                                ? "设为默认翻译服务"
                                : "启用后才可设为默认"
                            }
                          >
                            <input
                              type="radio"
                              name="defaultTranslate"
                              checked={settings.translate.default === id}
                              disabled={!settings.translate.enabled.includes(id)}
                              onChange={() =>
                                patch({ translate: { ...settings.translate, default: id } })
                              }
                            />
                            默认
                          </label>
                          <label className="switch">
                            <input
                              type="checkbox"
                              checked={settings.translate.enabled.includes(id)}
                              onChange={(e) => toggleTranslate(id, e.target.checked)}
                            />
                            <span className="knob" />
                          </label>
                          <button
                            className={`svc-chev ${svcOpen[id] ? "open" : ""}`}
                            title={svcOpen[id] ? "收起配置" : "展开配置"}
                            onClick={() => setSvcOpen((m) => ({ ...m, [id]: !m[id] }))}
                          >
                            <ChevronDown size={13} strokeWidth={2} />
                          </button>
                        </div>
                      </div>
                      <div className="row-sub">{desc}</div>

                      {id === "ai" && (
                        <div className={`svc-body ${svcOpen[id] ? "open" : ""}`}>
                          <div>
                            <div className="svc-fields">
                              <div className="row-sub" style={{ marginTop: 0 }}>
                                翻译使用「模型服务」页设为默认的模型，密钥与地址在该页统一管理。
                              </div>
                              <div className="svc-fields-foot">
                                <button
                                  className="btn sm"
                                  onClick={() => setPage("model")}
                                >
                                  前往模型服务
                                </button>
                              </div>
                            </div>
                          </div>
                        </div>
                      )}

                      {(id === "baidu" || id === "deepl") && (
                        <div className={`svc-body ${svcOpen[id] ? "open" : ""}`}>
                          <div>
                            <div className="svc-fields">
                              {id === "baidu" && (
                                <>
                                  <label className="field">
                                    <span>APPID</span>
                                    <input
                                      value={settings.translate.appId}
                                      onChange={(e) =>
                                        patch({
                                          translate: {
                                            ...settings.translate,
                                            appId: e.target.value,
                                          },
                                        })
                                      }
                                      placeholder="注册后登录官网获取"
                                    />
                                  </label>
                                  <label className="field">
                                    <span>API 密钥</span>
                                    <input
                                      type="password"
                                      value={settings.translate.appKey}
                                      onChange={(e) =>
                                        patch({
                                          translate: {
                                            ...settings.translate,
                                            appKey: e.target.value,
                                          },
                                        })
                                      }
                                      placeholder="与 APPID 在同一页面"
                                    />
                                  </label>
                                </>
                              )}
                              {id === "deepl" && (
                                <label className="field wide">
                                  <span>Authentication Key</span>
                                  <input
                                    type="password"
                                    value={settings.translate.deeplKey}
                                    onChange={(e) =>
                                      patch({
                                        translate: {
                                          ...settings.translate,
                                          deeplKey: e.target.value,
                                        },
                                      })
                                    }
                                    placeholder="免费密钥以 :fx 结尾"
                                  />
                                </label>
                              )}
                              <div className="svc-fields-foot">
                                <button
                                  className="btn sm"
                                  onClick={() =>
                                    invoke(
                                      "open_url",
                                      id === "baidu"
                                        ? { url: "https://fanyi-api.baidu.com/product/11" }
                                        : { url: "https://www.deepl.com/pro-api" },
                                    ).catch(() => undefined)
                                  }
                                >
                                  {id === "baidu" ? "打开官网文档" : "打开 DeepL API"}
                                </button>
                              </div>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <div className="save-bar">
              <button className="btn primary" onClick={save}>
                {saved ? "已保存" : "保存更改"}
              </button>
            </div>
          </>
        )}

        {page === "search" && (
          <>
            <h1>搜索引擎</h1>
            <p className="page-hint">
              开关决定该引擎是否进入「搜索」展开列表，拖动把手调整顺序，「默认」为单击直达项；链接中的 {'{q}'} 代入选中文字。改动即时反映到浮动条，点「保存更改」持久化。
            </p>
            <div className="card">
              {settings.searchEngines.map((eng, idx) => (
                <div
                  key={eng.name}
                  ref={(el) => {
                    if (el) engRowEls.current.set(eng.name, el);
                    else engRowEls.current.delete(eng.name);
                  }}
                  className={`eng-row ${engDragId === eng.name ? "dragging" : ""} ${
                    engOverId === eng.name && engDragId && engDragId !== eng.name ? "drop-target" : ""
                  }`}
                >
                  <span
                    className="grip"
                    title="拖动排序"
                    onMouseDown={(e) => onEngineGripDown(e, eng.name)}
                  >
                    <GripVertical size={13} strokeWidth={1.75} />
                  </span>
                  <input
                    className="eng-name"
                    value={eng.name}
                    onChange={(e) => updateEngine(idx, { name: e.target.value })}
                  />
                  <input
                    className="eng-url"
                    value={eng.url}
                    onChange={(e) => updateEngine(idx, { url: e.target.value })}
                  />
                  <label
                    className="radio sm"
                    title={eng.enabled ? "设为默认引擎" : "启用后才可设为默认"}
                  >
                    <input
                      type="radio"
                      name="defaultEngine"
                      checked={settings.defaultSearch === eng.name}
                      disabled={!eng.enabled}
                      onChange={() => patch({ defaultSearch: eng.name })}
                    />
                    默认
                  </label>
                  <label className="switch">
                    <input
                      type="checkbox"
                      checked={eng.enabled}
                      onChange={(e) => updateEngine(idx, { enabled: e.target.checked })}
                    />
                    <span className="knob" />
                  </label>
                  {/* 仅自定义引擎可删除；内置引擎为系统默认，只可停用/排序 */}
                  {!BUILTIN_ENGINES.has(eng.name) && (
                    <button
                      className="row-del"
                      title="删除该引擎"
                      aria-label="删除该引擎"
                      onClick={() => removeEngine(idx)}
                    >
                      <Trash2 size={13} strokeWidth={1.75} />
                    </button>
                  )}
                </div>
              ))}

              <div className="eng-add">
                {ENGINE_PRESETS.filter(
                  ([n]) => !settings.searchEngines.some((e) => e.name === n),
                ).map(([n, u]) => (
                  <button key={n} className="btn sm" onClick={() => addEngine(n, u)}>
                    ＋ {n}
                  </button>
                ))}
                <button className="btn sm" onClick={() => addEngine("自定义", "https://")}>
                  ＋ 自定义
                </button>
              </div>
            </div>

            <div className="save-bar">
              <button className="btn primary" onClick={save}>
                {saved ? "已保存" : "保存更改"}
              </button>
            </div>
          </>
        )}

        {page === "blocklist" && (
          <>
            <h1>禁用应用</h1>
            <p className="page-hint">
              列表内的应用在划词时不显示浮动条。「选择应用…」添加，条目右侧图标移除。更改需保存后生效。
            </p>

            <div className="card">
              {settings.appBlacklist.length === 0 ? (
                <div className="row-between tight">
                  <div>
                    <div className="row-title" style={{ color: "var(--sec)" }}>
                      暂无禁用应用
                    </div>
                    <div className="row-sub">列表为空，所有应用划词时均显示浮动条。</div>
                  </div>
                </div>
              ) : (
                settings.appBlacklist.map((name, i) => (
                  <div className="row-between tight" key={`${name}-${i}`}>
                    <div className="row-title">{name}</div>
                    <button
                      className="row-del"
                      title="移出禁用列表"
                      aria-label="移出禁用列表"
                      onClick={() =>
                        patch({
                          appBlacklist: settings.appBlacklist.filter((_, idx) => idx !== i),
                        })
                      }
                    >
                      <Trash2 size={13} strokeWidth={1.75} />
                    </button>
                  </div>
                ))
              )}
              <div className="card-foot">
                <button
                  className="btn primary"
                  onClick={() => {
                    invoke<string | null>("pick_app_bundle")
                      .then((app) => {
                        if (app && !settings.appBlacklist.includes(app)) {
                          patch({ appBlacklist: [...settings.appBlacklist, app] });
                        }
                      })
                      .catch(() => undefined);
                  }}
                >
                  选择应用…
                </button>
              </div>
            </div>

            <div className="save-bar">
              <button className="btn primary" onClick={save}>
                {saved ? "已保存" : "保存更改"}
              </button>
            </div>
          </>
        )}

        {page === "appearance" && (
          <>
            <h1>外观</h1>
            <h2 className="sec">主题</h2>
            <div className="card">
              <div className="row-between">
                <div>
                  <div className="row-title">应用外观</div>
                  <div className="row-sub">
                    亮色、暗色或跟随系统自动切换。即时生效，覆盖浮动条、识别面板与提示。
                  </div>
                </div>
                <div className="seg" role="radiogroup" aria-label="应用外观">
                  {[
                    ["auto", "跟随系统"],
                    ["light", "亮色"],
                    ["dark", "暗色"],
                  ].map(([value, label]) => (
                    <button
                      key={value}
                      className={appearance === value ? "on" : ""}
                      onClick={() => setAppearanceMode(value)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </>
        )}
        {page === "about" && (
          <>
            <h1>关于</h1>
            <p className="page-hint">
              查看版本、检查更新、设定程序坞图标显隐。更新检测仅读取 GitHub Releases 的公开版本信息，不发送本机数据。
            </p>
            <div className="card about-card">
              <img className="mark big" src={markIcon} alt="拾趣" />
              <div className="about-name">拾趣</div>
              <div className="about-slogan">划词拾趣，阅有所得</div>
              <div className="about-desc">拾趣 Magpie · 划词即懂的阅读伴侣</div>
              <div className="about-motto">得于阅，存于思</div>
              <div className="about-ver">版本 {appVersion || "—"}</div>
            </div>
            <h2 className="sec">应用</h2>
            <div className="card">
              <div className="row-between">
                <div>
                  <div className="row-title">在程序坞中显示图标</div>
                  <div className="row-sub">
                    默认仅以菜单栏形态常驻。开启后程序坞同时显示图标；关闭时点主窗口关闭按钮仅隐藏窗口，退出请用菜单栏右键「退出应用」。
                  </div>
                </div>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={settings.showDockIcon}
                    onChange={(e) => {
                      const next = { ...settings, showDockIcon: e.target.checked };
                      setSettings(next);
                      invoke("save_settings", { settings: next }).catch(() =>
                        toast("保存失败，请重试", "err"),
                      );
                    }}
                  />
                  <span className="knob" />
                </label>
              </div>
              <div className="row-between sep">
                <div>
                  <div className="row-title">检查新版本</div>
                  <div className="row-sub">{updateHint(upd)}</div>
                </div>
                <div className="row-ctl">
                  {upd?.status === "available" && upd.url && (
                    <button
                      className="btn sm primary"
                      onClick={() =>
                        invoke("open_url", { url: upd.url }).catch(() => undefined)
                      }
                    >
                      下载 v{upd.latest}
                    </button>
                  )}
                  <button
                    className="btn sm"
                    disabled={checking}
                    onClick={() => runUpdateCheck(true)}
                  >
                    {checking ? "检查中…" : "检查更新"}
                  </button>
                </div>
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
