import type { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";

export function isSqliteBusy(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { errcode?: number; code?: string };
  return (typeof value.errcode === "number" && [5, 6].includes(value.errcode & 0xff))
    || ["SQLITE_BUSY", "SQLITE_LOCKED"].includes(value.code ?? "");
}

// DatabaseSync's busy timeout blocks the whole Web event loop. Retry callbacks
// outside SQLite instead, restoring the connection setting before yielding.
function withoutBusyWait<T>(db: DatabaseSync, operation: () => T): T {
  const previous = Number((db.prepare("PRAGMA busy_timeout").get() as { timeout: number }).timeout);
  db.exec("PRAGMA busy_timeout=0");
  try { return operation(); }
  finally { db.exec(`PRAGMA busy_timeout=${previous}`); }
}

export async function retrySqliteWrite<T>(db: DatabaseSync, operation: () => T, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { return withoutBusyWait(db, operation); }
    catch (error) {
      if (!isSqliteBusy(error) || Date.now() >= deadline) throw error;
      await delay(100);
    }
  }
}

export class JobEventPersistenceError extends Error {
  constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = "JobEventPersistenceError"; }
}

type Entry = { operation: () => void; bytes: number; queuedAt: number };

// Callbacks from sockets, IPC and remote Workers must never throw into an
// EventEmitter. Keep their order, bound memory/time and surface failure through
// the Runner's awaited execution, without replaying the model turn.
export class SqliteJobEventQueue {
  private readonly entries: Entry[] = [];
  private bytes = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private error?: Error;
  private closed = false;
  private rejectFailure!: (error: Error) => void;
  private readonly failure = new Promise<never>((_, reject) => { this.rejectFailure = reject; });
  private readonly waiters: Array<{ resolve(): void; reject(error: Error): void }> = [];

  constructor(private readonly db: DatabaseSync, private readonly options: {
    timeoutMs?: number; retryMs?: number; maxEntries?: number; maxBytes?: number;
    onFailure?(error: Error): void;
  } = {}) {
    // A callback can fail before the execution Promise has been returned.
    void this.failure.catch(() => undefined);
  }

  enqueue(operation: () => void, payload: unknown = null): void {
    if (this.closed || this.error) return;
    try {
      const bytes = Buffer.byteLength(JSON.stringify(payload) ?? "null");
      if (this.entries.length >= (this.options.maxEntries ?? 4096)
        || this.bytes + bytes > (this.options.maxBytes ?? 16 * 1024 * 1024)) {
        throw new JobEventPersistenceError("任务进度保存积压超过上限；已停止本轮执行，请检查数据库后继续");
      }
      this.entries.push({ operation, bytes, queuedAt: Date.now() });
      this.bytes += bytes;
      if (!this.timer) this.flush();
    } catch (error) { this.fail(error); }
  }

  async waitFor<T>(execution: Promise<T>): Promise<T> {
    let result: T;
    try { result = await Promise.race([execution, this.failure]); }
    catch (error) { await this.drain(); throw error; }
    await this.drain();
    return result;
  }

  drain(): Promise<void> {
    if (this.error) return Promise.reject(this.error);
    if (!this.entries.length) return Promise.resolve();
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.entries.length = 0;
    this.bytes = 0;
    for (const waiter of this.waiters.splice(0)) waiter.resolve();
  }

  private flush(): void {
    this.timer = undefined;
    if (this.closed || this.error) return;
    while (this.entries.length) {
      const entry = this.entries[0];
      try { withoutBusyWait(this.db, entry.operation); }
      catch (error) {
        if (isSqliteBusy(error) && Date.now() - entry.queuedAt < (this.options.timeoutMs ?? 30_000)) {
          this.timer = setTimeout(() => this.flush(), this.options.retryMs ?? 100);
          return;
        }
        this.fail(isSqliteBusy(error)
          ? new JobEventPersistenceError("数据库持续繁忙，任务进度无法保存；已停止本轮执行，请检查后继续", { cause: error })
          : error);
        return;
      }
      this.entries.shift();
      this.bytes -= entry.bytes;
    }
    for (const waiter of this.waiters.splice(0)) waiter.resolve();
  }

  private fail(error: unknown): void {
    if (this.error || this.closed) return;
    this.error = error instanceof JobEventPersistenceError ? error
      : new JobEventPersistenceError("任务进度保存失败；已停止本轮执行，请检查后继续", { cause: error });
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.entries.length = 0;
    this.bytes = 0;
    this.rejectFailure(this.error);
    for (const waiter of this.waiters.splice(0)) waiter.reject(this.error);
    try { this.options.onFailure?.(this.error); }
    catch { /* Failure reporting cannot escape a socket/IPC callback either. */ }
  }
}
