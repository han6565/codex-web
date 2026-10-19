import { useEffect, useState } from "react";
import { api } from "./api";
import type { Recurrence, RecurrencePreview } from "./recurring-types";

export function changeRecurrenceKind(kind: Recurrence["kind"], previous: Recurrence): Recurrence {
  if (kind === previous.kind) return previous;
  const timeZone = previous.timeZone;
  if (kind === "once") return { kind, timeZone, at: new Date(Date.now()+86400000).toISOString() };
  if (kind === "daily_times") return { kind, timeZone, times: ["09:00", "18:00"] };
  if (kind === "daily_windows") return { kind, timeZone, windows: [{ start: "10:00", end: "22:00", intervalMinutes: 360 }, { start: "22:00", end: "10:00", intervalMinutes: 120 }] };
  if (previous.kind === "once" || previous.kind === "daily_times" || previous.kind === "daily_windows") return { kind, timeZone, time: "09:00", intervalMinutes: 60, weekdays: [1, 2, 3, 4, 5], monthDay: 1 };
  return { ...previous, kind };
}

export function RecurringScheduleFields({ schedule: s, onChange }: { schedule: Recurrence; onChange: (schedule: Recurrence) => void }) {
  if (s.kind === "once") return <p>一次性执行：{new Date(s.at).toLocaleString("zh-CN",{ timeZone:s.timeZone })}（{s.timeZone}）</p>;
  if (s.kind === "daily_times") return <div className="recurring-intraday">
    <p>每天按这些节点执行。最多 96 个，不可重复。</p>
    <div className="recurring-time-nodes">{s.times.map((time, i) => <div className="recurring-time-node" key={i}>
      <label>节点 {i + 1}<input aria-label={`节点 ${i + 1}`} type="time" required value={time} onChange={e => onChange({ ...s, times: s.times.map((t, n) => n === i ? e.target.value : t) })} /></label>
      <button type="button" aria-label={`删除节点 ${i + 1}`} disabled={s.times.length <= 1} onClick={() => onChange({ ...s, times: s.times.filter((_, n) => n !== i) })}>删除</button>
    </div>)}</div>
    <button type="button" disabled={s.times.length >= 96} onClick={() => onChange({ ...s, times: [...s.times, ""] })}>添加节点</button>
  </div>;
  if (s.kind === "daily_windows") return <div className="recurring-intraday">
    <p>每天重复，包含起点、不含终点。结束早于开始表示跨午夜；间隔从各时段起点计算。时段可留空档，不可重叠。</p>
    {s.windows.map((w, i) => <div className="recurring-window" key={i} role="group" aria-label={`时段 ${i + 1}`}>
      <strong>时段 {i + 1}{w.end < w.start ? " · 跨午夜" : ""}</strong>
      <div className="recurring-grid">
        <label>开始<input aria-label={`时段 ${i + 1} 开始`} type="time" required value={w.start} onChange={e => onChange({ ...s, windows: s.windows.map((v, n) => n === i ? { ...v, start: e.target.value } : v) })} /></label>
        <label>结束{w.end < w.start ? "（次日）" : ""}<input aria-label={`时段 ${i + 1} 结束`} type="time" required value={w.end} onChange={e => onChange({ ...s, windows: s.windows.map((v, n) => n === i ? { ...v, end: e.target.value } : v) })} /></label>
        <label>间隔（分钟）<input aria-label={`时段 ${i + 1} 间隔（分钟）`} type="number" min={1} max={1440} required value={w.intervalMinutes} onChange={e => onChange({ ...s, windows: s.windows.map((v, n) => n === i ? { ...v, intervalMinutes: Number(e.target.value) } : v) })} /></label>
        <button type="button" aria-label={`删除时段 ${i + 1}`} disabled={s.windows.length <= 1} onClick={() => onChange({ ...s, windows: s.windows.filter((_, n) => n !== i) })}>删除时段</button>
      </div>
    </div>)}
    <button type="button" disabled={s.windows.length >= 8} onClick={() => onChange({ ...s, windows: [...s.windows, { start: "09:00", end: "12:00", intervalMinutes: 60 }] })}>添加时段</button>
  </div>;
  return <>
    <div className="recurring-grid">
      {s.kind === "interval" ? <label>间隔（分钟）<input aria-label="间隔（分钟）" type="number" min={1} max={525600} required value={s.intervalMinutes} onChange={e => onChange({ ...s, intervalMinutes: Number(e.target.value) })} /></label> : <label>执行时间<input aria-label="执行时间" type="time" required value={s.time} onChange={e => onChange({ ...s, time: e.target.value })} /></label>}
      {s.kind === "monthly" && <label>每月几号<input aria-label="每月几号" type="number" min={1} max={31} required value={s.monthDay} onChange={e => onChange({ ...s, monthDay: Number(e.target.value) })} /><small>没有该日期的月份会跳过。</small></label>}
    </div>
    {s.kind === "weekly" && <div className="recurring-weekdays" role="group" aria-label="每周执行日期">{[1,2,3,4,5,6,0].map(d => <label key={d}><input type="checkbox" checked={s.weekdays.includes(d)} onChange={e => onChange({ ...s, weekdays: e.target.checked ? [...s.weekdays,d].sort() : s.weekdays.filter(v => v !== d) })} />周{["日", "一", "二", "三", "四", "五", "六"][d]}</label>)}</div>}
  </>;
}

export function IntradayPreview({ schedule }: { schedule: Recurrence }) {
  const [result, setResult] = useState<{ key: string; data?: RecurrencePreview; error?: string } | null>(null);
  const key = JSON.stringify(schedule);
  const enabled = schedule.kind === "daily_times" || schedule.kind === "daily_windows";
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    async function refresh() {
      try { const data = await api.previewRecurrence(JSON.parse(key)); if (!disposed) setResult({ key, data }); }
      catch (e) { if (!disposed) setResult({ key, error: e instanceof Error ? e.message : "预览读取失败，请重试。" }); }
    }
    const timer = window.setTimeout(() => void refresh(), 300);
    const refreshTimer = window.setInterval(() => void refresh(), 30_000);
    return () => { disposed = true; window.clearTimeout(timer); window.clearInterval(refreshTimer); };
  }, [key, enabled]);
  if (!enabled) return null;
  const current = result?.key === key ? result : null;
  return <section className="recurring-preview" aria-label="日程预览" aria-live="polite">
    <h4>日程预览 · {schedule.timeZone}</h4>
    {!current ? <p>正在计算…</p> : current.error ? <p role="alert" className="recurring-error">{current.error}</p> : current.data && <>
      <p>每日 {current.data.nodes.length} 个节点</p>
      <div className="recurring-preview-nodes">{current.data.nodes.map(time => <span key={time}>{time}</span>)}</div>
      <details><summary>接下来 8 个日程时间</summary><ol>{current.data.occurrences.map(time => <li key={time}><time dateTime={time}>{new Intl.DateTimeFormat("zh-CN", { timeZone: current.data!.timeZone, dateStyle: "medium", timeStyle: "short", hourCycle: "h23" }).format(new Date(time))}</time></li>)}</ol></details>
      <p>按服务器当前时间预览日程；编辑后需保存。实际下次执行见下方，暂停、次数上限或上一轮占用会影响执行。夏令时不存在的时间跳过，重复时间仅执行第一次。</p>
    </>}
  </section>;
}
