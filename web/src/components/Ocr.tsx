import { Command, Crop, MousePointerClick, Pin } from "lucide-react";
import { OCR_STEPS, SHORTCUTS } from "../data";
import { Reveal } from "./Reveal";
import { Section } from "./Section";

export function Ocr() {
  return (
    <Section
      id="ocr"
      eyebrow="Screen Capture"
      title={
        <>
          无法选中的文字，<span className="text-accent">框选即可识别</span>
        </>
      }
      lead="划词仅适用于可选中的文本。图片、视频字幕、扫描文档与应用界面中的文字，可通过框选在本机识别，识别结果使用同一组动作处理。"
    >
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {OCR_STEPS.map((s, i) => (
          <Reveal key={s.title} delay={i * 0.07} y={18}>
            <div className="h-full rounded-2xl border border-line bg-panel lift p-6">
              <div className="flex items-baseline gap-2.5">
                <span className="text-[13px] font-medium text-accent tabular-nums">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <h3 className="text-[15.5px] leading-snug font-semibold tracking-tight">{s.title}</h3>
              </div>
              <p className="mt-2.5 text-[13.5px] leading-relaxed text-mute">{s.desc}</p>
            </div>
          </Reveal>
        ))}
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-[1fr_1.15fr]">
        <Reveal y={18}>
          <div className="h-full rounded-2xl border border-line bg-elev lift p-6">
            <h3 className="text-[15px] font-semibold tracking-tight">四个识图快捷键</h3>
            <p className="mt-1.5 text-[13px] text-mute">
              按下快捷键进入框选，识别完成后自动执行对应动作。键位可在设置中修改。
            </p>
            <ul className="mt-5 space-y-2.5">
              {SHORTCUTS.map((k) => (
                <li key={k.keys} className="flex items-center justify-between gap-4">
                  <span className="text-[13.5px] text-ink/85">{k.label}</span>
                  <kbd className="rounded-md border border-line bg-fill px-2.5 py-1 font-sans text-[12px] tracking-wide text-ink/90">
                    {k.keys}
                  </kbd>
                </li>
              ))}
            </ul>
          </div>
        </Reveal>

        <Reveal delay={0.08} y={18}>
          <div className="h-full rounded-2xl border border-line bg-elev lift p-6">
            <h3 className="text-[15px] font-semibold tracking-tight">其他取词与显示规则</h3>
            <ul className="mt-5 space-y-4 text-[13.5px] leading-relaxed text-mute">
              <li className="flex gap-3">
                <MousePointerClick size={16} strokeWidth={1.9} className="mt-0.5 shrink-0 text-accent" />
                <span>
                  拖选与双击均可触发。界面由应用自绘、划词取不到文字时，改用识图取字。
                </span>
              </li>
              <li className="flex gap-3">
                <Crop size={16} strokeWidth={1.9} className="mt-0.5 shrink-0 text-accent" />
                <span>截图与识别在后台完成，框选期间划词自动暂停。</span>
              </li>
              <li className="flex gap-3">
                <Pin size={16} strokeWidth={1.9} className="mt-0.5 shrink-0 text-accent" />
                <span>截图可固定在屏幕上，支持再次识别，复制、搜索与 AI 动作同样可用。</span>
              </li>
              <li className="flex gap-3">
                <Command size={16} strokeWidth={1.9} className="mt-0.5 shrink-0 text-accent" />
                <span>指定应用可加入禁用列表；重复选择同一段文字不会重复弹出。</span>
              </li>
            </ul>
          </div>
        </Reveal>
      </div>
    </Section>
  );
}
