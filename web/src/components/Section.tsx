import type { ReactNode } from "react";
import { Reveal } from "./Reveal";

export function Section({
  id,
  eyebrow,
  title,
  lead,
  children,
}: {
  id: string;
  eyebrow: string;
  title: ReactNode;
  lead?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section id={id} className="mx-auto w-full max-w-6xl px-6 py-24 sm:py-28">
      <div className="max-w-3xl">
        <Reveal>
          <p className="text-xs font-medium tracking-[0.18em] text-accent uppercase">{eyebrow}</p>
        </Reveal>
        <Reveal delay={0.06}>
          <h2 className="mt-3 text-3xl leading-tight font-semibold tracking-tight text-balance sm:text-[2.6rem]">
            {title}
          </h2>
        </Reveal>
        {lead && (
          <Reveal delay={0.12}>
            <p className="mt-4 text-[1.05rem] leading-relaxed text-mute">{lead}</p>
          </Reveal>
        )}
      </div>
      <div className="mt-12">{children}</div>
    </section>
  );
}
