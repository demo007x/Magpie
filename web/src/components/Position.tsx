import { Layers, ListChecks, ScanText } from "lucide-react";
import { Reveal } from "./Reveal";

const FAMILIES = [
  {
    icon: Layers,
    name: "AI 处理",
    state: "已上线",
    items: ["翻译（三种服务）", "解释", "总结", "自定义动作最多 10 个", "提示词逐条可改"],
  },
  {
    icon: ListChecks,
    name: "本地动作",
    state: "已上线",
    items: [
      "复制 / 搜索",
      "打开链接 / 写邮件",
      "网址、邮箱、验证码、号码提取",
      "结果窗独立显示，可钉住、可拖动",
    ],
  },
  {
    icon: ScanText,
    name: "应用接入",
    state: "开发中",
    items: [
      "存至笔记应用（Notion / Obsidian / flomo / 备忘录）",
      "待办、日程、生词本等同类接入",
      "随内容附带来源应用、链接与时间",
    ],
  },
];

export function Position() {
  return (
    <section id="position" className="border-y border-line bg-elev/50">
      <div className="mx-auto w-full max-w-6xl px-6 py-24 sm:py-28">
        <Reveal>
          <p className="text-xs font-medium tracking-[0.18em] text-accent-2 uppercase">Positioning</p>
        </Reveal>
        <Reveal delay={0.06}>
          <h2 className="mt-3 max-w-3xl text-3xl leading-tight font-semibold tracking-tight text-balance sm:text-[2.6rem]">
            取字、处理、转送、留存，<span className="text-accent">四个环节连续可用</span>
          </h2>
        </Reveal>
        <Reveal delay={0.12}>
          <p className="mt-4 max-w-2xl text-[1.05rem] leading-relaxed text-mute">
            拾趣覆盖取字、处理、转送、留存四个环节：除 AI 动作与本机动作外，正在扩展笔记、待办等应用接入，
            处理结果可继续流向用户已在用的应用与笔记体系。
          </p>
        </Reveal>

        <div className="mt-12 grid gap-4 lg:grid-cols-3">
          {FAMILIES.map((f, i) => (
            <Reveal key={f.name} delay={i * 0.08} y={20}>
              <div
                className={`h-full rounded-2xl border p-6 ${
                  f.state === "已上线" ? "border-line bg-panel lift" : "border-dashed border-line bg-transparent"
                }`}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <f.icon size={17} strokeWidth={1.9} className="text-accent" />
                    <h3 className="text-[17px] font-semibold tracking-tight">{f.name}</h3>
                  </div>
                  <span
                    className={`rounded-full px-2.5 py-1 text-[11px] ${
                      f.state === "已上线" ? "bg-accent-fill text-accent-ink" : "bg-fill text-mute"
                    }`}
                  >
                    {f.state}
                  </span>
                </div>
                <ul className="mt-5 space-y-2 text-[13.5px] leading-relaxed text-mute">
                  {f.items.map((it) => (
                    <li key={it} className="flex gap-2.5">
                      <span className="mt-[9px] h-1 w-1 shrink-0 rounded-full bg-mute/50" />
                      <span>{it}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </Reveal>
          ))}
        </div>

        <Reveal delay={0.1}>
          <p className="mt-8 text-[13px] text-mute-soft">
            流程示例：选中 → 解释 → 复制 → 粘贴至笔记。
            <a href="#download" className="ml-2 text-accent underline-offset-4 hover:underline">
              下载拾趣
            </a>
          </p>
        </Reveal>
      </div>
    </section>
  );
}
