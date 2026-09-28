import { RELEASES } from "../data";
import { useSite } from "../i18n";
import { Reveal } from "./Reveal";
import { Section } from "./Section";

export function Faq() {
  const { d } = useSite();
  return (
    <Section
      id="faq"
      eyebrow={d.faq.eyebrow}
      title={d.faq.title}
      lead={d.faq.lead}
    >
      <div className="grid items-start gap-4 sm:grid-cols-2">
        {d.faq.items.map((item, i) => (
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
          href={RELEASES}
          target="_blank"
          rel="noreferrer"
          className="mt-8 inline-flex items-center gap-1.5 text-[13px] text-mute transition-colors hover:text-ink"
        >
          {d.faq.more}
        </a>
      </Reveal>
    </Section>
  );
}
