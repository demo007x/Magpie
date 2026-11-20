import { useEffect, useState } from "react";
import { ArrowRight, BookOpen, Download, ExternalLink, FolderOpen, Search, Sparkles } from "lucide-react";
import { RELEASES } from "../data";
import { useSite } from "../i18n";
import { Footer } from "../components/Footer";
import { Reveal } from "../components/Reveal";
import { Section } from "../components/Section";
import { DICT, type DictCopy } from "./content";

/** 页头导航：与 Anki 教程页同构（返回首页 + 面包屑 + 语言按钮）。
    文案取自 DICT[locale].nav，语言按钮指向对方语言的 /dict/ 真地址 */
function DictNav() {
  const [solid, setSolid] = useState(false);
  const { locale, d, setLocale, assetBase, root } = useSite();
  const t = DICT[locale];
  const nextHref = locale === "zh" ? `${root}en/dict/` : `${root}dict/`;
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

/** 行内链接渲染：文案里的 [label](url) 转外链（下载 mention 直达 Release 页） */
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

const PATH_ICONS = [Download, FolderOpen];

/** 两条获取路径卡：并排双卡，步骤内嵌编号 */
function PathsCards({ paths }: { paths: DictCopy["paths"] }) {
  const cards = [paths.a, paths.b];
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      {cards.map((c, idx) => {
        const Icon = PATH_ICONS[idx % PATH_ICONS.length];
        return (
          <Reveal key={c.name} delay={idx * 0.06}>
            <div className="lift flex h-full flex-col rounded-2xl border border-line bg-panel p-6 sm:p-7">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2.5">
                  <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-line bg-fill">
                    <Icon size={16} strokeWidth={1.9} className="text-accent" />
                  </div>
                  <h3 className="text-[15.5px] font-semibold tracking-tight">{c.name}</h3>
                </div>
                <span className="shrink-0 rounded-full border border-line px-2.5 py-1 text-[11px] text-mute-soft">
                  {c.tag}
                </span>
              </div>
              <ol className="mt-4 space-y-3">
                {c.steps.map((s, i) => (
                  <li key={i} className="flex gap-3 text-[13.5px] leading-relaxed text-mute">
                    <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-line text-[11px] font-medium text-accent">
                      {i + 1}
                    </span>
                    <span>
                      <Rich text={s} />
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          </Reveal>
        );
      })}
    </div>
  );
}

export function DictApp() {
  const { locale, root } = useSite();
  const t = DICT[locale];
  const homeHref = root || "./";

  return (
    <div className="min-h-screen bg-bg text-ink">
      <DictNav />

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

      {/* 两条获取路径 */}
      <Section id="paths" eyebrow={t.paths.eyebrow} title={t.paths.title} lead={t.paths.lead}>
        <PathsCards paths={t.paths} />
      </Section>

      {/* 怎么用 */}
      <Section id="usage" eyebrow={t.usage.eyebrow} title={t.usage.title} lead={t.usage.lead}>
        <div className="grid gap-6 lg:grid-cols-[1fr_1.1fr] lg:items-start">
          <Reveal>
            <div className="lift rounded-2xl border border-line bg-panel p-8">
              <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-accent-line bg-accent-fill">
                <Search size={22} strokeWidth={1.9} className="text-accent" />
              </div>
              <p className="mt-5 text-[15px] font-semibold tracking-tight">
                {t.usage.items[0].title}
              </p>
              <p className="mt-2 text-[13.5px] leading-relaxed text-mute">
                {t.usage.items[0].desc}
              </p>
              <div className="mt-6 flex items-center gap-2 rounded-xl border border-line bg-fill px-4 py-3 text-[13px] text-mute">
                <Sparkles size={14} strokeWidth={1.9} className="shrink-0 text-accent" />
                perceive → perceived → perception
              </div>
            </div>
          </Reveal>
          <div className="space-y-5">
            {t.usage.items.slice(1).map((it, idx) => (
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

      {/* 来源与署名 */}
      <Section
        id="attribution"
        eyebrow={t.attribution.eyebrow}
        title={t.attribution.title}
        lead={t.attribution.lead}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          {t.attribution.items.map((r, idx) => (
            <Reveal key={r.name} delay={idx * 0.04}>
              <a
                href={r.url}
                target="_blank"
                rel="noreferrer"
                className="lift block h-full rounded-2xl border border-line bg-panel p-5 transition-colors hover:border-accent-line"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <BookOpen size={14} strokeWidth={1.9} className="text-accent" />
                    <h3 className="text-[14.5px] font-semibold tracking-tight">{r.name}</h3>
                  </div>
                  <ExternalLink size={13} strokeWidth={1.9} className="shrink-0 text-mute-faint" />
                </div>
                <p className="mt-2 text-[13px] leading-relaxed text-mute">{r.desc}</p>
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
