// AI 语义提取（「提取信息」面板的优先路径）：模型把选中文本里的日历事件、
// 地点、链接等按固定 JSON 结构返回，面板按类型渲染、点击即执行。
//
// 与确定性提取的分工（语义归 AI，精确归规则）：
// - AI 负责理解上下文——日期区间合并、裸时间挂靠就近日期、阶段名作事件标题、
//   纯日期不编造时间（NSDataDetector 会把纯日期补成 12:00、把裸时间解析成今天/明天）
// - 链接/邮箱/电话/验证码这类精确形态由正则兜底：AI 返回值必须过同一套校验才被采纳，
//   AI 空组/失败/未配置时整组回落 textContext 正则 + 系统识别（NSDataDetector/NLTagger）
import { effectivePrompt } from "./actions";
import { extractEmail, extractTel, extractUrl } from "./textContext";

/** 一个日历事件：startUnix/endUnix 为本地 unix 秒；allDay = 原文未给具体时间（纯日期） */
export interface AiEventItem {
  title?: string;
  startUnix: number;
  endUnix?: number;
  allDay: boolean;
}

export interface AiExtractResult {
  events: AiEventItem[];
  places: string[];
  urls: string[];
  emails: string[];
  tels: string[];
  codes: string[];
}

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;
const CODE_SHAPE_RE = /^\d{4,8}$/;
const YEAR_SHAPE_RE = /^(?:19|20)\d{2}$/;
const MAX_ITEMS = 20; // 与 textContext 提取上限一致

/** "YYYY-MM-DD" 按本地零点、"YYYY-MM-DDTHH:mm" 按本地时间解析为 unix 秒；非法 → undefined */
function parseLocalUnix(s: unknown): { unix: number; allDay: boolean } | undefined {
  if (typeof s !== "string") return undefined;
  const v = s.trim();
  const allDay = DATE_ONLY_RE.test(v);
  if (!allDay && !DATE_TIME_RE.test(v)) return undefined;
  const ms = new Date(allDay ? `${v}T00:00` : v).getTime();
  return Number.isFinite(ms) ? { unix: Math.floor(ms / 1000), allDay } : undefined;
}

/** 字符串数组清洗：非字符串丢弃、去空白、去重保序、截上限；validator 过不了的丢弃 */
function cleanStrings(arr: unknown, validate?: (v: string) => boolean): string[] {
  if (!Array.isArray(arr)) return [];
  const out: string[] = [];
  for (const item of arr) {
    if (typeof item !== "string") continue;
    const v = item.trim();
    if (!v || out.includes(v)) continue;
    if (validate && !validate(v)) continue;
    out.push(v);
    if (out.length >= MAX_ITEMS) break;
  }
  return out;
}

/** 构建提取用 system 提示词：DEFAULT_PROMPTS.extract 或用户自定义（提示词页），
 * 替换 {date} 占位符为当天日期（含星期）——模型不知道「今天」，相对时间换算需要基准。
 * 自定义模板丢了 {date} 也不补救：所见即所发，效果差是改坏者自己的责任 */
export function buildExtractPrompt(
  actionPrompts?: Record<string, string>,
  now: Date = new Date(),
): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const today = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
  const weekday = "日一二三四五六"[now.getDay()];
  return effectivePrompt("extract", actionPrompts).replace("{date}", `${today} 星期${weekday}`);
}

/** 解析模型输出：容错 markdown 代码围栏与前后废话；整体非法 → null（调用方走确定性兜底）。
 * 链接/邮箱/电话用 textContext 同款提取器校验（AI 照抄原文才收，改写/补全的不收）。
 * srcText 用于「整段倾倒」守卫：title 长度 ≈ 原文全长说明模型没理解、把选区整个抄进了
 * 标题（实测翻车：行内容变成原文复读，时间区间反被遮罩夹掉），丢弃 title 只留时间 */
export function parseAiExtract(raw: string, srcText?: string): AiExtractResult | null {
  const s = raw.indexOf("{");
  const e = raw.lastIndexOf("}");
  if (s < 0 || e <= s) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(raw.slice(s, e + 1));
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null) return null;
  const o = obj as Record<string, unknown>;

  const events: AiEventItem[] = [];
  if (Array.isArray(o.events)) {
    for (const item of o.events) {
      if (typeof item !== "object" || item === null) continue;
      const ev = item as Record<string, unknown>;
      const start = parseLocalUnix(ev.start);
      if (!start) continue;
      const end = parseLocalUnix(ev.end);
      let title = typeof ev.title === "string" && ev.title.trim() ? ev.title.trim() : undefined;
      const srcLen = srcText?.trim().length ?? 0;
      if (title && srcLen > 0 && title.length >= srcLen * 0.8) title = undefined;
      const out: AiEventItem = {
        startUnix: start.unix,
        allDay: start.allDay,
        title,
      };
      // end 与 start 形态不一致（一个全天一个带时间）或早于开始时间时不采纳
      if (end && end.allDay === start.allDay && end.unix > start.unix) out.endUnix = end.unix;
      events.push(out);
      if (events.length >= MAX_ITEMS) break;
    }
  }

  const inSrc = (v: string): boolean => !srcText || srcText.includes(v);

  return {
    events,
    places: cleanStrings(o.places),
    // 精确形态四组双重校验：①过正则（照抄不收改写）②必须出现在选区原文里——
    // 防模型把「来源页面：…」上下文行当成选区链接抄进 urls（2026-10-24 实证翻车）
    urls: cleanStrings(o.urls, (v) => inSrc(v) && extractUrl(v) === v),
    emails: cleanStrings(o.emails, (v) => inSrc(v) && extractEmail(v) === v),
    tels: cleanStrings(o.tels, (v) => inSrc(v) && extractTel(v) === v),
    codes: cleanStrings(o.codes, (v) => inSrc(v) && CODE_SHAPE_RE.test(v) && !YEAR_SHAPE_RE.test(v)),
  };
}
