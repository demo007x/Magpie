import { AlertTriangle, Download as DownloadIcon, ExternalLink } from "lucide-react";
import { RELEASES, REPO } from "../data";
import { useSite } from "../i18n";
import { Reveal } from "./Reveal";
import { Section } from "./Section";

export function Download() {
  const { d } = useSite();
  return (
    <Section
      id="download"
      eyebrow={d.download.eyebrow}
      title={
        <>
          {d.download.titlePre}
          <span className="text-accent">{d.download.titleAccent}</span>
          {d.download.titlePost}
        </>
      }
      lead={d.download.lead}
    >
      <div className="grid items-start gap-4 lg:grid-cols-[1fr_1.25fr]">
        <Reveal y={18}>
          <div className="rounded-2xl border border-line bg-panel lift p-7">
            <p className="text-[12px] tracking-wide text-mute-soft uppercase">macOS</p>
            <p className="mt-1.5 text-[22px] font-semibold tracking-tight">{d.download.card.name}</p>
            <p className="mt-1 text-[13px] text-mute">{d.download.card.sub}</p>

            <a
              href={RELEASES}
              target="_blank"
              rel="noreferrer"
              className="mt-6 flex w-full items-center justify-center gap-2 rounded-xl bg-ink px-5 py-3.5 text-[15px] font-medium text-bg transition-opacity hover:opacity-85"
            >
              <DownloadIcon size={16} strokeWidth={2.2} />
              {d.download.card.cta}
            </a>
            <a
              href={REPO}
              target="_blank"
              rel="noreferrer"
              className="mt-2.5 flex items-center justify-center gap-1.5 text-[13px] text-mute transition-colors hover:text-ink"
            >
              {d.download.card.repo}
              <ExternalLink size={13} strokeWidth={1.9} />
            </a>

            <p className="mt-4 text-[12px] text-mute-soft">{d.download.card.note}</p>
            <div className="mt-5 flex items-center gap-2 rounded-xl border border-accent-2-line bg-accent-2-fill px-4 py-3 text-[12.5px] leading-relaxed text-accent-2-ink">
              <AlertTriangle size={15} strokeWidth={1.9} className="shrink-0 text-accent-2" />
              <span>{d.download.card.warn}</span>
            </div>
          </div>
        </Reveal>

        <Reveal delay={0.08} y={18}>
          <div className="h-full rounded-2xl border border-line bg-elev lift p-7">
            <h3 className="text-[15px] font-semibold tracking-tight">{d.download.stepsTitle}</h3>
            <ol className="mt-5 space-y-5">
              {d.download.steps.map((s, i) => (
                <li key={s.t} className="flex items-baseline gap-2.5">
                  <span className="text-[13px] font-medium text-accent tabular-nums">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <div>
                    <p className="text-[15.5px] leading-snug font-semibold tracking-tight">{s.t}</p>
                    <p className="mt-1 whitespace-pre-line text-[13.5px] leading-relaxed text-mute">{s.d}</p>
                  </div>
                </li>
              ))}
            </ol>
            <p className="mt-6 border-t border-line pt-5 text-[12.5px] leading-relaxed text-mute-soft">
              {d.download.note}
            </p>
          </div>
        </Reveal>
      </div>
    </Section>
  );
}
