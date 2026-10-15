import { Download as DownloadIcon, ExternalLink } from "lucide-react";
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
import { Download as DownloadIcon, ExternalLink } from "lucide-react";
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
      {/* 双平台下载卡：结构与文案同构（os / name / sub / cta / note），
          新增平台 = 字典里加一项 */}
      <div className="grid gap-4 lg:grid-cols-2">
        {d.download.cards.map((c, i) => (
          <Reveal key={c.os} delay={i * 0.08} y={18}>
            <div className="flex h-full flex-col rounded-2xl border border-line bg-panel lift p-7">
              <p className="text-[12px] tracking-wide text-mute-soft uppercase">{c.os}</p>
              <p className="mt-1.5 text-[22px] font-semibold tracking-tight">{c.name}</p>
              <p className="mt-1 text-[13px] text-mute">{c.sub}</p>

              <a
                href={RELEASES}
                target="_blank"
                rel="noreferrer"
                className="mt-6 flex w-full items-center justify-center gap-2 rounded-xl bg-ink px-5 py-3.5 text-[15px] font-medium text-bg transition-opacity hover:opacity-85"
              >
                <DownloadIcon size={16} strokeWidth={2.2} />
                {c.cta}
              </a>

              <p className="mt-4 text-[12px] text-mute-soft">{c.note}</p>
            </div>
          </Reveal>
        ))}
      </div>
      <a
        href={REPO}
        target="_blank"
        rel="noreferrer"
        className="mt-3 inline-flex items-center gap-1.5 text-[13px] text-mute transition-colors hover:text-ink"
      >
        {d.download.repo}
        <ExternalLink size={13} strokeWidth={1.9} />
      </a>

      {/* 安装步骤：按平台分组（macOS 三步 / Windows 两步），同卡展示 */}
      <Reveal delay={0.08} y={18}>
        <div className="mt-4 rounded-2xl border border-line bg-elev lift p-7">
          <h3 className="text-[15px] font-semibold tracking-tight">{d.download.stepsTitle}</h3>
          {d.download.steps.map((g) => (
            <div key={g.label} className="mt-5 first:mt-4">
              <p className="inline-flex rounded-lg border border-line bg-fill px-2.5 py-1 text-[12px] font-medium text-mute">
                {g.label}
              </p>
              <ol className="mt-3 space-y-5">
                {g.items.map((s, i) => (
                  <li key={s.t} className="flex items-baseline gap-2.5">
                    <span className="text-[13px] font-medium text-accent tabular-nums">
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    <div className="min-w-0">
                      <p className="text-[15.5px] leading-snug font-semibold tracking-tight">{s.t}</p>
                      <p className="mt-1 whitespace-pre-line text-[13.5px] leading-relaxed text-mute">{s.d}</p>
                      {s.code && (
                        <pre className="mt-2 overflow-x-auto rounded-lg border border-line bg-fill px-3 py-2 font-mono text-[12px] leading-relaxed text-ink select-all">
                          {s.code}
                        </pre>
                      )}
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          ))}
          <p className="mt-6 border-t border-line pt-5 text-[12.5px] leading-relaxed text-mute-soft">
            {d.download.note}
          </p>
        </div>
      </Reveal>

      {/* 权限子面板：安装里最容易失败的环节，独立成全宽卡片——
          三条权限行天然横向舒展，也不受左列高度差影响 */}
      <Reveal delay={0.12} y={18}>
        <div className="mt-4 rounded-2xl border border-line bg-elev lift p-7">
          <h3 className="text-[15px] font-semibold tracking-tight">{d.download.perm.title}</h3>
          <p className="mt-1.5 max-w-3xl text-[13px] leading-relaxed text-mute">{d.download.perm.lead}</p>
          <div className="mt-4 grid gap-2.5 lg:grid-cols-3">
            {d.download.perm.items.map((p) => (
              <div
                key={p.name}
                className="flex flex-col justify-between gap-3 rounded-xl border border-line bg-panel p-4"
              >
                <div>
                  <p className="text-[14px] font-medium">{p.name}</p>
                  <p className="mt-1 text-[12px] leading-relaxed text-mute">{p.why}</p>
                </div>
                <a
                  href={p.url}
                  className="inline-flex w-fit items-center rounded-lg border border-line px-3 py-1.5 text-[12px] text-accent transition-colors hover:bg-accent-soft"
                >
                  {d.download.perm.open}
                </a>
              </div>
            ))}
          </div>
        </div>
      </Reveal>
    </Section>
  );
}
