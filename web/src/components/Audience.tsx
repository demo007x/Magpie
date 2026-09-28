import { BookOpen, Feather, GraduationCap, NotebookPen } from "lucide-react";
import { useSite } from "../i18n";
import { Reveal } from "./Reveal";
import { Section } from "./Section";

const ICONS = [Feather, NotebookPen, BookOpen, GraduationCap];

export function Audience() {
  const { d } = useSite();
  return (
    <Section
      id="who"
      eyebrow={d.audience.eyebrow}
      title={
        <>
          {d.audience.titlePre}
          <span className="text-accent">{d.audience.titleAccent}</span>
          {d.audience.titlePost}
        </>
      }
      lead={d.audience.lead}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {d.audience.people.map((p, i) => {
          const Icon = ICONS[i] ?? Feather;
          return (
            <Reveal key={p.who} delay={(i % 2) * 0.07} y={18}>
              <div className="flex h-full gap-4 rounded-2xl border border-line bg-panel lift p-6">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-fill text-accent">
                  <Icon size={17} strokeWidth={1.9} />
                </div>
                <div>
                  <h3 className="text-[15.5px] font-semibold tracking-tight">{p.who}</h3>
                  <p className="mt-2 text-[13.5px] leading-relaxed text-mute">{p.scene}</p>
                </div>
              </div>
            </Reveal>
          );
        })}
      </div>
    </Section>
  );
}
