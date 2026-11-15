// Anki 页：AnkiConnect 连接测试、默认牌组/笔记类型、字段映射与标签（docs/08）。
// 字段映射是唯一配置面：连接测试自动预填（第 1 字段 = 选中文本、两字段类型
// 第 2 字段 = AI 释义），每个字段是「数据来源」下拉，自定义模板才展开输入框；
// 字段列表自动跟随笔记类型（已接入即拉取，Anki 未运行时静默隐藏映射区）。
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { DEFAULT_TAGS } from "./labels";
import type { PageProps } from "./types";
import { t, useLocale } from "../../shared/i18n";

/** 模板变量说明里的 {text} 等字面量：经 vars 显式注入，避免被 t() 当占位符吃掉 */
const TEMPLATE_VARS = {
  fText: "{text}",
  fResult: "{result}",
  fSource: "{source}",
  fDate: "{date}",
  fTime: "{time}",
  fUrl: "{url}",
};

/** 映射下拉的数据源预设：把拾趣能提供的值作为语义选项（值为落盘的模板串，
    与 fieldTemplates 直接匹配；用户手写的非预设模板走「自定义」形态） */
const SOURCE_PRESETS: Array<[string, string]> = [
  ["{text}", "anki.mapText"],
  ["{result}", "anki.mapResult"],
  ["{source} · {date}", "anki.mapSourceDate"],
  ["{source}", "anki.mapSource"],
  ["{date}", "anki.mapDate"],
  ["{time}", "anki.mapTime"],
  ["{url}", "anki.mapUrl"],
];

export default function AnkiPage({ settings, patch, save, saved }: PageProps) {
  useLocale(); // 界面语言变化时重渲染（文案经 t() 取词）
  const anki = settings.anki;
  /** 本轮「连接测试」的结果：成功存版本号（下拉数据随 patch 落进 settings.anki） */
  const [test, setTest] = useState<{ ok: boolean; version?: string; msg?: string } | null>(null);
  const [testing, setTesting] = useState(false);
  /** 当前笔记类型的字段名列表（自动跟随笔记类型实拉；驱动映射区渲染，不落盘） */
  const [fields, setFields] = useState<string[]>([]);
  /** 用户显式切到「自定义模板」的字段：此时在该字段下展开模板输入框 */
  const [customMap, setCustomMap] = useState<Record<string, boolean>>({});

  const runTest = () => {
    setTesting(true);
    const url = anki.connectUrl;
    invoke<string>("anki_version", { url })
      .then((version) =>
        Promise.all([
          invoke<string[]>("anki_deck_names", { url }),
          invoke<string[]>("anki_model_names", { url }),
        ])
          .then(async ([decks, models]) => {
            // 选择值校正：受控下拉的 value 不在实拉列表里时浏览器会「幻影显示」
            // 第一项（看着选了、实际没选）——当前值不在列表里就取第一项
            const model = models.includes(anki.modelName)
              ? anki.modelName
              : models[0] ?? anki.modelName;
            const fields = model
              ? await invoke<string[]>("anki_model_fields", { url, model }).catch(
                  () => [] as string[],
                )
              : [];
            // 映射预填（只填从未配置过的字段，显式「不填」与已有选择不覆盖）：
            // 第 1 字段 = 选中文本；恰好两个字段的类型第 2 字段 = AI 释义
            const tpl = { ...anki.fieldTemplates };
            const pre = (name: string | undefined, v: string) => {
              if (name && tpl[name] === undefined) tpl[name] = v;
            };
            pre(fields[0], "{text}");
            if (fields.length === 2) pre(fields[1], "{result}");
            setTest({ ok: true, version });
            setFields(fields);
            patch((s) => ({
              anki: {
                ...anki,
                decks,
                models,
                deck: decks.includes(anki.deck) ? anki.deck : decks[0] ?? "",
                modelName: model,
                fieldTemplates: tpl,
              },
              actionOrder: s.actionOrder.includes("anki")
                ? s.actionOrder
                : [...s.actionOrder, "anki"],
            }));
          })
          .catch((e) => {
            setTest({ ok: false, msg: String(e) });
            setFields([]);
          }),
      )
      .catch((e) => {
        setTest({ ok: false, msg: String(e) });
        setFields([]);
      })
      .finally(() => setTesting(false));
  };

  // 字段列表自动跟随所选笔记类型：已接入（deck 非空）即拉取，无需手动重跑
  // 连接测试；Anki 未运行时静默留空（映射区随之隐藏）。地址/类型变化同触发
  useEffect(() => {
    if (!anki.deck) return;
    invoke<string[]>("anki_model_fields", {
      url: anki.connectUrl,
      model: anki.modelName,
    })
      .then(setFields)
      .catch(() => setFields([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anki.deck, anki.modelName, anki.connectUrl]);

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

      <h2 className="sec">{t("anki.fieldsSec")}</h2>
      <div className="card">
        <div className="row-between">
          <div className="row-sub">{t("anki.fieldsHint")}</div>
        </div>
        {fields.map((f) => {
          // 值分类：空 = 不填；预设 = 语义选项直接下拉；其余 = 自定义模板
          const val = anki.fieldTemplates[f] ?? "";
          const isPreset = val === "" || SOURCE_PRESETS.some(([p]) => p === val);
          const showCustom = Boolean(customMap[f]) || (val !== "" && !isPreset);
          return (
            <div className="row-between sep" key={f}>
              <div className="field wide">
                <span>{f}</span>
                <select
                  value={showCustom ? "custom" : val}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v === "custom") {
                      setCustomMap((m) => ({ ...m, [f]: true }));
                      if (val === "") setFieldTpl(f, "{text}");
                      return;
                    }
                    setCustomMap((m) => ({ ...m, [f]: false }));
                    // 空值同样落盘：Rust 侧跳过空模板，语义即「不填」
                    setFieldTpl(f, v);
                  }}
                >
                  <option value="">{t("anki.mapNone")}</option>
                  {SOURCE_PRESETS.map(([p, key]) => (
                    <option key={p} value={p}>
                      {t(key)}
                    </option>
                  ))}
                  <option value="custom">{t("anki.mapCustom")}</option>
                </select>
                {showCustom && (
                  <input
                    value={val}
                    placeholder="{source} · {date}"
                    onChange={(e) => setFieldTpl(f, e.target.value)}
                  />
                )}
              </div>
            </div>
          );
        })}
        {fields.length === 0 && (
          <div className="row-between">
            <span className="row-sub">{t("anki.fieldsUnavailable")}</span>
          </div>
        )}
      </div>

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
