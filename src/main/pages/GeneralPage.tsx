// 通用页：主题（跟随系统/亮/暗）、界面语言（跟随系统/中/英）、登录自启、自动检查更新、程序坞图标（macOS）、结果窗默认尺寸。
import { invoke } from "@tauri-apps/api/core";
import { toast } from "../../shared/toast";
import { t, useLocale } from "../../shared/i18n";
import type { PageProps } from "./types";

const IS_MAC = /Mac/i.test(navigator.platform);

interface GeneralProps extends Omit<PageProps, "save"> {
  appearance: string;
  setAppearanceMode: (mode: string) => void;
  uiLocale: string;
  setUiLocale: (pref: string) => void;
}

  /** 结果窗口预设档位（逻辑坐标），横竖两个方向 × 紧凑/宽敞两个量级：
      横向宽度顶格 560（拖拽钳制上限）、竖向大档高度顶格 800（同上）。
      点选立即作用于结果窗并持久化（走 Rust 命令，不经过本页保存按钮）；
      用户拖拽微调仍会记忆，拖后与预设不一致时高亮自然消失 */
  const RESULT_SIZE_PRESETS: { label: string; size: [number, number] }[] = [
    { label: "general.sizeCompactH", size: [560, 320] },
    { label: "general.sizeCompactV", size: [400, 560] },
    { label: "general.sizeRoomyH", size: [560, 480] },
    { label: "general.sizeRoomyV", size: [480, 800] },
  ];



export default function GeneralPage({ settings, patch, saveNow, appearance, setAppearanceMode, uiLocale, setUiLocale }: GeneralProps) {
  useLocale(); // 界面语言变化时重渲染（文案经 t() 取词）
  const applyResultPreset = (size: [number, number]) => {
    invoke("apply_result_preset", { width: size[0], height: size[1] }).catch(() => undefined);
    // save_settings 提交的是本地全量 settings——本地不同步的话，其他页面的保存会回退预设
    patch({ resultWindowSize: size });
  };
  return (
          <>
            {/* 不设页级/节级标题：导航已标明页面，且每节只有一张卡、行标题自述内容，
                节标题是纯重复——卡片直接堆叠开场（同组贴合间距由 .card + .card 控制） */}
            <div className="card">
              <div className="row-between">
                <div>
                  <div className="row-title">{t("general.appearance")}</div>
                </div>
                <div className="seg" role="radiogroup" aria-label={t("general.appearance")}>
                  {[
                    ["auto", t("general.appearanceAuto")],
                    ["light", t("general.appearanceLight")],
                    ["dark", t("general.appearanceDark")],
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

            <div className="card">
              <div className="row-between">
                <div>
                  <div className="row-title">{t("general.uiLocaleTitle")}</div>
                  <div className="row-sub">
                    {t("general.uiLocaleSub")}
                  </div>
                </div>
                <div className="seg" role="radiogroup" aria-label={t("general.uiLocaleTitle")}>
                  {(
                    [
                      ["auto", t("general.uiLocaleAuto")],
                      ["zh", "中文"],
                      ["en", "English"],
                    ] as const
                  ).map(([value, label]) => (
                    <button
                      key={value}
                      className={uiLocale === value ? "on" : ""}
                      onClick={() => setUiLocale(value)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="card">
              <div className="row-between">
                <div>
                  <div className="row-title">{t("general.launchAtLogin")}</div>
                  <div className="row-sub">
                    {t("general.launchAtLoginSub")}
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
                        .catch((err) =>
                          toast(t("general.setFailed", { error: String(err) }), "err"),
                        );
                    }}
                  />
                  <span className="knob" />
                </label>
              </div>
            </div>

            {/* 更新从不静默安装：本开关只控制启动时的后台检查，
                发现新版仍弹窗确认，关于页手动检查不受影响 */}
            <div className="card">
              <div className="row-between">
                <div>
                  <div className="row-title">{t("general.autoUpdateCheck")}</div>
                  <div className="row-sub">
                    {t("general.autoUpdateCheckSub")}
                  </div>
                </div>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={settings.autoUpdateCheck}
                    onChange={(e) => {
                      patch({ autoUpdateCheck: e.target.checked });
                      saveNow?.();
                    }}
                  />
                  <span className="knob" />
                </label>
              </div>
            </div>

            {/* 程序坞为 macOS 概念：Windows 无程序坞，整节隐藏（能力门控） */}
            {IS_MAC && (
            <>
            <div className="card">
              <div className="row-between">
                <div>
                  <div className="row-title">{t("general.dockIcon")}</div>
                  <div className="row-sub">
                    {t("general.dockIconSub")}
                  </div>
                </div>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={settings.showDockIcon}
                    onChange={(e) => {
                      patch({ showDockIcon: e.target.checked });
                      saveNow?.();
                    }}
                  />
                  <span className="knob" />
                </label>
              </div>
            </div>
            </>
            )}

            <div className="card">
              <div className="row-between">
                <div>
                  <div className="row-title">{t("general.resultSize")}</div>
                </div>
                <div className="seg sized" role="radiogroup" aria-label={t("general.resultSize")}>
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
                        {t(p.label)}
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
  );
}
