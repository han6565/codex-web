import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import bcrypt from "bcryptjs";
import request from "supertest";
import { createApp } from "../server/app.js";
import type { FileRow } from "../server/db.js";
import { prepareFinalizationFiles } from "../server/job-finalization.js";
import { validateWebDocument, parsePresentationDeclaration, WEB_MAX_BYTES } from "../server/web-presentation.js";

const html = '<!doctype html><meta charset="utf-8"><meta name="pp-agent-view" content="web"><title>交互作品</title><style>body{color:#123}</style><button onclick="this.textContent=\'已点击\'">点击</button><script type="application/json">{"items":[1]}</script><script>window.ready=true</script>';
const digest = (body: string | Buffer) => crypto.createHash("sha256").update(body).digest("hex");

test("web manifest registers the complete inline package and rejects unsupported dependencies", () => {
  const manifest = validateWebDocument(Buffer.from(html), "demo.html");
  assert.equal(manifest.title, "交互作品");
  assert.deepEqual(manifest.members, [{ name: "demo.html", size: Buffer.byteLength(html), sha256: digest(html) }]);
  assert.equal(validateWebDocument(Buffer.from('<style>@font-face{font-family:test;src:url(data:application/font-woff;base64,AA==)}</style>'), "font.html").inline.fonts, 1);
  assert.equal(manifest.inline.scripts, 2); assert.equal(manifest.inline.data, 1);
  for (const fragment of ['<script src="app.js"></script>', '<link rel="stylesheet" href="style.css">', '<img src="pic.png">', '<style>@import "https://a.test/a.css";</style>', '<style>body{background:url(https://a.test/a)}</style>', '<iframe srcdoc="hello"></iframe>', '<form action="/api/action"></form>', '<a href="https://a.test">外部</a>', '<meta name="pp-agent-view" content="reader">']) {
    assert.throws(() => validateWebDocument(Buffer.from(html + fragment), "bad.html"), undefined, fragment);
  }
  assert.throws(() => validateWebDocument(Buffer.alloc(WEB_MAX_BYTES + 1), "big.html"));
  assert.throws(() => validateWebDocument(Buffer.from([0xff]), "bad.html"));
  assert.throws(() => parsePresentationDeclaration('{"presentation_mode":"unknown","sha256":"x"}'));
  assert.throws(() => parsePresentationDeclaration(`{"presentation_mode":"reader","presentation_mode":"web","sha256":"${'0'.repeat(64)}"}`), /重复/);
});

test("managed delivery requires a matching explicit declaration; hints, upload and transport corruption do not upgrade execution", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pp-web-delivery-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  function source(name: string, body: string) {
    const id = crypto.randomUUID(), absolute = path.join(root, id);
    fs.writeFileSync(absolute, body);
    return { row: { id, conversation_id: crypto.randomUUID(), message_id: null, original_name: name, relative_path: `deliverables/${id}/${name}`, mime_type: name.endsWith("html") ? "text/html" : "application/json", size: Buffer.byteLength(body), kind: "output", created_at: new Date().toISOString() } as FileRow, sourcePath: absolute, expectedSha256: digest(body) };
  }
  const { files: hinted } = await prepareFinalizationFiles(root, crypto.randomUUID(), [source("hint.html", html)]);
  assert.equal(hinted[0].presentation_mode, "reader");
  const { files: declared } = await prepareFinalizationFiles(root, crypto.randomUUID(), [source("demo.html", html), source("demo.html.pp-agent.json", JSON.stringify({ presentation_mode: "web", sha256: digest(html) }))]);
  assert.equal(declared.length, 1); assert.equal(declared[0].presentation_mode, "web");
  assert.equal(JSON.parse(declared[0].presentation_manifest!).members[0].sha256, digest(html));
  const rejected = await prepareFinalizationFiles(root, crypto.randomUUID(), [source("bad.html", html), source("bad.html.pp-agent.json", JSON.stringify({ presentation_mode: "web", sha256: "0".repeat(64) }))]);
  assert.equal(rejected.files[0].presentation_mode, "reader"); assert.equal(rejected.files[0].presentation_manifest, null);
  assert.match(rejected.warnings[0].reason, /SHA-256/);
  const corrupt = source("corrupt.html", html); corrupt.expectedSha256 = "0".repeat(64);
  await assert.rejects(prepareFinalizationFiles(root, crypto.randomUUID(), [corrupt]), /hash mismatch/);
});

