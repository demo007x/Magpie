import { CalendarDays, Copy, Globe, Languages, Lightbulb, ListChecks, Mail, ScanText } from "lucide-react";
import { useSite } from "../i18n";
import { Reveal } from "./Reveal";
import { Section } from "./Section";

const ICONS = [Languages, Lightbulb, ListChecks, Copy, ScanText, Mail, CalendarDays];

export function Actions() {
  const { d } = useSite();
  return (
    <Section
      id="actions"
      eyebrow={d.actions.eyebrow}
      title={
        <>
          {d.actions.titlePre}
          <span className="text-accent">{d.actions.titleAccent}</span>
          {d.actions.titlePost}
        </>
      }
      lead={d.actions.lead}
    >
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {d.actions.items.map((a, i) => {
          const Icon = ICONS[i] ?? Globe;
          return (
            <Reveal key={a.name} delay={(i % 3) * 0.06} y={18}>
              <div className="group h-full rounded-2xl border border-line bg-panel lift p-6 transition-colors duration-300 hover:border-accent-line hover:bg-card">
                <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-fill text-accent transition-transform duration-300 group-hover:-translate-y-0.5">
                  <Icon size={17} strokeWidth={1.9} />
                </div>
                <h3 className="mt-4 text-[16px] font-semibold tracking-tight">{a.name}</h3>
                <p className="mt-2 text-[13.5px] leading-relaxed text-mute">{a.desc}</p>
              </div>
            </Reveal>
          );
        })}
      </div>

</Section>
  );
}
