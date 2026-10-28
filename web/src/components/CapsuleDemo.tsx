// 首屏交互演示：划选 → 浮动条弹出 → 点翻译 → 结果窗流式（循环状态机）。
// 2026-10-27 重做：mock 对齐 v0.1.18 产品定稿——浮动条动作带 ⌄ 与「⌃N」收纳钮、
// 选中项实底白字；结果窗头部三工具钮 + 识别原文区 + 底部动作行（含 Obsidian ⌄）；
// 面板用 .mock-app-panel（渐变哑光、零描边，见 styles.css），与被阅读应用的
// .mock-card（保留描边）拉开层次。循环脚本与减弱动态效果回退不变。
import { useEffect, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  AlignLeft,
  ChevronDown,
  ChevronsUp,
  Copy,
  HelpCircle,
  Languages,
  Pin,
  Search,
  Sparkles,
  X,
} from "lucide-react";
import { DEMO } from "../data";

type Stage = "idle" | "selected" | "typing" | "done";

const NEXT: Record<Exclude<Stage, "typing">, [Stage, number]> = {
  idle: ["selected", 700],
  selected: ["typing", 1000],
  done: ["idle", 3400],
};

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

        {/* 浮动条：动作带 ⌄（换服务/引擎），右侧 ⌃N 收纳其余动作——与 v0.1.18 一致 */}
        <motion.div
          className="absolute -bottom-5 left-6"
          initial={false}
          animate={{ opacity: shown ? 1 : 0, y: shown ? 0 : 8 }}
          transition={{ duration: reduce ? 0 : 0.34, ease: [0.22, 1, 0.36, 1] }}
        >
          <div className="mock-app-panel flex items-center gap-0.5 p-1">
            <span
              className={`flex items-center gap-1 rounded-md px-2.5 py-1.5 text-[12px] font-medium transition-colors duration-200 ${
                active ? "bg-accent text-white" : "text-ink/90"
              }`}
            >
              <Languages size={13} strokeWidth={1.9} className="opacity-80" />
              翻译
              <ChevronDown size={12} strokeWidth={2} className="opacity-70" />
            </span>
            <span className="flex items-center gap-1 rounded-md px-2.5 py-1.5 text-[12px] text-ink/90">
              <HelpCircle size={13} strokeWidth={1.9} className="opacity-80" />
              解释
            </span>
            <span className="flex items-center gap-1 rounded-md px-2.5 py-1.5 text-[12px] text-ink/90">
              <AlignLeft size={13} strokeWidth={1.9} className="opacity-80" />
              总结
            </span>
            <span className="flex items-center gap-1 rounded-md px-2.5 py-1.5 text-[12px] text-ink/90">
              <Search size={13} strokeWidth={1.9} className="opacity-80" />
              搜索
              <ChevronDown size={12} strokeWidth={2} className="opacity-70" />
            </span>
            <span className="ml-0.5 flex items-center gap-0.5 rounded-md px-2 py-1.5 text-[12px] text-mute">
              <ChevronsUp size={13} strokeWidth={2} />
              2
            </span>
          </div>
        </motion.div>
      </div>

      {/* 拾趣自己的结果窗：独立、常驻、可钉住；头部工具钮 + 识别原文 + 底部动作行 */}
      <div className="relative mt-10">
        <AnimatePresence initial={false}>
          {active && (
            <motion.div
              initial={reduce ? false : { opacity: 0, y: 14, scale: 0.985 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={reduce ? undefined : { opacity: 0, y: 8 }}
              transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
              className="mock-app-panel p-5"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-[12px] text-ink/90">
                  <Sparkles size={13} strokeWidth={1.9} className="text-accent" />
                  翻译
                  <span className="text-mute">·</span>
                  <span className="text-mute">AI 翻译</span>
                </div>
                <div className="flex items-center gap-2.5 text-mute-soft">
                  <Pin size={13} strokeWidth={1.8} />
                  <Copy size={13} strokeWidth={1.8} />
                  <X size={13} strokeWidth={1.8} />
                </div>
              </div>
              <p className="mt-3 border-l-2 border-line pl-2.5 text-[11px] leading-relaxed text-mute">
                {DEMO.source}
              </p>
              <p className="mt-3 min-h-[3.4em] text-[15px] leading-relaxed text-ink">
                {typed}
                {stage === "typing" && (
                  <span className="ml-0.5 inline-block h-[1.05em] w-[2px] translate-y-[2px] bg-accent" />
                )}
              </p>
              {/* 动作行对齐产品 .ocr-actions / .action.sm：12px、靠左密排、
                  当前动作（翻译）强调色，其余常规；行尾「更多 ⌃」收纳 */}
              <div className="mt-3 flex items-center gap-0.5 border-t border-line pt-1.5">
                <span className="flex h-[22px] items-center gap-1 rounded-md px-1.5 text-[12px] font-medium text-accent-ink">
                  <Sparkles size={12} strokeWidth={1.9} />
                  翻译
                </span>
                <span className="flex h-[22px] items-center rounded-md px-1.5 text-[12px] text-ink">
                  解释
                </span>
                <span className="flex h-[22px] items-center rounded-md px-1.5 text-[12px] text-ink">
                  总结
                </span>
                <span className="flex h-[22px] items-center rounded-md px-1.5 text-[12px] text-ink">
                  Obsidian
                  <ChevronDown size={11} strokeWidth={2} className="opacity-70" />
                </span>
                <span className="ml-auto flex h-[22px] items-center gap-0.5 rounded-md px-1.5 text-[12px] text-mute">
                  更多
                  <ChevronDown size={11} strokeWidth={2} className="rotate-180 opacity-70" />
                </span>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
