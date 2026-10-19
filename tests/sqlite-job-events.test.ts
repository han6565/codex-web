import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { AppDatabase, LEGACY_USER_ID } from "../server/db.js";
import { SqliteJobEventQueue, JobEventPersistenceError, retrySqliteWrite } from "../server/sqlite-job-events.js";
import { loadConfig } from "../server/config.js";
import { CodexRunner } from "../server/codex-runner.js";
import { RemoteWorkerGateway } from "../server/remote-worker-gateway.js";
import { ensureTenant } from "../server/paths.js";
import type { TenantWorkerClient } from "../server/tenant-worker-client.js";

function fixture(t: { after(fn: () => void): void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sqlite-job-events-"));
  const db = new AppDatabase(path.join(root, "data"));
  const writer = new DatabaseSync(path.join(root, "data", "codex-web.sqlite"));
  const conversation = db.createConversation(crypto.randomUUID(), "lock regression");
  const job = db.createJob(crypto.randomUUID(), conversation.id);
  t.after(() => { writer.close(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, db, writer, conversation, job };
}

test("a real writer lock longer than five seconds preserves event order without blocking the event loop", async t => {
  const { db, writer, job } = fixture(t);
  const queue = new SqliteJobEventQueue(db.sqlite);
  t.after(() => queue.close());
  writer.exec("BEGIN IMMEDIATE");
  const started = Date.now();
  queue.enqueue(() => db.appendEvent(job.id, "progress", { step: 1 }));
  queue.enqueue(() => db.appendEvent(job.id, "progress", { step: 2 }));
  assert.ok(Date.now() - started < 1000, "SQLite's five-second synchronous wait must not run in a callback");
  assert.equal(db.sqlite.prepare("PRAGMA busy_timeout").get()!.timeout, 5000);
  let completed = false;
  const completion = queue.waitFor(Promise.resolve("model done")).then(value => { completed = true; return value; });
  await delay(5200);
  assert.equal(completed, false, "completion must wait for buffered progress");
  writer.exec("COMMIT");
  assert.equal(await completion, "model done");
  const events = db.listEvents(job.id);
  assert.deepEqual(events.map(e => e.seq), [1, 2]);
  assert.deepEqual(events.map(e => JSON.parse(e.payload).step), [1, 2]);
});

test("appendEvent rolls back its insert if updating the job fails, including inside an outer transaction", t => {
  const { db, job } = fixture(t);
  db.sqlite.exec("CREATE TEMP TRIGGER reject_job_event_update BEFORE UPDATE ON jobs BEGIN SELECT RAISE(ABORT, 'fixture update rejected'); END");
  assert.throws(() => db.appendEvent(job.id, "progress", { step: 1 }), /fixture update rejected/);
  assert.equal(db.listEvents(job.id).length, 0);
  db.sqlite.exec("DROP TRIGGER reject_job_event_update; BEGIN IMMEDIATE");
  assert.equal(db.appendEvent(job.id, "progress", { step: 2 }), 1);
  db.sqlite.exec("ROLLBACK");
  assert.equal(db.listEvents(job.id).length, 0);
  assert.equal(db.appendEvent(job.id, "progress", { step: 3 }), 1);
});

test("non-lock callback errors fail only the awaited job and are not retried", async t => {
  const { db } = fixture(t);
  let calls = 0, failures = 0;
  const queue = new SqliteJobEventQueue(db.sqlite, { onFailure: () => { failures++; } });
  t.after(() => queue.close());
  assert.doesNotThrow(() => queue.enqueue(() => { calls++; throw new Error("fixture callback failed"); }));
  await assert.rejects(queue.waitFor(Promise.resolve("must not complete")), JobEventPersistenceError);
  queue.enqueue(() => { calls++; });
  await delay(20);
  assert.equal(calls, 1); assert.equal(failures, 1);
});

test("persistent contention has a bounded deadline and pending callbacks are discarded", async t => {
  const { db, writer, job } = fixture(t);
  const queue = new SqliteJobEventQueue(db.sqlite, { timeoutMs: 50, retryMs: 10 });
  t.after(() => queue.close());
  writer.exec("BEGIN IMMEDIATE");
  queue.enqueue(() => db.appendEvent(job.id, "progress", { step: 1 }));
  await assert.rejects(queue.waitFor(new Promise(() => {})), /数据库持续繁忙/);
  writer.exec("COMMIT");
  await delay(30);
  assert.equal(db.listEvents(job.id).length, 0);
});

test("buffer limits reject excess progress and close cancels deferred writes", async t => {
  const { db, writer, job } = fixture(t);
  const queue = new SqliteJobEventQueue(db.sqlite, { maxEntries: 1, maxBytes: 32 });
  t.after(() => queue.close());
  writer.exec("BEGIN IMMEDIATE");
  queue.enqueue(() => db.appendEvent(job.id, "progress", { step: 1 }), "first");
  assert.doesNotThrow(() => queue.enqueue(() => {}, "second"));
  await assert.rejects(queue.drain(), /积压超过上限/);
  const closed = new SqliteJobEventQueue(db.sqlite);
  closed.enqueue(() => db.appendEvent(job.id, "progress", { step: 2 }));
  const drained = closed.drain(); closed.close(); await drained;
  writer.exec("COMMIT");
  await delay(120);
  assert.equal(db.listEvents(job.id).length, 0);
  const oversized = new SqliteJobEventQueue(db.sqlite, { maxBytes: 2 });
  oversized.enqueue(() => assert.fail("oversized callback executed"), "large");
  await assert.rejects(oversized.drain(), /积压超过上限/); oversized.close();
});

test("terminal state can be persisted asynchronously when a competing transaction releases its lock", async t => {
  const { db, writer, job, conversation } = fixture(t);
  writer.exec("BEGIN IMMEDIATE");
  const pending = retrySqliteWrite(db.sqlite, () => db.finishJob(job.id, conversation.id, "failed", "fixture failure"));
  await delay(120); writer.exec("COMMIT"); await pending;
  assert.equal(db.getJob(job.id)?.status, "failed");
});

for (const mode of ["success", "cancel", "callback failure"] as const) test(`Runner isolates callback persistence (${mode}) without replaying execution`, async t => {
  const { root, db, writer } = fixture(t);
  const config = loadConfig({ projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot: path.join(root, "tenants"),
    pythonRuntimeRoot: path.join(root, "python"), tenantWorkerIsolation: true, taskMemoryGuard: false, queueAutoStart: false });
  const gateway = new RemoteWorkerGateway(config, db);
  t.after(() => gateway.close());
  const tenant = ensureTenant(config.tenantRoot, LEGACY_USER_ID);
  const directory = path.join(tenant.library, "project"); fs.mkdirSync(directory, { recursive: true });
  const project = db.createProject(crypto.randomUUID(), LEGACY_USER_ID, "fixture", directory, "tenant-local");
  const selection = { model: "gpt-5.6-sol", reasoningEffort: "high" } as const;
  const c = db.createConversation(crypto.randomUUID(), "runner lock", selection, LEGACY_USER_ID, project.id);
  const job = db.createJob(crypto.randomUUID(), c.id, undefined, selection);
  const runner = new CodexRunner(config, db, (id, type, payload) => {
    if (mode === "callback failure" && (payload as { detail?: string })?.detail === "first") throw new Error("fixture non-lock storage failure");
    db.appendEvent(id, type, payload);
  }, gateway);
  let executions = 0, cancellations = 0;
  const fake = {
    run: async (_: unknown, callbacks: Parameters<TenantWorkerClient["run"]>[1]) => {
      executions++;
      callbacks.onThreadStarted(crypto.randomUUID());
      if (mode !== "callback failure") writer.exec("BEGIN IMMEDIATE");
      callbacks.onProgress({ kind: "update", detail: "first" });
      callbacks.onProgress({ kind: "update", detail: "second" });
      if (mode !== "callback failure") setTimeout(() => writer.exec("COMMIT"), 150);
      if (mode === "cancel") setTimeout(() => runner.cancel(job.id), 20);
      return "completed result";
    }, cancel: () => { cancellations++; return true; },
  };
  (runner as unknown as { workerClient: unknown }).workerClient = fake;
  await runner.run(job.id, c.id, "fixture prompt", [], selection);
  assert.equal(db.getJob(job.id)?.status, mode === "success" ? "completed" : mode === "cancel" ? "cancelled" : "failed", db.getJob(job.id)?.error ?? "");
  assert.equal(executions, 1);
  assert.equal(runner.activeJobCount, 0);
  const updates = db.listEvents(job.id).filter(e => e.event_type === "progress" && JSON.parse(e.payload).kind === "update");
  assert.deepEqual(updates.map(e => JSON.parse(e.payload).detail), mode === "success" ? ["first", "second"] : []);
  assert.equal(cancellations, mode === "success" ? 0 : 1);
});
