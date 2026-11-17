import { useEffect, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { Check, ChevronDown, Layers, Sparkles } from "lucide-react";
import { useSite } from "../i18n";

/** Anki 教程页的三块 mock 演示（自包含、循环状态机驱动；恒深色构造，
    减弱动态效果下直接呈现终态）。拟真文字为应用本身中文 UI，两语言一致。 */

/** 循环状态机 hook：stage 按表推进，reduce 时停在第终态 */
function useCycle<S extends string>(next: Record<S, [S, number]>, initial: S, final: S) {
  const reduce = useReducedMotion();
  const [stage, setStage] = useState<S>(initial);
  useEffect(() => {
    if (reduce) {
      setStage(final);
      return;
    }
    const [n, ms] = next[stage];
    const id = setTimeout(() => setStage(n), ms);
    return () => clearTimeout(id);
  }, [stage, reduce]);
  return stage;
}

const DOTS = (
  <div className="flex items-center gap-1.5">
    <span className="h-2.5 w-2.5 rounded-full bg-fill-2" />
    <span className="h-2.5 w-2.5 rounded-full bg-fill-2" />
    <span className="h-2.5 w-2.5 rounded-full bg-fill-2" />
  </div>
);

/** 演示一：设置页一键配置——按钮 → 配置中 → 徽标就绪 */
export function SetupDemo() {
  const stage = useCycle<"form" | "busy" | "ready">(
    { form: ["busy", 1600], busy: ["ready", 1600], ready: ["form", 2400] },
    "form",
    "ready",
  );
  const { locale } = useSite();
  const t =
    locale === "zh"
      ? { hint: "在 Anki 中创建「拾趣」牌组，以及单词卡、内容卡两种卡片模板。", create: "一键配置", busy: "配置中…", ready: "已就绪", info: "已就绪：划词后卡片会存入 Anki 的「拾趣」牌组" }
      : { hint: "Creates a \"Magpie\" deck in Anki, plus two card templates: Word and Content.", create: "Set up in one click", busy: "Setting up…", ready: "Ready", info: "Ready — clippings will be saved to the \"Magpie\" deck in Anki" };
  return (
    <div className="mock-card p-5">
      {DOTS}
      <div className="mt-4 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <p className="text-[12px] leading-relaxed text-mute-soft">{t.hint}</p>
          {stage === "ready" ? (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-accent-fill px-2.5 py-1 text-[11px] font-medium text-accent-ink">
              <Check size={11} strokeWidth={2.5} />
              {t.ready}
            </span>
          ) : (
            <span className="inline-flex shrink-0 items-center rounded-lg bg-ink px-3 py-1.5 text-[11.5px] font-medium text-bg">
              {stage === "busy" ? t.busy : t.create}
            </span>
          )}
        </div>
        <div className="h-px bg-line" />
        <motion.p
          key={stage === "ready" ? "info" : "none"}
          initial={stage === "ready" ? { opacity: 0, y: 4 } : false}
          animate={{ opacity: 1, y: 0 }}
          className="text-[11.5px] leading-relaxed text-mute-soft"
        >
          {stage === "ready" ? t.info : ""}
        </motion.p>
      </div>
    </div>
  );
}

/** 演示二：划词胶囊 + ⌄ 类型菜单——选区 → 胶囊浮出 → 菜单展开两项 */
export function ClipDemo() {
  const stage = useCycle<"sel" | "bar" | "menu">(
    { sel: ["bar", 1400], bar: ["menu", 1500], menu: ["sel", 2600] },
    "sel",
    "menu",
  );
  const zh = useSite().locale === "zh";
  const word = { deck: "拾趣::单词卡", label: zh ? "单词卡" : "Word" };
  const content = { deck: "拾趣::内容卡", label: zh ? "内容卡" : "Content" };
  return (
    <div className="mock-card p-5">
      {DOTS}
      <p className="mt-4 text-[12px] leading-relaxed text-mute-soft">
        {zh ? "Safari — 英文原句" : "Safari — original sentence"}
      </p>
      <p className="mt-1.5 text-[13px] leading-relaxed text-ink/90">
        The quickest way to remember a <span className="rounded bg-accent-fill px-1 py-0.5 text-accent-ink">word</span>{" "}
        is to meet it again right before you forget.
      </p>
      <div className="relative mt-4 h-[104px]">
        <motion.div
          initial={false}
          animate={stage === "sel" ? { opacity: 0, y: 8 } : { opacity: 1, y: 0 }}
          transition={{ duration: 0.35 }}
          className="absolute left-1/2 top-2 flex -translate-x-1/2 items-center gap-1 whitespace-nowrap rounded-xl border border-line bg-elev px-2 py-1.5 text-[12px] shadow-lg"
        >
          {[
            zh ? "翻译" : "Translate",
            zh ? "解释" : "Explain",
            zh ? "总结" : "Summarize",
            zh ? "复制" : "Copy",
          ].map((a) => (
            <span key={a} className="rounded-lg px-2 py-1 text-mute-soft">
              {a}
            </span>
          ))}
          <span className="flex items-center gap-1 rounded-lg bg-accent-fill px-2 py-1 font-medium text-accent-ink">
            <Layers size={11} strokeWidth={2} />
            Anki
          </span>
          <motion.span
            animate={stage === "menu" ? { rotate: 180 } : { rotate: 0 }}
            className="ml-0.5 flex items-center text-mute"
          >
            <ChevronDown size={12} strokeWidth={2} />
          </motion.span>
        </motion.div>
        <motion.div
          initial={false}
          animate={
            stage === "menu"
              ? { opacity: 1, y: 0, scale: 1 }
              : { opacity: 0, y: -6, scale: 0.96 }
          }
          transition={{ duration: 0.3 }}
          className="absolute left-1/2 top-[52px] w-44 -translate-x-1/2 rounded-xl border border-line bg-elev p-1.5 shadow-lg"
        >
          {[word, content].map((it) => (
            <div
              key={it.deck}
              className="flex items-center justify-between rounded-lg px-2.5 py-1.5 text-[12px] text-ink/85"
            >
              <span>{it.label}</span>
              <span className="text-[10px] text-mute-faint">{it.deck}</span>
            </div>
          ))}
        </motion.div>
      </div>
    </div>
  );
}

/** 演示三：Anki 复习界面——正面 → 显示答案（背面释义 + 来源/日期 meta） */
export function StudyDemo() {
  const revealed = useCycle<"front" | "back">(
    { front: ["back", 2200], back: ["front", 2600] },
    "front",
    "back",
  );
  const zh = useSite().locale === "zh";
  const show = revealed === "back";
  return (
    <div className="mock-card p-5">
      <div className="flex items-center justify-between">
        {DOTS}
        <span className="text-[11px] text-mute-faint">
          {zh ? "拾趣 · 单词卡" : "Magpie · Word"}
        </span>
      </div>
      <div className="mt-5 rounded-xl border border-line bg-fill px-4 py-5 text-center">
        <p className="text-[22px] font-semibold tracking-tight text-ink">resilient</p>
        <motion.div
          initial={false}
          animate={show ? { opacity: 1, y: 0 } : { opacity: 0, y: 6 }}
          transition={{ duration: 0.35 }}
          className="mt-4 space-y-3"
        >
          <div className="h-px w-2/5 mx-auto bg-line" />
          <p className="text-[13.5px] leading-relaxed text-ink/90">
            /rɪˈzɪliənt/ <span className="text-mute">{zh ? "adj." : "adj."}</span>{" "}
            {zh ? "有韧性的；能快速恢复的" : "able to recover quickly"}
          </p>
          <p className="text-[12px] leading-relaxed text-mute">
            {zh ? "例句：A resilient mind recovers faster than a perfect plan." : "Example: A resilient mind recovers faster than a perfect plan."}
          </p>
          <div className="flex items-center justify-center gap-2 text-[11px] text-mute-faint">
            <Sparkles size={11} strokeWidth={1.9} className="text-accent-2" />
            {zh ? "背面释义由「解释」动作生成" : "Back side from the Explain action"}
          </div>
        </motion.div>
      </div>
      <div className="mt-4 flex items-center justify-between text-[11px] text-mute-faint">
        <span>{zh ? "来源：Safari · 2026-11-16" : "Source: Safari · 2026-11-16"}</span>
        <span className="rounded-lg bg-fill-2 px-2 py-1 text-mute-soft">
          {show ? (zh ? "良好" : "Good") : zh ? "显示答案" : "Show answer"}
        </span>
      </div>
    </div>
  );
}
