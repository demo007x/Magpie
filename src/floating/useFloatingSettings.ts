// src/floating/useFloatingSettings.ts —— 浮动条/结果窗的设置状态底座。
// 三条进入路径（2026-10-27 从 App.tsx 拆出，逻辑零改动）：
// 1. loadSettings —— 挂载即拉全量（get_settings），落到各 useState；
// 2. settings://changed —— 主窗口保存后广播，重拉全量；
// 3. settings://live —— 主窗口改开关/顺序/引擎的实时推送（无需保存即时生效），
//    按字段增量落 state。
// 注意：settings://live 不覆盖 providers / obsidianCfg / translateCfg（那些只随
// 全量刷新）；liveRef（动作注册表 + 提示词覆盖）在此一并维护——runAction 可能由
// 挂载效应的首帧闭包调用（划词/识图导流自动执行），那份闭包读到的 state 永远停
// 在初始值，须经 ref 取。新增设置项若被 runAction 用到，一并写进 liveRef 写入处。
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { actionRegistry } from "../shared/actions";
import type { CustomAction, ObsidianConfig, Provider, SearchEngine, Settings, TranslateConfig } from "../shared/types";

export function useFloatingSettings() {
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
  /** 用户自定义 AI 动作（注册表 = 内置 + 这份数据，见 registry） */
  const [customActions, setCustomActions] = useState<CustomAction[]>([]);
  const liveRef = useRef<{
    registry: ReturnType<typeof actionRegistry>;
    prompts: Record<string, string>;
  }>({ registry: actionRegistry(), prompts: {} });
  const [capsuleMax, setCapsuleMax] = useState(4);
  const [translateEnabled, setTranslateEnabled] = useState<string[]>(["ai"]);
  const [translateDefault, setTranslateDefault] = useState("ai");
  const [translateOrder, setTranslateOrder] = useState<string[]>([]);
  // 翻译服务配置快照：使用时兜底提醒的判据（shared/translate.ts）
  const [translateCfg, setTranslateCfg] = useState<TranslateConfig | null>(null);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [defaultProviderId, setDefaultProviderId] = useState("");
  const [engines, setEngines] = useState<SearchEngine[]>([]);
  const [defaultSearch, setDefaultSearch] = useState("");
  // Obsidian 接入配置：vaultPath 非空 = 「存入 Obsidian」动作可用
  const [obsidianCfg, setObsidianCfg] = useState<ObsidianConfig | null>(null);

  const loadSettings = () => {
    invoke<Settings>("get_settings")
      .then((s) => {
        setActions({ ...s.actions });
        setActionOrder(s.actionOrder ?? []);
        setCustomActions(s.customActions ?? []);
        liveRef.current = {
          registry: actionRegistry((s.customActions ?? []).filter((c) => c.enabled)),
          prompts: s.actionPrompts ?? {},
        };
        setCapsuleMax(Math.max(2, Math.min(8, s.capsuleShowCount ?? 4)));
        setEngines(s.searchEngines ?? []);
        setDefaultSearch(s.defaultSearch ?? "");
        setTranslateEnabled(s.translate?.enabled ?? ["ai"]);
        setTranslateDefault(s.translate?.default ?? "ai");
        setTranslateOrder(s.translate?.order ?? []);
        setTranslateCfg(s.translate ?? null);
        setProviders(s.providers ?? []);
        setDefaultProviderId(s.defaultProviderId ?? "");
        setObsidianCfg(s.obsidian ?? null);
      })
      .catch(() => undefined);
  };

  // 设置进入路径 2/3：全量广播重拉 + 实时推送增量落。监听随组件卸载解绑
  // （本 hook 的监听不依赖 StrictMode 防护——listen() 的 promise 链在 cleanup
  // 里经 un() 解绑，双挂载只多注册一次随即摘除）
  useEffect(() => {
    loadSettings();
    const uns: Array<() => void> = [];
    listen("settings://changed", () => loadSettings())
      .then((un) => uns.push(un))
      .catch(() => undefined);
    listen<{
      actions: Record<string, boolean>;
      actionOrder: string[];
      capsuleShowCount?: number;
      searchEngines?: SearchEngine[];
      defaultSearch?: string;
      translateEnabled?: string[];
      translateDefault?: string;
      translateOrder?: string[];
    }>("settings://live", (e) => {
      setActions({ ...e.payload.actions });
      setActionOrder(e.payload.actionOrder ?? []);
      if (e.payload.capsuleShowCount)
        setCapsuleMax(Math.max(2, Math.min(8, e.payload.capsuleShowCount)));
      if (e.payload.searchEngines) setEngines(e.payload.searchEngines);
      if (e.payload.defaultSearch) setDefaultSearch(e.payload.defaultSearch);
      if (e.payload.translateEnabled) setTranslateEnabled(e.payload.translateEnabled);
      if (e.payload.translateDefault) setTranslateDefault(e.payload.translateDefault);
      if (e.payload.translateOrder) setTranslateOrder(e.payload.translateOrder);
    })
      .then((un) => uns.push(un))
      .catch(() => undefined);
    return () => uns.forEach((u) => u());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    actions,
    setActions,
    actionOrder,
    customActions,
    liveRef,
    capsuleMax,
    translateEnabled,
    setTranslateEnabled,
    translateDefault,
    setTranslateDefault,
    translateOrder,
    setTranslateOrder,
    translateCfg,
    providers,
    defaultProviderId,
    engines,
    setEngines,
    defaultSearch,
    setDefaultSearch,
    obsidianCfg,
    loadSettings,
  };
}
