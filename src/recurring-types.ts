export type LegacyRecurrence = { kind: "interval" | "daily" | "weekly" | "monthly"; timeZone: string; time: string; intervalMinutes: number; weekdays: number[]; monthDay: number };
export type DailyWindow = { start: string; end: string; intervalMinutes: number };
export type Recurrence = LegacyRecurrence | { kind: "once"; at: string; timeZone: string } | { kind: "daily_times"; timeZone: string; times: string[] } | { kind: "daily_windows"; timeZone: string; windows: DailyWindow[] };
export type RecurrencePreview = { asOf: string; timeZone: string; nodes: string[]; occurrences: string[] };
export type RecurringTask = { judgment?: {id:string;title:string}|null; opportunityTopic?: { id: string; name: string } | null; id: string; project_id: string; name: string; prompt: string; model: string; reasoningEffort: string; schedule: Recurrence; maxRuns: number | null; runCount: number; state: "active" | "paused" | "completed"; nextRunAt: string | null; revision: number; createdAt: string };
export type RecurringInput = Pick<RecurringTask, "name" | "prompt" | "model" | "reasoningEffort" | "schedule" | "maxRuns">;
export type RecurringRun = { id: string; scheduled_at: string; created_at: string; conversation_id: string | null; status: string; reason: string | null };
