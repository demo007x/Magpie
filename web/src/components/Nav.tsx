import { useEffect, useState } from "react";
import { Download } from "lucide-react";
import { RELEASES } from "../data";
import { useSite } from "../i18n";
import icon from "../assets/app-icon.png";

export function Nav() {
  const [solid, setSolid] = useState(false);
  const { locale, d, setLocale } = useSite();
  const next = locale === "zh" ? "en" : "zh";

  useEffect(() => {
    const onScroll = () => setSolid(window.scrollY > 12);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className={`fixed inset-x-0 top-0 z-50 transition-colors duration-300 ${
        solid ? "border-b border-line bg-bg/85 backdrop-blur-xl" : "border-b border-transparent"
      }`}
    >
      <nav className="mx-auto grid h-16 w-full max-w-6xl grid-cols-[auto_1fr_auto] items-center gap-6 px-6">
        <a href="#top" className="flex items-center gap-2.5">
          <img src={icon} alt="" className="h-7 w-7 rounded-[7px]" />
          <span className="text-[15px] font-semibold tracking-tight">拾趣</span>
          <span className="text-[13px] text-mute">Magpie</span>
        </a>

        <div className="hidden w-[588px] grid-cols-6 items-center justify-items-center lg:grid">
          {d.nav.items.map((item) => (
            <a
              key={item.id}
              href={`#${item.id}`}
              className="text-[13px] text-mute transition-colors hover:text-ink"
            >
              {item.label}
            </a>
          ))}
        </div>

        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => setLocale(next)}
            title={locale === "zh" ? "Switch to English" : "切换到中文"}
            className="w-12 rounded-lg px-2 py-2 text-[13px] font-medium text-mute transition-colors hover:text-ink"
          >
            {locale === "zh" ? "EN" : "中文"}
          </button>
          <a
            href={RELEASES}
            target="_blank"
            rel="noreferrer"
            className="hidden min-w-[84px] items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-[13px] text-mute transition-colors hover:text-ink sm:flex"
          >
            {d.nav.updates}
          </a>
          <a
            href="#download"
            className="flex min-w-[112px] items-center justify-center gap-1.5 rounded-lg bg-ink px-3.5 py-2 text-[13px] font-medium text-bg transition-opacity hover:opacity-85"
          >
            <Download size={14} strokeWidth={2} />
            {d.nav.download}
          </a>
        </div>
      </nav>
    </header>
  );
}
