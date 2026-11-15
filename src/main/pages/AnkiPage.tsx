// Anki 页：AnkiConnect 连接测试、默认牌组/笔记类型、卡片模板与高级字段映射（docs/08）。
// 连接测试实拉 deckNames/modelNames 缓存进设置（⌄ 牌组菜单与下拉共用）；
// 字段列表会话内实拉，仅服务高级映射区的展示，不落盘。
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { DEFAULT_BACK_TEMPLATE, DEFAULT_FRONT_TEMPLATE, DEFAULT_TAGS } from "./labels";
import type { PageProps } from "./types";
import { t, useLocale } from "../../shared/i18n";

/** 模板变量说明里的 {text} 等字面量：经 vars 显式注入，避免被 t() 当占位符吃掉 */
const TEMPLATE_VARS = {
  fText: "{text}",
  fSource: "{source}",
  fDate: "{date}",
  fTime: "{time}",
  fUrl: "{url}",
};

export default function AnkiPage({ settings, patch, save, saved }: PageProps) {
  useLocale(); // 界面语言变化时重渲染（文案经 t() 取词）
  const anki = settings.anki;
  /** 本轮「连接测试」的结果：成功存版本号（下拉数据随 patch 落进 settings.anki.decks/models） */
  const [test, setTest] = useState<{ ok: boolean; version?: string; msg?: string } | null>(null);
  const [testing, setTesting] = useState(false);
  /** 当前笔记类型的字段名列表（会话内实拉；驱动高级映射区渲染，不落盘） */
  const [fields, setFields] = useState<string[]>([]);

  const runTest = () => {
    setTesting(true);
    const url = anki.connectUrl;
    invoke<string>("anki_version", { url })
      .then((version) =>
        Promise.all([
          invoke<string[]>("anki_deck_names", { url }),
          invoke<string[]>("anki_model_names", { url }),
        ]).then(([decks, models]) => {
          setTest({ ok: true, version });
          setFields([]);
          // 牌组/类型缓存进设置：⌄ 菜单与两个下拉共用（随 save 落盘）。
          // 顺带校正选择值：受控下拉的 value 不在列表里时浏览器会「幻影显示」
          // 第一项（看着选了、实际没选）——当前值不在实拉列表里就取第一项。
          // 动作顺序里没登记过的 anki 一并补登记（新接入动作不悬在排序末尾）
          patch((s) => ({
            anki: {
              ...anki,
              decks,
              models,
              deck: decks.includes(anki.deck) ? anki.deck : decks[0] ?? "",
              modelName: models.includes(anki.modelName)
                ? anki.modelName
                : models[0] ?? anki.modelName,
            },
            actionOrder: s.actionOrder.includes("anki")
              ? s.actionOrder
              : [...s.actionOrder, "anki"],
          }));
        }),
      )
      .catch((e) => {
        setTest({ ok: false, msg: String(e) });
        setFields([]);
      })
      .finally(() => setTesting(false));
  };

  // 连接成功后按当前笔记类型拉字段列表（驱动高级映射区；类型切换时跟随刷新）
  useEffect(() => {
    if (!test?.ok) return;
    invoke<string[]>("anki_model_fields", {
      url: anki.connectUrl,
      model: anki.modelName,
    })
      .then(setFields)
      .catch(() => setFields([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [test?.ok, anki.modelName, anki.connectUrl]);

  const setFieldTpl = (name: string, v: string) =>
    patch({ anki: { ...anki, fieldTemplates: { ...anki.fieldTemplates, [name]: v } } });

  return (
    <>
      <h1>Anki</h1>
      <p className="page-hint">{t("anki.hint")}</p>

      <div className="card">
        <div className="row-between sep">
          <div className="field wide">
            <span>{t("anki.connectUrl")}</span>
            <input
              value={anki.connectUrl}
              placeholder="http://127.0.0.1:8765"
              onChange={(e) => patch({ anki: { ...anki, connectUrl: e.target.value } })}
            />
          </div>
          <div className="row-ctl">
            <button className="btn sm" disabled={testing} onClick={runTest}>
              {testing ? t("anki.testing") : t("anki.test")}
            </button>
          </div>
        </div>
        {test && (
          <div className="row-between">
            <span className="row-sub">
              {test.ok
                ? t("anki.testOk", { version: test.version ?? "" })
                : test.msg || t("anki.testFail")}
            </span>
          </div>
        )}

        <div className="row-between sep">
          <div className="field wide">
            <span>{t("anki.deck")}</span>
            <select
              value={anki.deck}
              onChange={(e) => patch({ anki: { ...anki, deck: e.target.value } })}
            >
              {anki.decks.length ? (
                anki.decks.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))
              ) : (
                <option value="">{t("anki.selectUnset")}</option>
              )}
            </select>
          </div>
        </div>

        <div className="row-between sep">
          <div className="field wide">
            <span>{t("anki.modelName")}</span>
            <select
              value={anki.modelName}
              onChange={(e) => patch({ anki: { ...anki, modelName: e.target.value } })}
            >
              {anki.models.length ? (
                anki.models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))
              ) : (
                <option value={anki.modelName}>{anki.modelName || t("anki.selectUnset")}</option>
              )}
            </select>
          </div>
        </div>
      </div>

      <h2 className="sec">{t("anki.templatesSec")}</h2>
      <div className="card">
        <div className="row-between">
          <div>
            <div className="row-title">{t("anki.frontTpl")}</div>
            <div className="row-sub">{t("anki.tplVars", TEMPLATE_VARS)}</div>
          </div>
          <button
            className="btn sm"
            disabled={anki.frontTemplate === DEFAULT_FRONT_TEMPLATE}
            title={t("anki.resetTplTitle")}
            onClick={() => patch({ anki: { ...anki, frontTemplate: DEFAULT_FRONT_TEMPLATE } })}
          >
            {t("common.resetDefault")}
          </button>
        </div>
        <textarea
          className="prompt-input tpl"
          spellCheck={false}
          rows={2}
          value={anki.frontTemplate}
          onChange={(e) => patch({ anki: { ...anki, frontTemplate: e.target.value } })}
        />

        <div className="row-between sep">
          <div>
            <div className="row-title">{t("anki.backTpl")}</div>
          </div>
          <button
            className="btn sm"
            disabled={anki.backTemplate === DEFAULT_BACK_TEMPLATE}
            title={t("anki.resetTplTitle")}
            onClick={() => patch({ anki: { ...anki, backTemplate: DEFAULT_BACK_TEMPLATE } })}
          >
            {t("common.resetDefault")}
          </button>
        </div>
        <textarea
          className="prompt-input tpl"
          spellCheck={false}
          rows={2}
          value={anki.backTemplate}
          onChange={(e) => patch({ anki: { ...anki, backTemplate: e.target.value } })}
        />
      </div>

      {fields.length > 0 && (
        <div className="card">
          <div className="row-between">
            <div>
              <div className="row-title">{t("anki.fieldsSec")}</div>
              <div className="row-sub">{t("anki.fieldsHint")}</div>
            </div>
          </div>
          {fields.map((f, i) => (
            <div className="row-between sep" key={f}>
              <div className="field wide">
                <span>{f}</span>
                <input
                  value={anki.fieldTemplates[f] ?? ""}
                  // 前两字段留空时由正/背模板按序填充，placeholder 提示默认来源
                  placeholder={
                    i === 0 ? t("anki.frontTpl") : i === 1 ? t("anki.backTpl") : ""
                  }
                  onChange={(e) => setFieldTpl(f, e.target.value)}
                />
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="card">
        <div className="row-between">
          <div className="field wide">
            <span>{t("anki.tags")}</span>
            <input
              value={anki.tags}
              placeholder={DEFAULT_TAGS}
              onChange={(e) => patch({ anki: { ...anki, tags: e.target.value } })}
            />
          </div>
          <button
            className="btn sm"
            disabled={anki.tags === DEFAULT_TAGS}
            title={t("anki.resetTplTitle")}
            onClick={() => patch({ anki: { ...anki, tags: DEFAULT_TAGS } })}
          >
            {t("common.resetDefault")}
          </button>
        </div>
        <p className="row-sub">{t("anki.tagsVars", TEMPLATE_VARS)}</p>
      </div>

      <div className="save-bar">
        <button className="btn primary" onClick={save}>
          {saved ? t("common.saved") : t("common.saveChanges")}
        </button>
      </div>
    </>
  );
}
