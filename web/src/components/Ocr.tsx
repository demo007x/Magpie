import { Command, Crop, MousePointerClick, Pin } from "lucide-react";
import { useSite } from "../i18n";
import { Reveal } from "./Reveal";
import { Section } from "./Section";

const RULE_ICONS = [MousePointerClick, Crop, Pin, Command];

export function Ocr() {
  const { d } = useSite();
  return (
    <Section
      id="ocr"
      eyebrow={d.ocr.eyebrow}
      title={
        <>
          {d.ocr.titlePre}
          <span className="text-accent">{d.ocr.titleAccent}</span>
          {d.ocr.titlePost}
        </>
      }
      lead={d.ocr.lead}
    >
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {d.ocr.steps.map((s, i) => (
          <Reveal key={s.title} delay={i * 0.07} y={18}>
            <div className="h-full rounded-2xl border border-line bg-panel lift p-6">
              <div className="flex items-baseline gap-2.5">
                <span className="text-[13px] font-medium text-accent tabular-nums">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <h3 className="text-[15.5px] leading-snug font-semibold tracking-tight">{s.title}</h3>
              </div>
              <p className="mt-2.5 text-[13.5px] leading-relaxed text-mute">{s.desc}</p>
            </div>
          </Reveal>
        ))}
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-[1fr_1.15fr]">
        <Reveal y={18}>
          <div className="h-full rounded-2xl border border-line bg-elev lift p-6">
            <h3 className="text-[15px] font-semibold tracking-tight">{d.ocr.shortcutsTitle}</h3>
            <p className="mt-1.5 text-[13px] text-mute">
              {d.ocr.shortcutsNote}
            </p>
            <ul className="mt-5 space-y-2.5">
              {d.ocr.shortcuts.map((k) => (
                <li key={k.keys} className="flex items-center justify-between gap-4">
                  <span className="text-[13.5px] text-ink/85">{k.label}</span>
                  <kbd className="rounded-md border border-line bg-fill px-2.5 py-1 font-sans text-[12px] tracking-wide text-ink/90">
                    {k.keys}
                  </kbd>
                </li>
              ))}
            </ul>
          </div>
        </Reveal>

        <Reveal delay={0.08} y={18}>
          <div className="h-full rounded-2xl border border-line bg-elev lift p-6">
            <h3 className="text-[15px] font-semibold tracking-tight">{d.ocr.rulesTitle}</h3>
            <ul className="mt-5 space-y-4 text-[13.5px] leading-relaxed text-mute">
              {d.ocr.rules.map((r, i) => {
                const Icon = RULE_ICONS[i];
                return (
                  <li key={r.slice(0, 8)} className="flex gap-3">
                    {Icon && (
                      <Icon size={16} strokeWidth={1.9} className="mt-0.5 shrink-0 text-accent" />
                    )}
                    <span>{r}</span>
                  </li>
                );
              })}
            </ul>
          </div>
        </Reveal>
      </div>
    </Section>
  );
}
