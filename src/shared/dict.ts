// src/shared/dict.ts —— 离线词典结果的排版层（ADR-12）。
// Rust 只回结构化数据（src-tauri/src/dict/query.rs 的 DictEntry），词性显示名、
// 版面与提示文案都在 TS——与「Rust 管不变的、TS 管多变的」同一分工。
// 产出 markdown 送进既有结果窗（remarkGfm + remarkBreaks），于是钉图、朗读、复制、
// 存 Obsidian/Anki 这些既有能力自动可用，Windows 分离卡也不必长出第二条渲染路径。
import { t } from "./i18n";
import type { DictEntry } from "./types";

/** 词性显示名：pos 是词库原文（实测封闭取值 14 个），词典里没有的原样显示——
    上游将来新增词性不至于把信息吞掉 */
export function posLabel(pos: string): string {
  const key = `dict.pos.${pos}`;
  const label = t(key);
  return label === key ? pos : label;
}

/** 释义是人写的说明文，行首的 "-"/"1." 不该被 markdown 解释成列表 */
function literal(text: string): string {
  return text
    .replace(/^(\d+)([.)])(\s)/gm, "$1\\$2$3")
    .replace(/^([-+*>#])(\s)/gm, "\\$1$2");
}

export function formatDictEntry(e: DictEntry): string {
  const blocks: string[] = [];
  const ipa = e.ipa.map((p) => `/${p}/`).join(" · ");
  // 汉→英库给的是拼音，不是 IPA：用方括号，别让 `/…/` 把声调数字读成音标
  const reading = e.reading ? `[${e.reading}]` : "";
  const pron = [ipa, reading].filter(Boolean).join(" · ");
  blocks.push(pron ? `**${e.headword}**\n${pron}` : `**${e.headword}**`);
  for (const s of e.senses) {
    // CC-CEDICT 没有词性维度，pos 为空时不该回退成未翻译的键名
    const pos = s.pos ? posLabel(s.pos) : "";
    const lines = [`**${[pos, s.gloss].filter(Boolean).join(" ｜ ")}**`];
    if (s.explanation) lines.push(literal(s.explanation));
    if (s.usageNote) lines.push(`**${t("dict.usage")}** ｜ ${literal(s.usageNote)}`);
    const ex = s.examples.flatMap((x) => [x.text, x.translation]).filter(Boolean);
    if (ex.length) lines.push(ex.map((l) => `> ${literal(l)}`).join("\n"));
    blocks.push(lines.join("\n"));
  }
  if (e.memoryHook) blocks.push(`**${t("dict.memory")}** ｜ ${literal(e.memoryHook)}`);
  if (e.etymology) blocks.push(`**${t("dict.etymology")}** ｜ ${literal(e.etymology)}`);
  return blocks.join("\n\n");
}
