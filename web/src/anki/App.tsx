import { useEffect, useRef, useState } from "react";
import { motion, useScroll } from "motion/react";
import {
  ArrowRight,
  Check,
  Download,
  ExternalLink,
  MousePointerClick,
  Plug,
  ScanText,
  Wand2,
} from "lucide-react";
import { RELEASES } from "../data";
import { useSite } from "../i18n";
import { Footer } from "../components/Footer";
import { Reveal } from "../components/Reveal";
import { Section } from "../components/Section";
import { ANKI, type AnkiCopy } from "./content";
import { ClipDemo, SetupDemo, StudyDemo } from "./demos";

/** 页头导航：与专题页同构（返回首页 + 面包屑 + 语言按钮）。
    文案取自 ANKI[locale].nav，语言按钮指向对方语言的 /anki/ 真地址 */
function AnkiNav() {
  const [solid, setSolid] = useState(false);
  const { locale, d, setLocale, assetBase, root } = useSite();
  const t = ANKI[locale];
  const nextHref = locale === "zh" ? `${root}en/anki/` : `${root}anki/`;
  const homeHref = root || "./";

  const softSwitch = (e: React.MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    setLocale(locale === "zh" ? "en" : "zh");
    history.pushState({}, "", nextHref + window.location.hash);
  };

  useEffect(() => {
    const onScroll = () => setSolid(window.scrollY > 12);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className={`fixed inset-x-0 top-0 z-50 transition-colors duration-300 ${
        solid ? "border-b border-line bg-bg/85 backdrop-blur-xl" : "border-b border-transparent"
      }`}
    >
      <nav className="mx-auto flex h-16 w-full max-w-6xl items-center gap-6 px-6">
        <a href={homeHref} className="flex shrink-0 items-center gap-2.5">
          <img src={`${assetBase}app-icon.png`} alt="" className="h-7 w-7 rounded-[7px]" />
          <span className="text-[15px] font-semibold tracking-tight">拾趣</span>
          <span className="text-[13px] text-mute">Magpie</span>
        </a>

        <div className="hidden min-w-0 flex-1 items-center gap-2 text-[13px] sm:flex">
          <a href={homeHref} className="text-mute transition-colors hover:text-ink">
            {t.nav.home}
          </a>
          <span className="text-mute-faint">/</span>
          <span className="truncate text-ink/85">{t.nav.crumb}</span>
        </div>

        <div className="flex shrink-0 items-center justify-end gap-2">
          <a
            href={nextHref}
            onClick={softSwitch}
            title={locale === "zh" ? "Switch to English" : "切换到中文"}
            className="w-12 rounded-lg px-2 py-2 text-center text-[13px] font-medium text-mute transition-colors hover:text-ink"
          >
            {locale === "zh" ? "EN" : "中文"}
          </a>
          <a
            href={RELEASES}
            target="_blank"
            rel="noreferrer"
            className="flex min-w-[112px] items-center justify-center gap-1.5 rounded-lg bg-ink px-3.5 py-2 text-[13px] font-medium text-bg transition-opacity hover:opacity-85"
          >
            <Download size={14} strokeWidth={2} />
            {d.nav.download}
          </a>
        </div>
      </nav>
    </header>
  );
}

/** 五步时间线：左侧进度轨随滚动填充，节点图标逐个点亮，终点是「第一张卡就位」。
    耗时标注回答「要多久」，站点动效语言（Reveal/渐变轨）的延伸 */
const STEP_ICONS = [Download, Plug, MousePointerClick, Wand2, ScanText];

/** 行内链接渲染：文案里的 [label](url) 转外链（下载 mention 直达 Releases/官网/插件页） */
function Rich({ text }: { text: string }) {
  const parts = text.split(/(\[[^\]]+\]\([^)]+\))/g);
  return (
    <>
      {parts.map((p, i) => {
        const m = p.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
        return m ? (
          <a
            key={i}
            href={m[2]}
            target="_blank"
            rel="noreferrer"
            className="text-accent underline-offset-2 transition-colors hover:underline"
          >
            {m[1]}
          </a>
        ) : (
          p
        );
      })}
    </>
  );
}