test("real routes enforce private ownership, immutable versions, share revisions, no-touch metadata and cold gates", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pp-web-routes-")), dataRoot = path.join(root, "data");
  const instance = createApp({ projectRoot: process.cwd(), dataRoot, tenantRoot: path.join(root, "tenants"), username: "pp", passwordHash: bcrypt.hashSync("Test-password-2026!", 4), sessionSecret: "test-secret-with-at-least-thirty-two-characters", queueAutoStart: false, publicBaseUrl: "https://agent.test" });
  t.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const db = instance.db, conversation = db.createConversation(crypto.randomUUID(), "web tests"), messageId = crypto.randomUUID(), now = new Date().toISOString();
  db.addMessage({ id: messageId, conversation_id: conversation.id, role: "assistant", content: "test", created_at: now });
  const id = crypto.randomUUID(), relative = `deliverables/${id}/demo.html`, absolute = path.join(dataRoot, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true }); fs.writeFileSync(absolute, html);
  db.addFile({ id, conversation_id: conversation.id, message_id: messageId, original_name: "demo.html", relative_path: relative, mime_type: "text/html", size: Buffer.byteLength(html), sha256: digest(html), kind: "output", created_at: now, presentation_mode: "web", presentation_manifest: JSON.stringify(validateWebDocument(Buffer.from(html), "demo.html")) });
  const owner = request.agent(instance.app), guest = request(instance.app);
  const login = await owner.post("/api/auth/login").send({ username: "pp", password: "Test-password-2026!" }).expect(200);
  const csrf = login.body.csrfToken;
  const outsiderId = crypto.randomUUID();
  db.createUser({ id: outsiderId, username: "outsider", display_name: "Outsider", password_hash: bcrypt.hashSync("Other-password-2026!", 4), role: "member", status: "active", created_at: now, updated_at: now });
  const outsider = request.agent(instance.app);
  const otherLogin = await outsider.post("/api/auth/login").send({ username: "outsider", password: "Other-password-2026!" }).expect(200);
  for (const endpoint of ["share", "preview", "web-session"]) await outsider.get(`/api/files/${id}/${endpoint}`).expect(404);
  await outsider.post(`/api/files/${id}/share`).set("X-CSRF-Token", otherLogin.body.csrfToken).expect(404);
  await outsider.post(`/api/files/${id}/presentation-version`).set("X-CSRF-Token", otherLogin.body.csrfToken).send({ presentation_mode: "web" }).expect(404);

  await guest.get(`/api/files/${id}/share`).expect(401);
  await guest.get(`/api/files/${id}/web-session/public`).expect(404);
  db.sqlite.prepare("UPDATE conversations SET last_active_at='2020-01-01T00:00:00.000Z' WHERE id=?").run(conversation.id);
  const metadata = (await owner.get(`/api/files/${id}/share`).expect(200)).body;
  assert.equal(metadata.share.status, "private");
  assert.equal(db.getConversation(conversation.id)?.last_active_at, "2020-01-01T00:00:00.000Z");
  const privateRun = (await owner.get(`/api/files/${id}/web-session?presentation_mode=reader`).expect(200)).body;
  await guest.get(privateRun.src).expect(404);
  const content = await owner.get(privateRun.src).set("Sec-Fetch-Dest", "iframe").expect(200);
  assert.match(content.headers["content-security-policy"], /sandbox allow-scripts/);
  assert.doesNotMatch(content.headers["content-security-policy"], /allow-same-origin/);
  await owner.get(privateRun.src).set("Sec-Fetch-Dest", "document").expect(404);
  await owner.get(`/api/files/${id}/preview/content`).expect(415);
  await owner.get(`/api/reader/files/${id}/manifest`).expect(415);
  await owner.post(`/api/files/${id}/share`).expect(403);
  const enabled = (await owner.post(`/api/files/${id}/share`).set("X-CSRF-Token", csrf).expect(200)).body.share;
  const publicRun = (await guest.get(`/api/files/${id}/web-session/public`).expect(200)).body;
  await guest.get(publicRun.src).expect(200); await guest.head(publicRun.src).expect(204);
  assert.equal((await guest.get(`/api/files/${id}/preview/public`).expect(200)).body.file.presentation_mode, "web");
  assert.equal((await guest.get(`/api/files/${id}/preview/public`).expect(200)).body.content, null);
  const v2 = (await owner.post(`/api/files/${id}/presentation-version`).set("X-CSRF-Token", csrf).send({ presentation_mode: "reader" }).expect(201)).body;
  assert.notEqual(v2.file.id, id); assert.equal(v2.share.enabled, false); assert.equal(v2.file.previous_file_id, id);
  assert.equal(db.getFile(id)?.presentation_mode, "web"); assert.equal(db.getPublicFileShare(id)?.expires_at, enabled.expiresAt);
  await owner.get(`/api/files/${v2.file.id}/web-session?presentation_mode=web`).expect(404);
  assert.throws(() => db.sqlite.prepare("UPDATE files SET presentation_mode='reader' WHERE id=?").run(id), /immutable/);
  await owner.delete(`/api/files/${id}/share`).set("X-CSRF-Token", csrf).expect(200);
  await guest.get(publicRun.src).expect(404); await guest.head(publicRun.src).expect(404);
  const reopened = (await owner.post(`/api/files/${id}/share`).set("X-CSRF-Token", csrf).expect(200)).body.share;
  assert.equal(reopened.publicUrl, enabled.publicUrl); await guest.get(publicRun.src).expect(404);
  const newRun = (await guest.get(`/api/files/${id}/web-session/public`).expect(200)).body;
  db.sqlite.prepare("UPDATE public_file_shares SET expires_at=? WHERE file_id=?").run(new Date(Date.now() - 1).toISOString(), id);
  await guest.get(newRun.src).expect(404); await guest.head(`/api/files/${id}/preview/public`).expect(404);
  const listed = (await owner.get("/api/public-shares").expect(200)).body.shares;
  assert.ok(listed.some((item: { fileId: string }) => item.fileId === id));
  db.transitionConversationStorage(conversation.id, ["local"], "uploading", "test");
  await owner.post(`/api/files/${id}/share`).set("X-CSRF-Token", csrf).expect(409);
  const beforeStorage = db.getConversationStorage(conversation.id);
  await owner.get(`/api/files/${id}/share`).expect(200); await owner.get("/api/public-shares").expect(200);
  assert.deepEqual(db.getConversationStorage(conversation.id), beforeStorage);
  // Private ticket is checked against the current session on every request.
  db.sqlite.prepare("DELETE FROM sessions").run();
  await owner.get(privateRun.src).expect(404);
});
