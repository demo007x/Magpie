import { useCallback, useEffect, useRef, useState } from "react";
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
  Languages,
  Search,
  ShieldCheck,
  TextCursorInput,
  Trash2,
} from "lucide-react";
import { ACTIONS } from "../shared/actions";
import markIcon from "./assets/mark.svg";
import type { Provider, SearchEngine, Settings } from "../shared/types";

type Page =
  | "model"
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
  capture: <TextCursorInput size={15} strokeWidth={1.75} />,
  shortcuts: <Keyboard size={15} strokeWidth={1.75} />,
  perms: <ShieldCheck size={15} strokeWidth={1.75} />,
  translate: <Languages size={15} strokeWidth={1.75} />,
  search: <Search size={15} strokeWidth={1.75} />,
  blocklist: <Ban size={15} strokeWidth={1.75} />,
  appearance: <Palette size={15} strokeWidth={1.75} />,
  about: <Info size={15} strokeWidth={1.75} />,
};

// 快捷键条目注册表：新增全局快捷键 = 加一行配置 + settings 加对应字段
// （文案面向用户描述触发后的行为，不描述按键本身）
const SHORTCUT_ITEMS: Array<{
  key: "ocrShortcut";
  label: string;
  desc: string;
}> = [
  {
    key: "ocrShortcut",
    label: "文本识别",
    desc: "点击右侧框后按下组合键即完成录制（需含 Alt / ⌘ / Ctrl / Shift 至少一个修饰键，如 ⌥S、⌘⇧O；Esc 取消）。任意应用内按下即拉起框选识别，托盘菜单旁会同步显示当前设定的键。注册失败（被其他应用占用）时不会生效，可换一个组合。",
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
};

const ACTION_DESC: Record<string, string> = {
  translate: "中文译英文，其他译中文，附学习要点",
  explain: "解释选中内容是什么、为什么重要",
  summarize: "提炼要点，最多 5 条",
  copy: "复制选中的原文",
  search: "用默认搜索引擎搜索选中内容",
  link: "选中的是网址时，一键打开网页",
  email: "选中的是邮箱时，唤起邮件客户端",
  code: "选中含验证码时，一键复制纯数字",
  tel: "选中含电话号码时，一键复制号码",
};

const isAiAction = (id: string) => ACTIONS.find((a) => a.id === id)?.kind !== "local";

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
  ["ai", "AI 翻译", "大模型翻译，语句自然灵活，适合学习、对照等质量优先的场景。"],
  ["baidu", "百度翻译", "出结果快，每月有免费额度，适合快速读懂大意、日常查词；注册即可获取免费密钥。"],
  ["deepl", "DeepL", "译文自然地道，适合正式文档、精读等在意质量的场景；注册即可获取免费密钥。"],
];

