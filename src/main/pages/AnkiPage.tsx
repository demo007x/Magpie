// Anki 页：连接自动检测（打开页面/改地址即探测，保留手动按钮）+ 一键创建
// Anki 集合（牌组「拾趣」两个子牌组 + 两种配套笔记类型）+ 牌组/笔记类型显式选择。
// 零配置是主路径：建卡时智能默认 + 配套类型出厂映射（shared/anki.ts，不落盘）
// 兜底；用户在设置页显式选了牌组/类型则覆盖默认（建卡路由见 floating/App.tsx）。
import { invoke } from "@tauri-apps/api/core";
import { Check, ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Modal } from "../../shared/Modal";
import type { PageProps } from "./types";
import {
  COMPANION_CONTENT,
  COMPANION_ITEMS,
  COMPANION_WORD,
  isCompanionModel,
} from "../../shared/anki";
import { t, useLocale, getLocale } from "../../shared/i18n";
import { TutorialButton } from "../../shared/TutorialModal";

/** 下拉按钮共用的基础字体族（与 .card 内全局 input 的 font: inherit 对齐） */
const SANS = `-apple-system, "PingFang SC", "Microsoft YaHei", sans-serif`;

/** 单选下拉：样式见 main.css 的 .pick-*（Anki 页专用，就地卡片列表无弹层）。
    value 为空时显示 placeholder；选项来自连接测试实拉的缓存，切换即落盘。 */
