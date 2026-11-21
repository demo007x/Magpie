// src/shared/TutorialModal.tsx —— 设置页内嵌使用教程：入口按钮 + 步骤式弹窗。
// 内容来自 shared/tutorials（双语内置，离线可用）；结尾链接指向官网完整图文教程
// （有对应页面时）。外部链接经 open_url 走系统浏览器，与应用内跳转同口径。
import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Modal } from "./Modal";
import { t, useLocale } from "./i18n";
import { tutorial, type TutorialId } from "./tutorials";

/** 正文里的 [label](url) 转外链（词库下载页、上游 Release 等 mention） */
function Rich({ text }: { text: string }) {
  const parts = text.split(/(\[[^\]]+\]\([^)]+\))/g);
  return (
    <>
      {parts.map((p, i) => {
        const m = p.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
        return m ? (
          <a
            key={i}
            href="#"
            onClick={(e) => {
              e.preventDefault();
              invoke("open_url", { url: m[2] }).catch(() => undefined);
            }}
            className="text-link"
          >
            {m[1]}
          </a>
        ) : (
          p
        );
      })}
    </>
  );
}

/** 用法：页首提示行内嵌 <TutorialButton id="anki" />（文字链样式），
    点击弹出步骤式教程；语言随界面切换即时更新 */
export function TutorialButton({ id }: { id: TutorialId }) {
  useLocale(); // 界面语言变化时重渲染（文案经 t() 与 tutorial() 取词）
  const [open, setOpen] = useState(false);
  const tut = tutorial(id);

  return (
    <>
      <button className="text-link" onClick={() => setOpen(true)}>
        {t("common.tutorial")}
      </button>
      {open && (
        <Modal title={tut.title} onClose={() => setOpen(false)}>
          <p>{tut.intro}</p>
          <ol className="tutorial-steps">
            {tut.steps.map((s) => (
              <li key={s.title}>
                <p className="tutorial-step-title">{s.title}</p>
                <p className="tutorial-step-body">
                  <Rich text={s.body} />
                </p>
              </li>
            ))}
          </ol>
          {tut.linkUrl && (
            <p>
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  invoke("open_url", { url: tut.linkUrl }).catch(() => undefined);
                }}
                className="text-link"
              >
                {t("tutorial.fullGuide")}
              </a>
            </p>
          )}
        </Modal>
      )}
    </>
  );
}
