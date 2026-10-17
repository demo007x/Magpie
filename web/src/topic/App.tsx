import { CalendarDays, Crop, Download, Layers, NotebookText, ArrowRight, ArrowRightLeft, Vault } from "lucide-react";
import { RELEASES } from "../data";
import { useSite } from "../i18n";
import { Footer } from "../components/Footer";
import { Reveal } from "../components/Reveal";
import { Section } from "../components/Section";
import { CAPTURE, COLLECT, SELECT, TOPIC, type TopicCopy } from "./content";
import { CollectDemo } from "./CollectDemo";
import { FlowDemo } from "./FlowDemo";
import { LookupDemo } from "./LookupDemo";
import { OcrDemo } from "./OcrDemo";
import { TopicNav } from "./Nav";
import { VaultDemo } from "./VaultDemo";

const COLLECT_ICONS = [Crop, ArrowRightLeft, Vault];
const KEEP_ICONS = [NotebookText, CalendarDays, Layers];

/** 功能点列表：章节文案里的「功能点」列 */
function PointList({ items }: { items: TopicCopy["chapter"]["items"] }) {
  return (
    <ul className="space-y-5">
      {items.map((it) => (
        <li key={it.title} className="flex gap-3">
          <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
          <div>
            <p className="text-[15px] font-semibold tracking-tight">{it.title}</p>
            <p className="mt-1 text-[13.5px] leading-relaxed text-mute">{it.desc}</p>
          </div>
        </li>
      ))}
    </ul>
  );
}

function ChapterTitle({
  pre,
  accent,
  post,
}: {
  pre: string;
  accent: string;
  post: string;
}) {
  return (
    <>
      {pre}
      <span className="text-accent">{accent}</span>
      {post}
    </>
  );
}

