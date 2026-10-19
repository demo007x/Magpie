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
  NotebookPen,
  SlidersHorizontal,
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
import {
  formEntryOf,
  PRESET_PROVIDERS,
  presetByBaseUrl,
  type ProviderPreset,
} from "../shared/providerPresets";
import {
  TRANSLATE_SERVICES,
  translateMissingReason,
  translateService,
  type TranslateService,
} from "../shared/translate";
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
  | "obsidian"
  | "blocklist"
  | "general"
  | "about";

const NAV_ICONS: Record<Page, React.ReactNode> = {
  model: <Cpu size={15} strokeWidth={1.75} />,
  prompts: <Sparkles size={15} strokeWidth={1.75} />,
  capture: <TextCursorInput size={15} strokeWidth={1.75} />,
  shortcuts: <Keyboard size={15} strokeWidth={1.75} />,
  perms: <ShieldCheck size={15} strokeWidth={1.75} />,
  translate: <Languages size={15} strokeWidth={1.75} />,
  search: <Search size={15} strokeWidth={1.75} />,
  obsidian: <NotebookPen size={15} strokeWidth={1.75} />,
  blocklist: <Ban size={15} strokeWidth={1.75} />,
  general: <SlidersHorizontal size={15} strokeWidth={1.75} />,
  about: <Info size={15} strokeWidth={1.75} />,
};

// 快捷键条目注册表：新增全局快捷键 = 加一行配置 + settings 加对应字段。
// desc 只描述「按下去会发生什么」（用户视角）；录制操作说明放在页面顶部 hint
const SHORTCUT_ITEMS: Array<{
  key:
    | "ocrShortcut"
    | "ocrTranslateShortcut"
    | "ocrExplainShortcut"
    | "ocrSummarizeShortcut"
    | "fileOcrShortcut";
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
    desc: "框选截图，AI 自动解释识别出的内容。默认 ⌥E。",
  },
  {
    key: "ocrSummarizeShortcut",
    label: "识图总结",
    default: "Alt+D",
    desc: "框选截图，AI 自动提炼识别出的文字要点。默认 ⌥D。",
  },
  {
    key: "fileOcrShortcut",
    label: "访达选图取字",
    default: "Alt+F",
    desc: "选择一张图片文件，识别其中的文字，后续操作与识图取字一致。默认 ⌥F。",
  },
];

// 快捷键显示转换：存储统一为 Tauri 跨平台格式（"Alt+S"），显示按平台翻译——
// macOS 用 ⌥⌃⇧⌘ 符号，Windows 保留 Alt/Ctrl 原文。与 Rust 侧 shortcut_display
//（托盘菜单键位）同一套映射
const IS_MAC = /Mac/i.test(navigator.platform);
const MOD_SYMBOLS: Record<string, string> = {
  Alt: "⌥",
  Option: "⌥",
  CmdOrCtrl: "⌘",
  Cmd: "⌘",
  Meta: "⌘",
  Super: "⌘",
  Control: "⌃",
  Ctrl: "⌃",
  Shift: "⇧",
};
// Windows 显示名：修饰键规范化为平台惯用名（存储保持 Tauri 跨平台格式不变），
// 与 Rust 侧 shortcut_display（托盘菜单）同一套映射，两处需同步
const MOD_NAMES_WIN: Record<string, string> = {
  CmdOrCtrl: "Ctrl",
  Cmd: "Ctrl",
  Meta: "Ctrl",
  Super: "Ctrl",
  Control: "Ctrl",
  Ctrl: "Ctrl",
  Option: "Alt",
  Alt: "Alt",
  Shift: "Shift",
};
function displayShortcut(v: string): string {
  if (!v) return "";
  return v
    .split("+")
    .map((p) => (IS_MAC ? (MOD_SYMBOLS[p] ?? p) : (MOD_NAMES_WIN[p] ?? p)))
    // macOS 符号连写（⌥S）；Windows 用 + 连接（Alt+S）
    .join(IS_MAC ? "" : "+");
}

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

  const sym = (m: string) => (IS_MAC ? (MOD_SYMBOLS[m] ?? m) : m);

  return (
    <input
      readOnly
      style={{ width: 180, flexShrink: 0, cursor: "pointer" }}
      className={recording ? "recording" : ""}
      value={recording ? hint || "按下组合键…" : displayShortcut(value)}
      placeholder={IS_MAC ? "点击录制，如 ⌥S" : "点击录制，如 Alt+S"}
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
          setHint(mods.length ? `${mods.map(sym).join("+")}+…` : "按下组合键…");
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
  baseUrl: "",
  apiKey: "",
  model: "",
  form: "chat",
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
  obsidian: "Obsidian",
};

/** Obsidian 模板出厂默认值，与 src-tauri/src/settings.rs 的 ObsidianConfig::default 保持一致
    （「恢复默认」按钮的目标值；obsidian 配置为全量存储，没有缺省回落机制） */
