// 日历流（加入日历场景动作）：识别在 Rust 侧（NSDataDetector，系统级/离线/确定性，
// entities.rs）；TS 只负责格式化展示与 .ics 时间串计算（JS 原生 Date 处理本地时区）。
// 两条日历路径：确定性日期命中（openInCalendar / detectAndOpenCalendar）与
// AI 语义事件（openEventInCalendar，structured → 直接写日历，不经重检测）
import { invoke } from "@tauri-apps/api/core";
import type { AiEventItem } from "../shared/aiExtract";
import { extractEmails, extractUrl } from "../shared/textContext";

/** Rust detect_dates 的日期命中（entities.rs DateHit，camelCase） */
export interface DateHit {
  unix: number;
  duration: number;
  start: number;
  len: number;
}

/** 命中的展示标签："10月1日 周四 15:00"；零点视为全天（不带时间） */
export function formatDateLabel(h: DateHit): string {
  const d = new Date(h.unix * 1000);
  const base = `${d.getMonth() + 1}月${d.getDate()}日 周${"日一二三四五六"[d.getDay()]}`;
  if (d.getHours() === 0 && d.getMinutes() === 0) return base;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${base} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 日历附加字段：页面来源链接（浏览器地址栏现查，优先）或选区首个链接 → URL 属性、
 * 选区原文 → 备注、选区邮箱 → 受邀人；两条日历路径（确定性命中 / AI 事件）共用 */
function calendarExtras(text: string, pageUrl?: string) {
  return {
    url: pageUrl ?? extractUrl(text) ?? undefined,
    notes: text.trim().slice(0, 1000) || undefined,
    attendees: extractEmails(text),
  };
}

/** 日期命中 → 本地 .ics 交给系统日历（预填事件，附链接/备注/受邀人）。标题取选中文本前 40 字 */
export function openInCalendar(hit: DateHit, text: string, onDone?: (ok: boolean) => void, pageUrl?: string): void {
  const d = new Date(hit.unix * 1000);
  const allDay = d.getHours() === 0 && d.getMinutes() === 0;
  const p = (n: number) => String(n).padStart(2, "0");
  const dt = (x: Date) =>
    `${x.getFullYear()}${p(x.getMonth() + 1)}${p(x.getDate())}T${p(x.getHours())}${p(x.getMinutes())}00`;
  const durMs = (hit.duration > 0 ? hit.duration : 3600) * 1000;
  const start = allDay ? `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` : dt(d);
  const endDate = new Date(d.getTime() + (allDay ? 86400000 : durMs));
  const end = allDay
    ? `${endDate.getFullYear()}${p(endDate.getMonth() + 1)}${p(endDate.getDate())}`
    : dt(endDate);
  invoke("open_in_calendar", { start, end, title: text.slice(0, 40), allDay, ...calendarExtras(text, pageUrl) })
    .then((ok) => onDone?.(ok === true))
    .catch(() => onDone?.(false));
}

/** 面板行点击：从文本重检测（µs 级）并按展示标签匹配命中，打开日历。
 *  OCR 窗口侧不保存命中列表——重新检测比跨窗口传状态简单 */
export function detectAndOpenCalendar(text: string, label: string, onDone?: (ok: boolean) => void, pageUrl?: string): void {
  invoke<DateHit[]>("detect_dates", { text })
    .then((hits) => {
      const hit = (hits ?? []).find((h) => formatDateLabel(h) === label);
      if (hit) openInCalendar(hit, text, onDone, pageUrl);
      else onDone?.(false);
    })
    .catch(() => onDone?.(false));
}

/** 单个时间点标签："10月31日 周六" / 带时间 "10月31日 周六 10:00" */
function eventTimeLabel(unix: number, allDay: boolean): string {
  const d = new Date(unix * 1000);
  const base = `${d.getMonth() + 1}月${d.getDate()}日 周${"日一二三四五六"[d.getDay()]}`;
  if (allDay) return base;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${base} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 事件行标签：有标题带标题；有结束时间拼区间（同日只拼时间，跨天拼日期） */
export function eventLabel(ev: AiEventItem): string {
  let range = eventTimeLabel(ev.startUnix, ev.allDay);
  if (ev.endUnix) {
    const s = new Date(ev.startUnix * 1000);
    const e = new Date(ev.endUnix * 1000);
    const sameDay = s.toDateString() === e.toDateString();
    if (!sameDay) {
      range += ` – ${eventTimeLabel(ev.endUnix, ev.allDay)}`;
    } else if (!ev.allDay) {
      const p = (n: number) => String(n).padStart(2, "0");
      range = `${range}–${p(e.getHours())}:${p(e.getMinutes())}`;
    }
  }
  return ev.title ? `${ev.title} · ${range}` : range;
}

/** AI 事件 → 本地 .ics 交给系统日历。全天事件的 end 为含头不含尾的次日（RFC 5545） */
export function openEventInCalendar(
  ev: AiEventItem,
  fallbackTitle: string,
  onDone?: (ok: boolean) => void,
  pageUrl?: string,
): void {
  const p = (n: number) => String(n).padStart(2, "0");
  const s = new Date(ev.startUnix * 1000);
  const dt = (x: Date) =>
    `${x.getFullYear()}${p(x.getMonth() + 1)}${p(x.getDate())}T${p(x.getHours())}${p(x.getMinutes())}00`;
  const day = (x: Date) => `${x.getFullYear()}${p(x.getMonth() + 1)}${p(x.getDate())}`;
  let start: string;
  let end: string;
  if (ev.allDay) {
    start = day(s);
    const e = ev.endUnix ? new Date(ev.endUnix * 1000) : s;
    end = day(new Date(e.getFullYear(), e.getMonth(), e.getDate() + 1));
  } else {
    start = dt(s);
    end = dt(ev.endUnix ? new Date(ev.endUnix * 1000) : new Date(s.getTime() + 3_600_000));
  }
  invoke("open_in_calendar", {
    start,
    end,
    title: (ev.title ?? fallbackTitle).slice(0, 40),
    allDay: ev.allDay,
    ...calendarExtras(fallbackTitle, pageUrl),
  })
    .then((ok) => onDone?.(ok === true))
    .catch(() => onDone?.(false));
}
