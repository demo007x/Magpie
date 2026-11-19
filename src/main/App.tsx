import { useCallback, useEffect, useRef, useState } from "react";
import markIcon from "./assets/mark.svg";
import { toast } from "../shared/toast";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import {
  Ban,
  Cpu,
  Info,
  Image as ImageIcon,
  Keyboard,
  Layers,
  NotebookPen,
  SlidersHorizontal,
  Languages,
  Search,
  ShieldCheck,
  Sparkles,
  TextCursorInput,
  Volume2,
} from "lucide-react";
import { t, useLocale } from "../shared/i18n";
import {
  translateMissingReason,
} from "../shared/translate";
import type { Settings } from "../shared/types";
import PromptsPage from "./pages/PromptsPage";
import SearchPage from "./pages/SearchPage";
import PermsPage from "./pages/PermsPage";
import BlocklistPage from "./pages/BlocklistPage";
import VisionPage from "./pages/VisionPage";
import TranslatePage from "./pages/TranslatePage";
import SpeechPage from "./pages/SpeechPage";
import ObsidianPage from "./pages/ObsidianPage";
import AnkiPage from "./pages/AnkiPage";
import ModelPage from "./pages/ModelPage";
import CapturePage from "./pages/CapturePage";
import GeneralPage from "./pages/GeneralPage";
import AboutPage, { type UpdateInfo } from "./pages/AboutPage";
import UpdateModal from "./UpdateModal";
import ShortcutsPage from "./pages/ShortcutsPage";

type Page =
  | "model"
  | "prompts"
  | "vision"
  | "capture"
  | "shortcuts"
  | "blocklist"
  | "translate"
  | "speech"
  | "search"
  | "obsidian"
  | "anki"
  | "perms"
  | "general"
  | "about";

const NAV_ICONS: Record<Page, React.ReactNode> = {
  model: <Cpu size={15} strokeWidth={1.75} />,
  prompts: <Sparkles size={15} strokeWidth={1.75} />,
  vision: <ImageIcon size={15} strokeWidth={1.75} />,
  capture: <TextCursorInput size={15} strokeWidth={1.75} />,
  shortcuts: <Keyboard size={15} strokeWidth={1.75} />,
  blocklist: <Ban size={15} strokeWidth={1.75} />,
  translate: <Languages size={15} strokeWidth={1.75} />,
  speech: <Volume2 size={15} strokeWidth={1.75} />,
  search: <Search size={15} strokeWidth={1.75} />,
  obsidian: <NotebookPen size={15} strokeWidth={1.75} />,
  anki: <Layers size={15} strokeWidth={1.75} />,
  perms: <ShieldCheck size={15} strokeWidth={1.75} />,
  general: <SlidersHorizontal size={15} strokeWidth={1.75} />,
  about: <Info size={15} strokeWidth={1.75} />,
};
const IS_MAC = /Mac/i.test(navigator.platform);


// 系统内置引擎（与 Rust default_engines 同名单）：不可删除，只可停用/排序

/// Rust 侧 update::UpdateInfo 的镜像（status 见 src-tauri/src/update.rs）

/// 检查时刻：09/21 14:32

/// 「检查新版本」行的说明文案：只描述用户能看见的行为，不暴露接口细节。
/// 「已是最新」必须带检查时刻，否则手动点「检查更新」前后这一行一字不差，
/// 看起来就像按钮没反应（提示只做文案级，不弹 toast——重）。

