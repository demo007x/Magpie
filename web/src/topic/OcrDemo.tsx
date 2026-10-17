import { useEffect, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Check, ScanText } from "lucide-react";

/** 识图章演示（自包含一个容器）：在一份扫描版 PDF 上拖出框选区域 → 本机
    识别 → 译文实时打出。拟真文字为应用本身中文 UI，两语言一致；
    减弱动态效果下直接呈现终态。 */

const SCENE = {
  screenLabel: "扫描版 PDF · 第 3 页",
  paperTag: "Chapter 3 · Sleep and Memory",
  filler: [82, 96, 74],
  sentence: "Memory consolidation during sleep depends on the rhythmic dialogue between the hippocampus and the cortex.",
  translated: "睡眠中的记忆巩固，依赖海马体与大脑皮层之间的节律性对话。",
  hotkey: "⌥T",
  recognizing: "识别中",
  sourceTag: "识图翻译",
};

type Stage = "idle" | "draw" | "scan" | "text" | "typing" | "done";

const NEXT: Record<Exclude<Stage, "typing">, [Stage, number]> = {
  idle: ["draw", 800],
  draw: ["scan", 1000],
  scan: ["text", 900],
  text: ["typing", 800],
  done: ["idle", 2800],
};

export function OcrDemo() {
  const reduce = useReducedMotion();
  const [stage, setStage] = useState<Stage>("idle");
  const [typed, setTyped] = useState("");

  useEffect(() => {
    if (reduce) {
      setStage("done");
      setTyped(SCENE.translated);
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
    let hold: ReturnType<typeof setTimeout> | undefined;
    const id = setInterval(() => {
      i += 2;
      setTyped(SCENE.translated.slice(0, i));
      if (i >= SCENE.translated.length) {
        clearInterval(id);
        hold = setTimeout(() => setStage("done"), 600);
      }
    }, 36);
    return () => {
      clearInterval(id);
      if (hold) clearTimeout(hold);
    };
  }, [stage]);

  useEffect(() => {
    if (stage === "idle") setTyped("");
  }, [stage]);

  const capturing = stage === "draw" || stage === "scan";
  const recognized = stage === "text" || stage === "typing" || stage === "done";

  return (
    <div className="mock-card p-5">
      {/* 屏幕：正在看一份扫描版 PDF */}
      <div className="flex items-center gap-1.5">
        <span className="h-2.5 w-2.5 rounded-full bg-fill-2" />
        <span className="h-2.5 w-2.5 rounded-full bg-fill-2" />
        <span className="h-2.5 w-2.5 rounded-full bg-fill-2" />
        <span className="ml-3 text-[11px] text-mute-soft">{SCENE.screenLabel}</span>
        <motion.span
          animate={{ opacity: capturing || recognized ? 1 : 0.45 }}
          className={`ml-auto rounded-md border px-2 py-0.5 font-sans text-[11px] tracking-wide transition-colors duration-300 ${
            capturing ? "border-accent-line bg-accent-fill text-accent-ink" : "border-line text-mute"
          }`}
        >
          {SCENE.hotkey}
        </motion.span>
      </div>

      {/* 纸面：扫描页的样子（固定浅色，与真机截图同口径） */}
      <div className="mock-paper mt-4 rounded-lg p-4">
        <p className="text-[10px] tracking-wide text-mute-faint uppercase">{SCENE.paperTag}</p>
        <div className="mt-2.5 space-y-2">
          {SCENE.filler.map((w, i) => (
            <div key={i} className="mock-paper-line h-[7px] rounded-full" style={{ width: `${w}%` }} />
          ))}
        </div>
        {/* 框选区：句子 + 拖出的虚线框 */}
        <div className="relative mt-3">
          <motion.div
            aria-hidden
            className="absolute -inset-x-2.5 -inset-y-1.5 rounded-md border-2 border-dashed border-accent"
            initial={false}
            animate={
              capturing
                ? { opacity: 1, width: "100%", height: "100%" }
                : recognized
                  ? { opacity: 1, width: "100%", height: "100%" }
                  : { opacity: 0, width: "12%", height: "40%" }
            }
            transition={{ duration: reduce ? 0 : stage === "draw" ? 0.9 : 0.3, ease: "easeOut" }}
          />
          {stage === "scan" && (
            <motion.span
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute -top-3 right-0 z-10 flex items-center gap-1 rounded-full bg-accent px-2 py-0.5 text-[10px] font-medium text-bg"
            >
              <ScanText size={10} strokeWidth={2.2} />
              {SCENE.recognizing}
            </motion.span>
          )}
          <p className="mock-paper-text px-1 py-0.5 text-[12.5px] leading-relaxed">{SCENE.sentence}</p>
        </div>
        <div className="mt-3 space-y-2">
          <div className="mock-paper-line h-[7px] w-[68%] rounded-full" />
          <div className="mock-paper-line h-[7px] w-[46%] rounded-full" />
        </div>
      </div>

      {/* 识别与翻译结果：同一容器内的浮层 */}
      <div className="mt-4 min-h-[104px]">
        <AnimatePresence initial={false}>
          {recognized && (
            <motion.div
              initial={reduce ? false : { opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduce ? undefined : { opacity: 0, y: 8 }}
              transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
              className="mock-pill p-3.5"
            >
              <div className="flex items-center gap-2 text-[11px] text-mute">
                <ScanText size={12} strokeWidth={1.9} className="text-accent" />
                {SCENE.sourceTag}
                <span className="text-mute-soft">·</span>
                <span className="text-mute-soft">本机识别</span>
                {stage === "done" && (
                  <span className="ml-auto flex items-center gap-1 text-accent-2-ink">
                    <Check size={12} strokeWidth={2.2} />
                    完成
                  </span>
                )}
              </div>
              <p className="mt-2 text-[12px] leading-relaxed text-mute">{SCENE.sentence}</p>
              <p className="mt-1.5 min-h-[1.6em] text-[13px] leading-relaxed text-ink">
                {typed}
                {stage === "typing" && (
                  <span className="ml-0.5 inline-block h-[1.05em] w-[2px] translate-y-[2px] bg-accent" />
                )}
              </p>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
