import { KeyRound, ShieldCheck, Eye, BadgeDollarSign } from "lucide-react";
import { TRUST } from "../data";
import { Reveal } from "./Reveal";
import { Section } from "./Section";

const ICONS = [KeyRound, ShieldCheck, Eye, BadgeDollarSign];

export function Trust() {
  return (
    <Section
      id="trust"
      eyebrow="Privacy & Price"
      title={
        <>
          权限、<span className="text-accent">数据去向与费用</span>
        </>
      }
      lead="以下说明拾趣读取的内容、使用的系统权限、数据的存储与发送范围，以及免费与需要自备服务的边界。"
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {TRUST.map((t, i) => {
          const Icon = ICONS[i];
          return (
            <Reveal key={t.title} delay={(i % 2) * 0.07} y={18}>
              <div className="h-full rounded-2xl border border-line bg-panel lift p-6">
                <div className="flex items-center gap-2.5">
                  <Icon size={17} strokeWidth={1.9} className="text-accent-2" />
                  <h3 className="text-[16px] font-semibold tracking-tight">{t.title}</h3>
                </div>
                <p className="mt-2.5 text-[13.5px] leading-relaxed text-mute">{t.desc}</p>
              </div>
            </Reveal>
          );
        })}
      </div>

      <Reveal delay={0.1}>
        <p className="mt-6 text-[13px] leading-relaxed text-mute-soft">
          系统权限共三项：辅助功能与输入监控用于取词，屏幕录制用于识图框选。权限用途与授权状态在设置页「权限」中逐项列出。
        </p>
      </Reveal>
    </Section>
  );
}