export default function App() {
  useLocale(); // 界面语言变化时重渲染（文案经 t() 取词）
  const [settings, setSettings] = useState<Settings | null>(null);
  // 启动默认页（智能默认）：一个模型服务都没配过 → 停在「模型」页（引导完成 BYOK
  // 关键配置）；已配置 → 进「划词」页（产品核心）。用户点过导航后 userPage 落定，
  // 此后去哪页完全由用户掌控
  const [userPage, setUserPage] = useState<Page | null>(null);
  const page = userPage ?? (settings && settings.providers.length > 0 ? "capture" : "model");
  const setPage = (p: Page) => setUserPage(p);
  // 应用版本：运行时读取 tauri.conf.json 的权威值（不再手写，避免与配置漂移）
  const [appVersion, setAppVersion] = useState("");
  // 划词捕获能力位：后端真实可用才显示「划词/禁用应用」导航（Windows 后端落地自动出现）
  const [captureReady, setCaptureReady] = useState(false);
  // 本地朗读能力位：仅 macOS（音色包按需下载，与平台能力门控同一约定）
  const [speechReady, setSpeechReady] = useState(false);

  /** T 型导航分组（顶部横条切组、左栏切组内页）：每页恰属一组——组无独立
      状态，由 page 推导，点组 tab 跳该组第一个可见页。13 页（黑名单、权限
      曾并入他页，2026-11-17 起各自恢复独立子菜单）。平台能力门控在渲染层生效 */
  const NAV_GROUPS: Array<{
    label: string;
    items: Array<[Page, string, boolean]>;
  }> = [
    {
      label: "nav.capture",
      items: [
        ["capture", "nav.capture", captureReady],
        ["shortcuts", "nav.shortcuts", true],
        // 翻译/搜索引擎列表只在划词、识图动作里被消费：跟随动作配置归入
        // 划词组（2026-11-19 自 AI 服务组迁入，组件零改动）
        ["translate", "nav.translate", true],
        ["search", "nav.search", true],
        // 禁用应用只影响划词行为，随划词能力显隐
        ["blocklist", "nav.blocklist", captureReady],
      ],
    },
    {
      label: "nav.group.ai",
      items: [
        ["model", "nav.model", true],
        ["prompts", "nav.prompts", true],
        // 识图配置：识图动作是否由模型直接看图，依赖模型页的服务配置
        ["vision", "nav.vision", true],
        ["speech", "nav.speech", speechReady],
      ],
    },
    {
      label: "nav.group.dest",
      items: [
        ["obsidian", "nav.obsidian", true],
        ["anki", "nav.anki", true],
      ],
    },
    {
      label: "nav.group.app",
      items: [
        // 通用偏好是设置组的高频页，排前；权限是配置一次基本不再动的授权
        // 卡点（仅 macOS 有意义，Windows 无此项），排后
        ["general", "nav.general", true],
        ["perms", "nav.perms", IS_MAC],
        ["about", "nav.about", true],
      ],
    },
  ];
  const activeGroup =
    NAV_GROUPS.find((g) => g.items.some(([id]) => id === page)) ?? NAV_GROUPS[0];


  useEffect(() => {
    getVersion().then(setAppVersion).catch(() => undefined);
    invoke<{ captureAvailable: boolean }>("capture_status")
      .then((s) => setCaptureReady(s.captureAvailable))
      .catch(() => undefined);
    invoke<{ supported: boolean }>("tts_status")
      .then((s) => setSpeechReady(s.supported))
      .catch(() => undefined);
  }, []);

  // 版本更新：检测在 Rust（24h 节流）；这里消费结果 + 弹确认弹窗。
  // 更新从不静默安装，「稍后」仅本次会话不再弹，下个版本重新提醒
  const [upd, setUpd] = useState<UpdateInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [showUpdateModal, setShowUpdateModal] = useState(false);
  const dismissedRef = useRef<string | null>(null);
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
  // 启动后台检查发现新版本（Rust announce 广播）：弹更新弹窗
  useEffect(() => {
    const un = listen<UpdateInfo>("update://available", (e) => {
      setUpd(e.payload);
      if (dismissedRef.current !== e.payload.latest) setShowUpdateModal(true);
    });
    return () => {
      un.then((f) => f());
    };
  }, []);

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

  // 界面语言（auto=跟随系统 | zh | en）：偏好存 settings.uiLocale，切换走
  // set_ui_locale（Rust 落盘 + 广播 locale://changed + 托盘重建）。主窗口
  // 文案经 shared/i18n 的 locale store 渲染——initLocale 在 main.tsx 已挂
  // locale://changed 监听，这里只需维护 seg 高亮的偏好镜像
  const [uiLocale, setUiLocale] = useState<string>("auto");

  useEffect(() => {
    invoke<{ uiLocale?: string }>("get_settings")
      .then((s) => setUiLocale(s.uiLocale ?? "auto"))
      .catch(() => undefined);
    const unLocale = listen<string>("locale://changed", (e) => {
      setUiLocale(e.payload);
    });
    return () => {
      unLocale.then((f) => f()).catch(() => undefined);
    };
  }, []);

  const setUiLocalePref = (pref: string) => {
    setUiLocale(pref); // 主窗口即时反馈（Rust 广播回来值相同，幂等）
    invoke("set_ui_locale", { locale: pref }).catch(() => undefined);
  };

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
      .catch((e) => toast(t("main.saveFailed", { error: String(e) }), "err"));
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
      .catch((e) => toast(t("main.saveFailed", { error: String(e) }), "err"));
  };


  if (!settings) return <div className="loading">{t("main.loading")}</div>;

  return (
    <div className="shell">
      {/* T 型两级导航：顶部横条切组、左侧竖栏切组内页面。组无独立状态——
          由 page 推导（页面必属于某组），点组 tab 跳该组第一个可见页 */}
      <header className="topbar">
        {/* 品牌区一行化：图标 + 名称；版本号只在关于页出现（顶栏那份是冗余） */}
        <div className="brand">
          <img className="mark" src={markIcon} alt={t("main.appName")} />
          <div className="brand-name">{t("main.appName")}</div>
        </div>
        <div className="group-tabs">
          {NAV_GROUPS.map((g) => (
            <button
              key={g.label}
              className={`group-tab ${g.items.some(([id]) => id === page) ? "on" : ""}`}
              onClick={() => {
                const first = g.items.find(([, , show]) => show);
                if (first) setPage(first[0]);
              }}
            >
              {t(g.label)}
            </button>
          ))}
        </div>
      </header>
      <div className="shell-body">
        <aside className="side">
          <nav className="nav">
            {activeGroup.items
              .filter(([, , show]) => show)
              .map(([id, labelKey]) => (
                <button
                  key={id}
                  data-nav={id}
                  className={`nav-item ${page === id ? "active" : ""}`}
                  onClick={() => setPage(id)}
                >
                  <span className="nav-ic">{NAV_ICONS[id]}</span>
                  {t(labelKey)}
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

        {page === "blocklist" && captureReady && (
          <BlocklistPage settings={settings} patch={patch} saveNow={saveNow} />
        )}

        {page === "speech" && (
          <SpeechPage settings={settings} patch={patch} saveNow={saveNow} />
        )}

        {page === "vision" && (
          <VisionPage settings={settings} patch={patch} saveNow={saveNow} />
        )}

        {page === "model" && <ModelPage settings={settings} patch={patch} save={save} saved={saved} />}
        {page === "prompts" && (
          <PromptsPage settings={settings} patch={patch} save={save} saved={saved} />
        )}


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

        {page === "anki" && (
          <AnkiPage settings={settings} patch={patch} save={save} saved={saved} saveNow={saveNow} />
        )}

        {page === "perms" && IS_MAC && <PermsPage />}
        {page === "general" && (
          <GeneralPage
            settings={settings}
            patch={patch}
            saved={saved}
            saveNow={saveNow}
            appearance={appearance}
            setAppearanceMode={setAppearanceMode}
            uiLocale={uiLocale}
            setUiLocale={setUiLocalePref}
          />
        )}
        {page === "about" && (
          <AboutPage
            appVersion={appVersion}
            upd={upd}
            checking={checking}
            runUpdateCheck={runUpdateCheck}
            openUpdate={() => setShowUpdateModal(true)}
          />
        )}
      </main>
      <UpdateModal
        upd={showUpdateModal ? upd : null}
        onClose={() => {
          dismissedRef.current = upd?.latest ?? null;
          setShowUpdateModal(false);
        }}
      />
      </div>
    </div>
  );
}
