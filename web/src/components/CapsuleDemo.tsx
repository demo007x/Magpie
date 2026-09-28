import { useEffect, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Check, ChevronsDown, Pin, Sparkles } from "lucide-react";
import { DEMO } from "../data";

type Stage = "idle" | "selected" | "typing" | "done";

const NEXT: Record<Exclude<Stage, "typing">, [Stage, number]> = {
  idle: ["selected", 700],
  selected: ["typing", 1000],
  done: ["idle", 3400],
};

const PILLS = ["翻译", "解释", "总结", "搜索"];

export function CapsuleDemo() {
  const reduce = useReducedMotion();
  const [stage, setStage] = useState<Stage>("idle");
  const [typed, setTyped] = useState("");

  useEffect(() => {
    if (reduce) {
      setStage("done");
      setTyped(DEMO.translated);
      return;
    }
    if (stage === "typing") return;
    const [next, ms] = NEXT[stage];
    const id = setTimeout(() => setStage(next), ms);
    return () => clearTimeout(id);
  }, [stage, reduce]);

  useEffect(() => {
    if (stage !== "typing") return;
    let i = 0;
    const id = setInterval(() => {
      i += 2;
      setTyped(DEMO.translated.slice(0, i));
      if (i >= DEMO.translated.length) {
        clearInterval(id);
        setStage("done");
      }
    }, 32);
    return () => clearInterval(id);
  }, [stage, reduce]);

  useEffect(() => {
    if (stage === "idle") setTyped("");
  }, [stage]);

  const shown = stage !== "idle";
  const active = stage === "typing" || stage === "done";

  return (
    <div className="relative">
      {/* 被阅读的应用：拾趣不改变它，只是浮在它上面 */}
      <div className="mock-card relative p-6">
        <div className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-fill-2" />
          <span className="h-2.5 w-2.5 rounded-full bg-fill-2" />
          <span className="h-2.5 w-2.5 rounded-full bg-fill-2" />
          <span className="ml-3 text-[11px] text-mute-soft">任意应用中的文字</span>
        </div>

        <p className="mt-5 text-[15px] leading-relaxed text-ink/90">
          Self-recognition has long been treated as a mark of animal consciousness.{" "}
          <span
            className={`rounded-[3px] px-[1px] text-accent-ink transition-colors ${
              reduce ? "" : "duration-[260ms]"
            } ${shown ? "bg-accent/26" : "bg-transparent"}`}
          >
            {DEMO.source}
          </span>
        </p>

        <motion.div
          className="absolute -bottom-5 left-6"
          initial={false}
          animate={{ opacity: shown ? 1 : 0, y: shown ? 0 : 8 }}
          transition={{ duration: reduce ? 0 : 0.34, ease: [0.22, 1, 0.36, 1] }}
        >
          <div className="mock-card flex items-center gap-1 p-1.5">
            {PILLS.map((p) => (
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
      </div>

      {/* 拾趣自己的结果窗：独立、常驻、可钉住 */}
      <div className="relative mt-10">
        <AnimatePresence initial={false}>
          {active && (
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
                  <span className="text-mute-soft">AI 翻译</span>
                </div>
                <div className="flex items-center gap-2 text-mute-soft">
                  <Pin size={13} strokeWidth={1.8} />
                  <Check size={13} strokeWidth={2} className={stage === "done" ? "text-accent-2" : "opacity-0"} />
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
                <span className="mock-pill px-2.5 py-1 text-ink/70">继续处理</span>
                <span className="ml-auto">窗口尺寸与位置自动记忆</span>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
