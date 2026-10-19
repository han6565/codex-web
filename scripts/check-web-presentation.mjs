import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import bcrypt from 'bcryptjs';
import { createApp } from '../dist-server/server/app.js';
import { webFixtures } from './web-presentation-fixtures.mjs';
import { run } from './web-presentation-scenario.mjs';
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const root = fs.mkdtempSync(path.join(process.env.TEST_RUNTIME || os.tmpdir(), 'share-expiry-'));
const shortTemp = `/tmp/share-expiry-${crypto.randomUUID()}`;
fs.symlinkSync(root, shortTemp, 'dir');
const password = crypto.randomUUID();
const dataRoot = path.join(root, 'data');
const instance = createApp({ projectRoot: process.cwd(), dataRoot, tenantRoot: path.join(root, 'tenants'),
  codexHome: path.join(root, 'codex'), hostRootCodexHome: path.join(root, 'host-codex'), hostRootSocketPath: path.join(root, 'no-host.sock'),
  basePath: '/codex-web', queueAutoStart: false, username: 'pp', passwordHash: bcrypt.hashSync(password, 4), sessionSecret: crypto.randomBytes(32).toString('hex') });
const testUser=instance.db.sqlite.prepare("SELECT id FROM users WHERE username='pp'").get();
instance.db.setFeatureSelection(testUser.id,{...instance.db.getFeatureSelection(testUser.id),paraBoard:true});
const server = instance.app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const origin = `http://127.0.0.1:${server.address().port}/codex-web`;
let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
    ignoreDefaultArgs: ['--disable-dev-shm-usage'], args: ['--disable-gpu'], env: { ...process.env, TMPDIR: shortTemp } });
  const context = await browser.newContext({permissions:['clipboard-read','clipboard-write']});
  assert.equal((await context.request.post(origin + '/api/auth/login', { data: { username: 'pp', password } })).status(), 200);
  const results = await run({ page: await context.newPage(), context, origin, assert, work: root, fixtures: webFixtures(dataRoot,root) });
  fs.writeFileSync(path.join(root, 'checks.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ ok: true, results, work: root }));
} finally {
  await browser?.close();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  instance.db.close(); fs.unlinkSync(shortTemp);
  fs.rmSync(dataRoot, { recursive: true, force: true });
}
