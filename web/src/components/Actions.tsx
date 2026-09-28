import { Copy, Globe, Languages, Lightbulb, ListChecks, Mail, ScanText } from "lucide-react";
import { ACTIONS } from "../data";
import { Reveal } from "./Reveal";
import { Section } from "./Section";

const ICONS = [Languages, Lightbulb, ListChecks, Copy, ScanText, Mail];

export function Actions() {
  return (
    <Section
      id="actions"
      eyebrow="Actions"
      title={
        <>
          内置 <span className="text-accent">9 个动作</span>，分为 AI 与本地两类
        </>
      }
      lead="翻译、解释、总结由所选模型服务完成；复制、搜索、打开链接、写邮件与提取信息在本机完成。浮动条默认显示 4 个动作，其余收入展开面板；可用动作随选中内容类型变化，选中网址时提供「打开链接」，选中邮箱时提供「写邮件」。"
    >
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {ACTIONS.map((a, i) => {
          const Icon = ICONS[i] ?? Globe;
          return (
            <Reveal key={a.name} delay={(i % 3) * 0.06} y={18}>
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

</Section>
  );
}
