// src/shared/aiVision.ts —— 识图视觉链路的提示词与输出解析（内置，随界面语言）。
// 识图 pending 带视觉分流标志时，模型直接看图（不先本地 OCR）。两条路径：
// 取字 = 单段提取原文（面板把它当「识别原文」展示、后续动作以其为源）；
// 动作 = 模型一次请求完成「提取原文 + 执行任务」两段，用 <<<SOURCE>>>/<<<RESULT>>>
// 标记分隔，前端拆开分别回填原文区与结果区（原文区可编辑重跑动作）。
// 与翻译/解释/总结的提示词不同：提取行为与产品强绑定，不进 actionPrompts
// 覆盖机制，无设置页条目。
import { getLocale } from "./i18n";

const VISION_OCR_PROMPTS = {
  zh: `你是文字提取器。把图片中的所有文字完整提取出来。
- 保持原有的行序、段落与列表结构，不合并、不拆分
- 表格输出为 Markdown 表格，列数与原图一致；分隔线的列数必须与表头相同，例如：
  | 姓名 | 年龄 |
  | --- | --- |
  | 张三 | 25 |
  单元格内容里如果有竖线，写成 \\|
- 人名、代码、网址、数字一律原样照抄，不补全、不改写
- 数学公式用 LaTeX 输出：行内公式包在 $…$ 里，独立成行的公式包在 $$…$$ 里
- 只输出提取到的内容，不解释、不翻译、不添加任何说明
图中没有可提取的文字时，只输出一行：未识别到文字`,
  en: `You are a text extractor. Transcribe ALL text in the image.
- Preserve the original line order, paragraphs and list structure; do not merge or split
- Render tables as Markdown tables with the same number of columns as the original; the separator row must have exactly as many columns as the header row, for example:
  | Name | Age |
  | --- | --- |
  | Amy | 25 |
  If a cell itself contains a pipe, write it as \\|
- Copy names, code, URLs and numbers verbatim; no completion, no rewriting
- Output math as LaTeX: inline formulas wrapped in $…$, display formulas in $$…$$ on their own lines
- Output only the extracted content; no explanation, no translation, no extra commentary
If the image contains no extractable text, output exactly one line: No text recognized`,
} as const;

/// 两段式输出的固定标记（全大写英文，模型遵循稳定且不易与图中内容冲突）
export const VISION_SRC_MARK = "<<<SOURCE>>>";
export const VISION_RES_MARK = "<<<RESULT>>>";

/** 「图中没有文字」时模型被要求输出的整句（与上面两条提取提示词逐字对应）。
 *  不论界面语言都认：用户的模型未必按提示词的语言作答 */
const NO_TEXT_LINES = ["未识别到文字", "No text recognized"];

/** 模型是否在报告「没有文字」。必须是全文恰好等于这一句——图里真有一行
 *  「未识别到文字」（比如别人截图里的提示语）时，提取结果前后会带其他行，
 *  不会整段相等，照常当识别原文展示。
 *  也用于认本机识别的失败原因串（Rust i18n 的 `ocr.noText`）：两边必须逐字
 *  相同，改这里要同步改 src-tauri/src/i18n.rs 的 ocr.noText。对不上时的后果
 *  只是回退失败后仍显示那句原因（即改动前的行为），不会更糟 */
export function visionSaysNoText(full: string): boolean {
  const s = full.trim();
  return NO_TEXT_LINES.some((line) => s === line);
}

/** 已收到的流式片段是否「只可能是这句报告的开头」。成立时先不渲染，否则
 *  这几个字会先当成识别原文闪现一下，再变成错误提示。句子很短，正常提取
 *  结果不会以它开头再接别的内容 */
export function visionMightSayNoText(full: string): boolean {
  const s = full.trimStart();
  return NO_TEXT_LINES.some((line) => line.startsWith(s));
}

// ---- Markdown 表格修正 ----
// 模型提取表格时分隔线列数偶尔与表头不一致（实测：四列表格输出了三列分隔
// 线）。GFM 规定两者必须相等，否则整段不被视为表格——复制出去、存 Obsidian
// 都拿不到表格。这里在识别完成后自动补齐，不依赖模型听话。

/** 把一行表格按单元格拆开。单元格内的 \| 是内容不算分隔符（占位后再拆） */
function tableCells(line: string): string[] {
  const ESC = "\u0000";
  const s = line
    .trim()
    .replace(/\\\|/g, ESC)
    .replace(/^\|/, "")
    .replace(/\|$/, "");
  return s
    .split("|")
    .map((c) => c.replaceAll(ESC, "|").trim());
}

/** GFM 分隔线行（如 | --- | :---: |） */
function isTableDelimRow(line: string): boolean {
  return /^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(\|[ \t]*:?-{3,}:?[ \t]*)*\|?[ \t]*$/.test(
    line,
  );
}

/** 修正文中的 Markdown 表格：分隔线列数与表头不一致时按表头列数重建
 *  （对齐标记尽量沿用原分隔线的写法）。其余文本原样返回 */
export function normalizeMarkdownTables(text: string): string {
  const lines = text.split("\n");
  for (let i = 1; i < lines.length; i++) {
    if (!isTableDelimRow(lines[i])) continue;
    const header = tableCells(lines[i - 1]);
    const delim = tableCells(lines[i]);
    if (header.length < 1 || delim.length === header.length) continue;
    const row = Array.from({ length: header.length }, (_, j) => {
      const src = delim[j] ?? delim[delim.length - 1] ?? "---";
      // 沿用该列原有的对齐写法；列缺失时退回默认 ---
      return src === "---" || src === ":---" || src === "---:" || src === ":---:"
        ? src
        : "---";
    });
    lines[i] = `| ${row.join(" | ")} |`;
  }
  return lines.join("\n");
}

/** 文本里是否含一个「列数齐整、可被解析」的 Markdown 表格（用于决定结果窗
 *  是否默认渲染表格预览）。配合 normalizeMarkdownTables 使用：先修正再判断 */
export function hasMarkdownTable(text: string): boolean {
  const lines = text.split("\n");
  for (let i = 1; i < lines.length; i++) {
    if (
      isTableDelimRow(lines[i]) &&
      tableCells(lines[i - 1]).length === tableCells(lines[i]).length
    ) {
      return true;
    }
  }
  return false;
}

/** 是否含行内/独立公式（$…$ 或 $$…$$）。开头结尾不得贴空白：把「价格 $5，
 *  另一件 $10」这类含美元符号的普通文字挡在外面（闭美元后紧跟数字本就被
 *  remark-math 排除，这里再挡一层，避免结果窗误入预览态） */
export function hasMathExpression(text: string): boolean {
  return /\$\$[^$\n]+\$\$|\$[^\s$](?:[^$\n]*[^\s$])?\$/.test(text);
}

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
    ? `The image is the task input. First transcribe ALL text in the image as-is (keep the original layout and line order; render tables as Markdown tables), then handle it as the task requires. Output the line ${VISION_SRC_MARK} first, followed by the transcribed text, then the line ${VISION_RES_MARK}, followed by the task result. Do not output anything else besides these two markers.`
    : `图片是任务的输入。请先原样提取图片中的全部文字（保持原有的排版与行序，表格输出为 Markdown 表格），然后按任务要求处理。先输出一行 ${VISION_SRC_MARK}，接着是提取的原文；再输出一行 ${VISION_RES_MARK}，接着是任务结果。除这两个标记外，不要输出任何多余说明。`;
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