function Pick({
  value,
  options,
  placeholder,
  onChange,
}: {
  value: string;
  options: string[];
  placeholder: string;
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="pick-wrap">
      <button
        type="button"
        className={`pick-btn ${open ? "open" : ""}`}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="pick-val">{value || placeholder}</span>
        <ChevronDown size={13} />
      </button>
      {open && (
        <div className="pick-list">
          {options.length === 0 && (
            <div className="pick-opt">{t("anki.pickEmpty")}</div>
          )}
          {options.map((o) => (
            <div
              key={o}
              className={`pick-opt ${o === value ? "on" : ""}`}
              onClick={() => {
                onChange(o);
                setOpen(false);
              }}
            >
              {o}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** 配套类型最初的出厂 CSS（已退役，仅作升级指纹）：现役样式见 FACTORY_CSS_V2。
    连接探测时若卡型现值与之逐字一致（即用户没改过卡型），静默升到最新出厂值 */
const FACTORY_CSS_V1: Record<string, string> = {
  [COMPANION_WORD]: `.card {
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
  [COMPANION_CONTENT]: `.card {
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
};

/** markdown 元素样式：背面 AI 输出按 markdown 渲染后入卡（floating App.tsx 的
    mdToHtml），代码块/引用块/表格在裸卡面上会退回浏览器默认观感，出厂统一收敛。
    居中排版的单词卡里代码块/列表/引用强制左对齐 */
const MD_CSS = `
.card pre { background: #f3f3f5; border-radius: 6px; padding: 10px 12px; overflow-x: auto; text-align: left; font-size: 13px; }
.card code { background: #f3f3f5; border-radius: 4px; padding: 1px 5px; font-size: 0.9em; }
.card pre code { background: none; padding: 0; }
.card ul, .card ol { margin: 8px 0; padding-left: 1.4em; text-align: left; }
.card blockquote { margin: 8px 0; padding: 2px 12px; border-left: 3px solid #ddd; color: #555; text-align: left; }
.card table { border-collapse: collapse; margin: 8px auto; }
.card th, .card td { border: 1px solid #ddd; padding: 4px 10px; font-size: 0.92em; }
.card img { max-width: 100%; }`;

/** 上一版出厂样式（现仍作为升级指纹）：v0.2.0 出厂 = FACTORY_CSS_V1 + MD_CSS。
    保留它用于识别「用户没改过卡型」——升级到 V2 时须认得这个旧值，否则
    已建好的卡型会被当成用户自定义而永不升级 */
const FACTORY_CSS_V2_PREV: Record<string, string> = {
  [COMPANION_WORD]: FACTORY_CSS_V1[COMPANION_WORD] + MD_CSS,
  [COMPANION_CONTENT]: FACTORY_CSS_V1[COMPANION_CONTENT] + MD_CSS,
};

/** 现役出厂样式 V2：向权威双解词典类卡片的观感靠拢——白色圆角卡面、分区
    小标题（灰色大字距）、浅灰圆角释义面板、蓝色强调词与链接。单词卡额外给
    词头框（背面 markdown 首个 p，音标灰、单词蓝）、释义左对齐、例句去框中框。
    内容仍是拾趣自己的 AI markdown（无音标等结构化字段，故不追求与某家卡片
    逐像素一致）。注意 Anki 渲染字段时会在内容与 .card 之间插容器，词头框
    必须用后代选择器 .card p:first-of-type（不能用 > 直接子选择器，否则落空） */
const FACTORY_CSS_V2: Record<string, string> = {
  [COMPANION_WORD]: `.card {
  font-family: ${SANS};
  font-size: 15px;
  line-height: 1.75;
  text-align: center;
  color: #1f2937;
  background-color: #ffffff;
  border-radius: 12px;
  padding: 20px 22px;
  word-break: break-word;
}
.front {
  display: inline-block; background: #ffffff;
  border-radius: 12px; padding: 12px 22px;
  box-shadow: 0 2px 8px rgba(31, 41, 55, 0.10);
  font-size: 27px; font-weight: 600; color: #1a1a1a;
}
hr#answer { border: none; border-top: 1px solid #e8eaed; margin: 14px auto; width: 58%; }
.card p { text-align: left; }
.card p:first-of-type {
  display: inline-block; background: #ffffff; text-align: center;
  border-radius: 12px; padding: 12px 22px; margin: 0 auto 14px;
  box-shadow: 0 2px 8px rgba(31, 41, 55, 0.10);
  min-width: 60%;
  color: #8a8f98;
}
.card p:first-of-type strong { color: #2a6db0; }
.card h2, .card h3 {
  font-size: 12px; font-weight: 600; letter-spacing: 0.18em;
  text-transform: uppercase; color: #9aa0a6; margin: 18px 0 8px;
}
.card blockquote {
  margin: 10px 0; padding: 12px 16px; background: #f6f7f9;
  border-radius: 10px; color: #2f3542;
}
.card blockquote p:first-of-type { margin: 0; background: none; box-shadow: none; display: block; padding: 0; border-radius: 0; min-width: 0; text-align: center; color: #2f3542; }
.card strong, .card b { color: #2a6db0; }
.card a { color: #2a6db0; text-decoration: none; }
.card pre { background: #f6f7f9; border-radius: 8px; padding: 10px 12px; overflow-x: auto; text-align: left; font-size: 13px; }
.card code { background: #f6f7f9; border-radius: 4px; padding: 1px 5px; font-size: 0.9em; }
.card pre code { background: none; padding: 0; }
.card ul, .card ol { margin: 8px 0; padding-left: 1.4em; text-align: left; }
.card blockquote ul, .card blockquote ol { text-align: left; }
.card table { border-collapse: collapse; margin: 8px auto; }
.card th, .card td { border: 1px solid #e6e8eb; padding: 4px 10px; font-size: 0.92em; }
.card img { max-width: 100%; }
.meta { font-size: 11px; color: #9aa0a6; margin-top: 16px; letter-spacing: 0.02em; }
.meta:empty { display: none; }
.meta a { color: #9aa0a6; }`,
  [COMPANION_CONTENT]: `.card {
  font-family: ${SANS};
  font-size: 16px;
  line-height: 1.7;
  text-align: left;
  color: #1f2937;
  background-color: #ffffff;
  border-radius: 12px;
  padding: 20px 22px;
  word-break: break-word;
}
.card h2, .card h3 {
  font-size: 12px; font-weight: 600; letter-spacing: 0.16em;
  text-transform: uppercase; color: #9aa0a6; margin: 16px 0 8px;
}
.card blockquote {
  margin: 10px 0; padding: 12px 16px; background: #f6f7f9;
  border-radius: 10px; color: #2f3542;
}
.card blockquote p { margin: 0; }
.card strong, .card b { color: #2a6db0; }
.card a { color: #2a6db0; text-decoration: none; }
hr#answer { border: none; border-top: 1px solid #e8eaed; margin: 12px 0; }
.card pre { background: #f6f7f9; border-radius: 8px; padding: 10px 12px; overflow-x: auto; text-align: left; font-size: 13px; }
.card code { background: #f6f7f9; border-radius: 4px; padding: 1px 5px; font-size: 0.9em; }
.card pre code { background: none; padding: 0; }
.card ul, .card ol { margin: 8px 0; padding-left: 1.4em; }
.card table { border-collapse: collapse; margin: 8px 0; }
.card th, .card td { border: 1px solid #e6e8eb; padding: 4px 10px; font-size: 0.92em; }
.card img { max-width: 100%; }
.meta { font-size: 11px; color: #9aa0a6; margin-top: 14px; }
.meta:empty { display: none; }
.meta a { color: #9aa0a6; }`,
};

/** 配套笔记类型的出厂 createModel 定义（样式/模板归笔记类型）。
    模板语法用 Anki 条件替换（{{#字段}}…{{/字段}}）包裹溯源行，字段为空时整块
    省略，不留孤儿括号；.meta:empty 兜底整行隐藏。两类型字段同构，只差排版：
    单词卡居中大字（查词场景），内容卡左对齐换行（摘录场景） */
const COMPANION_MODELS = [
  {
    def: {
      modelName: COMPANION_WORD,
      inOrderFields: ["正面", "背面", "来源", "链接", "日期"],
      css: FACTORY_CSS_V2[COMPANION_WORD],
      cardTemplates: [
        {
          Name: "划词卡",
          Front: `<div class="front">{{正面}}</div>`,
          // 背面不再重复 {{正面}}<hr>：词头与音标由背面字段 markdown 的首个 <p>
          // 承载，配合 CSS 的 .card p:first-of-type 白底圆角框呈现，避免两处大字
          Back: `{{背面}}
<div class="meta">{{#来源}}来源：{{来源}}&ensp;{{/来源}}{{#链接}}<a href="{{链接}}">页面链接</a>&ensp;{{/链接}}{{#日期}}{{日期}}{{/日期}}</div>`,
        },
      ],
    },
  },
  {
    def: {
      modelName: COMPANION_CONTENT,
      inOrderFields: ["正面", "背面", "来源", "链接", "日期"],
      css: FACTORY_CSS_V2[COMPANION_CONTENT],
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

/** 配套类型卡片样式静默升级：现值仍是任一历史出厂值（V1 或 V1+MD_CSS，
    说明用户没改过卡型）就升到 V2；改过则完全不动。这样 v0.2.0 及更老安装
    已建好的配套卡型也能拿到新样式，不必删卡重建。指纹不匹配或请求失败都
    静默——样式升级是卫生动作，不进连接判定、不弹提示（与连接自动探测同一
    克制程度）。仅升级 CSS：模板结构（单词卡背面删重复 {{正面}}<hr>）只在
    新建配套类型时应用，存量卡型的模板不自动改写，避免动用户已有笔记结构 */
const upgradeCompanionCss = (url: string, models: string[]) => {
  COMPANION_ITEMS.forEach(({ model }) => {
    if (!models.includes(model)) return;
    invoke<string>("anki_model_styling", { url, model })
      .then((css) => {
        if (css !== FACTORY_CSS_V1[model] && css !== FACTORY_CSS_V2_PREV[model]) return;
        return invoke("anki_update_model_styling", {
          url,
          model,
          css: FACTORY_CSS_V2[model],
        });
      })
      .catch(() => {});
  });
};

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
  /** 连接成功后询问是否创建配套牌组：deck 空（未接入）才弹，用户选了牌组
      或创建了配套后永不再弹；本次会话问过一次即止（自动+手动探测共用） */
  const [askSetup, setAskSetup] = useState(false);
  const askedRef = useRef(false);
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
            // 配套牌组 + 类型是否都已存在于 Anki 侧。用本次实拉结果判定，
            // 不依赖可能与真实集合漂移的本地缓存——这是「用户已经在 Anki 里
            // 建过配套、却仍被追问要不要创建」的根因：此前只看本地 deck 为空
            const companionExists = COMPANION_ITEMS.every(
              (i) => decks.includes(i.deck) && models.includes(i.model),
            );
            patch((s) => ({
              anki: {
                ...s.anki,
                connectUrl: url,
                decks,
                models,
                // 配套已在 Anki 侧、但本地默认牌组为空（换机/清配置/升级）：
                // 视为已接入，直接沿用第一个子牌组，不再重复询问创建
                deck: !s.anki.deck && companionExists ? COMPANION_ITEMS[0].deck : s.anki.deck,
              },
              actionOrder: s.actionOrder.includes("anki")
                ? s.actionOrder
                : [...s.actionOrder, "anki"],
            }));
            // 自动补填的默认牌组要落盘，避免下次打开又被当作未接入
            if (!anki.deck && companionExists) saveNow?.();
            // 连接就绪后顺带做配套样式卫生升级（静默，失败不进连接状态）
            upgradeCompanionCss(url, models);
            setTest({ ok: true });
            // 主动接入：连上了、本地没设默认牌组、且 Anki 侧确实没有配套，
            // 才弹确认问是否创建（也可取消后自己在下方下拉选已有牌组）。
            // deck 非空 / 配套已存在 / 本次会话问过，都不再打扰
            if (!anki.deck && !companionExists && !askedRef.current) {
              askedRef.current = true;
              setAskSetup(true);
            }
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
      <p className="page-hint">
        {t("anki.hint")} <TutorialButton id="anki" />
      </p>

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
            <span className={`row-sub ${test.ok ? "ok" : "warn"}`}>
              {test.ok
                ? t("anki.testOk")
                : test.msg || (test.auto ? t("anki.autoFail") : t("anki.testFail"))}
              {/* 检测失败时内嵌教程入口：官网 Anki 教程（按界面语言取中文/英文页） */}
              {!test.ok && (
                <button
                  className="text-link"
                  onClick={() =>
                    invoke("open_url", {
                      url:
                        getLocale() === "en"
                          ? "https://demo007x.github.io/Magpie/en/anki/"
                          : "https://demo007x.github.io/Magpie/anki/",
                    }).catch(() => undefined)
                  }
                >
                  {t("anki.tutorialLink")}
                </button>
              )}
            </span>
          </div>
        )}

        {/* 显式选择：连接成功后从实拉缓存里挑默认牌组/笔记类型，选完即落盘。
            deck 非空 = 已接入，胶囊 Anki 动作随之出现；不挑则由上面的配套
            按钮一键配置，零配置也能用（建卡时智能默认兜底） */}
        <div className="row-between sep">
          <div className="field wide">
            <span>{t("anki.deckLabel")}</span>
            <Pick
              value={anki.deck}
              options={anki.decks}
              placeholder={t("anki.deckPlaceholder")}
              onChange={(deck) => {
                patch((s) => ({ anki: { ...s.anki, deck } }));
                saveNow?.();
              }}
            />
          </div>
          <div className="field wide">
            <span>{t("anki.modelLabel")}</span>
            <Pick
              value={anki.modelName}
              options={anki.models}
              placeholder={t("anki.modelPlaceholder")}
              onChange={(modelName) => {
                patch((s) => ({ anki: { ...s.anki, modelName } }));
                saveNow?.();
              }}
            />
          </div>
        </div>

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
        {/* 主按钮默认卡型（配套两种类型就绪时才有选择意义）：
            主按钮按所选卡型建卡，⌄ 菜单可临时指定 */}
        {companionReady && (
          <div className="row-between sep">
            <div className="row-title">{t("anki.defaultCardLabel")}</div>
            <div className="row-ctl">
              <div className="seg" role="radiogroup" aria-label={t("anki.defaultCardLabel")}>
                {(
                  [
                    ["auto", t("anki.defaultCardAuto")],
                    ["word", t("anki.defaultCardWord")],
                    ["content", t("anki.defaultCardContent")],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    className={(anki.defaultCard ?? "auto") === value ? "on" : ""}
                    onClick={() => patch((s) => ({ anki: { ...s.anki, defaultCard: value } }))}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="save-bar">
        <button className="btn primary" onClick={save}>
          {saved ? t("common.saved") : t("common.saveChanges")}
        </button>
      </div>

      {/* 连接成功后的主动接入询问：取消 = 自己在上面下拉选已有牌组；
          确认 = 建拾趣配套牌组+类型并落盘。不用 Confirm——它的确认按钮是
          danger 红钮，适合删除而非创建（见 shared/Modal.tsx） */}
      {askSetup && (
        <Modal
          title={t("anki.setupTitle")}
          size="sm"
          onClose={() => setAskSetup(false)}
          footer={
            <>
              <button className="btn sm" onClick={() => setAskSetup(false)}>
                {t("anki.setupCancel")}
              </button>
              <button
                className="btn sm primary"
                onClick={() => {
                  setAskSetup(false);
                  createCompanions();
                }}
              >
                {t("anki.setupConfirm")}
              </button>
            </>
          }
        >
          <p className="modal-text">{t("anki.setupText")}</p>
        </Modal>
      )}
    </>
  );
}
