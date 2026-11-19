// 禁用应用页：划词时不显示浮动条的应用列表（应用选择面板添加，.row-del 移除）。
// 曾并入划词页尾部，2026-11-17 恢复为独立子菜单（划词组、随划词能力显隐，无页级标题）
import { Trash2 } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import type { PageProps } from "./types";
import { t, useLocale } from "../../shared/i18n";

export default function BlocklistPage({ settings, patch, saveNow }: PageProps) {
  useLocale(); // 界面语言变化时重渲染（文案经 t() 取词）
  return (
    <>
      {/* 无页级标题：左栏导航已标明页面，说明行直接开场 */}
      <p className="page-hint">{t("blocklist.hint")}</p>

      <div className="card">
        {settings.appBlacklist.length === 0 ? (
          <div className="row-between tight">
            <div>
              <div className="row-title" style={{ color: "var(--sec)" }}>
                {t("blocklist.emptyTitle")}
              </div>
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
                    saveNow?.();
                  }
                })
                .catch(() => undefined);
            }}
          >
            {t("blocklist.pickApp")}
          </button>
        </div>
      </div>

    </>
  );
}
