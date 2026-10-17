import { useEffect, useState } from "react";
import { Download } from "lucide-react";
import { RELEASES } from "../data";
import { useSite } from "../i18n";
import { TOPIC } from "./content";

/** 专题页导航：与首页同构，中段换成「返回首页 + 面包屑」；语言按钮指向
    对方语言的同一专题页 */
export function TopicNav() {
  const [solid, setSolid] = useState(false);
  const { locale, d, setLocale, assetBase, root } = useSite();
  const t = TOPIC[locale];
  const nextHref = locale === "zh" ? `${root}en/translate/` : `${root}translate/`;
  const homeHref = root || "./";

  const softSwitch = (e: React.MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    setLocale(locale === "zh" ? "en" : "zh");
    history.pushState({}, "", nextHref + window.location.hash);
  };

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
      <nav className="mx-auto flex h-16 w-full max-w-6xl items-center gap-6 px-6">
        <a href={homeHref} className="flex shrink-0 items-center gap-2.5">
          <img src={`${assetBase}app-icon.png`} alt="" className="h-7 w-7 rounded-[7px]" />
          <span className="text-[15px] font-semibold tracking-tight">拾趣</span>
          <span className="text-[13px] text-mute">Magpie</span>
        </a>

        <div className="hidden min-w-0 flex-1 items-center gap-2 text-[13px] sm:flex">
          <a href={homeHref} className="text-mute transition-colors hover:text-ink">
            {t.nav.home}
          </a>
          <span className="text-mute-faint">/</span>
          <span className="truncate text-ink/85">{t.nav.crumb}</span>
        </div>

        <div className="flex shrink-0 items-center justify-end gap-2">
          <a
            href={nextHref}
            onClick={softSwitch}
            title={locale === "zh" ? "Switch to English" : "切换到中文"}
            className="w-12 rounded-lg px-2 py-2 text-center text-[13px] font-medium text-mute transition-colors hover:text-ink"
          >
            {locale === "zh" ? "EN" : "中文"}
          </a>
          <a
            href={RELEASES}
            target="_blank"
            rel="noreferrer"
            className="hidden min-w-[84px] items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-[13px] text-mute transition-colors hover:text-ink sm:flex"
          >
            {d.nav.updates}
          </a>
          <a
            href={RELEASES}
            target="_blank"
            rel="noreferrer"
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
