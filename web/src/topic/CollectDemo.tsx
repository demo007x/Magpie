import { useEffect, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Check, Inbox, Vault } from "lucide-react";

/** 信息收集章演示（自包含一个容器）：三个来源（视频字幕 / 公众号文章 /
    社交笔记）依次被框选取出，进右侧收集清单，最后存入 Obsidian。
    拟真文字为应用本身中文 UI，两语言一致；减弱动态效果下直接呈现终态。 */

const SCENE = {
  screenLabel: "屏幕上刷到的内容",
  listTitle: "收集清单",
  chip: "存入 Obsidian",
  doneLabel: "3 条已存入",
  sources: [
    { tag: "视频字幕", line: "Spacing effect: review just before you forget." },
    { tag: "公众号文章", line: "真正有效的复习，发生在快要忘记的时候。" },
    { tag: "社交笔记", line: "分享 5 个亲测有效的记忆方法" },
  ],
};

type Stage = "s0" | "s1" | "s2" | "saved" | "hold";

const NEXT: Record<Stage, [Stage, number]> = {
  s0: ["s1", 1100],
  s1: ["s2", 1100],
  s2: ["saved", 1100],
  saved: ["hold", 1700],
  hold: ["s0", 1900],
};

export function CollectDemo() {
  const reduce = useReducedMotion();
  const [stage, setStage] = useState<Stage>("s0");

  useEffect(() => {
    if (reduce) {
      setStage("hold");
      return;
    }
    const [next, ms] = NEXT[stage];
    const id = setTimeout(() => setStage(next), ms);
    return () => clearTimeout(id);
  }, [stage, reduce]);

  const doneCount = stage === "hold" ? 3 : stage === "saved" ? 3 : stage === "s2" ? 2 : stage === "s1" ? 1 : 0;
  const activeIdx = stage === "s0" ? 0 : stage === "s1" ? 1 : stage === "s2" ? 2 : -1;
  const saved = stage === "saved" || stage === "hold";

  return (
    <div className="mock-card p-5">
      <div className="flex items-center gap-1.5">
        <span className="h-2.5 w-2.5 rounded-full bg-fill-2" />
        <span className="h-2.5 w-2.5 rounded-full bg-fill-2" />
        <span className="h-2.5 w-2.5 rounded-full bg-fill-2" />
        <span className="ml-3 text-[11px] text-mute-soft">{SCENE.screenLabel}</span>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-[1.25fr_1fr]">
        {/* 左：三个来源，轮流被框选取出 */}
        <div className="space-y-2.5">
          {SCENE.sources.map((src, i) => {
            const active = i === activeIdx;
            const taken = i < doneCount;
            return (
              <div
                key={src.tag}
                className={`rounded-xl border p-3 transition-all duration-300 ${
                  active
                    ? "border-accent-line bg-accent-fill"
                    : taken
                      ? "border-line bg-fill opacity-70"
                      : "border-line bg-fill opacity-45"
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="mock-pill px-2 py-0.5 text-[10px] text-ink/70">{src.tag}</span>
                  <AnimatePresence>
                    {taken && (
                      <motion.span
                        initial={{ scale: 0, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        exit={{ scale: 0, opacity: 0 }}
                        className="text-accent"
                      >
                        <Check size={13} strokeWidth={2.4} />
                      </motion.span>
                    )}
                  </AnimatePresence>
                </div>
                <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink/90">{src.line}</p>
              </div>
            );
          })}
        </div>

        {/* 右：收集清单，逐条落入 */}
        <div className="flex flex-col rounded-xl border border-line bg-elev/60 p-3">
          <div className="flex items-center gap-1.5 text-[11px] text-mute">
            <Inbox size={12} strokeWidth={1.9} />
            {SCENE.listTitle}
          </div>
          <div className="mt-2.5 flex-1 space-y-2">
            {SCENE.sources.map((src, i) => (
              <div key={src.tag} className="min-h-[38px]">
                <AnimatePresence initial={false}>
                  {i < doneCount && (
                    <motion.div
                      initial={reduce ? false : { opacity: 0, x: 14 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={reduce ? undefined : { opacity: 0 }}
                      transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
                      className="rounded-lg border border-line bg-fill px-2.5 py-1.5"
                    >
                      <p className="truncate text-[11.5px] leading-snug text-ink/85">{src.line}</p>
                      <p className="mt-0.5 text-[10px] text-mute-faint">{src.tag}</p>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            ))}
          </div>
          <div className="mt-2.5 border-t border-line pt-2.5">
            <motion.span
              animate={stage === "saved" ? { scale: [1, 0.94, 1] } : { scale: 1 }}
              transition={{ duration: 0.45 }}
              className={`flex items-center justify-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] font-medium transition-colors duration-300 ${
                saved
                  ? "bg-accent-2-fill text-accent-2-ink ring-1 ring-accent-2-line"
                  : "mock-pill text-ink/80"
              }`}
            >
              <Vault size={12} strokeWidth={1.9} />
              {SCENE.chip}
            </motion.span>
            <AnimatePresence>
              {saved && (
                <motion.p
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="mt-1.5 text-center text-[10.5px] text-accent-2-ink"
                >
                  {SCENE.doneLabel}
                </motion.p>
              )}
            </AnimatePresence>
          </div>
        </div>
      </div>
    </div>
  );
}
