import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { AppDatabase, LEGACY_USER_ID } from "../server/db.js";
import { loadConfig } from "../server/config.js";
import { CodexRunner } from "../server/codex-runner.js";
import { RemoteWorkerGateway } from "../server/remote-worker-gateway.js";
import { ensureTenant, ensureTenantWorkspace } from "../server/paths.js";
import type { TenantWorkerClient } from "../server/tenant-worker-client.js";

function fixture(t: { after(fn: () => void): void }, beforePublish?: (type: string) => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "job-finalization-locks-"));
  const config = loadConfig({ projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot: path.join(root, "tenants"),
    pythonRuntimeRoot: path.join(root, "python"), tenantWorkerIsolation: true, taskMemoryGuard: false, queueAutoStart: false });
  const db = new AppDatabase(config.dataRoot);
  const writer = new DatabaseSync(path.join(config.dataRoot, "codex-web.sqlite"));
  const gateway = new RemoteWorkerGateway(config, db);
  const tenant = ensureTenant(config.tenantRoot, LEGACY_USER_ID);
  const directory = path.join(tenant.library, "project"); fs.mkdirSync(directory, { recursive: true });
  const project = db.createProject(crypto.randomUUID(), LEGACY_USER_ID, "fixture", directory, "tenant-local");
  const selection = { model: "gpt-5.6-sol", reasoningEffort: "high" } as const;
  const conversation = db.createConversation(crypto.randomUUID(), "finalization lock", selection, LEGACY_USER_ID, project.id);
  const job = db.createJob(crypto.randomUUID(), conversation.id, undefined, selection);
  const runner = new CodexRunner(config, db, (id, type, payload) => { beforePublish?.(type); db.appendEvent(id, type, payload); }, gateway);
  let executions = 0;
  (runner as unknown as { workerClient: unknown }).workerClient = {
    run: async (_: unknown, callbacks: Parameters<TenantWorkerClient["run"]>[1]) => {
      executions++; callbacks.onThreadStarted(crypto.randomUUID());
      const output = path.join(ensureTenantWorkspace(config.tenantRoot, LEGACY_USER_ID, conversation.id), "outputs", "result.txt");
      fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, "persistent artifact");
      return "durable completed result [file](outputs/result.txt)";
    }, cancel: () => true,
  };
  t.after(() => { gateway.close(); writer.close(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, db, writer, runner, conversation, job, executions: () => executions,
    run: () => runner.run(job.id, conversation.id, "fixture prompt", [], selection) };
}

test("a competing writer during the done event must not turn an already committed result into failure", async t => {
  let locked = false;
  const f = fixture(t, type => {
    if (type !== "done" || locked) return;
    locked = true; f.writer.exec("BEGIN IMMEDIATE");
    setTimeout(() => f.writer.exec("COMMIT"), 150);
  });
  await f.run();
  assert.equal(locked, true);
  assert.equal(f.db.getJob(f.job.id)?.status, "completed");
  assert.equal(f.db.getJob(f.job.id)?.finalization_state, "published");
  assert.equal(f.db.getJob(f.job.id)?.error, null);
  assert.equal(f.db.listMessages(f.conversation.id).filter(m => m.role === "assistant").length, 1);
  assert.equal(f.db.listEvents(f.job.id).filter(e => e.event_type === "done").length, 1);
  assert.equal(f.db.listEvents(f.job.id).some(e => e.event_type === "failed"), false);
  assert.equal(f.executions(), 1);
});

for (const phase of ["stageJobFinalization", "markJobFilesReady", "finalizeJob", "publishJobFinalization"] as const) {
  test(`finalization retries only the contended ${phase} write and keeps one answer and file`, async t => {
    const f = fixture(t);
    // Keep the pre-fix failure fast; the separate long-lock case uses the
    // production timeout and proves that its event loop remains responsive.
    f.db.sqlite.exec("PRAGMA busy_timeout=10");
    const methods = f.db as unknown as Record<string, (...args: unknown[]) => unknown>;
    const original = methods[phase].bind(f.db);
    let locked = false;
    methods[phase] = (...args) => {
      if (!locked) { locked = true; f.writer.exec("BEGIN IMMEDIATE"); setTimeout(() => f.writer.exec("COMMIT"), 150); }
      return original(...args);
    };
    await f.run();
    assert.equal(locked, true);
    assert.equal(f.db.getJob(f.job.id)?.status, "completed");
    assert.equal(f.db.getJob(f.job.id)?.finalization_state, "published");
    assert.equal(f.db.getJob(f.job.id)?.finalization_payload, null);
    assert.equal(f.db.listMessages(f.conversation.id).filter(m => m.role === "assistant").length, 1);
    assert.equal(f.db.listFiles(f.conversation.id).length, 1);
    assert.equal(f.db.listFiles(f.conversation.id)[0].sha256, crypto.createHash("sha256").update("persistent artifact").digest("hex"));
    assert.equal(f.db.listEvents(f.job.id).filter(e => e.event_type === "done").length, 1);
    assert.equal(f.executions(), 1);
    assert.equal(f.db.sqlite.prepare("PRAGMA busy_timeout").get()!.timeout, 10);
  });
}

test("publication waits through a real writer held over five seconds without blocking other work", async t => {
  let locked = false, notifyLocked!: () => void;
  const lockStarted = new Promise<void>(resolve => { notifyLocked = resolve; });
  const f = fixture(t, type => {
    if (type !== "done" || locked) return;
    locked = true; f.writer.exec("BEGIN IMMEDIATE"); notifyLocked();
    setTimeout(() => f.writer.exec("COMMIT"), 5200);
  });
  const completion = f.run();
  await lockStarted;
  const start = performance.now(); await delay(100);
  assert.ok(performance.now() - start < 1500, "the Web event loop must remain available during contention");
  assert.equal(f.db.getJob(f.job.id)?.status, "completed");
  assert.equal(f.db.getJob(f.job.id)?.finalization_state, "db_committed");
  await completion;
  assert.equal(f.db.getJob(f.job.id)?.finalization_state, "published");
  assert.equal(f.executions(), 1);
});

test("post-commit publication failure stays successful and is recovered without affecting a newer turn", async t => {
  let rejectPublication = true;
  const f = fixture(t, type => { if (type === "done" && rejectPublication) throw new Error("fixture notification unavailable"); });
  await f.run();
  assert.equal(f.db.getJob(f.job.id)?.status, "completed");
  assert.equal(f.db.getJob(f.job.id)?.finalization_state, "db_committed");
  assert.match(f.db.getJob(f.job.id)?.finalization_error ?? "", /notification unavailable/);
  assert.ok(f.db.getJob(f.job.id)?.finalization_payload);
  assert.equal(f.db.listEvents(f.job.id).some(e => e.event_type === "failed" || JSON.parse(e.payload).kind === "error"), false);

  const next = f.db.createJob(crypto.randomUUID(), f.conversation.id);
  f.db.updateJob(next.id, "running"); f.db.updateConversation(f.conversation.id, { status: "running" });
  f.db.finishJob(f.job.id, f.conversation.id, "failed", "late failure", "must not appear");
  f.db.updateJob(f.job.id, "cancelled", "late cancellation");
  assert.equal(f.db.getJob(f.job.id)?.status, "completed");
  assert.equal(f.db.getJob(f.job.id)?.error, null);
  assert.equal(f.db.getConversation(f.conversation.id)?.status, "running");

  rejectPublication = false;
  const recovered = await f.runner.recoverJobFinalizations({ committedOnly: true });
  assert.equal(recovered.published, 1); assert.deepEqual(recovered.errors, []);
  assert.equal(f.db.getJob(f.job.id)?.finalization_state, "published");
  assert.equal(f.db.getJob(next.id)?.status, "running");
  assert.equal(f.db.getConversation(f.conversation.id)?.status, "running");
  assert.equal(f.db.listMessages(f.conversation.id).length, 1);
  assert.equal(f.db.listFiles(f.conversation.id).length, 1);
  assert.equal(f.db.listEvents(f.job.id).filter(e => e.event_type === "done").length, 1);
  assert.equal((await f.runner.recoverJobFinalizations({ committedOnly: true })).published, 0);
  assert.equal(f.executions(), 1);
});

test("a genuine failure before database commit remains failed with no false success", async t => {
  const f = fixture(t);
  f.db.markJobFilesReady = () => { throw new Error("fixture disk integrity failure"); };
  await f.run();
  assert.equal(f.db.getJob(f.job.id)?.status, "failed");
  assert.match(f.db.getJob(f.job.id)?.error ?? "", /disk integrity failure/);
  assert.equal(f.db.listMessages(f.conversation.id).length, 0);
  assert.equal(f.db.listEvents(f.job.id).some(e => e.event_type === "done"), false);
  assert.equal((await f.runner.recoverJobFinalizations({ committedOnly: true })).published, 0);
  assert.equal(f.db.getJob(f.job.id)?.status, "failed");
  assert.equal(f.executions(), 1);
});

test("personal context revision and result metadata commit or roll back together", t => {
  const f = fixture(t); f.db.updateJob(f.job.id, "running");
  const payload = { message: { id: crypto.randomUUID(), conversation_id: f.conversation.id,
    role: "assistant" as const, content: "atomic result", created_at: new Date().toISOString() }, files: [], personalContextRevision: 7 };
  f.db.stageJobFinalization(f.job.id, payload); f.db.markJobFilesReady(f.job.id, payload);
  f.db.sqlite.exec("CREATE TEMP TRIGGER reject_revision BEFORE UPDATE OF personal_context_revision ON conversations BEGIN SELECT RAISE(ABORT, 'fixture revision rejected'); END");
  assert.throws(() => f.db.finalizeJob(f.job.id, f.conversation.id, payload), /revision rejected/);
  assert.equal(f.db.listMessages(f.conversation.id).length, 0);
  assert.equal(f.db.getConversation(f.conversation.id)?.personal_context_revision, 0);
  assert.equal(f.db.getJob(f.job.id)?.finalization_state, "files_ready");
  f.db.sqlite.exec("DROP TRIGGER reject_revision");
  f.db.finalizeJob(f.job.id, f.conversation.id, payload);
  assert.equal(f.db.getConversation(f.conversation.id)?.personal_context_revision, 7);
  assert.equal(f.db.getJob(f.job.id)?.status, "completed");
  assert.equal(f.db.listMessages(f.conversation.id).length, 1);
});
