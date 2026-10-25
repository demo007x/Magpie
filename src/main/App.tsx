import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "../shared/toast";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import {
  Ban,
  Cpu,
  Info,
  Keyboard,
  NotebookPen,
  SlidersHorizontal,
  Languages,
  Search,
  ShieldCheck,
  Sparkles,
  TextCursorInput,
} from "lucide-react";
import {
  ACTIONS,
} from "../shared/actions";
import {
  translateMissingReason,
} from "../shared/translate";
import markIcon from "./assets/mark.svg";
import type { Settings } from "../shared/types";
import PromptsPage from "./pages/PromptsPage";
import SearchPage from "./pages/SearchPage";
import PermsPage from "./pages/PermsPage";
import TranslatePage from "./pages/TranslatePage";
import ObsidianPage from "./pages/ObsidianPage";
import ModelPage from "./pages/ModelPage";
import CapturePage from "./pages/CapturePage";
import GeneralPage from "./pages/GeneralPage";
import AboutPage, { type UpdateInfo } from "./pages/AboutPage";
import ShortcutsPage from "./pages/ShortcutsPage";
import BlocklistPage from "./pages/BlocklistPage";

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
const IS_MAC = /Mac/i.test(navigator.platform);

export const isAiAction = (id: string) => ACTIONS.find((a) => a.id === id)?.kind === "ai";

/** 动作行序的唯一真相：已排顺序 + 内置 + 自定义（未排过的追加末尾）。
    自定义动作 id 带 "c:" 前缀，与内置同池混排，胶囊按这份顺序取前 N 个。
    末尾过滤：只保留今天仍然存在的动作——手改配置或删动作后残留的 id 会渲染成空白行 */
export const allActionIds = (s: Settings) =>
  [
    ...new Set([...s.actionOrder, ...Object.keys(s.actions), ...s.customActions.map((c) => c.id)]),
  ].filter((id) => id in s.actions || s.customActions.some((c) => c.id === id));

// 系统内置引擎（与 Rust default_engines 同名单）：不可删除，只可停用/排序

/// Rust 侧 update::UpdateInfo 的镜像（status 见 src-tauri/src/update.rs）

/// 检查时刻：09/21 14:32

/// 「检查新版本」行的说明文案：只描述用户能看见的行为，不暴露接口细节。
/// 「已是最新」必须带检查时刻，否则手动点「检查更新」前后这一行一字不差，
/// 看起来就像按钮没反应（提示只做文案级，不弹 toast——重）。

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
  const [settings, setSettings] = useState<Settings | null>(null);
  // settings 的同步镜像：同一 tick 内连发的多个 patch 依次叠加在 ref 上，紧随其后
  // 的 saveNow() 读 ref 即得最新值（函数式 setState 的更新在事件结束后才提交，
  // 靠它做「改完即存」会存到旧值——自定义动作丢字问题的同源坑）
  const settingsRef = useRef<Settings | null>(null);
  const [saved, setSaved] = useState(true);
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

  // 翻译凭据折叠态：TranslatePage 交互用，但保存闸（任意页的 save）也要能展开缺凭据行
  const [svcOpen, setSvcOpen] = useState<Record<string, boolean>>({});

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
        {page === "capture" && (
          <CapturePage settings={settings} patch={patch} saveNow={saveNow} />
        )}
        {page === "shortcuts" && (
          <ShortcutsPage settings={settings} patch={patch} save={save} saved={saved} />
        )}

        {page === "model" && <ModelPage settings={settings} patch={patch} save={save} saved={saved} />}
        {page === "prompts" && (
          <PromptsPage settings={settings} patch={patch} save={save} saved={saved} />
        )}


        {page === "perms" && <PermsPage />}

        {page === "translate" && <TranslatePage
          settings={settings}
          patch={patch}
          save={save}
          saved={saved}
          setPage={setPage}
          svcOpen={svcOpen}
          setSvcOpen={setSvcOpen}
        />}

        {page === "search" && <SearchPage settings={settings} patch={patch} save={save} saved={saved} />}

        {page === "obsidian" && <ObsidianPage settings={settings} patch={patch} save={save} saved={saved} />}

        {page === "blocklist" && <BlocklistPage settings={settings} patch={patch} save={save} saved={saved} />}

        {page === "general" && (
          <GeneralPage
            settings={settings}
            patch={patch}
            saved={saved}
            saveNow={saveNow}
            appearance={appearance}
            setAppearanceMode={setAppearanceMode}
          />
        )}
        {page === "about" && (
          <AboutPage
            appVersion={appVersion}
            upd={upd}
            checking={checking}
            runUpdateCheck={runUpdateCheck}
          />
        )}
      </main>
    </div>
  );
}
