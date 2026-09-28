import { KeyRound, ShieldCheck, Eye, BadgeDollarSign } from "lucide-react";
import { useSite } from "../i18n";
import { Reveal } from "./Reveal";
import { Section } from "./Section";

const ICONS = [KeyRound, ShieldCheck, Eye, BadgeDollarSign];

export function Trust() {
  const { d } = useSite();
  return (
    <Section
      id="trust"
      eyebrow={d.trust.eyebrow}
      title={
        <>
          {d.trust.titlePre}
          <span className="text-accent">{d.trust.titleAccent}</span>
          {d.trust.titlePost}
        </>
      }
      lead={d.trust.lead}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {d.trust.items.map((t, i) => {
          const Icon = ICONS[i];
          return (
            <Reveal key={t.title} delay={(i % 2) * 0.07} y={18}>
              <div className="h-full rounded-2xl border border-line bg-panel lift p-6">
                <div className="flex items-center gap-2.5">
                  <Icon size={17} strokeWidth={1.9} className="text-accent-2" />
                  <h3 className="text-[16px] font-semibold tracking-tight">{t.title}</h3>
                </div>
                <p className="mt-2.5 text-[13.5px] leading-relaxed text-mute">{t.desc}</p>
              </div>
            </Reveal>
          );
        })}
      </div>

      <Reveal delay={0.1}>
        <p className="mt-6 text-[13px] leading-relaxed text-mute-soft">
          {d.trust.note}
        </p>
      </Reveal>
    </Section>
  );
}
