// 提示词页：内置 AI 动作（含智能提取）的 system 提示词编辑。
// 编辑框始终是「当前生效内容」，内容与默认一致时不落覆盖项——恢复默认因此是删 key，
// 而不是回写一份当时的默认文本（所见即所发）。
import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { AI_ACTION_IDS, DEFAULT_PROMPTS, effectivePrompt, type AiActionId } from "../../shared/actions";
import { ACTION_LABELS } from "./labels";
import type { PageProps } from "./types";

// settings 由 App 的载入守卫保证非空

export default function PromptsPage({ settings, patch, save, saved }: PageProps) {
  // 手风琴：同时只展开一个（卡全展开要滚三屏，而这页的用法就是一次调一个动作）
  const [promptOpen, setPromptOpen] = useState<AiActionId | null>(null);

  const setPrompt = (id: AiActionId, value: string) => {
    patch((s) => {
      const next = { ...s.actionPrompts };
      if (value.trim() === DEFAULT_PROMPTS[id].trim()) delete next[id];
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
            <h1>提示词</h1>
            <p className="page-hint">
              编辑各动作发给模型的指令，输入框内即实际发送的内容，所选文字随后附带。更改需保存后生效。
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
                      {ACTION_LABELS[id]}
                      <span className="tag ai">AI</span>
                      <span className="action-desc">
                        {custom ? "已自定义" : "使用系统默认"}
                      </span>
                    </div>
                    {/* 不持 onClick：点把手冒泡到卡片头统一切换，避免双重 toggle */}
                    <button className={`svc-chev ${open ? "open" : ""}`} title={open ? "收起" : "展开编辑"}>
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
                          <summary>查看系统默认</summary>
                          <pre className="prompt-default">{DEFAULT_PROMPTS[id]}</pre>
                        </details>
                        <button
                          className="btn sm"
                          disabled={!custom}
                          title="清除自定义，恢复系统默认提示词"
                          onClick={() => resetPrompt(id)}
                        >
                          恢复默认
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
            <div className="save-bar">
              <button className="btn primary" onClick={save}>
                {saved ? "已保存" : "保存更改"}
              </button>
            </div>
    </>
  );
}
