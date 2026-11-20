// src/shared/aiVision.ts —— 识图视觉链路的提示词与输出解析（内置，随界面语言）。
// 识图 pending 带视觉分流标志时，模型直接看图（不先本地 OCR）。两条路径：
// 取字 = 单段提取原文（面板把它当「识别原文」展示、后续动作以其为源）；
// 动作 = 模型一次请求完成「提取原文 + 执行任务」两段，用 <<<SOURCE>>>/<<<RESULT>>>
// 标记分隔，前端拆开分别回填原文区与结果区（原文区可编辑重跑动作）。
// 与翻译/解释/总结的提示词不同：提取行为与产品强绑定，不进 actionPrompts
// 覆盖机制，无设置页条目。
import { getLocale } from "./i18n";

const VISION_OCR_PROMPTS = {
  zh: `你是文字提取器。把图片中的所有文字完整提取为纯文本。
- 保持原有的行序、段落与列表结构，不合并、不拆分
- 表格按行列顺序逐格提取，单元格之间用制表符分隔
- 人名、代码、网址、数字一律原样照抄，不补全、不改写
- 只输出提取到的文字，不解释、不翻译、不添加任何说明
图中没有可提取的文字时，只输出一行：未识别到文字`,
  en: `You are a text extractor. Transcribe ALL text in the image as plain text.
- Preserve the original line order, paragraphs and list structure; do not merge or split
- Transcribe tables row by row, cell by cell, separated by tabs
- Copy names, code, URLs and numbers verbatim; no completion, no rewriting
- Output only the extracted text; no explanation, no translation, no extra commentary
If the image contains no extractable text, output exactly one line: No text recognized`,
} as const;

/// 两段式输出的固定标记（全大写英文，模型遵循稳定且不易与图中内容冲突）
export const VISION_SRC_MARK = "<<<SOURCE>>>";
export const VISION_RES_MARK = "<<<RESULT>>>";

export function visionOcrPrompt(): string {
  return getLocale() === "en" ? VISION_OCR_PROMPTS.en : VISION_OCR_PROMPTS.zh;
}

/** 取字路径的用户消息：单段提取，不引入两段式标记协议（system 已约定输出
 *  口径，user 只需指明本次输入就是这张图，避免与 system 指令打架） */
export function visionOcrUserText(): string {
  return getLocale() === "en"
    ? "Extract all text in this image. Output the text only."
    : "提取这张图片中的全部文字，只输出文字本身。";
}

/** 视觉动作的用户消息指令：一次请求完成「提取原文 + 执行任务」，输出用
 *  固定标记分段（system 承载动作提示词，user 附图片与输出格式约定） */
export function visionUserText(): string {
  return getLocale() === "en"
    ? `The image is the task input. First transcribe ALL text in the image as-is (keep the original layout and line order), then handle it as the task requires. Output the line ${VISION_SRC_MARK} first, followed by the transcribed text, then the line ${VISION_RES_MARK}, followed by the task result. Do not output anything else besides these two markers.`
    : `图片是任务的输入。请先原样提取图片中的全部文字（保持原有的排版与行序），然后按任务要求处理。先输出一行 ${VISION_SRC_MARK}，接着是提取的原文；再输出一行 ${VISION_RES_MARK}，接着是任务结果。除这两个标记外，不要输出任何多余说明。`;
}

/** 拆分模型的两段式输出。流式中（结果标记未出现）已到内容视为原文，实时
 *  回填原文区；流结束仍无结果标记时视为模型直接给出结果（跳过格式的容错），
 *  全文进结果区、原文留空。SOURCE 标记缺失也能拆（模型可能直接开始原文） */
export function visionSplit(
  full: string,
  done = false,
): { source: string; result: string } {
  const rIdx = full.indexOf(VISION_RES_MARK);
  if (rIdx < 0) {
    if (done) return { source: "", result: full.trim() };
    return { source: stripMark(full), result: "" };
  }
  return {
    source: stripMark(full.slice(0, rIdx)),
    result: full.slice(rIdx + VISION_RES_MARK.length).replace(/^\s+/, ""),
  };
}

function stripMark(s: string): string {
  return s.split(VISION_SRC_MARK).join("").trim();
}