function StepsTimeline({ steps }: { steps: AnkiCopy["steps"] }) {
  const railRef = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({
    target: railRef,
    offset: ["start 75%", "end 65%"],
  });

  return (
    <div ref={railRef} className="relative">
      {/* 底轨 + 滚动进度填充（轨心 = 24px / sm 28px，与节点圆心对齐） */}
      <div className="absolute top-3 bottom-14 left-[24px] w-px bg-line sm:left-[28px]" />
      <motion.div
        style={{ scaleY: scrollYProgress }}
        className="absolute top-3 bottom-14 left-[24px] w-px origin-top bg-gradient-to-b from-accent to-accent-2 sm:left-[28px]"
      />
      {steps.step.map((s, idx) => {
        const Icon = STEP_ICONS[idx % STEP_ICONS.length];
        return (
          <div key={s.n} className="relative pb-8 pl-16 last:pb-12 sm:pl-24">
            {/* 节点：图标圆片压在轨上（轨心 24/28px = 圆心） */}
            <div className="absolute top-3 left-0 flex h-12 w-12 items-center justify-center rounded-full border border-line bg-panel shadow-sm sm:h-14 sm:w-14">
              <Icon size={18} strokeWidth={1.9} className="text-accent" />
            </div>
            <Reveal delay={idx * 0.04}>
              <div className="lift rounded-2xl border border-line bg-panel p-6 sm:p-7">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-baseline gap-3">
                    <span className="text-[11px] font-medium tracking-[0.18em] text-accent/80">
                      {s.n}
                    </span>
                    <h3 className="text-[17px] font-semibold tracking-tight">{s.title}</h3>
                  </div>
                  <span className="rounded-full border border-line px-2.5 py-1 text-[11px] text-mute-soft">
                    {s.time}
                  </span>
                </div>
                <p className="mt-2.5 text-[14px] leading-relaxed text-mute">
                  <Rich text={s.body} />
                </p>
                <ul className="mt-3 space-y-2">
                  {s.points.map((p) => (
                    <li key={p} className="flex gap-2.5 text-[13px] leading-relaxed text-mute">
                      <Check size={14} strokeWidth={2.2} className="mt-0.5 shrink-0 text-accent" />
                      <span>
                        <Rich text={p} />
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </Reveal>
          </div>
        );
      })}
      {/* 终点节点：第一张卡就位 */}
      <div className="relative pl-16 sm:pl-24">
        <div className="absolute top-0 left-0 flex h-12 w-12 items-center justify-center rounded-full border border-accent-line bg-accent-fill sm:h-14 sm:w-14">
          <Check size={18} strokeWidth={2.4} className="text-accent" />
        </div>
        <Reveal>
          <div className="pt-2.5">
            <h3 className="text-[17px] font-semibold tracking-tight">{steps.done.title}</h3>
            <p className="mt-2 text-[14px] leading-relaxed text-mute">{steps.done.desc}</p>
          </div>
        </Reveal>
      </div>
    </div>
  );
}

export function AnkiApp() {
  const { locale, root } = useSite();
  const t = ANKI[locale];
  const homeHref = root || "./";

  return (
    <div className="min-h-screen bg-bg text-ink">
      <AnkiNav />

      {/* Hero */}
      <section className="mx-auto w-full max-w-6xl px-6 pt-32 pb-10 sm:pt-40">
        <Reveal>
          <p className="text-xs font-medium tracking-[0.18em] text-accent uppercase">
            {t.hero.badge}
          </p>
        </Reveal>
        <Reveal delay={0.06}>
          <h1 className="mt-4 max-w-3xl text-4xl leading-tight font-semibold tracking-tight text-balance sm:text-[3.2rem]">
            {t.hero.h1a}
            <span className="text-accent">{t.hero.h1b}</span>
          </h1>
        </Reveal>
        <Reveal delay={0.12}>
          <p className="mt-5 max-w-2xl text-[1.05rem] leading-relaxed text-mute">{t.hero.lead}</p>
        </Reveal>
        <Reveal delay={0.18}>
          <div className="mt-8 flex flex-wrap items-center gap-4">
            <a
              href={RELEASES}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-2 rounded-xl bg-ink px-5 py-3 text-[15px] font-medium text-bg transition-opacity hover:opacity-85"
            >
              <Download size={16} strokeWidth={2} />
              {t.hero.cta}
            </a>
            <span className="text-[12.5px] text-mute-soft">{t.hero.note}</span>
          </div>
        </Reveal>
      </section>

      {/* 开始之前 */}
      <Section id="prereq" eyebrow={t.prereq.eyebrow} title={t.prereq.title}>
        <div className="grid gap-4 sm:grid-cols-2">
          {t.prereq.items.map((it) => (
            <Reveal key={it.title}>
              <div className="lift rounded-2xl border border-line bg-panel p-6">
                <h3 className="text-[15px] font-semibold tracking-tight">{it.title}</h3>
                <p className="mt-2 text-[13.5px] leading-relaxed text-mute">
                  <Rich text={it.desc} />
                </p>
              </div>
            </Reveal>
          ))}
        </div>
      </Section>

      {/* 五步教程：滚动进度轨 + 节点时间线，终点为「第一张卡就位」 */}
      <Section id="steps" eyebrow={t.steps.eyebrow} title={t.steps.title} lead={t.steps.lead}>
        <StepsTimeline steps={t.steps} />
      </Section>

      {/* 界面演示 */}
      <Section
        id="demo"
        eyebrow={t.demo.eyebrow}
        title={
          <>
            {t.demo.titlePre}
            <span className="text-accent">{t.demo.titleAccent}</span>
            {t.demo.titlePost}
          </>
        }
        lead={t.demo.lead}
      >
        <div className="grid gap-6 lg:grid-cols-2">
          <Reveal>
            <div>
              <SetupDemo />
              <h3 className="mt-4 text-[15px] font-semibold tracking-tight">{t.demo.setupTitle}</h3>
              <p className="mt-1 text-[13.5px] leading-relaxed text-mute">{t.demo.setupDesc}</p>
            </div>
          </Reveal>
          <Reveal delay={0.08}>
            <div>
              <ClipDemo />
              <h3 className="mt-4 text-[15px] font-semibold tracking-tight">{t.demo.clipTitle}</h3>
              <p className="mt-1 text-[13.5px] leading-relaxed text-mute">{t.demo.clipDesc}</p>
            </div>
          </Reveal>
        </div>
      </Section>

      {/* 学习方法 */}
      <Section
        id="study"
        eyebrow={t.study.eyebrow}
        title={
          <>
            {t.study.titlePre}
            <span className="text-accent">{t.study.titleAccent}</span>
            {t.study.titlePost}
          </>
        }
        lead={t.study.lead}
      >
        <div className="grid gap-6 lg:grid-cols-[1fr_1.1fr] lg:items-start">
          <Reveal>
            <StudyDemo />
          </Reveal>
          <div className="space-y-5">
            {t.study.items.map((it, idx) => (
              <Reveal key={it.title} delay={idx * 0.05}>
                <div className="flex gap-3.5">
                  <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
                  <div>
                    <p className="text-[15px] font-semibold tracking-tight">{it.title}</p>
                    <p className="mt-1 text-[13.5px] leading-relaxed text-mute">{it.desc}</p>
                  </div>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </Section>

      {/* 学习资源 */}
      <Section id="resources" eyebrow={t.resources.eyebrow} title={t.resources.title} lead={t.resources.lead}>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {t.resources.items.map((r, idx) => (
            <Reveal key={r.name} delay={idx * 0.04}>
              <a
                href={r.url}
                target="_blank"
                rel="noreferrer"
                className="lift block h-full rounded-2xl border border-line bg-panel p-5 transition-colors hover:border-accent-line"
              >
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-[14.5px] font-semibold tracking-tight">{r.name}</h3>
                  <ExternalLink size={13} strokeWidth={1.9} className="shrink-0 text-mute-faint" />
                </div>
                <p className="mt-2 text-[13px] leading-relaxed text-mute">{r.desc}</p>
                <p className="mt-3 inline-flex items-center gap-1 text-[12px] text-accent">
                  {r.link}
                  <ArrowRight size={11} strokeWidth={2} />
                </p>
              </a>
            </Reveal>
          ))}
        </div>
      </Section>

      {/* FAQ */}
      <Section id="faq" eyebrow={t.faq.eyebrow} title={t.faq.title}>
        <div className="grid gap-4 sm:grid-cols-2">
          {t.faq.items.map((f, idx) => (
            <Reveal key={f.q} delay={idx * 0.03} className="h-full">
              <div className="h-full rounded-2xl border border-line bg-panel p-5">
                <p className="text-[14.5px] font-semibold tracking-tight">{f.q}</p>
                <p className="mt-2 text-[13.5px] leading-relaxed text-mute">{f.a}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </Section>

      {/* 结尾 CTA */}
      <section className="mx-auto w-full max-w-6xl px-6 pb-20">
        <Reveal>
          <div className="lift rounded-3xl border border-line bg-panel p-8 text-center sm:p-12">
            <h2 className="text-2xl font-semibold tracking-tight text-balance sm:text-3xl">
              {t.cta.title}
            </h2>
            <p className="mx-auto mt-3 max-w-xl text-[14.5px] leading-relaxed text-mute">
              {t.cta.lead}
            </p>
            <div className="mt-7 flex flex-wrap items-center justify-center gap-4">
              <a
                href={RELEASES}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-2 rounded-xl bg-ink px-5 py-3 text-[15px] font-medium text-bg transition-opacity hover:opacity-85"
              >
                <Download size={16} strokeWidth={2} />
                {t.cta.button}
              </a>
              <a
                href={`${homeHref}translate/`}
                className="inline-flex items-center gap-1.5 text-[13.5px] text-mute transition-colors hover:text-ink"
              >
                {t.cta.guide}
                <ArrowRight size={13} strokeWidth={2} />
              </a>
            </div>
          </div>
        </Reveal>
      </section>

      <Footer />
    </div>
  );
}
