import { ArrowRight, CalendarDays, Copy, KeyRound, Languages, Lightbulb, ListChecks, Mail, Pencil, Plus, ScanText, Vault } from "lucide-react";
import { useSite } from "../i18n";
import { Reveal } from "./Reveal";
import { Section } from "./Section";

const AI_ICONS = [Languages, Lightbulb, ListChecks];
const CUSTOM_ICONS = [Pencil, Plus, KeyRound];
const LOCAL_ICONS = [Copy, ScanText, Mail, CalendarDays, Vault];

/** 组头：小字标签 + 计数 + 右侧一句说明，两个分组共用 */
function GroupHead({ label, count, note, accent }: { label: string; count: string; note: string; accent: boolean }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <p className={`text-xs font-medium tracking-[0.18em] uppercase ${accent ? "text-accent" : "text-mute"}`}>
        {label}
      </p>
      <span className="text-xs text-mute">{count}</span>
      <span className="ml-auto text-[13px] text-mute-soft">{note}</span>
    </div>
  );
}

export function Actions() {
  const { d, root } = useSite();
  return (
    <Section
      id="actions"
      eyebrow={d.actions.eyebrow}
      title={
        <>
          {d.actions.titlePre}
          <span className="text-accent">{d.actions.titleAccent}</span>
          {d.actions.titlePost}
        </>
      }
      lead={d.actions.lead}
    >
      {/* AI 动作：卡片组，蓝色图标 */}
      <Reveal>
        <GroupHead label={d.actions.aiLabel} count={d.actions.aiCount} note={d.actions.aiNote} accent />
      </Reveal>
      <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {d.actions.aiItems.map((a, i) => {
          const Icon = AI_ICONS[i] ?? Languages;
          return (
            <Reveal key={a.name} delay={i * 0.06} y={18}>
              <div className="group h-full rounded-2xl border border-line bg-panel lift p-6 transition-colors duration-300 hover:border-accent-line hover:bg-card">
                <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-fill text-accent transition-transform duration-300 group-hover:-translate-y-0.5">
                  <Icon size={17} strokeWidth={1.9} />
                </div>
                <h3 className="mt-4 text-[16px] font-semibold tracking-tight">{a.name}</h3>
                <p className="mt-2 text-[13.5px] leading-relaxed text-mute">{a.desc}</p>
              </div>
            </Reveal>
          );
        })}
      </div>

      {/* AI 可定制横带：虚线 accent 边框示意「你的扩展空间」——内置 3 个之外，提示词、动作、模型服务都能换 */}
      <Reveal delay={0.08} y={18}>
        <div className="mt-4 rounded-2xl border border-dashed border-accent-line bg-accent-fill/40 px-7 py-5">
          <p className="text-xs font-medium tracking-[0.18em] text-accent uppercase">
            {d.actions.customBand.label}
          </p>
          <div className="mt-4 grid gap-x-10 gap-y-4 sm:grid-cols-3">
            {d.actions.customBand.items.map((c, i) => {
              const Icon = CUSTOM_ICONS[i] ?? Pencil;
              return (
                <div key={c.name} className="flex items-start gap-3">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-bg/60 text-accent">
                    <Icon size={15} strokeWidth={1.9} />
                  </div>
                  <div>
                    <h3 className="text-[14.5px] font-semibold tracking-tight">{c.name}</h3>
                    <p className="mt-1 text-[12.5px] leading-relaxed text-mute">{c.desc}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </Reveal>

      {/* 本地动作：整块面板里的清单（与上方卡片组形成两种形态），中性图标 */}
      <div className="mt-12">
        <Reveal>
          <GroupHead label={d.actions.localLabel} count={d.actions.localCount} note={d.actions.localNote} accent={false} />
        </Reveal>
        <Reveal delay={0.06} y={18}>
          <div className="mt-4 rounded-2xl border border-line bg-elev lift px-7 py-2">
            <div className="grid gap-x-12 sm:grid-cols-2">
              {d.actions.localItems.map((a, i) => {
                const Icon = LOCAL_ICONS[i] ?? Copy;
                return (
                  <div
                    key={a.name}
                    className={`flex gap-4 py-5 ${i === 0 ? "" : "border-t border-line"} ${
                      i === 1 ? "sm:border-t-0" : ""
                    }`}
                  >
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-fill text-ink/70">
                      <Icon size={15} strokeWidth={1.9} />
                    </div>
                    <div>
                      <h3 className="text-[15px] font-semibold tracking-tight">{a.name}</h3>
                      <p className="mt-1 text-[13px] leading-relaxed text-mute">{a.desc}</p>
                    </div>
                  </div>
                );
              })}
              {/* 第六格：开发中的能力占位（与 Position 区「开发中」同口径） */}
              <div className="flex gap-4 py-5">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-dashed border-line text-mute-faint">
                  <Plus size={15} strokeWidth={1.9} />
                </div>
                <div>
                  <h3 className="text-[15px] font-semibold tracking-tight text-mute">
                    {d.actions.moreItem.name}
                  </h3>
                  <p className="mt-1 text-[13px] leading-relaxed text-mute">{d.actions.moreItem.desc}</p>
                </div>
              </div>
            </div>
          </div>
        </Reveal>

        {/* 语境出口：翻译是专题页的主角，读完动作能力顺势导流 */}
        <Reveal delay={0.08}>
          <a
            href={`${root}translate/`}
            className="mt-8 inline-flex items-center gap-1.5 text-[13px] text-mute transition-colors hover:text-ink"
          >
            {d.actions.topicLink}
            <ArrowRight size={13} strokeWidth={2} />
          </a>
        </Reveal>
      </div>
    </Section>
  );
}
