import { useEffect, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Check, ChevronsDown, MousePointer2, Pin, Sparkles } from "lucide-react";

/** 划词章演示（自包含一个容器）：双击生词 → 浮动条 → 词典卡展示释义与
    译法说明，翻译服务轮换高亮演示「可切换」。拟真文字为应用本身中文 UI，
    两语言一致；减弱动态效果下直接呈现终态。 */

const SCENE = {
  docLabel: "任意应用 · 阅读中",
  pre: "During sleep, the ",
  word: "consolidation",
  post: " of new memories depends on rhythmic dialogue between the hippocampus and the cortex.",
  phonetic: "/ˌkɒnsɒlɪˈdeɪʃn/",
  pos: "n.",
  gloss: "巩固；记忆巩固",
  note: "语境译法：memory consolidation → 记忆巩固",
  services: ["AI 翻译", "百度翻译", "DeepL"],
};

type Stage = "read" | "pick" | "bar" | "result";

const NEXT: Record<Stage, [Stage, number]> = {
  read: ["pick", 900],
  pick: ["bar", 900],
  bar: ["result", 1000],
  result: ["read", 3800],
};

export function LookupDemo() {
  const reduce = useReducedMotion();
  const [stage, setStage] = useState<Stage>("read");
  const [service, setService] = useState(0);

  useEffect(() => {
    if (reduce) {
      setStage("result");
      return;
    }
    const [next, ms] = NEXT[stage];
    const id = setTimeout(() => setStage(next), ms);
    return () => clearTimeout(id);
  }, [stage, reduce]);

  // 结果期轮换翻译服务，演示「三种服务可切换」
  useEffect(() => {
    if (stage !== "result" || reduce) return;
    const id = setInterval(() => setService((s) => (s + 1) % SCENE.services.length), 900);
    return () => clearInterval(id);
  }, [stage, reduce]);

  const shown = stage !== "read";
  const selected = stage === "pick" || stage === "bar" || stage === "result";
  const active = stage === "bar" || stage === "result";

  return (
    <div className="mock-card relative p-6">
      <div className="flex items-center gap-1.5">
        <span className="h-2.5 w-2.5 rounded-full bg-fill-2" />
        <span className="h-2.5 w-2.5 rounded-full bg-fill-2" />
        <span className="h-2.5 w-2.5 rounded-full bg-fill-2" />
        <span className="ml-3 text-[11px] text-mute-soft">{SCENE.docLabel}</span>
      </div>

      <p className="mt-5 text-[15px] leading-relaxed text-ink/90">
        {SCENE.pre}
        <span className="relative inline">
          <span
            className={`rounded-[3px] px-[1px] transition-colors duration-300 ${
              selected ? "bg-accent/25 text-accent-ink" : "bg-transparent"
            }`}
          >
            {SCENE.word}
          </span>
          {/* 双击取词的指针：落到词上，点两下后离开 */}
          <AnimatePresence>
            {stage === "pick" && (
              <motion.span
                aria-hidden
                className="pointer-events-none absolute -top-5 z-20"
                initial={{ left: "-40%", opacity: 0 }}
                animate={{
                  left: "30%",
                  opacity: 1,
                  scale: [1, 0.82, 1, 0.82, 1],
                }}
                exit={{ opacity: 0, transition: { duration: 0.25 } }}
                transition={{ duration: 0.9, scale: { duration: 0.9, times: [0, 0.35, 0.5, 0.75, 0.9] } }}
              >
                <MousePointer2 size={16} strokeWidth={1.6} className="fill-ink text-ink" />
              </motion.span>
            )}
          </AnimatePresence>
        </span>
        {SCENE.post}
      </p>

      {/* 浮动条 */}
      <motion.div
        className="absolute -bottom-5 left-6 z-10"
        initial={false}
        animate={{ opacity: shown ? 1 : 0, y: shown ? 0 : 8, scale: shown ? 1 : 0.97 }}
        transition={{ duration: reduce ? 0 : 0.3, ease: [0.22, 1, 0.36, 1] }}
      >
        <div className="mock-card flex items-center gap-1 p-1.5">
          {["翻译", "解释", "总结", "搜索"].map((p) => (
            <span
              key={p}
              className={`rounded-full px-3 py-1.5 text-[12px] font-medium transition-colors duration-200 ${
                p === "翻译" && active
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

      {/* 词典卡：释义 + 译法说明 + 服务轮换 */}
      <div className="mt-10 min-h-[178px]">
        <AnimatePresence initial={false}>
          {stage === "result" && (
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
                  {SCENE.services.map((s, i) => (
                    <span
                      key={s}
                      className={`transition-colors duration-300 ${
                        i === service ? "font-medium text-accent-ink" : "text-mute-soft"
                      }`}
                    >
                      {s}
                    </span>
                  ))}
                </div>
                <div className="flex items-center gap-2 text-mute-soft">
                  <Pin size={13} strokeWidth={1.8} />
                  <Check size={13} strokeWidth={2.2} className="text-accent" />
                </div>
              </div>
              <p className="mt-3 text-[15px] leading-relaxed">
                <span className="font-semibold text-ink">{SCENE.word}</span>
                <span className="ml-2 text-[12.5px] text-mute">{SCENE.phonetic}</span>
                <span className="ml-2 text-[12.5px] text-mute">{SCENE.pos}</span>
                <span className="ml-2 text-[14px] text-ink/90">{SCENE.gloss}</span>
              </p>
              <p className="mt-2.5 border-l-2 border-accent-2/50 pl-2.5 text-[12px] leading-relaxed text-accent-2-ink">
                {SCENE.note}
              </p>
              <p className="mt-3 border-t border-line pt-2.5 text-[11px] text-mute-soft">
                可钉住 · 尺寸与位置自动记忆
              </p>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
