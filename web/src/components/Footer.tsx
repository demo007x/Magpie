import { REPO, RELEASES } from "../data";
import { useSite } from "../i18n";
import icon from "../assets/app-icon.png";

export function Footer() {
  const { d } = useSite();
  return (
    <footer className="border-t border-line">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-10 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <img src={icon} alt="" className="h-8 w-8 rounded-[8px]" />
          <div>
            <p className="text-[14px] font-semibold tracking-tight">拾趣 Magpie</p>
            <p className="text-[12.5px] text-mute">{d.footer.tagline}</p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-[13px] text-mute">
          <a href={REPO} target="_blank" rel="noreferrer" className="transition-colors hover:text-ink">
            GitHub
          </a>
          <a href={RELEASES} target="_blank" rel="noreferrer" className="transition-colors hover:text-ink">
            {d.footer.updates}
          </a>
          <a href="#download" className="transition-colors hover:text-ink">
            {d.footer.download}
          </a>
          <span className="text-mute-soft">© {new Date().getFullYear()} {d.footer.copyright}</span>
        </div>
      </div>
    </footer>
  );
}
