// 通用页：主题（跟随系统/亮/暗）、界面语言（跟随系统/中/英）、登录自启、程序坞图标（macOS）、结果窗默认尺寸。
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
            <h1>{t("nav.general")}</h1>
            <p className="page-hint">{t("general.hint")}</p>
            <h2 className="sec">{t("general.themeSec")}</h2>
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

            <h2 className="sec">{t("general.languageSec")}</h2>
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

            <h2 className="sec">{t("general.launchSec")}</h2>
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

            {/* 程序坞为 macOS 概念：Windows 无程序坞，整节隐藏（能力门控） */}
            {IS_MAC && (
            <>
            <h2 className="sec">{t("general.dockSec")}</h2>
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

            <h2 className="sec">{t("general.resultSec")}</h2>
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
