// 词典页：离线查词的词库来源（ADR-12）。拾趣只读用户本机已有的词典文件——
// 不下载、不随包分发、也不写它一个字节；本页只回答「用的哪个文件、能不能用」。
import { invoke } from "@tauri-apps/api/core";
import { Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { getLocale, t, useLocale } from "../../shared/i18n";
import { TutorialButton } from "../../shared/TutorialModal";
import type { DictStatus } from "../../shared/types";
import type { PageProps } from "./types";

/** 状态行：只说用户能行动的事，读不了的原因（表名/版本串）留在日志里 */
function stateLine(s: DictStatus | null): string {
  if (!s) return t("dict.stateUnset");
  if (s.state === "ready") return t("dict.stateReady", { count: s.entryCount.toLocaleString() });
  if (s.state === "missing") return t("dict.stateMissing");
  if (s.state === "unknown") return t("dict.stateUnknown");
  return t("dict.stateUnset");
}

export default function DictPage({ settings, patch, saveNow }: PageProps) {
  useLocale(); // 界面语言变化时重渲染（文案经 t() 取词）
  const [st, setSt] = useState<DictStatus | null>(null);
  const refresh = () =>
    invoke<DictStatus>("dict_status")
      .then(setSt)
      .catch(() => setSt(null));

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 选完即存即探：探测读的是 Rust 侧现行配置，必须等落盘 resolve，否则拿到旧路径的结果
  const applyPath = (dbPath: string) => {
    patch({ dict: { ...settings.dict, dbPath } });
    const done = saveNow ? saveNow() : Promise.resolve();
    done.then(refresh).catch(() => undefined);
  };

  const pick = () =>
    invoke<string | null>("pick_dict_file")
      .then((p) => {
        if (p) applyPath(p);
      })
      .catch(() => undefined);

  const manual = Boolean(settings.dict.dbPath);
  const path = st?.path || settings.dict.dbPath;

  return (
    <>
      {/* 无页级标题：左栏导航已标明页面，说明行直接开场 */}
      <p className="page-hint">
        {t("dict.hint")} <TutorialButton id="dict" />
      </p>

      <div className="card">
        <div className="row-between">
          <div>
            <div className="row-title">{t("dict.fileLabel")}</div>
            <div className="row-sub">{stateLine(st)}</div>
          </div>
          <div className="row-ctl">
            <button className="btn sm" onClick={pick}>
              {t("dict.choose")}
            </button>
          </div>
        </div>

        {path && (
          <div className="row-between">
            <span className="row-sub" style={{ wordBreak: "break-all" }} title={path}>
              {t(manual ? "dict.chosenManually" : "dict.autoDetected")} · {path}
            </span>
            {/* 只清了「手动指定」这一层：自动探测本就无需按钮 */}
            {manual && (
              <button
                className="row-del"
                title={t("dict.useAuto")}
                aria-label={t("dict.useAuto")}
                onClick={() => applyPath("")}
              >
                <Trash2 size={13} strokeWidth={1.7} />
              </button>
            )}
          </div>
        )}

        <p className="row-sub">{t("dict.autoHint")}</p>
        <p className="row-sub">{t("dict.enOnly")}</p>
        <p className="row-sub">
          {t("dict.tutorialLead")}{" "}
          <button
            className="text-link"
            onClick={() =>
              invoke("open_url", {
                url:
                  getLocale() === "en"
                    ? "https://demo007x.github.io/Magpie/en/dict/"
                    : "https://demo007x.github.io/Magpie/dict/",
              }).catch(() => undefined)
            }
          >
            {t("dict.tutorialLink")}
          </button>
        </p>
      </div>

      {/* 词库数据的署名义务：CC BY-SA 4.0，即使我们只读用户本机文件、不随之分发 */}
      <div className="card">
        <div className="row-title">{t("dict.sourceTitle")}</div>
        <div className="row-sub">
          {t("dict.credit")}{" "}
          <button
            className="text-link"
            onClick={() =>
              invoke("open_url", { url: "https://github.com/ahpxex/open-dictionary" }).catch(
                () => undefined,
              )
            }
          >
            {t("dict.sourceLink")}
          </button>
        </div>
      </div>
    </>
  );
}
