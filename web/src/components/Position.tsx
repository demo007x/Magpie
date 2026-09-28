import { Layers, ListChecks, ScanText } from "lucide-react";
import { useSite } from "../i18n";
import { Reveal } from "./Reveal";

const ICONS = [Layers, ListChecks, ScanText];

export function Position() {
  const { d } = useSite();
  return (
    <section id="position" className="border-y border-line bg-elev/50">
      <div className="mx-auto w-full max-w-6xl px-6 py-24 sm:py-28">
        <Reveal>
          <p className="text-xs font-medium tracking-[0.18em] text-accent-2 uppercase">{d.position.eyebrow}</p>
        </Reveal>
        <Reveal delay={0.06}>
          <h2 className="mt-3 max-w-3xl text-3xl leading-tight font-semibold tracking-tight text-balance sm:text-[2.6rem]">
            {d.position.titlePre}
            <span className="text-accent">{d.position.titleAccent}</span>
            {d.position.titlePost}
          </h2>
        </Reveal>
        <Reveal delay={0.12}>
          <p className="mt-4 max-w-2xl text-[1.05rem] leading-relaxed text-mute">
            {d.position.lead}
          </p>
        </Reveal>

        <div className="mt-12 grid gap-4 lg:grid-cols-3">
          {d.position.families.map((f, i) => {
            const Icon = ICONS[i];
            return (
            <Reveal key={f.name} delay={i * 0.08} y={20}>
              <div
                className={`h-full rounded-2xl border p-6 ${
                  f.live ? "border-line bg-panel lift" : "border-dashed border-line bg-transparent"
                }`}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <Icon size={17} strokeWidth={1.9} className="text-accent" />
                    <h3 className="text-[17px] font-semibold tracking-tight">{f.name}</h3>
                  </div>
                  <span
                    className={`rounded-full px-2.5 py-1 text-[11px] ${
                      f.live ? "bg-accent-fill text-accent-ink" : "bg-fill text-mute"
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
            );
          })}
        </div>

        <Reveal delay={0.1}>
          <p className="mt-8 text-[13px] text-mute-soft">
            {d.position.example}
            <a href="#download" className="ml-2 text-accent underline-offset-4 hover:underline">
              {d.position.exampleCta}
            </a>
          </p>
        </Reveal>
      </div>
    </section>
  );
}
