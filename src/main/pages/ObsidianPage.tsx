// Obsidian 页：vault 接入、日记/任务/知识卡目标文件与三套模板（恢复默认 = 回写出厂值）。
import { invoke } from "@tauri-apps/api/core";
import { Trash2 } from "lucide-react";
import {
  DEFAULT_CARD_TEMPLATE,
  DEFAULT_EXCERPT_TEMPLATE,
  DEFAULT_TASK_TEMPLATE,
} from "./labels";
import type { PageProps } from "./types";

export default function ObsidianPage({ settings, patch, save, saved }: PageProps) {
  return (
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
  );
}
