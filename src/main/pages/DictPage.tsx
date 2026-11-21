// 词典页：双向离线查词的词库来源（ADR-12）。拾趣只读用户本机的词库文件——
// 不下载、不随包分发、也不写它一个字节；本页只回答「用的哪个文件、能不能用」。
// 英→汉读 open-dictionary 兼容词库，汉→英读 CC-CEDICT 兼容词库；两个方向都是
// 可替换的槽位，具体产品只是默认来源——文案标题因此只写方向、不写产品名。
import { invoke } from "@tauri-apps/api/core";
import { Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { getLocale, t, useLocale } from "../../shared/i18n";
import { TutorialButton } from "../../shared/TutorialModal";
import type { DictStatus, DictStatusBundle } from "../../shared/types";
import type { PageProps } from "./types";

/** 状态行：只说用户能行动的事，读不了的原因（表名/版本串）留在日志里 */
function stateLine(s: DictStatus | null): string {
  if (!s) return t("dict.stateUnset");
  if (s.state === "ready") return t("dict.stateReady", { count: s.entryCount.toLocaleString() });
  if (s.state === "missing") return t("dict.stateMissing");
  if (s.state === "unknown") return t("dict.stateUnknown");
  return t("dict.stateUnset");
}

function LibraryRow({
  title,
  status,
  configured,
  hint,
  chooseLabel,
  onPick,
  onClear,
}: {
  title: string;
  status: DictStatus | null;
  configured: string;
  hint: string;
  chooseLabel: string;
  onPick: () => void;
  onClear: () => void;
}) {
  const manual = Boolean(configured);
  const path = status?.path || configured;
  return (
    <div className="card">
      <div className="row-between">
        <div>
          <div className="row-title">{title}</div>
          <div className="row-sub">{stateLine(status)}</div>
        </div>
        <div className="row-ctl">
          <button className="btn sm" onClick={onPick}>
            {chooseLabel}
          </button>
        </div>
      </div>

      {path && (
        <div className="row-between">
          <span className="row-sub" style={{ wordBreak: "break-all" }} title={path}>
            {t(manual ? "dict.chosenManually" : "dict.autoDetected")} · {path}
          </span>
          {manual && (
            <button
              className="row-del"
              title={t("dict.useAuto")}
              aria-label={t("dict.useAuto")}
              onClick={onClear}
            >
              <Trash2 size={13} strokeWidth={1.7} />
            </button>
          )}
        </div>
      )}

      <p className="row-sub">{hint}</p>
    </div>
  );
}

export default function DictPage({ settings, patch, saveNow }: PageProps) {
  useLocale(); // 界面语言变化时重渲染（文案经 t() 取词）
  const [st, setSt] = useState<DictStatusBundle | null>(null);
  const refresh = () =>
    invoke<DictStatusBundle>("dict_status")
      .then(setSt)
      .catch(() => setSt(null));

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 选完即存即探：探测读的是 Rust 侧现行配置，必须等落盘 resolve，否则拿到旧路径的结果
  const applyPath = (field: "dbPath" | "zhEnPath", value: string) => {
    const dict =
      field === "dbPath"
        ? { ...settings.dict, dbPath: value }
        : { ...settings.dict, zhEnPath: value };
    patch({ dict });
    const done = saveNow ? saveNow() : Promise.resolve();
    done.then(refresh).catch(() => undefined);
  };

  const pickEn = () =>
    invoke<string | null>("pick_dict_file")
      .then((p) => {
        if (p) applyPath("dbPath", p);
      })
      .catch(() => undefined);

  const pickZh = () =>
    invoke<string | null>("pick_zh_dict_file")
      .then((p) => {
        if (p) applyPath("zhEnPath", p);
      })
      .catch(() => undefined);

  return (
    <>
      {/* 无页级标题：左栏导航已标明页面，说明行直接开场 */}
      <p className="page-hint">
        {t("dict.hint")} <TutorialButton id="dict" />
      </p>
      <p className="page-hint">{t("dict.routeHint")}</p>

      <LibraryRow
        title={t("dict.enZhTitle")}
        status={st?.enZh ?? null}
        configured={settings.dict.dbPath}
        hint={t("dict.autoHint")}
        chooseLabel={t("dict.choose")}
        onPick={pickEn}
        onClear={() => applyPath("dbPath", "")}
      />

      <LibraryRow
        title={t("dict.zhEnTitle")}
        status={st?.zhEn ?? null}
        configured={settings.dict.zhEnPath}
        hint={t("dict.zhHint")}
        chooseLabel={t("dict.chooseZh")}
        onPick={pickZh}
        onClear={() => applyPath("zhEnPath", "")}
      />

      {/* 官网图文教程：与页首的 TutorialButton（内嵌步骤）互补，给需要详细步骤的用户 */}
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

      {/* 词库数据的署名义务：两本库均为 CC BY-SA 4.0，即使只读本机文件、不随之分发 */}
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
        <div className="row-sub">
          {t("dict.zhCredit")}{" "}
          <button
            className="text-link"
            onClick={() =>
              invoke("open_url", { url: "https://www.mdbg.net/chinese/dictionary?page=cedict" }).catch(
                () => undefined,
              )
            }
          >
            {t("dict.zhSourceLink")}
          </button>
        </div>
      </div>
    </>
  );
}
