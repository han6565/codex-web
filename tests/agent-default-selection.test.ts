import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import bcrypt from "bcryptjs";
import request from "supertest";
import { createApp } from "../server/app.js";
import { AppDatabase, LEGACY_USER_ID } from "../server/db.js";
import { ensureTenant } from "../server/paths.js";

const endpoint = "/api/user-settings/new-conversation-agent-selection";
const baseline = { model: "gpt-6.1-sol", reasoningEffort: "medium" };
const explicit = { model: "gpt-6-astra", reasoningEffort: "high" };

async function fixture(context: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-agent-default-"));
  const tenantRoot = path.join(root, "tenants");
  const instance = createApp({
    projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot, queueAutoStart: false,
    username: "pp", passwordHash: bcrypt.hashSync("Default-Selection-Test-2026!", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters",
  });
  context.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const catalog = path.join(ensureTenant(tenantRoot, LEGACY_USER_ID).codexHome, "models_cache.json");
  fs.writeFileSync(catalog, JSON.stringify({ models: ["gpt-6.1-sol", "gpt-6-astra"].map(slug => ({
    slug, display_name: slug, visibility: "list", input_modalities: ["text", "image"],
    supported_reasoning_levels: ["low", "medium", "high", "max"].map(effort => ({ effort })),
  })) }));
  const agent = request.agent(instance.app);
  const login = await agent.post("/api/auth/login").send({ username: "pp", password: "Default-Selection-Test-2026!" }).expect(200);
  const csrf = login.body.csrfToken as string;
  const create = (reuseEmpty = true) => agent.post("/api/conversations").set("X-CSRF-Token", csrf).send({ reuseEmpty });
  return { root, instance, agent, csrf, create, catalog };
}

test("a persisted new-conversation default survives explicit choices, empty-task reuse and a fresh login without changing snapshots", async context => {
  const { root, instance, agent, csrf, create, catalog } = await fixture(context);
  const older = (await create(false).expect(201)).body.conversation;
  await agent.put(`/api/conversations/${older.id}/agent-selection`).set("X-CSRF-Token", csrf).send(explicit).expect(200);
  const running = instance.db.createJob(crypto.randomUUID(), older.id, undefined, explicit);
  instance.db.updateJob(running.id, "running");
  const queued = instance.db.createJob(crypto.randomUUID(), older.id, undefined, explicit);
  const pending = instance.db.createPendingPrompt(crypto.randomUUID(), older.id, "isolated pending test", explicit);
  const wake = instance.db.createWakePlan({
    id: crypto.randomUUID(), conversationId: older.id, mode: "after", label: "isolated wake test",
    deadlineAt: "2099-01-01T00:00:00.000Z", successPrompt: "test", failurePrompt: "test", timeoutPrompt: "test",
    newConversation: true, selection: explicit,
  });
  const snapshots = () => ({
    old: instance.db.getConversation(older.id), running: instance.db.getJob(running.id), queued: instance.db.getJob(queued.id),
    pending: instance.db.listPendingPrompts(older.id).find(item => item.id === pending.id),
    wake: instance.db.getWakePlan(wake.id), target: instance.db.getConversation(wake.target_conversation_id!),
  });
  const before = snapshots();
  await agent.put(endpoint).set("X-CSRF-Token", csrf).send(baseline).expect(200, { selection: baseline });
  assert.deepEqual(snapshots(), before);
  assert.deepEqual((await agent.get("/api/agent-options").expect(200)).body.selection, baseline);
  const first = await create().expect(201);
  assert.deepEqual(first.body.agentSelection, baseline);
  await agent.put(`/api/conversations/${first.body.conversation.id}/agent-selection`)
    .set("X-CSRF-Token", csrf).send(explicit).expect(200);
  const [second, duplicate] = await Promise.all([create(), create()]);
  assert.deepEqual([second.status, duplicate.status].sort(), [200, 201]);
  assert.equal(second.body.conversation.id, duplicate.body.conversation.id);
  assert.notEqual(second.body.conversation.id, first.body.conversation.id);
  assert.deepEqual(second.body.agentSelection, baseline);
  assert.deepEqual((await agent.get(`/api/conversations/${first.body.conversation.id}`).expect(200)).body.agentSelection, explicit);
  assert.deepEqual(snapshots(), before);

  // Explicit account recent-choice writes are independent of the pinned default.
  await agent.put("/api/agent-selection").set("X-CSRF-Token", csrf).send(explicit).expect(200);
  assert.deepEqual((await create(false).expect(201)).body.agentSelection, baseline);
  const fresh = request.agent(instance.app);
  const login = await fresh.post("/api/auth/login").send({ username: "pp", password: "Default-Selection-Test-2026!" }).expect(200);
  assert.deepEqual((await fresh.get(endpoint).expect(200)).body.selection, baseline);
  assert.deepEqual((await fresh.post("/api/conversations").set("X-CSRF-Token", login.body.csrfToken)
    .send({ reuseEmpty: false }).expect(201)).body.agentSelection, baseline);
  const reopened = new AppDatabase(path.join(root, "data"), undefined, false);
  try { assert.deepEqual(reopened.getNewConversationAgentSelection(LEGACY_USER_ID), baseline); }
  finally { reopened.close(); }

  // A missing catalog can repair a new conversation, but never erase the baseline.
  const originalCatalog = fs.readFileSync(catalog);
  fs.unlinkSync(catalog);
  await create(false).expect(201);
  await agent.get(endpoint).expect(200, { selection: baseline });
  fs.writeFileSync(catalog, originalCatalog);
  assert.deepEqual((await create(false).expect(201)).body.agentSelection, baseline);
  assert.deepEqual(snapshots(), before);
});

test("new-conversation defaults are authenticated, validated, isolated and opt-in", async context => {
  const { instance, agent, csrf, create } = await fixture(context);
  await request(instance.app).get(endpoint).expect(401);
  await agent.put(endpoint).send(baseline).expect(403);
  await agent.delete(endpoint).expect(403);
  for (const invalid of [{}, { ...baseline, model: "unknown-model" }, { ...baseline, reasoningEffort: "invalid" },
    { ...baseline, userId: "someone-else" }, { ...baseline, model: 7 }]) {
    await agent.put(endpoint).set("X-CSRF-Token", csrf).send(invalid).expect(400);
  }
  await agent.get(endpoint).expect(200, { selection: null });
  const otherId = crypto.randomUUID();
  const now = new Date().toISOString();
  instance.db.createUser({ id: otherId, username: "other", display_name: "Other", role: "member", status: "active",
    password_hash: bcrypt.hashSync("Other-Default-Test-2026!", 8), created_at: now, updated_at: now });
  const other = request.agent(instance.app);
  const otherLogin = await other.post("/api/auth/login").send({ username: "other", password: "Other-Default-Test-2026!" }).expect(200);
  await agent.put(endpoint).set("X-CSRF-Token", csrf).send(baseline).expect(200);
  await other.get(endpoint).expect(200, { selection: null });
  const otherChoice = { model: "gpt-5.6-luna", reasoningEffort: "low" };
  const otherConversation = (await other.post("/api/conversations").set("X-CSRF-Token", otherLogin.body.csrfToken).expect(201)).body.conversation;
  await other.put(`/api/conversations/${otherConversation.id}/agent-selection`)
    .set("X-CSRF-Token", otherLogin.body.csrfToken).send(otherChoice).expect(200);
  assert.deepEqual((await other.post("/api/conversations").set("X-CSRF-Token", otherLogin.body.csrfToken)
    .send({ reuseEmpty: false }).expect(201)).body.agentSelection, otherChoice);
  await agent.get(endpoint).expect(200, { selection: baseline });
  await agent.put("/api/agent-selection").set("X-CSRF-Token", csrf).send(explicit).expect(200);
  await agent.delete(endpoint).set("X-CSRF-Token", csrf).expect(204);
  await agent.get(endpoint).expect(200, { selection: null });
  assert.deepEqual((await create(false).expect(201)).body.agentSelection, explicit);
});
