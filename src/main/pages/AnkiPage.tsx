// Anki 页：连接自动检测（打开页面/改地址即探测，保留手动按钮）+ 一键创建
// Anki 集合（牌组「拾趣」两个子牌组 + 两种配套笔记类型，docs/08）。
// 零配置是主路径：建卡时智能默认 + 配套类型出厂映射（shared/anki.ts，不落盘）
// 兜底；牌组/标签均无配置面（牌组由建卡路由在两个子牌组间决定，标签走出厂默认）。
import { invoke } from "@tauri-apps/api/core";
import { Check } from "lucide-react";
import { useEffect, useState } from "react";
import type { PageProps } from "./types";
import {
  COMPANION_CONTENT,
  COMPANION_ITEMS,
  COMPANION_WORD,
  isCompanionModel,
} from "../../shared/anki";
import { t, useLocale } from "../../shared/i18n";

/** 下拉按钮共用的基础字体族（与 .card 内全局 input 的 font: inherit 对齐） */
const SANS = `-apple-system, "PingFang SC", "Microsoft YaHei", sans-serif`;

/** 配套笔记类型的出厂 createModel 定义（样式/模板归笔记类型，docs/08 §7）。
    模板语法用 Anki 条件替换（{{#字段}}…{{/字段}}）包裹溯源行，字段为空时整块
    省略，不留孤儿括号；.meta:empty 兜底整行隐藏。两类型字段同构，只差排版：
    单词卡居中大字（查词场景），内容卡左对齐换行（摘录场景） */
const COMPANION_MODELS = [
  {
    def: {
      modelName: COMPANION_WORD,
      inOrderFields: ["正面", "背面", "来源", "链接", "日期"],
      css: `.card {
  font-family: ${SANS};
  font-size: 15px;
  line-height: 1.8;
  text-align: center;
  color: #1a1a1a;
  background-color: #fafafa;
  padding: 16px;
  word-break: break-word;
}
.front { font-size: 26px; }
hr#answer { border: none; border-top: 1px solid #ddd; margin: 12px auto; width: 60%; }
.meta { font-size: 12px; color: #888; margin-top: 12px; }
.meta:empty { display: none; }
.meta a { color: #888; }`,
      cardTemplates: [
        {
          Name: "划词卡",
          Front: `<div class="front">{{正面}}</div>`,
          Back: `{{正面}}
<hr id="answer">
{{背面}}
<div class="meta">{{#来源}}来源：{{来源}}&ensp;{{/来源}}{{#链接}}<a href="{{链接}}">页面链接</a>&ensp;{{/链接}}{{#日期}}{{日期}}{{/日期}}</div>`,
        },
      ],
    },
  },
  {
    def: {
      modelName: COMPANION_CONTENT,
      inOrderFields: ["正面", "背面", "来源", "链接", "日期"],
      css: `.card {
  font-family: ${SANS};
  font-size: 16px;
  line-height: 1.7;
  text-align: left;
  color: #1a1a1a;
  background-color: #fafafa;
  padding: 16px;
  word-break: break-word;
}
hr#answer { border: none; border-top: 1px solid #ddd; margin: 12px 0; }
.meta { font-size: 12px; color: #888; margin-top: 12px; }
.meta:empty { display: none; }
.meta a { color: #888; }`,
      cardTemplates: [
        {
          Name: "划词卡",
          Front: `<div class="front">{{正面}}</div>`,
          Back: `{{正面}}
<hr id="answer">
{{背面}}
<div class="meta">{{#来源}}来源：{{来源}}&ensp;{{/来源}}{{#链接}}<a href="{{链接}}">页面链接</a>&ensp;{{/链接}}{{#日期}}{{日期}}{{/日期}}</div>`,
        },
      ],
    },
  },
];

