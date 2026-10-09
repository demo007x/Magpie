import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { useSite } from "../i18n";
import { Reveal } from "./Reveal";
import { Section } from "./Section";

export function Gallery() {
  const { d } = useSite();
  const shots = d.gallery.shots;
  // 灯箱当前打开的截图下标；null = 关闭
  const [viewing, setViewing] = useState<number | null>(null);

  // 灯箱打开时：Esc 关闭、←/→ 循环切换、锁定页面滚动
  useEffect(() => {
    if (viewing === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setViewing(null);
      else if (e.key === "ArrowLeft")
        setViewing((v) => (v === null ? v : (v + shots.length - 1) % shots.length));
      else if (e.key === "ArrowRight")
        setViewing((v) => (v === null ? v : (v + 1) % shots.length));
    };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [viewing, shots.length]);

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
        {shots.map((s, i) => (
          <Reveal key={s.file} delay={(i % 2) * 0.06} y={18} className={s.cls}>
            <figure className="group flex h-full flex-col overflow-hidden rounded-2xl border border-line bg-panel lift">
              <button
                type="button"
                onClick={() => setViewing(i)}
                aria-label={`查看大图：${s.label}`}
                className="shot h-[240px] cursor-zoom-in border-b border-line p-4 sm:h-[340px] sm:p-6"
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
                    className="max-h-full max-w-full rounded-md shadow-md"
                    onError={(e) => {
                      e.currentTarget.closest(".shot")?.setAttribute("data-missing", "");
                    }}
                  />
                </picture>
              </button>
              <figcaption className="min-h-[70px] flex-1 px-5 py-4">
                <p className="text-[14.5px] font-semibold tracking-tight text-ink/85 transition-colors duration-300 group-hover:text-ink">
                  {s.label}
                </p>
                <p className="mt-1 text-[12.5px] leading-relaxed text-mute-soft">{s.note}</p>
              </figcaption>
            </figure>
          </Reveal>
        ))}
      </div>

      {viewing !== null && (
        <div
          className="lightbox fixed inset-0 z-50 flex flex-col items-center justify-center gap-5 p-6"
          role="dialog"
          aria-modal="true"
          aria-label={shots[viewing].label}
          onClick={() => setViewing(null)}
        >
          <button
            type="button"
            aria-label="关闭"
            className="lightbox-btn absolute right-5 top-5"
            onClick={() => setViewing(null)}
          >
            <X size={20} strokeWidth={2} />
          </button>
          <picture onClick={(e) => e.stopPropagation()}>
            <source
              srcSet={`shots/${shots[viewing].file.replace(/\.png$/, ".webp")}`}
              type="image/webp"
            />
            <img
              src={`shots/${shots[viewing].file}`}
              alt={`${shots[viewing].label}：${shots[viewing].note}`}
              className="max-h-[74vh] max-w-[92vw] rounded-lg"
            />
          </picture>
          <div className="lightbox-caption text-center" onClick={(e) => e.stopPropagation()}>
            <p className="text-[15px] font-semibold tracking-tight">{shots[viewing].label}</p>
            <p className="lightbox-caption-sub mt-1 max-w-[640px] text-[12.5px] leading-relaxed">
              {shots[viewing].note}
            </p>
          </div>
          <button
            type="button"
            aria-label="上一张"
            className="lightbox-btn absolute left-5 top-1/2 -translate-y-1/2"
            onClick={(e) => {
              e.stopPropagation();
              setViewing((v) => (v === null ? v : (v + shots.length - 1) % shots.length));
            }}
          >
            <ChevronLeft size={22} strokeWidth={2} />
          </button>
          <button
            type="button"
            aria-label="下一张"
            className="lightbox-btn absolute right-5 top-1/2 -translate-y-1/2"
            onClick={(e) => {
              e.stopPropagation();
              setViewing((v) => (v === null ? v : (v + 1) % shots.length));
            }}
          >
            <ChevronRight size={22} strokeWidth={2} />
          </button>
        </div>
      )}
    </Section>
  );
}
