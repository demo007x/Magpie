import { useSite } from "../i18n";
import { Reveal } from "./Reveal";
import { Section } from "./Section";

export function Gallery() {
  const { d } = useSite();
  return (
    <Section
      id="gallery"
      eyebrow={d.gallery.eyebrow}
      title={
        <>
          {d.gallery.titlePre}
          <span className="text-accent">{d.gallery.titleAccent}</span>
          {d.gallery.titlePost}
        </>
      }
      lead={d.gallery.lead}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {d.gallery.shots.map((s, i) => (
          <Reveal key={s.file} delay={(i % 2) * 0.06} y={18} className={s.cls}>
            <figure className="group flex h-full flex-col overflow-hidden rounded-2xl border border-line bg-panel lift">
              <a
                href={`shots/${s.file}`}
                target="_blank"
                rel="noreferrer"
                aria-label={`放大查看：${s.label}`}
                className="shot block border-b border-line"
                data-file={`public/shots/${s.file}`}
              >
                <picture>
                  <source srcSet={`shots/${s.file.replace(/\.png$/, ".webp")}`} type="image/webp" />
                  <img
                    src={`shots/${s.file}`}
                    alt={`${s.label}：${s.note}`}
                    loading="lazy"
                    decoding="async"
                    width={s.w}
                    height={s.h}
                    className="mx-auto block h-auto w-auto max-w-full"
                    onError={(e) => {
                      e.currentTarget.closest(".shot")?.setAttribute("data-missing", "");
                    }}
                  />
                </picture>
              </a>
              <figcaption className="px-5 py-4">
                <p className="text-[14.5px] font-semibold tracking-tight text-ink/85 transition-colors duration-300 group-hover:text-ink">
                  {s.label}
                </p>
                <p className="mt-1 text-[12.5px] leading-relaxed text-mute-soft">{s.note}</p>
              </figcaption>
            </figure>
          </Reveal>
        ))}
      </div>
    </Section>
  );
}
