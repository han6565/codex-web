import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import bcrypt from "bcryptjs";
import request from "supertest";
import { createApp } from "../server/app.js";
import { LEGACY_USER_ID } from "../server/db.js";

test("project unread acknowledgement covers all pages, preserves scope and allows new results", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-project-unread-"));
  const instance = createApp({
    projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot: path.join(root, "tenants"),
    username: "pp", passwordHash: bcrypt.hashSync("project-unread-test", 8),
    sessionSecret: "project-unread-test-secret-over-thirty-two-characters", queueAutoStart: false,
  });
  const db = instance.db;
  context.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const agent = request.agent(instance.app);
  const login = await agent.post("/api/auth/login").send({ username: "pp", password: "project-unread-test" }).expect(200);
  const csrf = login.body.csrfToken;
  const project = db.createProject(crypto.randomUUID(), LEGACY_USER_ID, "target", path.join(root, "target"), "remote:offline-worker");
  const other = db.createProject(crypto.randomUUID(), LEGACY_USER_ID, "other", path.join(root, "other"));
  const foreignUser = { ...db.getUser(LEGACY_USER_ID)!, id: crypto.randomUUID(), username: "another", phone: null };
  db.createUser(foreignUser);
  const foreign = db.createProject(crypto.randomUUID(), foreignUser.id, "foreign", path.join(root, "foreign"));
  function complete(projectId: string, userId = LEGACY_USER_ID) {
    const conversation = db.createConversation(crypto.randomUUID(), "result", undefined, userId, projectId);
    const jobId = crypto.randomUUID();
    db.createJob(jobId, conversation.id);
    db.finishJob(jobId, conversation.id, "completed", null, "unread result");
    return db.getConversation(conversation.id)!;
  }
  const tasks = Array.from({ length: 45 }, () => complete(project.id));
  db.setConversationPinnedForUser(tasks[0].id, LEGACY_USER_ID, true);
  db.archiveConversationForUser(tasks[1].id, LEGACY_USER_ID);
  const otherTask = complete(other.id);
  const foreignTask = complete(foreign.id, foreignUser.id);
  const runningJob = crypto.randomUUID();
  db.createJob(runningJob, tasks[2].id);
  const before = tasks.map(task => db.getConversation(task.id)!);
  const seenUrl = `/api/projects/${project.id}/seen`;
  await request(instance.app).post(seenUrl).expect(401);
  await agent.post(seenUrl).expect(403);
  await agent.post(`/api/projects/${foreign.id}/seen`).set("X-CSRF-Token", csrf).expect(404);
  await agent.post("/api/projects/missing/seen").set("X-CSRF-Token", csrf).expect(404);
  const cleared = await agent.post(seenUrl).set("X-CSRF-Token", csrf).expect(200);
  assert.equal(cleared.body.updatedCount, 45);
  for (const previous of before) {
    const current = db.getConversation(previous.id)!;
    assert.equal(current.has_unread_result, 0);
    assert.equal(current.unread_anchor_message_id, null);
    for (const key of ["updated_at", "last_active_at", "sidebar_order", "pinned_at", "status", "archived_at"] as const) {
      assert.equal(current[key], previous[key], key);
    }
    assert.equal(db.listMessages(previous.id).length, 1);
  }
  assert.equal(db.getConversation(otherTask.id)?.has_unread_result, 1);
  assert.equal(db.getConversation(foreignTask.id)?.has_unread_result, 1);
  assert.equal((await agent.post(seenUrl).set("X-CSRF-Token", csrf).expect(200)).body.updatedCount, 0);
  db.finishJob(runningJob, tasks[2].id, "completed", null, "new unread result");
  const latest = db.getConversation(tasks[2].id)!;
  assert.equal(latest.has_unread_result, 1);
  assert.equal(latest.unread_anchor_message_id, db.listMessages(latest.id).at(-1)!.id);
  assert.notEqual(latest.unread_anchor_message_id, before[2].unread_anchor_message_id);
  const page = await agent.get(`/api/conversations?projectId=${project.id}&limit=100`).expect(200);
  assert.equal(page.body.conversations.filter((task: { has_unread_result: number }) => task.has_unread_result).length, 1);
  db.archiveProjectForUser(other.id, LEGACY_USER_ID);
  await agent.post(`/api/projects/${other.id}/seen`).set("X-CSRF-Token", csrf).expect(404);
  assert.equal(db.getConversation(otherTask.id)?.has_unread_result, 1);
});
