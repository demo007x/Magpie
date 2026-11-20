// 选中文本上下文检测与提取：URL / 邮箱 / 验证码 / 电话号码。
// 提取支持"嵌入在句子中"的情形（取首个匹配）；URL 自动剥尾部标点（含括号平衡）。
//
// 识别原则（强一致性）：只识别符合各自规范的形态，不规范的宁可不识别——
// URL 以「带 scheme（http/https）」为规范形态；无协议裸域名（vue.js / a.id）与
// 代码属性访问结构上不可区分，一律不识别（产品决策 2026-09）。
// 带 scheme 的 URL 不做 TLD 白名单校验：scheme 是用户显式选中的强信号，
// 白名单只会误杀小众 ccTLD（.sh/.md 等域名服务，2026-09-18 实测误杀），
// 仅要求 host 含点，localhost / [::1] 等无点主机单列放行（开发服务器地址
// 是高频选区，一刀切拒掉后端口数字反倒落进验证码候选，2026-10-08）。

export type TextContext = "url" | "email" | null;

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const EMAIL_ALL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
// 显式协议：https?:// 后接非空白（排除常见引号/括号/全角标点）
const SCHEME_URL_RE = /https?:\/\/[^\s"'<>（）【】「」『』，。；：！？、]+/gi;
// 独立 4-8 位数字（验证码候选）
const CODE_RE = /(?<!\d)\d{4,8}(?!\d)/g;
const YEAR_RE = /^(?:19|20)\d{2}$/; // 年份不是验证码

// ---- 验证码语境三分规则（2026-10-24 用户定稿）----
// 真实验证码几乎总伴随语境标记（「验证码/校验码/code/OTP」）；脱离语境的数字
// 是 pid/端口/金额/编号。识别三分：① 选区就是数字本身（精准选中，意图明确）；
// ② 选区极短（≤16 字符，如「【美团】582914」，无标记也是刻意选择）；
// ③ 更长文本必须有语境关键词，且数字距关键词 ≤32 字符。
const CODE_KEYWORD_RE =
  /验证码|校验码|驗證碼|动态码|动态密码|口令|(?<![a-z])code(?![a-z])|(?<![a-z])otp(?![a-z])|passcode|one[\s-]?time/gi;
const CODE_STANDALONE_RE = /^\d{4,8}$/;
const CODE_SHORT_MAX = 16;
const CODE_PROXIMITY = 32;

function codeKeywordPositions(t: string): number[] {
  return [...t.matchAll(CODE_KEYWORD_RE)].map((m) => m.index ?? 0);
}

/** 句子跨度（。！？!?\n 分隔）：关键词与数字须同句——「验证码 1111 已发送。工单号
 *  77054」里 77054 距关键词仅 15 字符，仅靠距离过滤会误收 */
function codeSentenceSpans(t: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  let start = 0;
  for (let i = 0; i < t.length; i++) {
    if (/[。！？!?\n]/.test(t[i])) {
      spans.push([start, i]);
      start = i + 1;
    }
  }
  spans.push([start, t.length]);
  return spans;
}

function codeAccepted(t: string, pos: number, kws: number[], spans: Array<[number, number]>): boolean {
  if (t.length <= CODE_SHORT_MAX || CODE_STANDALONE_RE.test(t)) return true; // ①②
  return kws.some(
    (q) =>
      Math.abs(pos - q) <= CODE_PROXIMITY && // ③ 语境邻近
      spans.some(([a, b]) => q >= a && q < b && pos >= a && pos < b), // 且同句
  );
}
/** 中国手机号 / 400 热线 / 座机（可选 +86/86 国际前缀，可选分机 -1234）。单值提取 */
const TEL_CN_RE =
  /(?<!\d)(?:\+?86)?(?:1[3-9]\d{9}|400-?\d{3}-?\d{4}|0\d{2,3}-?\d{7,8})(?:-\d{1,6})?(?!\d)/;
/** 同上（全局）：多值提取 */
const TEL_CN_ALL_RE =
  /(?<!\d)(?:\+?86)?(?:1[3-9]\d{9}|400-?\d{3}-?\d{4}|0\d{2,3}-?\d{7,8})(?:-\d{1,6})?(?!\d)/g;

// 日期/时间/编号类数字片段：其覆盖区间内的数字不产出验证码候选
// （"10月31日 10:00-19:00 北京#001" 的编号与日期时间碎片曾漏进验证码，2026-10-23）
const NUMERIC_CONTEXT_RES: RegExp[] = [
  /#\d+/g, // #001 编号
  /\d{1,2}\s*[:：]\s*\d{2}(?:\s*[:：]\s*\d{2})?/g, // 10:00 / 19:00:30
  /\d{4}\s*[年.\-/]\s*\d{1,2}(?:\s*[月.\-/]\s*\d{1,2}\s*日?)?/g, // 2026.10.12 / 2026年10月
  /\d{1,2}\s*月\s*\d{1,2}\s*[日号]?/g, // 10月31日
];
/** 日期对（10.31 / 12-25）：两段均在 1-31 才视作日期片段——
 *  不做语义校验会把「折扣 88.5」「版本 2.0」也当成日期区间保护掉 */
const DATE_PAIR_RE = /\d{1,2}\s*[.\-/]\s*\d{1,2}/g;

const TRAIL_PUNCT_RE = /[.,;:!?、。，；：！？…"'’”]+$/;

/** host 是否可信：剥 scheme/路径/端口后须含点，或为 localhost / IPv6 字面量。
 * 含点规则排除任意单段主机；localhost 与 [::1] 是开发服务器的常态地址，
 * 且拒掉它们时 URL 内的端口数字会被验证码规则捡走（extractAll 的保护区间
 * 只登记被采纳的 URL）。127.0.0.1 等点分 IPv4 天然含点，无需特判 */
function hasPlausibleHost(url: string): boolean {
  const host = url
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
    .split(/[/?#]/)[0]
    .split(":")[0];
  return host.includes(".") || host.toLowerCase() === "localhost" || host.startsWith("[");
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

/** 提取验证码：首个非年份的 4-8 位独立数字，按语境三分规则过滤（见 codeAccepted） */
export function extractCode(raw: string): string | null {
  const t = raw.trim();
  if (!t || t.length > 200) return null;
  const kws = codeKeywordPositions(t);
  const spans = codeSentenceSpans(t);
  const shortCtx = t.length <= CODE_SHORT_MAX || CODE_STANDALONE_RE.test(t);
  if (!shortCtx && kws.length === 0) return null; // 长文本且无语境：整段放弃
  for (const m of t.matchAll(CODE_RE)) {
    if (YEAR_RE.test(m[0])) continue;
    if (codeAccepted(t, m.index ?? 0, kws, spans)) return m[0];
  }
  return null;
}

/** 提取全部验证码（排除年份，去重保序，上限 20；语境三分规则同 extractCode） */
export function extractCodes(raw: string): string[] {
  const t = raw.trim();
  if (!t || t.length > 200) return [];
  const kws = codeKeywordPositions(t);
  const spans = codeSentenceSpans(t);
  const shortCtx = t.length <= CODE_SHORT_MAX || CODE_STANDALONE_RE.test(t);
  if (!shortCtx && kws.length === 0) return [];
  return cap(
    dedupe(
      [...t.matchAll(CODE_RE)]
        .filter((m) => !YEAR_RE.test(m[0]) && codeAccepted(t, m.index ?? 0, kws, spans))
        .map((m) => m[0]),
    ),
  );
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

// ---------- 本机路径（Windows 形态，0.1.24） ----------

/** 盘符绝对路径的整体形态：`E:\a\b`、`E:/a/b`、`E:\`。锚定整段匹配，因此裸盘符
 *  （`E:`）与相对路径都不在这一支。NTFS 非法字符与控制字符出现即说明这坨文本不是
 *  路径（带通配的搜索串、日志片段），不给动作。空格合法（`C:\Program Files`），而
 *  路径可以长到占满整块屏幕——「结尾在哪里」无法从语法判断，这就是只认整段选区的原因 */
const DRIVE_PATH_RE = /^[A-Za-z]:[\\/][^<>"|?*\p{Cc}]*$/u;
/** WSL 发行版路径：`\\wsl.localhost\Ubuntu\home\me\a`，旧别名 `\\wsl$\` 同样收下。
 *  它写起来是 UNC，但不是共享盘：这条命名空间由 Windows 自己提供，Explorer 原生能开，
 *  不需要凭据、也不经过网络会话（用户 2026-11-19 明确要求支持这一条）。
 *  大小写不敏感：主机段是本机命名空间标识，日志里常按习惯写成 `\\WSL.LOCALHOST\`，
 *  Rust 侧（paths.rs::wsl_form）同样 to_ascii_lowercase，两边判据必须一致 */
const WSL_PATH_RE = /^\\\\wsl(?:\.localhost|\$)(?:\\[^<>"|?*\p{Cc}]*)?$/iu;
const MAX_PATH_LEN = 1024; // 正常路径远不到；超长串是误选（整段日志、base64）

/** `file:///E:/a`、`file://localhost/E:/a` → `E:\a`（资源管理器地址栏与浏览器里
 *  复制出来的链接就是这种写法）。盘符要靠正则从 scheme 之后取，不能用
 *  search(/[A-Za-z]:/)：`file:` 自己就是「字母+冒号」，会把 `e:` 当成盘符（探针实测）。
 *  地址栏做过百分号编码，还原一次（%20 → 空格）；残缺序列原样保留，不猜 */
const FILE_URL_RE = /^file:\/\/(?:localhost)?\/{0,2}([A-Za-z]:[\\/][^?#]*)/i;

function fileUrlToPath(raw: string): string | null {
  const m = FILE_URL_RE.exec(raw);
  if (!m) return null;
  return m[1].replace(/%[0-9A-Fa-f]{2}/g, (esc) => {
    try {
      return decodeURIComponent(esc);
    } catch {
      return esc;
    }
  });
}

/** 提取本机路径：只在**整段选区就是一个路径**时命中（产品决策 2026-11-19）。
 *  句子里夹着的路径不认——路径含空格，「结尾在哪里」无法从语法判断，猜结尾就会把
 *  「见 E:\Project\Magpie 目录里的说明」后面的中文一起带上，打开的是不存在的位置。
 *
 *  只看语法、不问文件系统：这条判据跑在每次划词的热路径上，一次 stat 会让网络盘、
 *  映射盘、已拔掉的 U 盘变成几百毫秒的卡顿（WSL 未启动的发行版也一样，第一次访问要
 *  等它开机）。真不存在是常态（选区里的路径常来自日志或聊天记录），交给执行侧回一行
 *  「这个位置不存在」，语气是陈述不是报错。用户点了才去问，那时等一等是应得的。
 *
 *  本版收下的形态：盘符路径、`file:///E:/` 地址栏写法、WSL 发行版路径。
 *  不做、接口预留的形态：共享盘 `\\server\share`（判在不在要发起 SMB 会话，服务器
 *  掉线时以十秒计，且可能弹凭据窗）、POSIX 写法 `/home/me/a`（那是 Linux 的路径，
 *  在原生 Linux 上做才对，塞进 WSL 里做只会得到一个既不像 Windows 也不像 Linux 的东西）。
 *  将来放开时只动这一处判据 + paths.rs 的执行分支，动作与面板不用改。 */
export function extractPath(raw: string): string | null {
  const t = raw.trim();
  if (!t || t.length > MAX_PATH_LEN) return null;
  const fromUrl = /^file:\/\//i.test(t) ? fileUrlToPath(t) : null;
  if (!fromUrl && /^file:\/\//i.test(t)) return null; // file:// 开头却还原不出盘符：不是本机位置
  // 正斜杠统一成反斜杠再判：`E:/a` 与 `//wsl.localhost/Ubuntu/a` 都是合法写法，但面板
  // 要显示的、复制走的是同一个形态，资源管理器地址栏也只认反斜杠
  const body = (fromUrl ?? t).replace(/\//g, "\\");
  return DRIVE_PATH_RE.test(body) || WSL_PATH_RE.test(body) ? body : null;
}

// ---------- 统一提取入口（胶囊「提取信息」用） ----------

export interface Extracted {
  urls: string[];
  emails: string[];
  tels: string[];
  codes: string[];
  /** 本机路径（Windows 形态）：整段选区就是一个路径时才有这一条，其余组同时清空——
   *  路径里的数字段（`D:\2026\1031`）不是验证码也不是电话，反斜杠也不是分隔符 */
  paths: string[];
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
 * 验证码使用「保护区间」规则：URL/邮箱/电话及日期时间/编号片段已覆盖的
 * 文本区间内不再产出验证码候选（如座机区号段、"10.31" 的碎片不再被拆成验证码）。 */
export function extractAll(raw: string): Extracted {
  let t = raw.trim();
  // 输入截断至 8KB：超长选区（整篇文章）提取无意义，同时封死
  // 邮箱正则尾部回溯的理论 O(n²) 最坏情况
  if (t.length > 8192) t = t.slice(0, 8192);
  if (!t) return { urls: [], emails: [], tels: [], codes: [], paths: [] };

  // 整段就是一个本机路径 → 这一组独占，其余组清空（不走保护区间：那套只挡验证码，
  // 而路径里的数字段既会被当成电话，也会被当成编号——位置本身就是答案，不该再拆）
  const wholePath = extractPath(t);
  if (wholePath) return { urls: [], emails: [], tels: [], codes: [], paths: [wholePath] };

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

  // 日期/时间/编号片段同样入保护区间：其内部数字是语义碎片，不是验证码
  for (const re of NUMERIC_CONTEXT_RES) {
    for (const m of t.matchAll(re)) {
      protectedRanges.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
    }
  }
  for (const m of t.matchAll(DATE_PAIR_RE)) {
    const [a, b] = m[0].split(/[.\-/]/).map((s) => parseInt(s, 10));
    if (a >= 1 && a <= 31 && b >= 1 && b <= 31) {
      protectedRanges.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
    }
  }

  const codes: string[] = [];
  // 语境三分规则同 extractCode：长文本中脱离关键词的数字（pid/端口/金额）不是验证码
  const codeKws = codeKeywordPositions(t);
  const codeSpans = codeSentenceSpans(t);
  for (const m of t.matchAll(CODE_RE)) {
    const s = m.index ?? 0;
    const e = s + m[0].length;
    // 与电话/邮箱/URL 区间重叠 → 是其组成部分（区号/本地段等），不是验证码
    if (protectedRanges.some(([ps, pe]) => s < pe && e > ps)) continue;
    if (YEAR_RE.test(m[0])) continue;
    if (!codeAccepted(t, s, codeKws, codeSpans)) continue;
    codes.push(m[0]);
  }

  return {
    urls: cap(uniqByKey(urls, (u) => normKey("url", u))),
    emails: cap(uniqByKey(emails, (e) => normKey("email", e))),
    tels: cap(uniqByKey(tels, (n) => normKey("tel", n))),
    codes: cap(dedupe(codes)),
    paths: [],
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