export function TopicApp() {
  const { locale, root } = useSite();
  const t = TOPIC[locale];
  const select = SELECT[locale];
  const capture = CAPTURE[locale];
  const collect = COLLECT[locale];
  const homeHref = root || "./";

  return (
    <>
      <TopicNav />
      <main>
        {/* 综述：主张 + 完整流程动画 */}
        <section id="top" className="relative overflow-hidden pt-28 pb-16 sm:pt-36">
          <div className="glow pointer-events-none absolute inset-x-0 top-0 h-[520px]" />
          <div className="grain pointer-events-none absolute inset-0 opacity-40" />

          <div className="relative mx-auto max-w-3xl px-6 text-center">
            <Reveal>
              <p className="inline-flex items-center gap-2 rounded-full border border-line px-3 py-1 text-xs text-mute">
                {t.hero.badge}
              </p>
            </Reveal>
            <Reveal delay={0.06}>
              <h1 className="mt-6 text-[2.5rem] leading-[1.18] font-semibold tracking-tight text-balance sm:text-[3.2rem]">
                {t.hero.h1a}
                <span className="anno-line">
                  {t.hero.h1b}
                  <svg viewBox="0 0 320 14" preserveAspectRatio="none" aria-hidden="true">
                    <path
                      d="M3 9 C 60 13, 120 3, 180 7 S 280 11, 317 5"
                      fill="none"
                      style={{ stroke: "var(--color-accent-2)" }}
                      strokeWidth="3.5"
                      strokeLinecap="round"
                      opacity="0.85"
                    />
                  </svg>
                </span>
              </h1>
            </Reveal>
            <Reveal delay={0.12}>
              <p className="mx-auto mt-6 max-w-2xl text-[1.05rem] leading-relaxed text-mute">
                {t.hero.lead}
              </p>
            </Reveal>
            <Reveal delay={0.18}>
              <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
                <a
                  href={RELEASES}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-2 rounded-xl bg-ink px-5 py-3 text-[15px] font-medium text-bg transition-opacity hover:opacity-85"
                >
                  <Download size={16} strokeWidth={2.2} />
                  {t.hero.cta1}
                </a>
                <a
                  href={homeHref}
                  className="flex items-center gap-2 rounded-xl border border-line px-5 py-3 text-[15px] text-ink/90 transition-colors hover:bg-fill"
                >
                  {t.hero.cta2}
                  <ArrowRight size={15} strokeWidth={2} />
                </a>
              </div>
            </Reveal>
            <Reveal delay={0.24}>
              <p className="mt-5 text-[13px] leading-relaxed text-mute-soft">{t.hero.note}</p>
            </Reveal>
          </div>
        </section>

        {/* 综述：完整流程动画 + 联动步骤条 */}
        <Section
          id="flow"
          eyebrow={t.flow.eyebrow}
          title={<ChapterTitle pre={t.flow.titlePre} accent={t.flow.titleAccent} post={t.flow.titlePost} />}
          lead={t.flow.lead}
        >
          <FlowDemo steps={t.flow.steps} />
        </Section>

        {/* 划词翻译：查词场景 */}
        <Section
          id="select"
          eyebrow={select.eyebrow}
          title={<ChapterTitle pre={select.titlePre} accent={select.titleAccent} post={select.titlePost} />}
          lead={select.lead}
        >
          <div className="grid items-center gap-10 lg:grid-cols-[1fr_1.25fr]">
            <Reveal>
              <PointList items={select.items} />
            </Reveal>
            <Reveal delay={0.08} y={18}>
              <LookupDemo />
            </Reveal>
          </div>
        </Section>

        {/* 截图识别与翻译：扫描版 PDF / 图片 / 视频字幕场景（演示居左，文案在 DOM 前面） */}
        <Section
          id="capture"
          eyebrow={capture.eyebrow}
          title={<ChapterTitle pre={capture.titlePre} accent={capture.titleAccent} post={capture.titlePost} />}
          lead={capture.lead}
        >
          <div className="grid items-center gap-10 lg:grid-cols-[1.25fr_1fr]">
            <Reveal className="lg:order-2">
              <PointList items={capture.items} />
            </Reveal>
            <Reveal delay={0.08} y={18} className="lg:order-1">
              <OcrDemo />
            </Reveal>
          </div>
        </Section>

        {/* 收集与保存：先取字，再按模板落库（一个章节的两半） */}
        <Section
          id="collect"
          eyebrow={collect.eyebrow}
          title={<ChapterTitle pre={collect.titlePre} accent={collect.titleAccent} post={collect.titlePost} />}
          lead={collect.lead}
        >
          <Reveal y={18}>
            <CollectDemo />
          </Reveal>
          <div className="mt-6 grid gap-4 sm:grid-cols-3">
            {collect.items.map((row, i) => {
              const Icon = COLLECT_ICONS[i] ?? Crop;
              return (
                <Reveal key={row.title} delay={i * 0.06} y={18}>
                  <div className="h-full rounded-2xl border border-line bg-panel lift p-6">
                    <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-fill text-accent">
                      <Icon size={17} strokeWidth={1.9} />
                    </div>
                    <h3 className="mt-4 text-[16px] font-semibold tracking-tight">{row.title}</h3>
                    <p className="mt-2 text-[13.5px] leading-relaxed text-mute">{row.desc}</p>
                  </div>
                </Reveal>
              );
            })}
          </div>

          <Reveal y={18}>
            <div className="mt-10">
              <VaultDemo />
            </div>
          </Reveal>
          <div className="mt-6 grid gap-4 sm:grid-cols-3">
            {collect.keepItems.map((row, i) => {
              const Icon = KEEP_ICONS[i] ?? NotebookText;
              return (
                <Reveal key={row.title} delay={i * 0.06} y={18}>
                  <div className="h-full rounded-2xl border border-line bg-panel lift p-6">
                    <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent-2-fill text-accent-2">
                      <Icon size={17} strokeWidth={1.9} />
                    </div>
                    <h3 className="mt-4 text-[16px] font-semibold tracking-tight">{row.title}</h3>
                    <p className="mt-2 text-[13.5px] leading-relaxed text-mute">{row.desc}</p>
                  </div>
                </Reveal>
              );
            })}
          </div>
          <Reveal delay={0.08}>
            <p className="mt-6 text-[12.5px] text-mute-soft">{collect.note}</p>
          </Reveal>
        </Section>

        {/* 适合人群 */}
        <Section
          id="audience"
          eyebrow={t.audience.eyebrow}
          title={<ChapterTitle pre={t.audience.titlePre} accent={t.audience.titleAccent} post={t.audience.titlePost} />}
          lead={t.audience.lead}
        >
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {t.audience.people.map((p, i) => (
              <Reveal key={p.who} delay={i * 0.06} y={18}>
                <div className="h-full rounded-2xl border border-line bg-panel lift p-6">
                  <h3 className="text-[16px] font-semibold tracking-tight">{p.who}</h3>
                  <p className="mt-2 text-[13.5px] leading-relaxed text-mute">{p.scene}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </Section>

        {/* 常见问题 */}
        <Section id="faq" eyebrow={t.faq.eyebrow} title={t.faq.title} lead={t.faq.lead}>
          <div className="grid items-start gap-4 sm:grid-cols-2">
            {t.faq.items.map((item, i) => (
              <Reveal key={item.q} delay={(i % 2) * 0.06} y={18}>
                <div className="group rounded-2xl border border-line bg-panel lift p-6 transition-colors duration-300 hover:border-accent-line hover:bg-card">
                  <div className="flex items-baseline gap-2.5">
                    <span className="text-[13px] font-medium text-accent tabular-nums">
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    <h3 className="text-[15.5px] leading-snug font-semibold tracking-tight text-ink/80 transition-colors duration-300 group-hover:text-ink">
                      {item.q}
                    </h3>
                  </div>
                  <p className="mt-2.5 text-[13.5px] leading-relaxed text-mute">{item.a}</p>
                </div>
              </Reveal>
            ))}
          </div>
          <Reveal delay={0.08}>
            <a
              href={homeHref}
              className="mt-8 inline-flex items-center gap-1.5 text-[13px] text-mute transition-colors hover:text-ink"
            >
              {t.faq.home}
            </a>
          </Reveal>
        </Section>

        {/* 收尾行动：下载 + 返回首页 */}
        <section id="download" className="mx-auto w-full max-w-6xl px-6 pb-20">
          <Reveal>
            <div className="relative overflow-hidden rounded-3xl border border-line bg-panel lift px-6 py-14 text-center sm:px-12">
              <div className="glow pointer-events-none absolute inset-x-0 top-0 h-56" />
              <h2 className="relative text-3xl font-semibold tracking-tight text-balance">
                {t.cta.title}
              </h2>
              <p className="relative mx-auto mt-4 max-w-xl text-[1.02rem] leading-relaxed text-mute">
                {t.cta.lead}
              </p>
              <div className="relative mt-8 flex flex-wrap items-center justify-center gap-3">
                <a
                  href={RELEASES}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-2 rounded-xl bg-ink px-5 py-3 text-[15px] font-medium text-bg transition-opacity hover:opacity-85"
                >
                  <Download size={16} strokeWidth={2.2} />
                  {t.cta.cta1}
                </a>
                <a
                  href={homeHref}
                  className="flex items-center gap-2 rounded-xl border border-line px-5 py-3 text-[15px] text-ink/90 transition-colors hover:bg-fill"
                >
                  {t.cta.cta2}
                  <ArrowRight size={15} strokeWidth={2} />
                </a>
              </div>
              <p className="relative mt-5 text-[12.5px] text-mute-soft">{t.cta.note}</p>
            </div>
          </Reveal>
        </section>
      </main>
      <Footer />
    </>
  );
}
