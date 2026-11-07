// 黑名单页：划词时不显示浮动条的应用列表（应用选择面板添加，.row-del 移除）。
import { Trash2 } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import type { PageProps } from "./types";
import { t, useLocale } from "../../shared/i18n";

export default function BlocklistPage({ settings, patch, save, saved }: PageProps) {
  useLocale(); // 界面语言变化时重渲染（文案经 t() 取词）
  return (
          <>
            <h1>{t("blocklist.title")}</h1>
            <p className="page-hint">
              {t("blocklist.hint")}
            </p>

            <div className="card">
              {settings.appBlacklist.length === 0 ? (
                <div className="row-between tight">
                  <div>
                    <div className="row-title" style={{ color: "var(--sec)" }}>
                      {t("blocklist.emptyTitle")}
                    </div>
                    <div className="row-sub">{t("blocklist.emptySub")}</div>
                  </div>
                </div>
              ) : (
                settings.appBlacklist.map((name, i) => (
                  <div className="row-between tight" key={`${name}-${i}`}>
                    <div className="row-title">{name}</div>
                    <button
                      className="row-del"
                      title={t("blocklist.removeTitle")}
                      aria-label={t("blocklist.removeTitle")}
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
                  {t("blocklist.pickApp")}
                </button>
              </div>
            </div>

            <div className="save-bar">
              <button className="btn primary" onClick={save}>
                {saved ? t("common.saved") : t("common.saveChanges")}
              </button>
            </div>
    </>
  );
}
