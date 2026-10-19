import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AppDatabase, LEGACY_USER_ID } from "../server/db.js";
import { loadConfig } from "../server/config.js";
import { CodexRunner } from "../server/codex-runner.js";
import { RemoteWorkerGateway } from "../server/remote-worker-gateway.js";
import { ensureTenant, ensureTenantWorkspace } from "../server/paths.js";
import type { TenantWorkerClient } from "../server/tenant-worker-client.js";
import { isUpstreamRoutingError, isRetryableUpstreamError } from "../server/retry-policy.js";
import { isModelCapacityContinuationPrompt, UPSTREAM_ROUTING_CONTINUATION_PROMPT } from "../server/internal-messages.js";

const selection = { model: "gpt-5.6-sol", reasoningEffort: "high" } as const;

for (const phase of ["before-acceptance", "accepted", "after-tool"] as const) {
  test(`routing discovery failure persists a safe continuation ${phase}`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "routing-recovery-"));
    const config = loadConfig({ projectRoot: process.cwd(), dataRoot: path.join(root, "data"),
      tenantRoot: path.join(root, "tenants"), pythonRuntimeRoot: path.join(root, "python"),
      tenantWorkerIsolation: true, queueAutoStart: false });
    let db = new AppDatabase(config.dataRoot);
    let gateway = new RemoteWorkerGateway(config, db);
    t.after(() => { gateway.close(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
    const tenant = ensureTenant(config.tenantRoot, LEGACY_USER_ID);
    const projectRoot = path.join(tenant.library, "routing-test"); fs.mkdirSync(projectRoot, { recursive: true });
    const project = db.createProject(crypto.randomUUID(), LEGACY_USER_ID, "routing", projectRoot, "tenant-local");
    const c = db.createConversation(crypto.randomUUID(), "routing", selection, LEGACY_USER_ID, project.id);
    const original = "ONLY_ORIGINAL_REQUEST create exactly one file";
    const messageId = crypto.randomUUID();
    db.addMessage({ id: messageId, conversation_id: c.id, role: "user", content: original, created_at: new Date().toISOString() });
    const job = db.createJob(crypto.randomUUID(), c.id, messageId, selection);
    const later = db.createJob(crypto.randomUUID(), c.id, undefined, selection);
    const other = db.createConversation(crypto.randomUUID(), "other", selection, LEGACY_USER_ID, project.id);
    const otherJob = db.createJob(crypto.randomUUID(), other.id, undefined, selection);
    const workspace = ensureTenantWorkspace(config.tenantRoot, LEGACY_USER_ID, c.id);
    const output = path.join(workspace, "outputs", "once.txt");
    const checkpoint = path.join(workspace, ".runtime", "jobs", job.id, "checkpoint.txt");
    const threadId = crypto.randomUUID();
    const prompts: string[] = [];
    let writes = 0;
    const fakeRun: TenantWorkerClient["run"] = async (request, callbacks) => {
      prompts.push(request.effectivePrompt);
      if (prompts.length > 1 && phase !== "before-acceptance") assert.equal(request.codexThreadId, threadId);
      if (phase !== "before-acceptance" || prompts.length > 1) {
        callbacks.onThreadStarted(threadId);
        callbacks.onProgress({ kind: "input_accepted", threadId, turnId: `turn-${prompts.length}` });
      }
      callbacks.onProgress({ kind: "status", label: "已开始分析" });
      if (prompts.length === 1) {
        fs.writeFileSync(checkpoint, "keep recovery state");
        if (phase === "after-tool") {
          fs.writeFileSync(output, "one durable result"); writes++;
          callbacks.onProgress({ kind: "command", label: "write once.txt", detail: "command completed" });
        }
        callbacks.onProgress({ kind: "error", label: "Reconnecting... 5/5" });
        throw new Error("workspace routing discovery failed");
      }
      assert.equal(fs.readFileSync(checkpoint, "utf8"), "keep recovery state");
      if (phase !== "after-tool") { fs.writeFileSync(output, "one durable result"); writes++; }
      return "routing recovered";
    };
    const publish = (id: string, type: string, payload: unknown) => { db.appendEvent(id, type, payload); };
    let runner = new CodexRunner(config, db, publish, gateway);
    (runner as unknown as { workerClient: unknown }).workerClient = { run: fakeRun };
    await runner.run(job.id, c.id, original, [], selection);
    assert.equal(db.getJob(job.id)?.status, "queued", db.getJob(job.id)?.error ?? "");
    assert.equal(db.getJob(job.id)?.error, null);
    assert.equal(runner.activeJobCount, 0);
    assert.equal(db.countRunningJobs(), 0);
    assert.equal(db.getJobRecoveryCheckpoint(job.id)?.reason, "upstream");
    assert.equal(db.listEvents(job.id).filter(e => e.event_type === "failed").length, 0);
    assert.equal(fs.existsSync(checkpoint), true);
    gateway.close(); db.close(); db = new AppDatabase(config.dataRoot);
    gateway = new RemoteWorkerGateway(config, db);
    assert.deepEqual(db.listRunnableQueuedJobs().map(j => j.id), [otherJob.id]);
    const state = db.getJobAttemptState(job.id)!;
    assert.equal(state.retryKind, "routing");
    assert.equal(state.continuation, phase !== "before-acceptance");
    state.nextAttemptAt = "2000-01-01T00:00:00.000Z"; db.saveJobAttemptState(job.id, state);
    runner = new CodexRunner(config, db, publish, gateway);
    (runner as unknown as { workerClient: unknown }).workerClient = { run: fakeRun };
    await runner.run(job.id, c.id, original, [], selection);
    assert.equal(prompts.length, 2);
    assert.equal(writes, 1);
    if (phase === "before-acceptance") assert.match(prompts[1], /ONLY_ORIGINAL_REQUEST/);
    else { assert.doesNotMatch(prompts[1], /ONLY_ORIGINAL_REQUEST|模型容量不足/); assert.match(prompts[1], /路由|连接/); }
    assert.equal(db.getJob(job.id)?.status, "completed");
    assert.equal(db.getJob(job.id)?.finalization_state, "published");
    assert.equal(db.getJobAttemptState(job.id), undefined);
    assert.equal(db.listEvents(job.id).filter(e => e.event_type === "done").length, 1);
    assert.equal(db.sqlite.prepare("SELECT count(*) n FROM files WHERE conversation_id=?").get(c.id)?.n, 1);
    assert.ok(db.listRunnableQueuedJobs().some(j => j.id === later.id));
  });
}

test("routing recovery classifies provider failures without swallowing local or identity errors", () => {
  assert.equal(isUpstreamRoutingError(new Error("workspace routing discovery failed")), true);
  assert.equal(isRetryableUpstreamError("Workspace routing discovery failed: upstream unavailable"), true);
  for (const error of ["workspace not found", "workspace permission denied", "routing config invalid", "authentication failed"])
    assert.equal(isRetryableUpstreamError(error), false, error);
  assert.equal(isModelCapacityContinuationPrompt(UPSTREAM_ROUTING_CONTINUATION_PROMPT), true);
  assert.equal(isModelCapacityContinuationPrompt(UPSTREAM_ROUTING_CONTINUATION_PROMPT + "\nuser request"), false);
});
