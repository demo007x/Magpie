import { ArrowDown, Download } from "lucide-react";
import { RELEASES, STATS } from "../data";
import { CapsuleDemo } from "./CapsuleDemo";
import { Reveal } from "./Reveal";

export function Hero() {
  return (
    <section id="top" className="relative overflow-hidden pt-28 pb-16 sm:pt-36">
      <div className="glow pointer-events-none absolute inset-x-0 top-0 h-[520px]" />
      <div className="grain pointer-events-none absolute inset-0 opacity-40" />

      <div className="relative mx-auto grid w-full max-w-6xl items-center gap-14 px-6 lg:grid-cols-[1.05fr_1fr]">
        <div>
          <Reveal>
            <p className="inline-flex items-center gap-2 rounded-full border border-line px-3 py-1 text-xs text-mute">
              macOS · 永久免费
            </p>
          </Reveal>

          <Reveal delay={0.06}>
            <h1 className="mt-6 text-[2.6rem] leading-[1.1] font-semibold tracking-tight text-balance sm:text-[3.4rem]">
              屏幕上任何文字，
              <br />
              选中或框选，<span className="text-accent">就地处理</span>
            </h1>
          </Reveal>

          <Reveal delay={0.12}>
            <p className="mt-6 max-w-xl text-[1.075rem] leading-relaxed text-mute">
              拖选或双击文字即显示浮动条；图片、视频与扫描文档中的文字可框选识别。
              支持翻译、解释、总结、搜索与信息提取，结果在独立窗口中显示，可复制、可继续处理。
            </p>
          </Reveal>

          <Reveal delay={0.18}>
            <div className="mt-9 flex flex-wrap items-center gap-3">
              <a
                href="#download"
                className="flex items-center gap-2 rounded-xl bg-ink px-5 py-3 text-[15px] font-medium text-bg transition-opacity hover:opacity-85"
              >
                <Download size={16} strokeWidth={2.2} />
                下载 macOS 版
              </a>
              <a
                href={RELEASES}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-2 rounded-xl border border-line px-5 py-3 text-[15px] text-ink/90 transition-colors hover:bg-fill"
              >
                GitHub Releases
                <ArrowDown size={15} strokeWidth={2} className="rotate-[-90deg]" />
              </a>
            </div>
          </Reveal>

          <Reveal delay={0.24}>
            <p className="mt-5 text-[13px] leading-relaxed text-mute-soft">
              模型服务自选 · 识图与信息提取在本机完成 · 不收集使用数据
            </p>
          </Reveal>
        </div>

        <Reveal delay={0.16} y={22}>
          <CapsuleDemo />
        </Reveal>
      </div>

      <div className="relative mx-auto mt-20 grid w-full max-w-6xl grid-cols-2 gap-px overflow-hidden rounded-2xl border border-line bg-line px-0 sm:grid-cols-4">
        {STATS.map((s, i) => (
          <Reveal key={s.label} delay={i * 0.06} y={14}>
            <div className="h-full bg-bg px-6 py-7">
              <div className="text-3xl font-semibold tracking-tight">{s.value}</div>
              <div className="mt-1.5 text-[14px] text-ink/85">{s.label}</div>
              <div className="text-[12px] text-mute-soft">{s.note}</div>
            </div>
          </Reveal>
        ))}
      </div>
    </section>
  );
}
