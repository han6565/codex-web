import fs from 'node:fs';
import path from 'node:path';

// Uses only recorded fixtures; internal projects now stay in the board workspace.
export async function run({ page, context, origin, work, assert }) {
  const report = { checks: [], boards: [], projects: [], errors: [], cleanup: false };
  const save = () => fs.writeFileSync(path.join(work, 'para-sidebar-search.json'), JSON.stringify(report, null, 2));
  const session = await (await context.request.get(origin + '/api/auth/session')).json();
  const api = async (method, route, data) => {
    const r = await context.request.fetch(origin + '/api' + route, { method, data, headers: { 'X-CSRF-Token': session.csrfToken } });
    assert.ok(r.ok(), method + ' ' + route + ': ' + r.status()); return r.status() === 204 ? null : r.json();
  };
  const originalFeatures = await api('GET', '/user-settings/features');
  const setFeatures = async values => { const current = await api('GET', '/user-settings/features'); await api('PUT', '/user-settings/features', { ...current, ...values }); };
  const stamp = Date.now().toString().slice(-8), name = '侧栏验收-' + stamp, projectName = '内部项目-' + stamp;
  const search = page.getByRole('textbox', { name: '搜索', exact: true });
  const group = page.locator('[data-extension-group="boards"]');
  const row = id => group.locator('[data-board-id="' + id + '"]');
  const until = async fn => { const end = Date.now() + 15000; do { if (await fn()) return; await page.waitForTimeout(100); } while (Date.now() < end); assert.fail('condition timed out'); };
  try {
    if (!originalFeatures.paraBoard) await setFeatures({ paraBoard: true });
    for (const suffix of ['', '-第二']) {
      const board = (await api('POST', '/para/boards', { key: crypto.randomUUID(), name: name + suffix })).board;
      report.boards.push(board.id); save();
    }
    const boardId = report.boards[0], otherId = report.boards[1];
    const project = (await api('POST', '/para/boards/' + boardId + '/projects', { key: crypto.randomUUID(), title: projectName })).project;
    report.projects.push(project.id); save();
    await page.reload(); await search.waitFor();
    if (await group.locator('.extension-toggle').getAttribute('aria-expanded') !== 'true') await group.locator('.extension-toggle').click();
    await row(boardId).locator('.para-sidebar-item').click();
    await page.locator('.para-workspace:visible').getByRole('heading', { name, exact: true }).waitFor();
    assert.equal(await row(boardId).locator('.para-sidebar-toggle').count(), 0);
    assert.equal(await group.locator('[data-para-project]').count(), 0);
    report.checks.push('board_opens_workspace_without_nested_project_tree');
    await search.fill(projectName);
    await row(boardId).waitFor(); await row(otherId).waitFor({ state: 'hidden' });
    assert.equal(await group.locator('[data-para-project]').count(), 0);
    await search.fill(''); await row(otherId).waitFor();
    await row(otherId).getByRole('button', { name: '拖动看板 ' + name + '-第二', exact: true }).focus(); await page.keyboard.press('ArrowUp');
    await until(async () => { const boards = (await api('GET', '/para/sidebar')).boards; return boards.findIndex(b => b.id === otherId) < boards.findIndex(b => b.id === boardId); });
    report.checks.push('project_search_reveals_parent_board_and_board_order_still_persists');
    await row(boardId).getByRole('button', { name: '看板 ' + name + ' 操作', exact: true }).click();
    await page.getByRole('menuitem', { name: '改名', exact: true }).click();
    const dialog = page.getByRole('dialog'); await dialog.getByRole('textbox').fill(name + '-改名'); await dialog.getByRole('button', { name: '保存名称', exact: true }).click();
    await row(boardId).locator('.para-sidebar-item').filter({ hasText: name + '-改名' }).waitFor();
    await row(boardId).getByRole('button', { name: '看板 ' + name + '-改名 操作', exact: true }).click(); await page.getByRole('menuitem', { name: '归档看板', exact: true }).click(); await row(boardId).waitFor({ state: 'hidden' });
    await group.getByRole('button', { name: '查看归档看板', exact: true }).click(); await row(boardId).waitFor();
    await row(boardId).getByRole('button', { name: '看板 ' + name + '-改名 操作', exact: true }).click(); await page.getByRole('menuitem', { name: '恢复看板', exact: true }).click();
    await until(async () => !(await api('GET', '/para/boards/' + boardId)).board.archived_at);
    report.checks.push('board_rename_archive_restore_menus_preserved');
    assert.equal((await api('GET', '/para/projects/' + project.id)).project.title, projectName);
    report.ok = true;
  } catch (e) { report.error = e.message; throw e; }
  finally {
    const cleanupErrors = [];
    for (const id of report.boards) {
      try {
        const data = await api('GET', '/para/boards/' + id);
        for (const p of data.projects) {
          if (!report.projects.includes(p.id)) throw new Error('Unexpected fixture project');
          const archived = p.archived_at ? p : (await api('PATCH', '/para/projects/' + p.id, { revision: p.revision, archived: true })).project;
          await api('DELETE', '/para/projects/' + p.id, { revision: archived.revision });
        }
        const board = data.board.archived_at ? data.board : (await api('PATCH', '/para/boards/' + id, { revision: data.board.revision, archived: true })).board;
        await api('DELETE', '/para/boards/' + id, { revision: board.revision });
      } catch (e) { cleanupErrors.push(e.message); }
    }
    try { if (!originalFeatures.paraBoard) await setFeatures({ paraBoard: false }); } catch (e) { cleanupErrors.push(e.message); }
    report.cleanup = !cleanupErrors.length; report.cleanupErrors = cleanupErrors; save(); assert.ok(report.cleanup, 'fixture cleanup');
  }
}
