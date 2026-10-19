import type { Recurrence } from "../src/recurring-types.js";

const validTime = (value: unknown): value is string => typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
const minuteOfDay = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
const clockTime = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
export const MAX_DAILY_NODES = 96;

// Input must first pass validateRecurrence. Windows are daily wall-clock ranges,
// including their start and excluding their end; midnight does not reset phase.
export function dailyNodes(s: Recurrence): string[] {
  if (s.kind === "daily_times") return [...s.times].sort();
  if (s.kind !== "daily_windows") return [];
  const nodes: number[] = [];
  for (const w of s.windows) {
    const start = minuteOfDay(w.start), length = (minuteOfDay(w.end) - start + 1440) % 1440;
    for (let offset = 0; offset < length; offset += w.intervalMinutes) nodes.push((start + offset) % 1440);
  }
  return nodes.sort((a, b) => a - b).map(clockTime);
}

export function validateRecurrence(raw: unknown): Recurrence {
  if (!raw || typeof raw !== "object") throw new Error("请选择重复时间。");
  const s = raw as Recurrence;
  if (!["interval", "daily", "weekly", "monthly", "daily_times", "daily_windows", "once"].includes(s.kind)) throw new Error("重复方式无效。");
  if (typeof s.timeZone !== "string" || s.timeZone.length > 100) throw new Error("时区无效。");
  try { new Intl.DateTimeFormat("en", { timeZone: s.timeZone }).format(); } catch { throw new Error("时区无效。"); }
  if (s.kind === "once") {
    if (typeof s.at !== "string" || !/^\d{4}-/.test(s.at) || !Number.isFinite(Date.parse(s.at))) throw new Error("一次性执行时间无效。");
    return { kind: "once", at: new Date(s.at).toISOString(), timeZone: s.timeZone };
  }
  if (s.kind === "daily_times") {
    if (!Array.isArray(s.times) || s.times.length < 1 || s.times.length > MAX_DAILY_NODES) throw new Error(`每天须设置 1 至 ${MAX_DAILY_NODES} 个执行节点。`);
    if (s.times.some(time => !validTime(time))) throw new Error("节点须使用 HH:mm 格式，例如 09:00。");
    if (new Set(s.times).size !== s.times.length) throw new Error("执行节点不能重复。");
    return { kind: s.kind, timeZone: s.timeZone, times: [...s.times].sort() };
  }
  if (s.kind === "daily_windows") {
    if (!Array.isArray(s.windows) || s.windows.length < 1 || s.windows.length > 8) throw new Error("每天须设置 1 至 8 个时段。");
    const occupied = new Set<number>();
    const windows = s.windows.map((w, index) => {
      if (!w || !validTime(w.start) || !validTime(w.end)) throw new Error(`时段 ${index + 1} 的起止时间无效，请使用 HH:mm。`);
      if (w.start === w.end) throw new Error(`时段 ${index + 1} 的起止时间不能相同；全天请使用两个相邻时段。`);
      if (!Number.isInteger(w.intervalMinutes) || w.intervalMinutes < 1 || w.intervalMinutes > 1440) throw new Error(`时段 ${index + 1} 的间隔须为 1 至 1440 分钟。`);
      const start = minuteOfDay(w.start), length = (minuteOfDay(w.end) - start + 1440) % 1440;
      for (let offset = 0; offset < length; offset++) {
        const minute = (start + offset) % 1440;
        if (occupied.has(minute)) throw new Error(`时段 ${index + 1} 与其他时段重叠（包含跨午夜部分），请调整起止时间。`);
        occupied.add(minute);
      }
      return { start: w.start, end: w.end, intervalMinutes: w.intervalMinutes };
    });
    const result = { kind: s.kind, timeZone: s.timeZone, windows };
    if (dailyNodes(result).length > MAX_DAILY_NODES) throw new Error(`每天最多 ${MAX_DAILY_NODES} 个执行节点，请增大间隔。`);
    return result;
  }
  if (!validTime(s.time)) throw new Error("执行时间无效。");
  if (!Number.isInteger(s.intervalMinutes) || s.intervalMinutes < 1 || s.intervalMinutes > 525600) throw new Error("间隔须为 1 至 525600 分钟。");
  if (!Array.isArray(s.weekdays) || s.weekdays.some(d => !Number.isInteger(d) || d < 0 || d > 6) || (s.kind === "weekly" && !s.weekdays.length)) throw new Error("请选择每周的执行日期。");
  if (!Number.isInteger(s.monthDay) || s.monthDay < 1 || s.monthDay > 31) throw new Error("每月日期无效。");
  return { kind: s.kind, timeZone: s.timeZone, time: s.time, intervalMinutes: s.intervalMinutes, weekdays: [...new Set(s.weekdays)].sort(), monthDay: s.monthDay };
}

// Strictly after `after`. Interval cadence stays anchored to its persisted due time.
// Calendar rules follow the selected zone: skip nonexistent wall times, and run
// only the first occurrence of an ambiguous wall time during a DST fall-back.
export function nextOccurrence(s: Recurrence, after: number, anchor = after): string {
  if (s.kind === "once") return s.at;
  if (s.kind === "interval") {
    const step = s.intervalMinutes * 60_000;
    return new Date(anchor + Math.max(1, Math.floor((after - anchor) / step) + 1) * step).toISOString();
  }
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: s.timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  const parts = (ms: number) => Object.fromEntries(formatter.formatToParts(ms).filter(p => p.type !== "literal").map(p => [p.type, Number(p.value)]));
  const utcValue = (p: Record<string, number>) => Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const start = parts(after);
  const times = s.kind === "daily_times" || s.kind === "daily_windows" ? dailyNodes(s) : [s.time];
  for (let day = 0; day < 370; day++) {
    const date = new Date(Date.UTC(start.year, start.month - 1, start.day + day));
    if (s.kind === "weekly" && !s.weekdays.includes(date.getUTCDay())) continue;
    if (s.kind === "monthly" && date.getUTCDate() !== s.monthDay) continue;
    for (const time of times) {
      const [hour, minute] = time.split(":").map(Number);
      const wall = date.getTime() + hour * 3600_000 + minute * 60_000;
      const candidates = new Set<number>();
      for (const offset of [-36, 0, 36]) {
        const probe = wall + offset * 3600_000;
        const candidate = wall - (utcValue(parts(probe)) - probe);
        if (utcValue(parts(candidate)) === wall) candidates.add(candidate);
      }
      const first = Math.min(...candidates);
      if (Number.isFinite(first) && first > after) return new Date(first).toISOString();
    }
  }
  throw new Error("无法计算下一次执行时间。");
}

// Uses the same nextOccurrence function as the durable scheduler and the server
// clock, never a separate browser calendar calculation.
export function previewRecurrence(s: Recurrence, now = Date.now()) {
  if (s.kind === "once") return { asOf: new Date(now).toISOString(), timeZone:s.timeZone, nodes:[], occurrences:[s.at] };
  let after = now;
  const occurrences = Array.from({ length: 8 }, () => {
    const next = nextOccurrence(s, after, now);
    after = Date.parse(next);
    return next;
  });
  return { asOf: new Date(now).toISOString(), timeZone: s.timeZone, nodes: dailyNodes(s), occurrences };
}
