import { useEffect, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Check, ChevronsDown, FileText, MousePointer2, Pin, Sparkles, Vault } from "lucide-react";
import { FLOW_DEMO, type TopicCopy } from "./content";

/** 专题页主动画：划选 → 点「翻译」 → 结果窗实时显示 → 存入 Obsidian，循环播放。
    与首页 CapsuleDemo 同一套构造：mock 深色卡复刻产品浮窗，状态机驱动，
    系统开启「减弱动态效果」时直接呈现终态。 */

type Stage = "read" | "sweep" | "bar" | "typing" | "save" | "flow" | "done";

const NEXT: Record<Exclude<Stage, "typing">, [Stage, number]> = {
  read: ["sweep", 900],
  sweep: ["bar", 1000],
  bar: ["typing", 1200],
  save: ["flow", 900],
  flow: ["done", 1100],
  done: ["read", 3000],
};

/** 当前阶段对应步骤条（划选 / 翻译 / 结果 / 存入 Obsidian）的序号 */
const STEP_OF: Record<Stage, number> = { read: 0, sweep: 0, bar: 1, typing: 2, save: 3, flow: 3, done: 3 };

export function FlowDemo({ steps }: { steps: TopicCopy["flow"]["steps"] }) {
  const reduce = useReducedMotion();
  const [stage, setStage] = useState<Stage>("read");
  const [typed, setTyped] = useState("");

  // 状态机主干；typing 段由打字效果自行接管推进
  useEffect(() => {
    if (reduce) {
      setStage("done");
      setTyped(FLOW_DEMO.translated);
      return;
    }
    if (stage === "typing") return;
    const [next, ms] = NEXT[stage];
    const id = setTimeout(() => setStage(next), ms);
    return () => clearTimeout(id);
  }, [stage, reduce]);

  // 打字：译文逐字出现，完成后停留一拍再进入「存入」阶段
  useEffect(() => {
    if (stage !== "typing") return;
    let i = 0;
    let hold: ReturnType<typeof setTimeout> | undefined;
    const id = setInterval(() => {
      i += 2;
      setTyped(FLOW_DEMO.translated.slice(0, i));
      if (i >= FLOW_DEMO.translated.length) {
        clearInterval(id);
        hold = setTimeout(() => setStage("save"), 800);
      }
    }, 36);
    return () => {
      clearInterval(id);
      if (hold) clearTimeout(hold);
    };
  }, [stage]);

  useEffect(() => {
    if (stage === "read") setTyped("");
  }, [stage]);

  const selecting = stage === "sweep";
  const selected = stage !== "read";
  const barShown = stage === "bar" || stage === "typing";
  const translating = stage === "bar" || stage === "typing";
  const resultShown = stage === "typing" || stage === "save" || stage === "flow" || stage === "done";
  const saved = stage === "flow" || stage === "done";
  const activeStep = STEP_OF[stage];

  return (
    <div>
      <div className="grid items-stretch gap-6 lg:grid-cols-[1.55fr_1fr]">
        <div>
          {/* 被阅读的应用：拾趣浮在它上面，不改变它 */}
          <div className="mock-card relative p-6">
            <div className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-full bg-fill-2" />
              <span className="h-2.5 w-2.5 rounded-full bg-fill-2" />
              <span className="h-2.5 w-2.5 rounded-full bg-fill-2" />
              <span className="ml-3 text-[11px] text-mute-soft">{FLOW_DEMO.docLabel}</span>
            </div>

            <p className="mt-5 text-[15px] leading-relaxed text-ink/90">
              {FLOW_DEMO.context}{" "}
              <span className="relative inline">
                {/* 划选扫过的选区高亮 */}
                <motion.span
                  aria-hidden
                  className="absolute inset-y-[-1px] left-0 rounded-[3px] bg-accent/25"
                  initial={false}
                  animate={{ width: selected ? "100%" : "0%" }}
                  transition={{ duration: reduce ? 0 : selecting ? 1 : 0, ease: "easeInOut" }}
                />
                <span
                  className={`relative transition-colors duration-300 ${
                    selected ? "text-accent-ink" : ""
                  }`}
                >
                  {FLOW_DEMO.source}
                </span>
                {/* 划选的指针：随高亮一起扫过选区，弹出浮动条后离开 */}
                <AnimatePresence>
                  {selecting && (
                    <motion.span
                      aria-hidden
                      className="pointer-events-none absolute -top-6 z-20"
                      initial={{ left: "-6%", opacity: 0 }}
                      animate={{ left: "97%", opacity: 1 }}
                      exit={{ opacity: 0, transition: { duration: 0.25 } }}
                      transition={{ duration: reduce ? 0 : 1, ease: "easeInOut" }}
                    >
                      <MousePointer2 size={16} strokeWidth={1.6} className="fill-ink text-ink" />
                    </motion.span>
                  )}
                </AnimatePresence>
              </span>
            </p>

            {/* 浮动条：就地在选区下方弹出，翻译进行中高亮「翻译」 */}
            <motion.div
              className="absolute -bottom-5 left-6 z-10"
              initial={false}
              animate={{ opacity: barShown ? 1 : 0, y: barShown ? 0 : 8, scale: barShown ? 1 : 0.97 }}
              transition={{ duration: reduce ? 0 : 0.3, ease: [0.22, 1, 0.36, 1] }}
            >
              <div className="mock-card flex items-center gap-1 p-1.5">
                {FLOW_DEMO.pills.map((p) => (
                  <span
                    key={p}
                    className={`rounded-full px-3 py-1.5 text-[12px] font-medium transition-colors duration-200 ${
                      p === "翻译" && translating
                        ? "bg-accent-fill text-accent-ink ring-1 ring-accent-line"
                        : "mock-pill text-ink/80"
                    }`}
                  >
                    {p}
                  </span>
                ))}
                <span className="mock-pill flex items-center gap-0.5 rounded-full px-2 py-1.5 text-[12px] text-mute">
                  <ChevronsDown size={13} strokeWidth={2} />
                  5
                </span>
              </div>
            </motion.div>
          </div>

          {/* 结果窗：独立、常驻、可钉住；存入后留下琥珀色凭证 */}
          <div className="mt-10 min-h-[196px]">
            <AnimatePresence initial={false}>
              {resultShown && (
                <motion.div
                  initial={reduce ? false : { opacity: 0, y: 14, scale: 0.985 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={reduce ? undefined : { opacity: 0, y: 8 }}
                  transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
                  className="mock-card p-5"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 text-[12px] text-mute">
                      <Sparkles size={13} strokeWidth={1.9} className="text-accent" />
                      翻译
                      <span className="text-mute-soft">·</span>
                      <span className="text-mute-soft">{FLOW_DEMO.resultTag}</span>
                    </div>
                    <div className="flex items-center gap-2 text-mute-soft">
                      <Pin size={13} strokeWidth={1.8} />
                      {saved && <Check size={13} strokeWidth={2.2} className="text-accent-2" />}
                    </div>
                  </div>
                  <p className="mt-3 min-h-[3.4em] text-[15px] leading-relaxed text-ink">
                    {typed}
                    {stage === "typing" && (
                      <span className="ml-0.5 inline-block h-[1.05em] w-[2px] translate-y-[2px] bg-accent" />
                    )}
                  </p>
                  <div className="mt-4 flex items-center gap-2 border-t border-line pt-3 text-[11px] text-mute-soft">
                    <span className="mock-pill px-2.5 py-1 text-ink/70">复制</span>
                    <motion.span
                      animate={stage === "save" ? { scale: [1, 0.92, 1] } : { scale: 1 }}
                      transition={{ duration: 0.45 }}
                      className={`flex items-center gap-1 rounded-full px-2.5 py-1 text-[12px] transition-colors duration-200 ${
                        saved
                          ? "bg-accent-2-fill text-accent-2-ink ring-1 ring-accent-2-line"
                          : "mock-pill text-ink/70"
                      }`}
                    >
                      <Vault size={12} strokeWidth={1.9} />
                      存入 Obsidian
                    </motion.span>
                    <span className="mock-pill px-2.5 py-1 text-ink/70">搜索</span>
                    <span className="ml-auto hidden sm:inline">可钉住 · 位置自动记忆</span>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>

        {/* Obsidian：存入动作的落点，摘录按模板追加进当日日记 */}
        <div className="mock-card flex flex-col p-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-[12px] text-mute">
              <Vault size={13} strokeWidth={1.9} className="text-accent-2" />
              Obsidian
              <span className="text-mute-soft">·</span>
              <span className="text-mute-soft">{FLOW_DEMO.vault}</span>
            </div>
            <div className="flex gap-1.5">
              <span className="h-2.5 w-2.5 rounded-full bg-fill-2" />
              <span className="h-2.5 w-2.5 rounded-full bg-fill-2" />
              <span className="h-2.5 w-2.5 rounded-full bg-fill-2" />
            </div>
          </div>

          <motion.div
            animate={
              stage === "flow"
                ? { boxShadow: "inset 0 0 0 1px var(--color-accent-2-line)" }
                : { boxShadow: "inset 0 0 0 1px transparent" }
            }
            className="mt-4 flex items-center gap-2 rounded-lg border border-line bg-fill px-3 py-2 text-[12px]"
          >
            <FileText size={13} strokeWidth={1.9} className="shrink-0 text-mute" />
            <span className="truncate text-ink/85">{FLOW_DEMO.noteFile}</span>
            {saved && (
              <motion.span
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-accent-2"
              />
            )}
          </motion.div>

          <div className="mt-4 space-y-2.5 text-[12.5px] leading-relaxed">
            {FLOW_DEMO.noteExisting.map((line) => (
              <p key={line} className="text-mute">
                <span className="mr-2 text-mute-faint">–</span>
                {line}
              </p>
            ))}
            <AnimatePresence initial={false}>
              {saved && (
                <motion.blockquote
                  initial={reduce ? false : { opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={reduce ? undefined : { opacity: 0 }}
                  transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
                  className="border-l-2 border-accent-2/50 pl-2.5"
                >
                  <p className="text-ink/85">{FLOW_DEMO.source}</p>
                  <p className="mt-1 text-mute">{FLOW_DEMO.translated}</p>
                </motion.blockquote>
              )}
            </AnimatePresence>
          </div>

          <div className="mt-auto pt-5">
            <AnimatePresence initial={false}>
              {stage === "done" && (
                <motion.p
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="flex items-center gap-1.5 border-t border-line pt-3 text-[11.5px] text-accent-2-ink"
                >
                  <Check size={13} strokeWidth={2.2} />
                  {FLOW_DEMO.savedLabel}
                </motion.p>
              )}
            </AnimatePresence>
          </div>
        </div>
      </div>

      {/* 步骤条：与动画阶段联动，当前环节高亮 */}
      <div className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {steps.map((s, i) => {
          const active = i === activeStep;
          return (
            <div
              key={s.title}
              className={`h-full rounded-2xl border p-5 transition-colors duration-300 ${
                active ? "border-accent-line bg-card" : "border-line bg-panel"
              } lift`}
            >
              <div className="flex items-baseline gap-2.5">
                <span
                  className={`text-[13px] font-medium tabular-nums ${
                    active ? "text-accent" : "text-mute-faint"
                  }`}
                >
                  {String(i + 1).padStart(2, "0")}
                </span>
                <h3 className={`text-[15px] font-semibold tracking-tight ${active ? "text-ink" : "text-mute"}`}>
                  {s.title}
                </h3>
              </div>
              <p className="mt-2 text-[13px] leading-relaxed text-mute">{s.desc}</p>
            </div>
          );
        })}
      </div>
    </div>
  );
}
