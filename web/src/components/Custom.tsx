import { GripVertical, Play, Trash2 } from "lucide-react";
import { ENGINE_ROWS } from "../data";
import { useSite } from "../i18n";
import { Reveal } from "./Reveal";
import { Section } from "./Section";

export function Custom() {
  const { d } = useSite();
  return (
    <Section
      id="custom"
      eyebrow={d.custom.eyebrow}
      title={
        <>
          {d.custom.titlePre}
          <span className="text-accent">{d.custom.titleAccent}</span>
          {d.custom.titlePost}
        </>
      }
      lead={d.custom.lead}
    >
      <GroupTag text={d.custom.group1.tag} note={d.custom.group1.note} />
      <div className="grid items-start gap-4 lg:grid-cols-[1.1fr_1fr]">
        <List items={d.custom.items} />
        <Reveal delay={0.1} y={20} className="min-w-0">
          <div className="mock-card overflow-hidden">
            <div className="flex items-center gap-2 border-b border-line px-5 py-3 text-[12px] text-mute">
              新建 AI 动作
              <span className="ml-auto text-mute-soft">自定义动作 3 / 10</span>
            </div>
            <div className="space-y-3 p-5">
              <Field label="名称（显示在浮动条上，建议不超过 6 字）" value="语气改写" />
              <Field
                label="提示词（发给模型的指令，所选文字随后附带）"
                value={
                  "把下面这段文字改写成更克制的书面语气：\n保留事实与数字，删去夸张副词，短句优先。只输出改写结果。"
                }
                area
              />
              <Field
                label="样例（作为所选文字发给模型，不保存）"
                value="这个方案真的超级无敌爆炸好用！！！"
                area
              />
              <div className="flex items-center gap-2 pt-1">
                <span className="flex items-center gap-1.5 rounded-lg bg-ink px-3 py-2 text-[12px] font-medium text-bg">
                  <Play size={12} strokeWidth={2.4} />
                  试跑
                </span>
                <span className="mock-pill rounded-lg px-3 py-2 text-[12px] text-ink/75">结果</span>
                <span className="mock-pill rounded-lg px-3 py-2 text-[12px] text-ink/75">
                  这个方案很好用。
                </span>
              </div>
            </div>
          </div>
        </Reveal>
      </div>

      <div className="mt-14">
        <GroupTag text={d.custom.group2.tag} note={d.custom.group2.note} />
        <div className="grid items-start gap-4 lg:grid-cols-[1fr_1.1fr]">
          <Reveal y={20} className="min-w-0">
            <div className="mock-card overflow-hidden">
              <div className="flex items-center gap-2 border-b border-line px-5 py-3 text-[12px] text-mute">
                搜索引擎
                <span className="ml-auto text-mute-soft">{"{q}"} 为选中文本占位符</span>
              </div>
              <ul>
                {ENGINE_ROWS.map((e) => (
                  <li
                    key={e.name}
                    className="flex items-center gap-3 border-b border-line/60 px-4 py-3 last:border-b-0"
                  >
                    <GripVertical size={14} strokeWidth={1.8} className="shrink-0 text-mute-faint" />
                    <span className="w-16 shrink-0 text-[13px] text-ink/90">{e.name}</span>
                    <span className="hidden min-w-0 flex-1 truncate font-mono text-[11.5px] text-mute-soft sm:block">
                      {e.url.split("{q}")[0]}
                      <span className="text-accent">{"{q}"}</span>
                      {e.url.split("{q}")[1]}
                    </span>
                    {e.def && (
                      <span className="shrink-0 rounded-full bg-accent-fill px-2 py-0.5 text-[10.5px] text-accent-ink">
                        默认
                      </span>
                    )}
                    {e.custom && <Trash2 size={13} strokeWidth={1.7} className="shrink-0 text-mute-faint" />}
                    <span
                      className={`h-[18px] w-[30px] shrink-0 rounded-full p-[3px] transition-colors ${
                        e.custom ? "bg-accent" : "bg-fill-2"
                      }`}
                    >
                      <span
                        className={`block h-3 w-3 rounded-full bg-white transition-transform ${
                          e.custom ? "translate-x-[12px]" : ""
                        }`}
                      />
                    </span>
                  </li>
                ))}
              </ul>
              <p className="border-t border-line px-5 py-3 text-[11.5px] text-mute-soft">
                内置引擎支持停用与排序，自定义引擎可增删；调整即时生效。
              </p>
            </div>
          </Reveal>
          <List items={d.custom.routes} delay={0.06} />
        </div>
      </div>
    </Section>
  );
}

function GroupTag({ text, note }: { text: string; note: string }) {
  return (
    <Reveal y={12}>
      <div className="mb-4 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="text-[13px] font-medium tracking-[0.14em] text-accent-2 uppercase">{text}</h3>
        <span className="text-[12px] text-mute-soft">{note}</span>
      </div>
    </Reveal>
  );
}

function List({
  items,
  delay = 0,
}: {
  items: { title: string; desc: string }[];
  delay?: number;
}) {
  return (
    <div className="min-w-0 space-y-3">
      {items.map((c, i) => (
        <Reveal key={c.title} delay={delay + i * 0.06} y={16}>
          <div className="rounded-2xl border border-line bg-panel lift p-5">
            <h4 className="text-[15px] font-semibold tracking-tight">{c.title}</h4>
            <p className="mt-1.5 text-[13.5px] leading-relaxed text-mute">{c.desc}</p>
          </div>
        </Reveal>
      ))}
    </div>
  );
}

function Field({ label, value, area }: { label: string; value: string; area?: boolean }) {
  return (
    <div>
      <span className="text-[11.5px] text-mute">{label}</span>
      <span
        className={`mt-1.5 block rounded-lg border border-line bg-fill px-3 py-2.5 text-[13px] leading-relaxed whitespace-pre-wrap text-ink/90 ${
          area ? "min-h-[68px]" : ""
        }`}
      >
        {value}
      </span>
    </div>
  );
}
