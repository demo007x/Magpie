// 选中文本上下文检测与提取：URL / 邮箱 / 验证码 / 电话号码。
// 提取支持"嵌入在句子中"的情形（取首个匹配）；URL 自动剥尾部标点（含括号平衡）。
//
// 识别原则（强一致性）：只识别符合各自规范的形态，不规范的宁可不识别——
// URL 以「带 scheme（http/https）」为规范形态；无协议裸域名（vue.js / a.id）与
// 代码属性访问结构上不可区分，一律不识别（产品决策 2026-09）。
// 带 scheme 的 URL 不做 TLD 白名单校验：scheme 是用户显式选中的强信号，
// 白名单只会误杀小众 ccTLD（.sh/.md 等域名服务，2026-09-18 实测误杀），
// 仅要求 host 含点（排除 https://localhost 类无意义主机）。

export type TextContext = "url" | "email" | null;

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const EMAIL_ALL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
// 显式协议：https?:// 后接非空白（排除常见引号/括号/全角标点）
const SCHEME_URL_RE = /https?:\/\/[^\s"'<>（）【】「」『』，。；：！？、]+/gi;
// 独立 4-8 位数字（验证码候选）
const CODE_RE = /(?<!\d)\d{4,8}(?!\d)/g;
const YEAR_RE = /^(?:19|20)\d{2}$/; // 年份不是验证码
/** 中国手机号 / 400 热线 / 座机（可选 +86/86 国际前缀，可选分机 -1234）。单值提取 */
const TEL_CN_RE =
  /(?<!\d)(?:\+?86)?(?:1[3-9]\d{9}|400-?\d{3}-?\d{4}|0\d{2,3}-?\d{7,8})(?:-\d{1,6})?(?!\d)/;
/** 同上（全局）：多值提取 */
const TEL_CN_ALL_RE =
  /(?<!\d)(?:\+?86)?(?:1[3-9]\d{9}|400-?\d{3}-?\d{4}|0\d{2,3}-?\d{7,8})(?:-\d{1,6})?(?!\d)/g;

const TRAIL_PUNCT_RE = /[.,;:!?、。，；：！？…"'’”]+$/;

/** host 是否可信：剥 scheme/路径/端口后必须含点（排除 localhost 类单段主机） */
function hasPlausibleHost(url: string): boolean {
  const host = url
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
    .split(/[/?#]/)[0]
    .split(":")[0];
  return host.includes(".");
}

/** 剥离 URL 尾部标点；右括号仅在括号不平衡时剥离（保留 Wikipedia 式链接的括号） */
function trimUrlTail(url: string): string {
  let out = url.replace(TRAIL_PUNCT_RE, "");
  while (
    out.endsWith(")") &&
    (out.match(/\(/g)?.length ?? 0) < (out.match(/\)/g)?.length ?? 0)
  ) {
    out = out.slice(0, -1).replace(TRAIL_PUNCT_RE, "");
  }
  return out;
}

/** 剪掉粘连进 host 段的页面文案：选区常把 URL 和周边文案连在一起
 *（如 Google 结果行「https://obsidian.md · 翻译此页」→「https://obsidian.md·翻译此页」，
 * 正则遇中文不停止），打开即空白页。host 段出现非 ASCII 一律从首个非 ASCII 截断——
 * 合法 IRI 的中文只出现在路径段（如 zh.wikipedia.org/wiki/维基百科），host 段
 * 纯 ASCII 时整体保留 */
function trimGluedText(url: string): string {
  const schemeEnd = url.indexOf("://");
  if (schemeEnd < 0) return url;
  const hostStart = schemeEnd + 3;
  const rest = url.slice(hostStart);
  const authLen = rest.search(/[/?#]/);
  const authority = authLen < 0 ? rest : rest.slice(0, authLen);
  const bad = authority.search(/[^\x00-\x7F]/);
  if (bad < 0) return url;
  return url.slice(0, hostStart + bad);
}

/** 提取首个 URL（规范形态：带 scheme 且 host 含点；可嵌在句中）；无 = null */
export function extractUrl(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  const m = t.match(SCHEME_URL_RE);
  if (!m) return null;
  const url = trimUrlTail(trimGluedText(m[0]));
  if (!url || !hasPlausibleHost(url)) return null;
  return url;
}

/** 提取全部 URL（host 含点；去重保序，上限 20） */
export function extractUrls(raw: string): string[] {
  const t = raw.trim();
  if (!t) return [];
  const out: string[] = [];
  for (const m of t.matchAll(SCHEME_URL_RE)) {
    const u = trimUrlTail(trimGluedText(m[0]));
    if (u && hasPlausibleHost(u)) out.push(u);
  }
  return cap(dedupe(out));
}

/** 提取首个邮箱；无 = null */
export function extractEmail(raw: string): string | null {
  return raw.trim().match(EMAIL_RE)?.[0] ?? null;
}

/** 提取全部邮箱（去重保序，上限 20） */
export function extractEmails(raw: string): string[] {
  if (!raw.trim()) return [];
  return cap(dedupe(raw.trim().match(EMAIL_ALL_RE) ?? []));
}

/** 提取验证码：首个非年份的 4-8 位独立数字（长文本不触发） */
export function extractCode(raw: string): string | null {
  const t = raw.trim();
  if (!t || t.length > 200) return null;
  const candidates = t.match(CODE_RE) ?? [];
  return candidates.find((c) => !YEAR_RE.test(c)) ?? null;
}

/** 提取全部验证码（排除年份，去重保序，上限 20） */
export function extractCodes(raw: string): string[] {
  const t = raw.trim();
  if (!t || t.length > 200) return [];
  return cap(dedupe((t.match(CODE_RE) ?? []).filter((c) => !YEAR_RE.test(c))));
}

/** 提取电话号码（手机/座机，含分机）；无 = null */
export function extractTel(raw: string): string | null {
  const t = raw.trim();
  if (!t || t.length > 200) return null;
  return t.match(TEL_CN_RE)?.[0] ?? null;
}

/** 提取全部电话号码（去重保序，上限 20） */
export function extractTels(raw: string): string[] {
  const t = raw.trim();
  if (!t || t.length > 200) return [];
  return cap(dedupe(t.match(TEL_CN_RE) ?? []));
}

// ---------- 统一提取入口（胶囊「提取信息」用） ----------

export interface Extracted {
  urls: string[];
  emails: string[];
  tels: string[];
  codes: string[];
}

function uniqByKey(arr: string[], key: (s: string) => string): string[] {
  const seen = new Set<string>();
  return arr.filter((s) => {
    const k = key(s);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** 归一化去重键：电话剥分隔符与 86 前缀；邮箱/URL 转小写并剥尾斜杠 */
function normKey(kind: "tel" | "email" | "url", s: string): string {
  if (kind === "tel") {
    const digits = s.replace(/\D/g, "");
    return digits.length > 11 && digits.startsWith("86") ? digits.slice(2) : digits;
  }
  return s.toLowerCase().replace(/\/$/, "");
}

/** 一次性提取全部实体（各组归一化去重、保序、上限 20）。
 * 验证码使用「保护区间」规则：URL/邮箱/电话已命中的文本区间内不再产出验证码候选
 *（如座机 0532-83661100 的区号段/本地段不再被拆成验证码）。 */
export function extractAll(raw: string): Extracted {
  let t = raw.trim();
  // 输入截断至 8KB：超长选区（整篇文章）提取无意义，同时封死
  // 邮箱正则尾部回溯的理论 O(n²) 最坏情况
  if (t.length > 8192) t = t.slice(0, 8192);
  if (!t) return { urls: [], emails: [], tels: [], codes: [] };

  const protectedRanges: Array<[number, number]> = [];

  const urls: string[] = [];
  for (const m of t.matchAll(SCHEME_URL_RE)) {
    const u = trimUrlTail(trimGluedText(m[0]));
    if (u && hasPlausibleHost(u)) {
      urls.push(u);
      protectedRanges.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
    }
  }

  const emails: string[] = [];
  for (const m of t.matchAll(EMAIL_ALL_RE)) {
    emails.push(m[0]);
    protectedRanges.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
  }

  const tels: string[] = [];
  for (const m of t.matchAll(TEL_CN_ALL_RE)) {
    tels.push(m[0]);
    protectedRanges.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
  }

  const codes: string[] = [];
  for (const m of t.matchAll(CODE_RE)) {
    const s = m.index ?? 0;
    const e = s + m[0].length;
    // 与电话/邮箱/URL 区间重叠 → 是其组成部分（区号/本地段等），不是验证码
    if (protectedRanges.some(([ps, pe]) => s < pe && e > ps)) continue;
    if (YEAR_RE.test(m[0])) continue;
    codes.push(m[0]);
  }

  return {
    urls: cap(uniqByKey(urls, (u) => normKey("url", u))),
    emails: cap(uniqByKey(emails, (e) => normKey("email", e))),
    tels: cap(uniqByKey(tels, (n) => normKey("tel", n))),
    codes: cap(dedupe(codes)),
  };
}

function cap(arr: string[]): string[] {
  return arr.slice(0, MAX_EXTRACT);
}

function dedupe(arr: string[]): string[] {
  return [...new Set(arr.filter((s) => s.trim()))];
}

const MAX_EXTRACT = 20; // 极端长文本防刷屏

/** 检测：url > email 优先（tel/code 动作走各自提取函数） */
export function detectTextContext(raw: string): TextContext {
  if (extractUrl(raw)) return "url";
  if (extractEmail(raw)) return "email";
  return null;
}

/** 剥离首尾成对/常见标点（复制、打开前的清洗） */
export function stripEdgePunctuation(s: string): string {
  return s
    .replace(/[\s。，、；：！？,,.;:!?)\]}>"'’”」』】…]+$/g, "")
    .replace(/^[\s([{"'‘“「『【<]+/g, "");
}
