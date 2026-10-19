import type { Recurrence } from "./recurring-types";

const weekdays = ["日", "一", "二", "三", "四", "五", "六"];

export function recurrenceLabel(schedule: Recurrence): string {
  if (schedule.kind === "once") return `一次 · ${new Date(schedule.at).toLocaleString("zh-CN", { timeZone: schedule.timeZone })}`;
  if (schedule.kind === "daily_times") return `每天 ${schedule.times.join("、")}`;
  if (schedule.kind === "daily_windows") return `每日分时段 · ${schedule.windows.map(w => `${w.start}–${w.end <= w.start ? "次日" : ""}${w.end} 每 ${w.intervalMinutes % 60 === 0 ? `${w.intervalMinutes / 60} 小时` : `${w.intervalMinutes} 分钟`}`).join("；")}`;
  if (schedule.kind === "interval") {
    const minutes = schedule.intervalMinutes;
    if (minutes < 120) return `每 ${minutes} 分钟`;
    const parts = [
      [Math.floor(minutes / 1440), "天"],
      [Math.floor(minutes % 1440 / 60), "小时"],
      [minutes % 60, "分钟"],
    ] as const;
    return `每 ${parts.filter(([value]) => value > 0).map(([value, unit]) => `${value} ${unit}`).join(" ")}`;
  }
  return `${schedule.kind === "daily" ? "每天" : schedule.kind === "weekly" ? `每周${schedule.weekdays.map(d => weekdays[d]).join("、")}` : `每月 ${schedule.monthDay} 日`} ${schedule.time}`;
}