const DEFAULT_EXCERPT_TEMPLATE = "- **{time}** · 来源：{source}\n  > {text}";
const DEFAULT_TASK_TEMPLATE = "- [ ] {text} {dueTag}";
const DEFAULT_CARD_TEMPLATE = "- **{time}** · 来源：{source}\n  > {text}";

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
  obsidian: "已配置 Obsidian vault 时，把选中内容按摘录模板追加进日记",
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
  // 划词捕获能力位：后端真实可用才显示「划词/黑名单」导航（Windows 后端落地自动出现）
  const [captureReady, setCaptureReady] = useState(false);

  useEffect(() => {
    getVersion().then(setAppVersion).catch(() => undefined);
    invoke<{ captureAvailable: boolean }>("capture_status")
      .then((s) => setCaptureReady(s.captureAvailable))
      .catch(() => undefined);
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

  /** 结果窗口预设档位（逻辑坐标），横竖两个方向 × 紧凑/宽敞两个量级：
      横向宽度顶格 560（拖拽钳制上限）、竖向大档高度顶格 800（同上）。
      点选立即作用于结果窗并持久化（走 Rust 命令，不经过本页保存按钮）；
      用户拖拽微调仍会记忆，拖后与预设不一致时高亮自然消失 */
  const RESULT_SIZE_PRESETS: { label: string; size: [number, number] }[] = [
    { label: "紧凑·横", size: [560, 320] },
    { label: "紧凑·竖", size: [400, 560] },
    { label: "宽敞·横", size: [560, 480] },
    { label: "宽敞·竖", size: [480, 800] },
  ];

  const applyResultPreset = (size: [number, number]) => {
    invoke("apply_result_preset", { width: size[0], height: size[1] }).catch(() => undefined);
    // save_settings 提交的是本地全量 settings——本地不同步的话，其他页面的保存会回退预设
    patch({ resultWindowSize: size });
  };
  const [settings, setSettings] = useState<Settings | null>(null);
  // settings 的同步镜像：同一 tick 内连发的多个 patch 依次叠加在 ref 上，紧随其后
  // 的 saveNow() 读 ref 即得最新值（函数式 setState 的更新在事件结束后才提交，
  // 靠它做「改完即存」会存到旧值——自定义动作丢字问题的同源坑）
  const settingsRef = useRef<Settings | null>(null);
  const [saved, setSaved] = useState(true);
  const [granted, setGranted] = useState<boolean | null>(null);
  const [listenAccess, setListenAccess] = useState<boolean | null>(null);
  const [axServiceOk, setAxServiceOk] = useState<boolean | null>(null);
  const [screenAccess, setScreenAccess] = useState<boolean | null>(null);
  // 截图/识别失败等全局提示改由独立 toast 窗口展示（主窗口隐藏时也可见）

  useEffect(() => {
    // 极早发出的 invoke 可能撞上 Rust 侧状态未就位（Windows webview 加载快于
    // setup，实测发生过）：失败退避重试而不是吞掉——吞掉 = 永远停在载入页
    let stop = false;
    const load = (delay: number) => {
      window.setTimeout(() => {
        if (stop) return;
        invoke<Settings>("get_settings")
          .then((s) => {
            if (!stop) {
              settingsRef.current = s;
              setSettings(s);
            }
          })
          .catch(() => load(delay === 0 ? 250 : Math.min(delay * 2, 2000)));
      }, delay);
    };
    load(0);
    return () => {
      stop = true;
    };
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

  const patch = useCallback((p: Partial<Settings> | ((s: Settings) => Partial<Settings>)) => {
    const s = settingsRef.current;
    if (!s) return;
    // 同步镜像：同一 tick 内连发的多个 patch（中文 IME 组合串、快速连打）依次
    // 叠加在 ref 上互不覆盖；渲染用 setSettings(next) 提交同一份。
    // 文本类更新必须走函数式 partial，禁止用渲染闭包的 settings 拼数组
    const next = { ...s, ...(typeof p === "function" ? p(s) : p) };
    settingsRef.current = next;
    setSettings(next);
    setSaved(false);
  }, []);

  // 即时落盘：读镜像 ref（恒为最新），供「改完即存」的路径调用
  const saveNow = useCallback(() => {
    const s = settingsRef.current;
    if (!s) return;
    invoke("save_settings", { settings: s })
      .then(() => setSaved(true))
      .catch((e) => toast(`保存失败：${e}`, "err"));
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
    // 保存闸：启用中的服务必填凭据未填不许落盘（提示即注册表推导的同一句文案，
    // 并当场展开该行）；停用的服务不拦——它不进菜单，用时另有兜底提醒
    for (const id of settings.translate.enabled) {
      const missing = translateMissingReason(
        settings.translate,
        settings.providers,
        settings.defaultProviderId,
        id,
      );
      if (missing) {
        toast(missing, "err");
        setSvcOpen((m) => ({ ...m, [id]: true }));
        return;
      }
    }
    invoke("save_settings", { settings })
      .then(() => {
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      })
      .catch((e) => toast(`保存失败：${e}`, "err"));
  };

  const patchProvider = (id: string, p: Partial<Provider>) => {
    patch((s) => ({ providers: s.providers.map((x) => (x.id === id ? { ...x, ...p } : x)) }));
  };

  // 添加模型服务：预设（预填名称/地址/形态/候选模型，只差密钥）或自定义（手填全项）。
  // 不置灰已添加预设——同一家开两个号是合理需求
  const addProvider = (preset: ProviderPreset) => {
    if (!settings) return;
    const p: Provider = {
      id: `p${Date.now()}`,
      name: preset.label,
      baseUrl: preset.forms[0].baseUrl,
      apiKey: "",
      model: "",
      form: preset.forms[0].form,
    };
    patch({
      providers: [...settings.providers, p],
      defaultProviderId: settings.providers.length === 0 ? p.id : settings.defaultProviderId,
    });
    setProviderOpen(p.id); // 新卡自动展开，直接进入编辑
    setProvPickerOpen(false);
  };

  const addCustomProvider = () => {
    if (!settings) return;
    const p = NEW_PROVIDER();
    patch({
      providers: [...settings.providers, p],
      defaultProviderId: settings.providers.length === 0 ? p.id : settings.defaultProviderId,
    });
    setProviderOpen(p.id);
    setProvPickerOpen(false);
  };

  // 翻译服务添加/移除：添加即启用（凭据可后补）；停用只摘出菜单、保留配置
  // （用量耗尽先停不删）——「保留配置」是停用的语义，移除则连凭据一起删净，
  // 两个动作分工明确，删除不留不可见的残余状态。默认项被停用/移除时顺延
  const addTranslate = (id: string) => {
    if (!settings) return;
    const cur = settings.translate;
    if (addedServiceIds.has(id)) return;
    const enabled = [...cur.enabled, id];
    setSvcOpen((m) => ({ ...m, [id]: true })); // 添加即自动展开该服务的凭据填写
    patch({
      translate: {
        ...cur,
        enabled,
        order: [...cur.order, id],
        default: cur.default || enabled[0] || "",
      },
    });
  };

  const removeTranslate = (id: string) => {
    if (!settings) return;
    const cur = settings.translate;
    if (cur.enabled.length <= 1) {
      toast("至少保留一个翻译服务", "err");
      return;
    }
    const enabled = cur.enabled.filter((x) => x !== id);
    const credentials = { ...cur.credentials };
    delete credentials[id];
    patch({
      translate: {
        ...cur,
        enabled,
        order: cur.order.filter((x) => x !== id),
        default: cur.default === id ? (enabled[0] ?? "") : cur.default,
        credentials,
      },
    });
    setConfirmDelSvc(null);
  };

  // 停用只摘出「翻译」展开列表（凭据与排序保留），全部停用也允许——
  // 浮动条点击翻译时会兜底提示未启用服务
  const toggleTranslate = (id: string, on: boolean) => {
    if (!settings) return;
    const cur = settings.translate;
    const enabled = on
      ? cur.enabled.includes(id)
        ? cur.enabled
        : [...cur.enabled, id]
      : cur.enabled.filter((x) => x !== id);
    patch({
      translate: {
        ...cur,
        enabled,
        default: enabled.includes(cur.default) ? cur.default : (enabled[0] ?? ""),
      },
    });
  };

  // 翻译凭据输入：函数式 partial（密钥是文本输入，同 updateCustom 的连发丢键风险）
  const updateCred = (svcId: string, field: string, value: string) => {
    patch((s) => ({
      translate: {
        ...s.translate,
        credentials: {
          ...s.translate.credentials,
          [svcId]: { ...s.translate.credentials[svcId], [field]: value },
        },
      },
    }));
  };

  // 动作顺序：已配置顺序 + 注册表中新增动作（追加末尾）
  const orderedActionIds = settings ? allActionIds(settings) : [];
  // resident 动作（含自定义）与上下文动作分两张卡：后者只在选中内容含实体时出现，
  // 且同时最多上一个胶囊，四者之间排序对浮动条没有意义——混在常驻列表里反而误导"可排"
  const residentIds = orderedActionIds.filter((id) => !CONTEXT_ACTION_IDS.has(id));
  // 打开地图依赖地名识别（macOS NLTagger，Windows 无系统级等价物）——
  // Windows 上不显示该开关（无能力不显示），地点 chip 运行时本就不会出现
  const contextIds = orderedActionIds.filter(
    (id) => CONTEXT_ACTION_IDS.has(id) && (IS_MAC || id !== "addr"),
  );

  // 翻译服务列表：已添加的（order ∪ enabled——旧配置 enabled 可能超出 order）
  // 按 order 排，order 里没记到的 id 按注册表顺序垫底。行内开关决定是否进入
  // 浮动条「翻译」展开列表（enabled ⊆ 已添加 ⊆ 注册表）；停用只摘出菜单，
  // 凭据保留（用量耗尽时先停不删配置）
  const translateRows: TranslateService[] = (() => {
    if (!settings) return [];
    const t = settings.translate;
    const regIdx = (id: string) => TRANSLATE_SERVICES.findIndex((s) => s.id === id);
    const okey = (id: string) => {
      const i = t.order.indexOf(id);
      return i >= 0 ? i : TRANSLATE_SERVICES.length + regIdx(id);
    };
    return [...new Set([...t.order, ...t.enabled])]
      .map((id) => translateService(id))
      .filter((s): s is TranslateService => !!s)
      .sort((a, b) => okey(a.id) - okey(b.id));
  })();
  // 已添加集合（选择器据此排除，停用中的不算未添加）
  const addedServiceIds = new Set(
    settings ? [...settings.translate.order, ...settings.translate.enabled] : [],
  );

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
      // 落位：从原位置移除后插入目标位置，随即落盘（划词页即时保存）
      patch((s) => {
        const order = allActionIds(s);
        const from = order.indexOf(id);
        const to = order.indexOf(target);
        if (from < 0 || to < 0) return {};
        order.splice(from, 1);
        order.splice(to, 0, id);
        return { actionOrder: order };
      });
      saveNow();
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
    // 守卫走渲染闭包即可：点击路径离散无连发竞态；文本字段（名称/URL）才需要函数式
    if (p.enabled === false && settings) {
      if (settings.searchEngines.filter((x) => x.enabled).length <= 1) {
        toast("至少保留一个启用的搜索引擎", "err");
        return;
      }
    }
    patch((s) => {
      const old = s.searchEngines[idx];
      const next = s.searchEngines.map((x, i) => (i === idx ? { ...x, ...p } : x));
      let defaultSearch = s.defaultSearch;
      // 重命名默认引擎时同步默认项；停用默认引擎时顺延到首个启用项
      if (p.name && old.name === defaultSearch) defaultSearch = p.name;
      if (p.enabled === false && defaultSearch === old.name) {
        defaultSearch = next.find((x) => x.enabled)?.name ?? "";
      }
      return { searchEngines: next, defaultSearch };
    });
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
  // 翻译服务凭据折叠态；添加服务时自动展开一次（见 addTranslate）
  const [svcOpen, setSvcOpen] = useState<Record<string, boolean>>({});
  // 「添加服务」内联 chips 面板（卡片底部展开，非弹窗）：完整目录常驻，已添加置灰
  const [svcPickerOpen, setSvcPickerOpen] = useState(false);
  // 移除翻译服务的二次确认（.row-del 一发就删太容易手滑；确认文案言明密钥同删）
  const [confirmDelSvc, setConfirmDelSvc] = useState<string | null>(null);

  // 提示词卡手风琴：同时只展开一个（三张卡全展开要滚三屏，而这页的用法就是一次调一个动作）。
  // 编辑框始终是「当前生效内容」，内容与默认一致时不落覆盖项——恢复默认因此是删 key，
  // 而不是回写一份当时的默认文本
  const [promptOpen, setPromptOpen] = useState<AiActionId | null>(null);
  // 模型服务折叠卡：单开（同 Prompt 页），添加服务后自动展开新卡进入编辑
  const [providerOpen, setProviderOpen] = useState<string | null>(null);
  // 「添加服务」预设 chips 面板（与翻译页同款内联交互）
  const [provPickerOpen, setProvPickerOpen] = useState(false);

  const setPrompt = (id: AiActionId, value: string) => {
    patch((s) => {
      const next = { ...s.actionPrompts };
      if (value.trim() === DEFAULT_PROMPTS[id].trim()) delete next[id];
      else next[id] = value;
      return { actionPrompts: next };
    });
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

  /** 关闭编辑模态 = 即时落盘（完成 / × / Esc / 点遮罩共用路径）：编辑在每次按键
   *  时已写入本地状态，这里统一持久化——划词页不再有「保存更改」按钮 */
  const closeActionModal = () => {
    tryRunRef.current++;
    setTryRun(null);
    setDelArm(false);
    setActionModal(null);
    saveNow();
  };

  const updateCustom = (id: string, p: Partial<CustomAction>) => {
    patch((s) => ({
      customActions: s.customActions.map((c) => (c.id === id ? { ...c, ...p } : c)),
    }));
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
    saveNow();
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
      if (!target || target === id) return;
      // 行序即新 order：列表是已添加全集，按视觉顺序整体替换
      const ids = translateRows.map((r) => r.id);
      const from = ids.indexOf(id);
      const to = ids.indexOf(target);
      if (from < 0 || to < 0 || !settings) return;
      ids.splice(from, 1);
      ids.splice(to, 0, id);
      patch({ translate: { ...settings.translate, order: ids } });
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
              // 导航用最短名词，风格统一：不带「设置/服务/引擎」等可由
              // 「这是设置 App」推断的后缀；品牌名（Obsidian）保留原文。
              // 平台能力门控：本平台没有的能力不显示（winVmac Windows 约定）——
              // 划词/黑名单随 capture_status.captureAvailable 自动显隐
              ["capture", "划词", captureReady],
              ["shortcuts", "快捷键", true],
              ["model", "模型", true],
              ["prompts", "提示词", true],
              ["translate", "翻译", true],
              ["search", "搜索", true],
              ["obsidian", "Obsidian", true],
              ["blocklist", "黑名单", captureReady],
              ["general", "通用", true],
              ["perms", "权限", IS_MAC],
              ["about", "关于", true],
            ] as Array<[Page, string, boolean]>
          )
            .filter(([, , show]) => show)
            .map(([id, label]) => (
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
              添加模型服务选预设即可自动带出地址与形态，只填密钥并确认模型名；设为默认的一项供全部划词动作调用。密钥仅保存在本机。更改需保存后生效。
            </p>

            <h2 className="sec">服务</h2>
            {settings.providers.map((p) => {
              const open = providerOpen === p.id;
              // 按地址反查预设（含所在形态项）：命中则给占位指引并决定形态切换是否露出；
              // 改过地址即不再命中
              const hit = presetByBaseUrl(p.baseUrl);
              const preset = hit?.preset;
              return (
                <div className="card" key={p.id}>
                  {/* 折叠卡头：名称 + 模型 + 默认标记，点击展开编辑（与 Prompt 页同形态） */}
                  <div className="prompt-head" onClick={() => setProviderOpen(open ? null : p.id)}>
                    <div className="row-title">
                      {p.name || "未命名服务"}
                      <span className="action-desc">{p.model || "未配置模型"}</span>
                      {settings.defaultProviderId === p.id && <span className="tag ai">默认</span>}
                    </div>
                    {/* 不持 onClick：点把手冒泡到卡片头统一切换（与 Prompt 页同约定） */}
                    <button className={`svc-chev ${open ? "open" : ""}`} title={open ? "收起" : "展开编辑"}>
                      <ChevronDown size={13} strokeWidth={2} />
                    </button>
                  </div>
                  <div className={`svc-body ${open ? "open" : ""}`}>
                    <div>
                      <div className="grid">
                        <label className="field">
                          <span>名称</span>
                          <input value={p.name} onChange={(e) => patchProvider(p.id, { name: e.target.value })} />
                        </label>
                        <label className="field">
                          <span>模型</span>
                          <input
                            value={p.model}
                            placeholder={preset?.hint ?? ""}
                            onChange={(e) => patchProvider(p.id, { model: e.target.value })}
                          />
                        </label>
                        {/* 接口形态所有卡常驻：形态选择权在用户（厂商随时可能新增
                            端点，注册表快照不该锁死）。预设含该形态地址则切换时
                            自动带出（不同形态端点前缀可能完全不同，如智谱两形态
                            是两个基址）；未含则保持当前地址由用户自行确认 */}
                        <label className="field">
                          <span>接口形态</span>
                          <div style={{ display: "flex", gap: 14, marginTop: 6 }}>
                            {(["chat", "responses"] as const).map((f) => (
                              <label key={f} className="radio sm">
                                <input
                                  type="radio"
                                  name={`form-${p.id}`}
                                  checked={(p.form ?? "chat") === f}
                                  onChange={() => {
                                    const next = preset ? formEntryOf(preset, f) : undefined;
                                    patchProvider(
                                      p.id,
                                      next ? { form: f, baseUrl: next.baseUrl } : { form: f },
                                    );
                                  }}
                                />
                                {f === "chat" ? "Chat · 通用" : "Responses"}
                              </label>
                            ))}
                          </div>
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
                      <div className="row-between" style={{ marginTop: 10 }}>
                        <div>
                          <div className="row-title">思考模式</div>
                          <div className="row-sub">开启后回答更准但更慢，关闭更快。</div>
                        </div>
                        <label className="switch">
                          <input
                            type="checkbox"
                            checked={!!p.thinking}
                            onChange={(e) => patchProvider(p.id, { thinking: e.target.checked })}
                          />
                          <span className="knob" />
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
                  </div>
                </div>
              );
            })}
            <div className="prov-add">
              <button className="btn" onClick={() => setProvPickerOpen((v) => !v)}>
                <Plus size={13} strokeWidth={2} /> {provPickerOpen ? "收起" : "添加服务"}
              </button>
              {/* 内联 chips 面板（与翻译页同款交互）：选预设即预填地址/形态/候选模型，
                  点自定义保留手填全项；不置灰已添加项——同一家开两个号是合理需求 */}
              {provPickerOpen && (
                <div className="svc-chips">
                  {PRESET_PROVIDERS.map((ps) => (
                    <button key={ps.id} className="svc-chip" onClick={() => addProvider(ps)}>
                      {ps.label}
                    </button>
                  ))}
                  <button className="svc-chip" onClick={addCustomProvider}>
                    自定义
                  </button>
                </div>
              )}
            </div>

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
            <h1>提示词</h1>
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
              设定浮动条显示哪些动作及其排列顺序：拖动把手调序，开关停用某项。开关、顺序与自定义动作的编辑即时生效并自动保存。
              <br />
              「提取信息」仅在所选文字含网址 / 邮箱 / 电话 / 验证码 / 日期
              {IS_MAC ? " / 地点" : ""}时出现。
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
            {Object.values(settings.actions).every((v) => v === false) &&
              !settings.customActions.some((c) => c.enabled) && (
              <div className="all-off-note">
                所有动作均已关闭：划词后浮动条将不再出现。主窗口仍可从菜单栏图标进入，
                打开任一开关即可恢复。
              </div>
            )}
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
                                saveNow();
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
                              saveNow();
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
                  onClose={closeActionModal}
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
                      <button className="btn primary sm" onClick={closeActionModal}>
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
              「添加服务」选择服务商，添加即启用（开关随时停用，配置保留——用量耗尽先停不删）；凭据在行内展开填写，「默认」为浮动条单击直达项，拖动把手调整顺序；译文方向自动识别。改动即时反映到浮动条，点「保存更改」持久化。
            </p>

            <h2 className="sec">服务</h2>
            <div className="card">
              {translateRows.map((svc) => (
                <div
                  key={svc.id}
                  ref={(el) => {
                    if (el) svcRowEls.current.set(svc.id, el);
                    else svcRowEls.current.delete(svc.id);
                  }}
                  className={`svc ${svcDragId === svc.id ? "dragging" : ""} ${
                    svcOverId === svc.id && svcDragId && svcDragId !== svc.id ? "drop-target" : ""
                  }`}
                >
                  <div className="svc-main">
                    <span
                      className="grip"
                      title="拖动排序"
                      onMouseDown={(e) => onSvcGripDown(e, svc.id)}
                    >
                      <GripVertical size={13} strokeWidth={1.75} />
                    </span>
                    <div className="svc-content">
                      <div className="svc-head">
                        <div className="row-title">{svc.label}</div>
                        <div className="row-ctl">
                          <label
                            className="radio sm"
                            title={
                              settings.translate.enabled.includes(svc.id)
                                ? "设为默认翻译服务"
                                : "启用后才可设为默认"
                            }
                          >
                            <input
                              type="radio"
                              name="defaultTranslate"
                              checked={settings.translate.default === svc.id}
                              disabled={!settings.translate.enabled.includes(svc.id)}
                              onChange={() =>
                                patch({ translate: { ...settings.translate, default: svc.id } })
                              }
                            />
                            默认
                          </label>
                          <label className="switch" title="启用后进入「翻译」展开列表">
                            <input
                              type="checkbox"
                              checked={settings.translate.enabled.includes(svc.id)}
                              onChange={(e) => toggleTranslate(svc.id, e.target.checked)}
                            />
                            <span className="knob" />
                          </label>
                          <button
                            className="row-del"
                            title="移除该服务"
                            aria-label={`移除${svc.label}`}
                            onClick={() => {
                              if (settings.translate.enabled.length <= 1) {
                                toast("至少保留一个翻译服务", "err");
                                return;
                              }
                              setConfirmDelSvc(svc.id);
                            }}
                          >
                            <Trash2 size={13} strokeWidth={1.75} />
                          </button>
                          <button
                            className={`svc-chev ${svcOpen[svc.id] ? "open" : ""}`}
                            title={svcOpen[svc.id] ? "收起配置" : "展开配置"}
                            onClick={() => setSvcOpen((m) => ({ ...m, [svc.id]: !m[svc.id] }))}
                          >
                            <ChevronDown size={13} strokeWidth={2} />
                          </button>
                        </div>
                      </div>
                      <div className="row-sub">{svc.blurb}</div>

                      {svc.auth === "ai" && (
                        <div className={`svc-body ${svcOpen[svc.id] ? "open" : ""}`}>
                          <div>
                            <div className="svc-fields">
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

                      {svc.fields.length > 0 && (
                        <div className={`svc-body ${svcOpen[svc.id] ? "open" : ""}`}>
                          <div>
                            <div className="svc-fields">
                              {svc.fields.map((f) => (
                                <label
                                  key={f.field}
                                  className={`field ${svc.fields.length === 1 ? "wide" : ""}`}
                                >
                                  <span>{f.label}</span>
                                  <input
                                    type={f.secret ? "password" : "text"}
                                    value={
                                      (settings.translate.credentials[svc.id]?.[f.field] as
                                        | string
                                        | undefined) ?? ""
                                    }
                                    onChange={(e) =>
                                      updateCred(svc.id, f.field, e.target.value)
                                    }
                                    placeholder={f.placeholder}
                                  />
                                </label>
                              ))}
                              <div className="svc-fields-foot">
                                <button
                                  className="btn sm"
                                  onClick={() =>
                                    invoke("open_url", { url: svc.docsUrl }).catch(
                                      () => undefined,
                                    )
                                  }
                                >
                                  {svc.docsLabel}
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
              {TRANSLATE_SERVICES.some((s) => !addedServiceIds.has(s.id)) && (
                <div className="card-foot">
                  <button className="btn sm" onClick={() => setSvcPickerOpen((v) => !v)}>
                    <Plus size={13} strokeWidth={2} /> {svcPickerOpen ? "收起" : "添加服务"}
                  </button>
                </div>
              )}
              {/* 内联 chips 面板（替代弹窗）：名字即决策，描述在列表行里常年可见；
                  完整目录常驻（已添加置灰打勾），点即添加并收起 */}
              {svcPickerOpen && (
                <div className="svc-chips">
                  {TRANSLATE_SERVICES.map((s) => {
                    const added = addedServiceIds.has(s.id);
                    return (
                      <button
                        key={s.id}
                        className="svc-chip"
                        disabled={added}
                        onClick={() => {
                          addTranslate(s.id);
                          setSvcPickerOpen(false);
                        }}
                      >
                        {added ? `✓ ${s.label}` : s.label}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="save-bar">
              <button className="btn primary" onClick={save}>
                {saved ? "已保存" : "保存更改"}
              </button>
            </div>

            {confirmDelSvc &&
              (() => {
                const svc = translateRows.find((x) => x.id === confirmDelSvc);
                if (!svc) return null;
                return (
                  <Confirm
                    title="移除翻译服务"
                    text={`移除「${svc.label}」？已填写的密钥会一并删除；停用可保留配置。`}
                    onCancel={() => setConfirmDelSvc(null)}
                    onConfirm={() => removeTranslate(confirmDelSvc)}
                  />
                );
              })()}
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

        {page === "obsidian" && (
          <>
            <h1>Obsidian</h1>
            <p className="page-hint">
              把划词与识图结果按模板直写进 vault 的 markdown 文件——离线可用，无需安装
              Obsidian 插件。配置 vault 后，胶囊与结果窗会出现「Obsidian」。更改需保存后生效。
            </p>

            <div className="card">
              <div className="row-between">
                <div>
                  <div className="row-title">Vault 目录</div>
                  <div className="row-sub">
                    {settings.obsidian.vaultPath
                      ? "已接入：写入范围仅限该目录内的相对路径。"
                      : "选择 vault 根目录（.obsidian 所在的那层）。未选择时「Obsidian」动作不出现。"}
                  </div>
                </div>
                <div className="row-ctl">
                  <button
                    className="btn sm"
                    onClick={() =>
                      invoke<string | null>("pick_vault_dir")
                        .then((p) => {
                          if (p) patch({ obsidian: { ...settings.obsidian, vaultPath: p } });
                        })
                        .catch(() => undefined)
                    }
                  >
                    选择目录…
                  </button>
                </div>
              </div>
              {settings.obsidian.vaultPath && (
                <div className="row-between">
                  <span
                    className="row-sub"
                    style={{ wordBreak: "break-all" }}
                    title={settings.obsidian.vaultPath}
                  >
                    {settings.obsidian.vaultPath}
                  </span>
                  <button
                    className="row-del"
                    title="清除 vault 目录"
                    aria-label="清除 vault 目录"
                    onClick={() => patch({ obsidian: { ...settings.obsidian, vaultPath: "" } })}
                  >
                    <Trash2 size={13} strokeWidth={1.7} />
                  </button>
                </div>
              )}

              <div className="row-between sep">
                <div className="field wide">
                  <span>日记子目录（相对 vault 根，空 = 根目录）</span>
                  <input
                    value={settings.obsidian.dailyFolder}
                    placeholder="如 Journal"
                    onChange={(e) =>
                      patch({ obsidian: { ...settings.obsidian, dailyFolder: e.target.value } })
                    }
                  />
                </div>
              </div>

              <div className="row-between sep">
                <div className="field wide">
                  <span>日记文件名格式（与 Daily Notes 插件约定互认）</span>
                  <input
                    value={settings.obsidian.dailyFileName}
                    placeholder="yyyy-MM-DD"
                    onChange={(e) =>
                      patch({ obsidian: { ...settings.obsidian, dailyFileName: e.target.value } })
                    }
                  />
                </div>
              </div>

              <div className="row-between sep">
                <div className="field wide">
                  <span>任务目标文件（相对 vault，空 = 写入当日日记）</span>
                  <input
                    value={settings.obsidian.taskFile}
                    placeholder="如 Tasks/todo.md"
                    onChange={(e) =>
                      patch({ obsidian: { ...settings.obsidian, taskFile: e.target.value } })
                    }
                  />
                </div>
              </div>

              <div className="row-between sep">
                <div className="field wide">
                  <span>知识卡目录（相对 vault）</span>
                  <input
                    value={settings.obsidian.cardFolder}
                    placeholder="Cards"
                    onChange={(e) =>
                      patch({ obsidian: { ...settings.obsidian, cardFolder: e.target.value } })
                    }
                  />
                </div>
              </div>
            </div>

            <h2 className="sec">模板</h2>
            <div className="card">
              <div className="row-between">
                <div>
                  <div className="row-title">摘录块模板</div>
                  <div className="row-sub">
                    变量：{"{text}"} 选中文本 · {"{source}"} 来源应用 · {"{time}"} 时间 ·{" "}
                    {"{date}"} 日期
                  </div>
                </div>
                <button
                  className="btn sm"
                  disabled={settings.obsidian.excerptTemplate === DEFAULT_EXCERPT_TEMPLATE}
                  title="恢复出厂默认模板"
                  onClick={() =>
                    patch({
                      obsidian: { ...settings.obsidian, excerptTemplate: DEFAULT_EXCERPT_TEMPLATE },
                    })
                  }
                >
                  恢复默认
                </button>
              </div>
              <textarea
                className="prompt-input tpl"
                spellCheck={false}
                rows={3}
                value={settings.obsidian.excerptTemplate}
                onChange={(e) =>
                  patch({
                    obsidian: { ...settings.obsidian, excerptTemplate: e.target.value },
                  })
                }
              />
              <p className="row-sub">多行选中文本会逐行保持 markdown 引用形态。</p>
            </div>

            <div className="card">
              <div className="row-between">
                <div>
                  <div className="row-title">任务行模板</div>
                  <div className="row-sub">
                    变量：{"{text}"} 任务内容 · {"{due}"} 截止日期 ·{" "}
                    {"{dueTag}"} 日历标记（无日期时整段省略）
                  </div>
                </div>
                <button
                  className="btn sm"
                  disabled={settings.obsidian.taskTemplate === DEFAULT_TASK_TEMPLATE}
                  title="恢复出厂默认模板"
                  onClick={() =>
                    patch({
                      obsidian: { ...settings.obsidian, taskTemplate: DEFAULT_TASK_TEMPLATE },
                    })
                  }
                >
                  恢复默认
                </button>
              </div>
              <textarea
                className="prompt-input tpl"
                spellCheck={false}
                rows={2}
                value={settings.obsidian.taskTemplate}
                onChange={(e) =>
                  patch({
                    obsidian: { ...settings.obsidian, taskTemplate: e.target.value },
                  })
                }
              />
            </div>

            <div className="card">
              <div className="row-between">
                <div>
                  <div className="row-title">知识卡模板</div>
                  <div className="row-sub">
                    变量：{"{text}"} 选中文本 · {"{source}"} 来源应用 · {"{time}"} 时间 ·{" "}
                    {"{date}"} 日期。一卡一文件，文件名取选中文本首行（≤20 字）。
                  </div>
                </div>
                <button
                  className="btn sm"
                  disabled={settings.obsidian.cardTemplate === DEFAULT_CARD_TEMPLATE}
                  title="恢复出厂默认模板"
                  onClick={() =>
                    patch({
                      obsidian: { ...settings.obsidian, cardTemplate: DEFAULT_CARD_TEMPLATE },
                    })
                  }
                >
                  恢复默认
                </button>
              </div>
              <textarea
                className="prompt-input tpl"
                spellCheck={false}
                rows={2}
                value={settings.obsidian.cardTemplate}
                onChange={(e) =>
                  patch({
                    obsidian: { ...settings.obsidian, cardTemplate: e.target.value },
                  })
                }
              />
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

        {page === "general" && (
          <>
            <h1>通用</h1>
            <p className="page-hint">主题、启动、程序坞与结果窗口的应用级设置，除注明外更改即时生效。</p>
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

            <h2 className="sec">启动</h2>
            <div className="card">
              <div className="row-between">
                <div>
                  <div className="row-title">登录时自动启动</div>
                  <div className="row-sub">
                    开机登录后自动运行拾趣并驻留菜单栏，无需手动打开。更改即时生效。
                  </div>
                </div>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={settings.launchAtLogin}
                    onChange={(e) => {
                      const enabled = e.target.checked;
                      invoke("set_launch_at_login", { enabled })
                        .then(() => patch({ launchAtLogin: enabled }))
                        .catch((err) => toast(`设置失败：${err}`, "err"));
                    }}
                  />
                  <span className="knob" />
                </label>
              </div>
            </div>

            {/* 程序坞为 macOS 概念：Windows 无程序坞，整节隐藏（能力门控） */}
            {IS_MAC && (
            <>
            <h2 className="sec">程序坞</h2>
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
                      patch({ showDockIcon: e.target.checked });
                      saveNow();
                    }}
                  />
                  <span className="knob" />
                </label>
              </div>
            </div>
            </>
            )}

            <h2 className="sec">结果窗口</h2>
            <div className="card">
              <div className="row-between">
                <div>
                  <div className="row-title">默认尺寸</div>
                  <div className="row-sub">
                    预设四种大小，点选立即作用于结果窗口；拖拽微调仍然有效并被记住。
                  </div>
                </div>
                <div className="seg sized" role="radiogroup" aria-label="结果窗口默认尺寸">
                  {RESULT_SIZE_PRESETS.map((p) => {
                    const rs = settings.resultWindowSize;
                    const active =
                      !!rs &&
                      Math.round(rs[0]) === p.size[0] &&
                      Math.round(rs[1]) === p.size[1];
                    return (
                      <button
                        key={p.label}
                        className={active ? "on" : ""}
                        onClick={() => applyResultPreset(p.size)}
                      >
                        {p.label}
                        <small>
                          {p.size[0]} × {p.size[1]}
                        </small>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </>
        )}
        {page === "about" && (
          <>
            <h1>关于</h1>
            <p className="page-hint">
              查看版本与检查更新。更新检测仅读取 GitHub Releases 的公开版本信息，不发送本机数据。
            </p>
            <div className="card about-card">
              <img className="mark big" src={markIcon} alt="拾趣" />
              <div className="about-name">拾趣</div>
              <div className="about-slogan">划词拾趣，阅有所得</div>
              <div className="about-desc">拾趣 Magpie · 划词即懂的阅读伴侣</div>
              <div className="about-motto">得于阅，存于思</div>
              <div className="about-ver">版本 {appVersion || "—"}</div>
            </div>
            <h2 className="sec">更新</h2>
            <div className="card">
              <div className="row-between">
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
