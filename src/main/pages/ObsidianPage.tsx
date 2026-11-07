// Obsidian 页：vault 接入、日记/任务/知识卡目标文件与三套模板（恢复默认 = 回写出厂值）。
import { invoke } from "@tauri-apps/api/core";
import { Trash2 } from "lucide-react";
import {
  DEFAULT_CARD_TEMPLATE,
  DEFAULT_EXCERPT_TEMPLATE,
  DEFAULT_TASK_TEMPLATE,
} from "./labels";
import type { PageProps } from "./types";
import { t, useLocale } from "../../shared/i18n";

/** 模板变量说明里的 {text} 等字面量：经 vars 显式注入，避免被 t() 当占位符吃掉 */
const TEMPLATE_VARS = {
  fText: "{text}",
  fSource: "{source}",
  fTime: "{time}",
  fDate: "{date}",
  fDue: "{due}",
  fDueTag: "{dueTag}",
};

export default function ObsidianPage({ settings, patch, save, saved }: PageProps) {
  useLocale(); // 界面语言变化时重渲染（文案经 t() 取词）
  return (
          <>
            <h1>Obsidian</h1>
            <p className="page-hint">
              {t("obsidian.hint")}
            </p>

            <div className="card">
              <div className="row-between">
                <div>
                  <div className="row-title">{t("obsidian.vaultTitle")}</div>
                  <div className="row-sub">
                    {settings.obsidian.vaultPath
                      ? t("obsidian.vaultSet")
                      : t("obsidian.vaultUnset")}
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
                    {t("obsidian.pickDir")}
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
                    title={t("obsidian.clearVault")}
                    aria-label={t("obsidian.clearVault")}
                    onClick={() => patch({ obsidian: { ...settings.obsidian, vaultPath: "" } })}
                  >
                    <Trash2 size={13} strokeWidth={1.7} />
                  </button>
                </div>
              )}

              <div className="row-between sep">
                <div className="field wide">
                  <span>{t("obsidian.dailyFolder")}</span>
                  <input
                    value={settings.obsidian.dailyFolder}
                    placeholder={t("obsidian.dailyFolderPh")}
                    onChange={(e) =>
                      patch({ obsidian: { ...settings.obsidian, dailyFolder: e.target.value } })
                    }
                  />
                </div>
              </div>

              <div className="row-between sep">
                <div className="field wide">
                  <span>{t("obsidian.dailyFileName")}</span>
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
                  <span>{t("obsidian.taskFile")}</span>
                  <input
                    value={settings.obsidian.taskFile}
                    placeholder={t("obsidian.taskFilePh")}
                    onChange={(e) =>
                      patch({ obsidian: { ...settings.obsidian, taskFile: e.target.value } })
                    }
                  />
                </div>
              </div>

              <div className="row-between sep">
                <div className="field wide">
                  <span>{t("obsidian.cardFolder")}</span>
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

            <h2 className="sec">{t("obsidian.templatesSec")}</h2>
            <div className="card">
              <div className="row-between">
                <div>
                  <div className="row-title">{t("obsidian.excerptTpl")}</div>
                  <div className="row-sub">
                    {t("obsidian.excerptTplVars", TEMPLATE_VARS)}
                  </div>
                </div>
                <button
                  className="btn sm"
                  disabled={settings.obsidian.excerptTemplate === DEFAULT_EXCERPT_TEMPLATE}
                  title={t("obsidian.resetTplTitle")}
                  onClick={() =>
                    patch({
                      obsidian: { ...settings.obsidian, excerptTemplate: DEFAULT_EXCERPT_TEMPLATE },
                    })
                  }
                >
                  {t("common.resetDefault")}
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
              <p className="row-sub">{t("obsidian.excerptNote")}</p>
            </div>

            <div className="card">
              <div className="row-between">
                <div>
                  <div className="row-title">{t("obsidian.taskTpl")}</div>
                  <div className="row-sub">
                    {t("obsidian.taskTplVars", TEMPLATE_VARS)}
                  </div>
                </div>
                <button
                  className="btn sm"
                  disabled={settings.obsidian.taskTemplate === DEFAULT_TASK_TEMPLATE}
                  title={t("obsidian.resetTplTitle")}
                  onClick={() =>
                    patch({
                      obsidian: { ...settings.obsidian, taskTemplate: DEFAULT_TASK_TEMPLATE },
                    })
                  }
                >
                  {t("common.resetDefault")}
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
                  <div className="row-title">{t("obsidian.cardTpl")}</div>
                  <div className="row-sub">
                    {t("obsidian.cardTplVars", TEMPLATE_VARS)}
                  </div>
                </div>
                <button
                  className="btn sm"
                  disabled={settings.obsidian.cardTemplate === DEFAULT_CARD_TEMPLATE}
                  title={t("obsidian.resetTplTitle")}
                  onClick={() =>
                    patch({
                      obsidian: { ...settings.obsidian, cardTemplate: DEFAULT_CARD_TEMPLATE },
                    })
                  }
                >
                  {t("common.resetDefault")}
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
                {saved ? t("common.saved") : t("common.saveChanges")}
              </button>
            </div>
    </>
  );
}