export default function App() {
  const [page, setPage] = useState<Page>("model");
  // 应用版本：运行时读取 tauri.conf.json 的权威值（不再手写，避免与配置漂移）
  const [appVersion, setAppVersion] = useState("");

  useEffect(() => {
    getVersion().then(setAppVersion).catch(() => undefined);
  }, []);

  // 外观：Liquid Glass 可用性 + 开关
  const [glassAvailable, setGlassAvailable] = useState<boolean | null>(null);
  const [liquidGlass, setLiquidGlass] = useState<boolean>(true);
  // 应用外观（auto=跟随系统 | light | dark）：主窗口自身也要应用
  const [appearance, setAppearance] = useState<string>("auto");

  const applyAppearance = (t: string) => {
    const el = document.documentElement;
    el.classList.toggle("theme-light", t === "light");
    el.classList.toggle("theme-dark", t === "dark");
  };

  useEffect(() => {
    invoke<boolean>("liquid_glass_available")
      .then(setGlassAvailable)
      .catch(() => setGlassAvailable(false));
    invoke<{ liquidGlass?: boolean; appearance?: string }>("get_settings")
      .then((s) => {
        setLiquidGlass(s.liquidGlass ?? true);
        setAppearance(s.appearance ?? "auto");
        applyAppearance(s.appearance ?? "auto");
      })
      .catch(() => undefined);
    // Rust 侧开关后广播最新状态，保持设置页与实际生效状态一致
    const unGlass = listen<boolean>("theme://liquid-glass", (e) => setLiquidGlass(e.payload));
    const unTheme = listen<string>("theme://appearance", (e) => {
      setAppearance(e.payload);
      applyAppearance(e.payload);
    });
    return () => {
      unGlass.then((f) => f()).catch(() => undefined);
      unTheme.then((f) => f()).catch(() => undefined);
    };
  }, []);

  const toggleLiquidGlass = (enabled: boolean) => {
    setLiquidGlass(enabled);
    invoke("set_liquid_glass", { enabled }).catch(() => undefined);
  };

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
      searchEngines: settings.searchEngines,
      defaultSearch: settings.defaultSearch,
      translateEnabled: settings.translate.enabled,
      translateDefault: settings.translate.default,
      translateOrder: settings.translate.order,
    }).catch(() => undefined);
  }, [
    settings?.actions,
    settings?.actionOrder,
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
      .catch((e) => alert(`保存失败：${e}`));
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
      alert("至少保留一个翻译服务");
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
  const orderedActionIds = settings
    ? [...new Set([...settings.actionOrder, ...Object.keys(settings.actions)])]
    : [];

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
        const order = [...new Set([...s.actionOrder, ...Object.keys(s.actions)])];
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
        alert("至少保留一个启用的搜索引擎");
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
      alert("至少保留一个启用的搜索引擎");
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
              翻译、解释、总结都由你选择的大模型驱动：添加任意 OpenAI
              协议兼容的服务并设为默认，密钥只保存在本机，请求仅发往你填写的地址。修改后点击「保存更改」生效。
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
                    className="btn ghost danger"
                    onClick={() => {
                      if (settings.providers.length <= 1) {
                        alert("至少保留一个模型服务");
                        return;
                      }
                      const rest = settings.providers.filter((x) => x.id !== p.id);
                      patch({
                        providers: rest,
                        defaultProviderId:
                          settings.defaultProviderId === p.id ? rest[0].id : settings.defaultProviderId,
                      });
                    }}
                  >
                    删除
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
          </>
        )}

        {page === "capture" && (
          <>
            <h1>划词</h1>
            <p className="page-hint">
              在任意应用中选中文字，浮动条即刻提供翻译、解释、总结等动作。本页管理浮动条动作的开关与顺序，改动点击「保存更改」后生效。
            </p>

            <h2 className="sec">动作</h2>
            <div className="card">
              {orderedActionIds.map((k) => (
                <div
                  key={k}
                  ref={(el) => {
                    if (el) rowEls.current.set(k, el);
                    else rowEls.current.delete(k);
                  }}
                  className={`row-between sep action-row ${dragId === k ? "dragging" : ""} ${
                    overId === k && dragId && dragId !== k ? "drop-target" : ""
                  }`}
                >
                  <div className="row-title">
                    <span className="grip" title="拖动排序" onMouseDown={(e) => onGripDown(e, k)}>
                      <GripVertical size={13} strokeWidth={1.75} />
                    </span>
                    {ACTION_LABELS[k] ?? k}
                    {isAiAction(k) && <span className="tag ai">AI</span>}
                    <span className="action-desc">{ACTION_DESC[k] ?? ""}</span>
                  </div>
                  <div className="row-ctl">
                    <label className="switch">
                      <input
                        type="checkbox"
                        checked={settings.actions[k as keyof typeof settings.actions] ?? false}
                        onChange={(e) => {
                          // 至少保留一个开启的动作，避免浮动条变空白
                          if (
                            !e.target.checked &&
                            Object.values(settings.actions).filter(Boolean).length <= 1
                          ) {
                            alert("至少保留一个动作");
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
              ))}
            </div>

            <div className="save-bar">
              <button className="btn primary" onClick={save}>
                {saved ? "已保存" : "保存更改"}
              </button>
            </div>
          </>
        )}

        {page === "shortcuts" && (
          <>
            <h1>快捷键</h1>
            <p className="page-hint">
              全局快捷键在任意应用内生效。改动点击「保存更改」后即时生效；若组合被其他应用占用导致注册失败，可换一个组合。
            </p>
            <div className="card">
              {SHORTCUT_ITEMS.map((item) => (
                <div className="row-between" key={item.key}>
                  <div>
                    <div className="row-title">{item.label}</div>
                    <div className="row-sub">{item.desc}</div>
                  </div>
                  <ShortcutRecorder
                    value={settings[item.key]}
                    onChange={(v) => patch({ [item.key]: v } as Partial<Settings>)}
                  />
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
              划词依赖两项系统权限，未授权时按引导开启，授权后状态自动刷新。
            </p>
            <div className="card">
              <div className="row-between">
                <div>
                  <div className="row-title">辅助功能</div>
                  <div className="row-sub">
                    划词的根基：读取你在任何应用中选中的文字。未授权时点下方「授权划词」开启。
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
                    让拾趣感知你的划词动作，缺失时浮动条不会弹出。未授权时点下方「授权输入监控」开启。
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
                    托盘「文本识别」需要读取屏幕画面并离线识别文字。未授权时点下方「授权屏幕录制」开启。
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
                    保障划词稳定的健康检查。若已授权仍显示异常：在系统设置「辅助功能」中取消再重新勾选拾趣，然后重启应用。
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
              一个划词，多个译法随点随换：开关控制服务是否出现在「翻译」展开列表，拖动调整顺序，「默认」单击直达；方向自动识别（中文译英文，其他译中文）。改动即时生效，点「保存更改」持久化。
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
              选中文字，一键开搜：开关控制引擎是否出现在「搜索」展开列表，拖动调整顺序，「默认」单击直达；也支持添加自定义引擎，链接中的 {'{q}'} 会替换为选中文本。改动即时生效，点「保存更改」持久化。
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
                      className="eng-del"
                      title="删除该引擎"
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
              让拾趣在敏感场景保持安静：黑名单应用内划词不触发浮动条，适合终端、密码管理器等应用。点「选择应用…」从应用列表挑选，保存后立即生效。
            </p>

            <div className="card">
              {settings.appBlacklist.length === 0 ? (
                <div className="row-between">
                  <div className="row-title" style={{ color: "var(--sec)" }}>
                    暂无禁用应用
                  </div>
                </div>
              ) : (
                settings.appBlacklist.map((name, i) => (
                  <div className="row-between" key={`${name}-${i}`}>
                    <div className="row-title">{name}</div>
                    <button
                      className="btn"
                      onClick={() =>
                        patch({
                          appBlacklist: settings.appBlacklist.filter((_, idx) => idx !== i),
                        })
                      }
                    >
                      移除
                    </button>
                  </div>
                ))
              )}
            </div>

            <div className="card">
              <div className="row-between">
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
                    选择亮色或暗色，或跟随系统外观自动切换。即时生效，对划词条、识别面板、提示全部生效。
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
            <h2 className="sec">Liquid Glass</h2>
            <div className="card">
              <div className="row-between">
                <div>
                  <div className="row-title">启用 Liquid Glass 效果</div>
                  <div className="row-sub">
                    {glassAvailable === false
                      ? "当前系统不支持 Liquid Glass（需 macOS 26），窗口保持实心样式。"
                      : "在 macOS 26 的玻璃材质上渲染半透明浮动窗口（划词条、结果面板、提示），即时生效并持久保存。"}
                  </div>
                </div>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={liquidGlass}
                    disabled={glassAvailable === false}
                    onChange={(e) => toggleLiquidGlass(e.target.checked)}
                  />
                  <span className="knob" />
                </label>
              </div>
            </div>
          </>
        )}
        {page === "about" && (
          <>
            <h1>关于</h1>
            <p className="page-hint">
              选中的文字仅发送至你配置的服务，拾趣不收集任何数据。
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
                    拾趣默认以菜单栏形态常驻，划词随时可用；开启后在程序坞同时显示图标。关闭时点主窗口关闭按钮仅隐藏窗口，退出请用菜单栏右键「退出应用」。
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
                        alert("保存失败，请重试"),
                      );
                    }}
                  />
                  <span className="knob" />
                </label>
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