export default function AnkiPage({ settings, patch, save, saved, saveNow }: PageProps) {
  useLocale(); // 界面语言变化时重渲染（文案经 t() 取词）
  const anki = settings.anki;
  /** 最近一次连接探测的结果：auto = 自动检测（失败只柔和提示，不弹错误文案） */
  const [test, setTest] = useState<
    { ok: boolean; msg?: string; auto?: boolean } | null
  >(null);
  const [testing, setTesting] = useState(false);
  /** 配套类型创建中（按钮忙态；两型一起创建，幂等） */
  const [creating, setCreating] = useState(false);
  /** 就绪判定（缓存 vs 实拉的桥）：牌组与笔记类型**都**在才算就绪——用户在
      Anki 侧删掉其中一半（删牌组不会连带删类型，反之亦然）时必须回到
      「一键配置」态，否则徽标在说谎 */
  const companionReady = COMPANION_ITEMS.every(
    (i) => anki.models.includes(i.model) && anki.decks.includes(i.deck),
  );

  /** 连接探测：实拉牌组/笔记类型缓存（就绪判定的数据源）。不做字段预填——
      智能默认与配套类型出厂映射在建卡时兜底（零配置主路径）。牌组无配置面：
      一键创建后由程序在两个子牌组间路由 */
  const probe = (manual: boolean) => {
    if (!anki.connectUrl) return;
    if (manual) setTesting(true);
    const url = anki.connectUrl;
    invoke<string>("anki_version", { url })
      .then(() =>
        Promise.all([
          invoke<string[]>("anki_deck_names", { url }),
          invoke<string[]>("anki_model_names", { url }),
        ])
          .then(([decks, models]) => {
            patch((s) => ({
              anki: {
                ...s.anki,
                connectUrl: url,
                decks,
                models,
              },
              actionOrder: s.actionOrder.includes("anki")
                ? s.actionOrder
                : [...s.actionOrder, "anki"],
            }));
            setTest({ ok: true });
          })
          .catch((e) => {
            setTest({ ok: false, msg: String(e), auto: !manual });
          }),
      )
      .catch((e) => {
        setTest({ ok: false, msg: String(e), auto: !manual });
      })
      .finally(() => setTesting(false));
  };

  // 连接自动检测：打开页面与地址变化（防抖）即探测；手动按钮同走 probe
  useEffect(() => {
    const h = setTimeout(() => probe(false), 600);
    return () => clearTimeout(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anki.connectUrl]);

  /** 一键创建 Anki 集合（幂等，缺啥补啥）：牌组「拾趣」+ 两种配套笔记类型，
      并把默认牌组落到「拾趣」。建卡时按划词长短自动路由类型，所以没有
      「选用哪一种」的独立状态。即时落盘——按钮的用户预期是立即生效 */
  const createCompanions = () => {
    setCreating(true);
    const url = anki.connectUrl;
    invoke<string[]>("anki_model_names", { url })
      .then((models) => {
        const missing = COMPANION_MODELS.filter(
          (m) => !models.includes(m.def.modelName),
        );
        const ensured =
          missing.length === 0
            ? Promise.resolve(models)
            : Promise.all(
                missing.map((m) =>
                  invoke("anki_create_model", { url, model: m.def }).then(
                    () => m.def.modelName,
                  ),
                ),
              ).then((created) => [...models, ...created]);
        return ensured;
      })
      .then((models) =>
        // 子牌组幂等建（已存在不报错），父牌组「拾趣」随首个子牌组自动出现；
        // 缓存同步补上，默认牌组落第一个子牌组
        Promise.all(
          COMPANION_ITEMS.map((i) => invoke("anki_create_deck", { url, deck: i.deck })),
        ).then(() => models),
      )
      .then((models) => {
        patch((s) => {
          const decks = [...s.anki.decks];
          for (const i of COMPANION_ITEMS) {
            if (!decks.includes(i.deck)) decks.push(i.deck);
          }
          return {
            anki: {
              ...s.anki,
              models,
              decks,
              deck: decks.includes(s.anki.deck) ? s.anki.deck : COMPANION_ITEMS[0].deck,
              modelName: isCompanionModel(s.anki.modelName)
                ? s.anki.modelName
                : COMPANION_WORD,
            },
          };
        });
        saveNow?.();
      })
      .catch((e) => setTest({ ok: false, msg: String(e) }))
      .finally(() => setCreating(false));
  };

  return (
    <>
      {/* 无页级标题：左栏导航已标明页面，说明行直接开场 */}
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
            <button className="btn sm" disabled={testing} onClick={() => probe(true)}>
              {testing ? t("anki.testing") : t("anki.test")}
            </button>
          </div>
        </div>
        {test && (
          <div className="row-between">
            <span className="row-sub">
              {test.ok
                ? t("anki.testOk")
                : test.auto
                  ? t("anki.autoFail")
                  : test.msg || t("anki.testFail")}
            </span>
          </div>
        )}

        <div className="row-between sep">
          <span className="row-sub">{t("anki.companionHint")}</span>
          <div className="row-ctl">
            {/* 就绪与配置互斥：未配置 = 按钮引导触发；已配置 = 徽标表达成功，
                不再提供无意义的再配置入口 */}
            {companionReady ? (
              <span className="ready-badge">
                <Check size={11} strokeWidth={2.5} />
                {t("anki.readyBadge")}
              </span>
            ) : (
              <button
                className="btn sm"
                disabled={creating}
                onClick={createCompanions}
                title={t("anki.companionUse")}
              >
                {creating ? t("anki.companionCreating") : t("anki.companionCreate")}
              </button>
            )}
          </div>
        </div>
        {/* 未就绪且落在自定义类型时提示：建卡只按通用规则自动填充 */}
        {!companionReady && !isCompanionModel(anki.modelName) && (
          <div className="row-between">
            <span className="row-sub">{t("anki.customTypeInUse", { name: anki.modelName })}</span>
          </div>
        )}
      </div>

      <div className="save-bar">
        <button className="btn primary" onClick={save}>
          {saved ? t("common.saved") : t("common.saveChanges")}
        </button>
      </div>
    </>
  );
}
