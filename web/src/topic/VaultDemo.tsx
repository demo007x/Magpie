import { useEffect, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { CalendarDays, Check, FileText, Layers, NotebookText, Vault } from "lucide-react";

/** 存入 Obsidian 章演示（自包含一个容器）：同一次选区依次写入三种模板——
    摘录进当日日记、任务自动带截止日期、知识卡一卡一文件。拟真文字为应用
    本身中文 UI，两语言一致；减弱动态效果下直接呈现终态。 */

const SCENE = {
  vaultLabel: "Obsidian · 拾趣笔记库",
  selectionTag: "已选中",
  selectionEn: "Spaced repetition: review chapter 4 by 2026-10-20.",
  selectionZh: "间隔重复：10 月 20 日前复习第四章。",
  excerptFile: "日记 / 2026-10-17.md",
  taskFile: "待办.md",
  taskLine: "10 月 20 日前复习第四章",
  taskDue: "2026-10-20",
  dueBadge: "截止日期已识别",
  cardFile: "卡片 / 间隔重复.md",
  cardTag: "#记忆",
  doneLabel: "已写入 vault",
};

type Dest = 0 | 1 | 2;
type Stage = "idle" | "pick0" | "pick1" | "pick2" | "done";

const NEXT: Record<Stage, [Stage, number]> = {
  idle: ["pick0", 700],
  pick0: ["pick1", 1600],
  pick1: ["pick2", 1700],
  pick2: ["done", 1700],
  done: ["idle", 1700],
};

const DEST_META: { label: string; icon: typeof FileText }[] = [
  { label: "摘录", icon: NotebookText },
  { label: "任务", icon: CalendarDays },
  { label: "卡片", icon: Layers },
];

export function VaultDemo() {
  const reduce = useReducedMotion();
  const [stage, setStage] = useState<Stage>("idle");

  useEffect(() => {
    if (reduce) {
      setStage("done");
      return;
    }
    const [next, ms] = NEXT[stage];
    const id = setTimeout(() => setStage(next), ms);
    return () => clearTimeout(id);
  }, [stage, reduce]);

  // 当前写入的目的地（-1 = 尚未写入）；done 期保留卡片态
  const dest: Dest | -1 =
    stage === "pick0" ? 0 : stage === "pick1" ? 1 : stage === "pick2" || stage === "done" ? 2 : -1;
  const written = dest !== -1;

  return (
    <div className="mock-card p-5">
      <div className="flex items-center gap-1.5">
        <span className="h-2.5 w-2.5 rounded-full bg-fill-2" />
        <span className="h-2.5 w-2.5 rounded-full bg-fill-2" />
        <span className="h-2.5 w-2.5 rounded-full bg-fill-2" />
        <span className="ml-3 flex items-center gap-1.5 text-[11px] text-mute-soft">
          <Vault size={12} strokeWidth={1.9} className="text-accent-2" />
          {SCENE.vaultLabel}
        </span>
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-[1fr_1.15fr]">
        {/* 左：一次选区 + 三个模板按钮 */}
        <div className="flex flex-col">
          <div className="rounded-xl border border-line bg-fill p-3">
            <p className="text-[10px] tracking-wide text-mute-faint uppercase">{SCENE.selectionTag}</p>
            <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink/90">{SCENE.selectionEn}</p>
            <p className="mt-1 text-[12px] leading-relaxed text-mute">{SCENE.selectionZh}</p>
          </div>
          <div className="mt-3 flex gap-1.5">
            {DEST_META.map((d, i) => {
              const Icon = d.icon;
              const active = dest === i;
              return (
                <motion.span
                  key={d.label}
                  animate={active ? { scale: [1, 0.93, 1] } : { scale: 1 }}
                  transition={{ duration: 0.4 }}
                  className={`flex flex-1 items-center justify-center gap-1 rounded-lg px-2 py-1.5 text-[12px] font-medium transition-colors duration-300 ${
                    active
                      ? "bg-accent-2-fill text-accent-2-ink ring-1 ring-accent-2-line"
                      : "mock-pill text-ink/70"
                  }`}
                >
                  <Icon size={12} strokeWidth={1.9} />
                  {d.label}
                </motion.span>
              );
            })}
          </div>
          <AnimatePresence>
            {stage === "done" && (
              <motion.p
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="mt-auto flex items-center gap-1.5 pt-3 text-[11.5px] text-accent-2-ink"
              >
                <Check size={13} strokeWidth={2.2} />
                {SCENE.doneLabel}
              </motion.p>
            )}
          </AnimatePresence>
        </div>

        {/* 右：vault 里的落点，随模板切换 */}
        <div className="rounded-xl border border-line bg-elev/60 p-3">
          <div className="flex items-center gap-2 text-[11.5px]">
            <FileText size={12} strokeWidth={1.9} className="shrink-0 text-mute" />
            <AnimatePresence mode="wait" initial={false}>
              <motion.span
                key={dest === -1 ? "none" : dest}
                initial={reduce ? false : { opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={reduce ? undefined : { opacity: 0, y: -4 }}
                transition={{ duration: 0.25 }}
                className="truncate text-ink/85"
              >
                {dest === 0 ? SCENE.excerptFile : dest === 1 ? SCENE.taskFile : dest === 2 ? SCENE.cardFile : "…"}
              </motion.span>
            </AnimatePresence>
            {stage === "pick1" && (
              <motion.span
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0 }}
                className="ml-auto shrink-0 rounded-full bg-accent-fill px-2 py-0.5 text-[10px] text-accent-ink"
              >
                {SCENE.dueBadge}
              </motion.span>
            )}
          </div>

          <div className="mt-3 min-h-[118px] text-[12px] leading-relaxed">
            <AnimatePresence mode="wait" initial={false}>
              {dest === 0 && (
                <motion.blockquote
                  key="excerpt"
                  initial={reduce ? false : { opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={reduce ? undefined : { opacity: 0 }}
                  transition={{ duration: 0.35 }}
                  className="border-l-2 border-accent-2/50 pl-2.5"
                >
                  <p className="text-ink/85">{SCENE.selectionEn}</p>
                  <p className="mt-1 text-mute">{SCENE.selectionZh}</p>
                </motion.blockquote>
              )}
              {dest === 1 && (
                <motion.div
                  key="task"
                  initial={reduce ? false : { opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={reduce ? undefined : { opacity: 0 }}
                  transition={{ duration: 0.35 }}
                  className="flex items-start gap-2"
                >
                  <span className="mt-[3px] h-3 w-3 shrink-0 rounded-[4px] border border-line" />
                  <p className="text-ink/85">
                    {SCENE.taskLine}
                    <span className="ml-2 whitespace-nowrap text-mute">📅 {SCENE.taskDue}</span>
                  </p>
                </motion.div>
              )}
              {dest === 2 && (
                <motion.div
                  key="card"
                  initial={reduce ? false : { opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={reduce ? undefined : { opacity: 0 }}
                  transition={{ duration: 0.35 }}
                  className="rounded-lg border border-line bg-fill p-2.5"
                >
                  <p className="text-[12.5px] font-semibold text-ink/90">间隔重复</p>
                  <p className="mt-1 text-mute">{SCENE.selectionZh}</p>
                  <p className="mt-1.5 text-[11px] text-accent-2-ink">{SCENE.cardTag}</p>
                </motion.div>
              )}
            </AnimatePresence>
            {!written && (              <p className="text-[11.5px] text-mute-faint">写入内容会出现在这里</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
