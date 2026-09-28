import { BookOpen, Feather, GraduationCap, NotebookPen } from "lucide-react";
import { Reveal } from "./Reveal";
import { Section } from "./Section";

const PEOPLE = [
  {
    icon: Feather,
    who: "作者 / 编辑",
    scene: "引用、查证与注释：选中即可解释与复制，无需在窗口之间来回切换。",
  },
  {
    icon: NotebookPen,
    who: "译者 / 语言学习者",
    scene: "提示词可按个人翻译规范设定；常用转换可保存为自定义动作；自定义搜索引擎可接入个人词条库。",
  },
  {
    icon: BookOpen,
    who: "研究者 / 重度阅读者",
    scene: "扫描版 PDF、图表与截图中的文字无法选中，框选后即可识别并执行翻译、解释或总结。",
  },
  {
    icon: GraduationCap,
    who: "学生 / 课程视频观看者",
    scene: "课件截图、视频字幕与图片板书可框选识别，⌥T 识图翻译、⌥E 识图解释。",
  },
];

export function Audience() {
  return (
    <Section
      id="who"
      eyebrow="Use cases"
      title={
        <>
          主要使用者：<span className="text-accent">高频处理文字内容的人</span>
        </>
      }
      lead="写作、编辑、翻译、研究与阅读场景中，查阅、核实、摘录、留存的频率最高。拾趣针对该流程提供取字与处理动作，不涉及内容创作。"
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {PEOPLE.map((p, i) => (
          <Reveal key={p.who} delay={(i % 2) * 0.07} y={18}>
            <div className="flex h-full gap-4 rounded-2xl border border-line bg-panel lift p-6">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-fill text-accent">
                <p.icon size={17} strokeWidth={1.9} />
              </div>
              <div>
                <h3 className="text-[15.5px] font-semibold tracking-tight">{p.who}</h3>
                <p className="mt-2 text-[13.5px] leading-relaxed text-mute">{p.scene}</p>
              </div>
            </div>
          </Reveal>
        ))}
      </div>
    </Section>
  );
}
