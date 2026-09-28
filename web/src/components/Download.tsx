import { AlertTriangle, Download as DownloadIcon, ExternalLink } from "lucide-react";
import { RELEASES, REPO } from "../data";
import { Reveal } from "./Reveal";
import { Section } from "./Section";

const STEPS = [
  { t: "下载", d: "在 GitHub Releases 获取 macOS 通用版（.dmg）。" },
  { t: "首次打开", d: "当前版本未完成 Apple 签名与公证：将应用移入「应用程序」后，右键选择「打开」并确认一次。" },
  { t: "授予权限", d: "在设置页「权限」按提示开启辅助功能与输入监控；识图需另开「屏幕录制」。" },
];

export function Download() {
  return (
    <Section
      id="download"
      eyebrow="Download"
      title={
        <>
          下载与<span className="text-accent">安装</span>
        </>
      }
      lead="永久免费，无需账号。翻译、解释、总结需接入自己的模型服务后使用。"
    >
      <div className="grid items-start gap-4 lg:grid-cols-[1fr_1.25fr]">
        <Reveal y={18}>
          <div className="rounded-2xl border border-line bg-panel lift p-7">
            <p className="text-[12px] tracking-wide text-mute-soft uppercase">macOS</p>
            <p className="mt-1.5 text-[22px] font-semibold tracking-tight">拾趣 for macOS</p>
            <p className="mt-1 text-[13px] text-mute">通用 .dmg · Apple Silicon 与 Intel 均可运行</p>

            <a
              href={RELEASES}
              target="_blank"
              rel="noreferrer"
              className="mt-6 flex w-full items-center justify-center gap-2 rounded-xl bg-ink px-5 py-3.5 text-[15px] font-medium text-bg transition-opacity hover:opacity-85"
            >
              <DownloadIcon size={16} strokeWidth={2.2} />
              从 GitHub Releases 下载
            </a>
            <a
              href={REPO}
              target="_blank"
              rel="noreferrer"
              className="mt-2.5 flex items-center justify-center gap-1.5 text-[13px] text-mute transition-colors hover:text-ink"
            >
              项目主页与更新记录
              <ExternalLink size={13} strokeWidth={1.9} />
            </a>

            <p className="mt-4 text-[12px] text-mute-soft">版本号与更新说明见 GitHub Releases。</p>
            <div className="mt-5 flex items-center gap-2 rounded-xl border border-accent-2-line bg-accent-2-fill px-4 py-3 text-[12.5px] leading-relaxed text-accent-2-ink">
              <AlertTriangle size={15} strokeWidth={1.9} className="shrink-0 text-accent-2" />
              <span>Windows 版本暂无可下载安装包。</span>
            </div>
          </div>
        </Reveal>

        <Reveal delay={0.08} y={18}>
          <div className="h-full rounded-2xl border border-line bg-elev lift p-7">
            <h3 className="text-[15px] font-semibold tracking-tight">安装步骤</h3>
            <ol className="mt-5 space-y-5">
              {STEPS.map((s, i) => (
                <li key={s.t} className="flex items-baseline gap-2.5">
                  <span className="text-[13px] font-medium text-accent tabular-nums">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <div>
                    <p className="text-[15.5px] leading-snug font-semibold tracking-tight">{s.t}</p>
                    <p className="mt-1 text-[13.5px] leading-relaxed text-mute">{s.d}</p>
                  </div>
                </li>
              ))}
            </ol>
            <p className="mt-6 border-t border-line pt-5 text-[12.5px] leading-relaxed text-mute-soft">
              更新或重装后需重新确认辅助功能权限，确认后长期有效。
            </p>
          </div>
        </Reveal>
      </div>
    </Section>
  );
}
