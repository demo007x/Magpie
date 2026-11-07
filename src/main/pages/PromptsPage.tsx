// 提示词页：内置 AI 动作（含智能提取）的 system 提示词编辑。
// 编辑框始终是「当前生效内容」，内容与默认一致时不落覆盖项——恢复默认因此是删 key，
// 而不是回写一份当时的默认文本（所见即所发）。
import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { AI_ACTION_IDS, defaultPrompt, effectivePrompt, type AiActionId } from "../../shared/actions";
import { actionLabel } from "./labels";
import type { PageProps } from "./types";
import { t, useLocale } from "../../shared/i18n";

// settings 由 App 的载入守卫保证非空

export default function PromptsPage({ settings, patch, save, saved }: PageProps) {
  useLocale(); // 界面语言变化时重渲染（文案经 t() 取词）
  // 手风琴：同时只展开一个（卡全展开要滚三屏，而这页的用法就是一次调一个动作）
  const [promptOpen, setPromptOpen] = useState<AiActionId | null>(null);

  const setPrompt = (id: AiActionId, value: string) => {
    patch((s) => {
      const next = { ...s.actionPrompts };
      if (value.trim() === defaultPrompt(id).trim()) delete next[id];
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

  return (
    <>
            <h1>{t("nav.prompts")}</h1>
            <p className="page-hint">
              {t("prompts.hint")}
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
                      {actionLabel(id)}
                      <span className="tag ai">AI</span>
                      <span className="action-desc">
                        {custom ? t("prompts.customized") : t("prompts.usingDefault")}
                      </span>
                    </div>
                    {/* 不持 onClick：点把手冒泡到卡片头统一切换，避免双重 toggle */}
                    <button
                      className={`svc-chev ${open ? "open" : ""}`}
                      title={open ? t("common.collapse") : t("common.expandEdit")}
                    >
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
                          <summary>{t("prompts.viewDefault")}</summary>
                          <pre className="prompt-default">{defaultPrompt(id)}</pre>
                        </details>
                        <button
                          className="btn sm"
                          disabled={!custom}
                          title={t("prompts.resetTitle")}
                          onClick={() => resetPrompt(id)}
                        >
                          {t("common.resetDefault")}
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
            <div className="save-bar">
              <button className="btn primary" onClick={save}>
                {saved ? t("common.saved") : t("common.saveChanges")}
              </button>
            </div>
    </>
  );
}
