import { checkCrossAccount } from './web-cross-account-check.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { webFixtures } from './web-presentation-fixtures.mjs';
export async function run({page,context,origin,work,assert,fixtures}) {
  assert.ok(fixtures, 'Provide isolated webFixtures explicitly');
  const session=await(await context.request.get(origin+'/api/auth/session')).json();
  const headers={'X-CSRF-Token':session.csrfToken,Origin:new URL(origin).origin};
  const guest=await context.browser().newContext(), publicPage=await guest.newPage();
  const checks=[], conversations=[];
  async function api(url,method='GET',data){const r=await context.request.fetch(origin+'/api'+url,{method,headers,data});assert.ok(r.ok(),`${method} ${url}: ${r.status()}`);return r.status()===204?null:r.json();}
  let stage='setup';
  try {
    page.setDefaultTimeout(15000);publicPage.setDefaultTimeout(15000);
    const {conversation}=await api('/conversations','POST',{reuseEmpty:false});conversations.push(conversation.id);
    await api('/conversations/'+conversation.id,'PATCH',{title:'web-acceptance-'+Date.now()});
    const files=await fixtures.seed(conversation.id,session.accountId), web=files[0];
    await page.addInitScript(({account,project,id})=>{const prefix=`cww:account:${encodeURIComponent(account)}:`;localStorage.setItem('codex-web:theme','system');localStorage.setItem(prefix+'selected-project',project);localStorage.setItem(prefix+'selected-conversation',id);},{account:session.accountId,project:conversation.project_id,id:conversation.id});
    for(const width of [1440,768,390,320]){
      stage=`card-${width}`;await page.emulateMedia({colorScheme:width<=390?"dark":"light"});await page.setViewportSize({width,height:900});await page.goto(origin);await page.locator('.file-card').filter({hasText:web.original_name}).waitFor();
      for(const file of files){
        const card=page.locator('.file-card').filter({hasText:file.original_name});
        const before=fixtures.activity(conversation.id);const pages=context.pages().length;
        await card.getByRole('button',{name:'分享 '+file.original_name,exact:true}).click();
        const panel=page.getByRole('dialog',{name:'公开分享',exact:true});await panel.getByText('开启公开分享（30 天）',{exact:true}).waitFor();
        assert.equal(context.pages().length,pages);assert.equal((await api(`/files/${file.id}/share`)).share.enabled,false);assert.equal(fixtures.activity(conversation.id),before);
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
        if(await card.getByRole('button',{name:'加入项目',exact:true}).count()) assert.equal(await card.getByRole('button',{name:'加入项目',exact:true}).evaluate(e=>e.getBoundingClientRect().height>=44),true);
        assert.equal(await card.locator('.share-button').evaluate(e=>e.getBoundingClientRect().width>=44&&e.getBoundingClientRect().height>=44),true);
        if(file.id===web.id)await panel.screenshot({path:path.join(work,`share-${width}.png`)});
        await page.keyboard.press('Escape');await panel.waitFor({state:'detached'});
        assert.equal(await card.locator('.share-button').evaluate(e=>e===document.activeElement),true);
      }
      await page.locator('.file-card').filter({hasText:web.original_name}).screenshot({path:path.join(work,`card-${width}.png`)});
      const collect=page.locator('.file-card').filter({hasText:web.original_name}).locator('.para-collect');
      if(await collect.count()) {assert.equal(await collect.evaluate(e=>e.getBoundingClientRect().height>=44&&e.getBoundingClientRect().width>=44),true);await collect.click();await page.locator('dialog.para-dialog').getByRole('heading',{name:'加入项目',exact:true}).waitFor();await page.keyboard.press('Escape');}
      assert.equal(await page.locator('html').getAttribute('data-theme'),width<=390?'dark':'light');

      checks.push(`${width}px: three card types, private panel, no activity or popup, 44px controls, focus and width`);
    }
    stage='private runtime';
    const popup=page.waitForEvent('popup');await page.locator('.file-card').filter({hasText:web.original_name}).getByRole('link',{name:'打开 '+web.original_name,exact:true}).click();
    const privatePage=await popup;await exercise(privatePage);await checkCrossAccount({context,origin,work,assert,fileId:web.id,privateSrc:await privatePage.locator('.web-presentation iframe').getAttribute('src')});checks.push('private: real controls, no shell, opaque origin, network/storage/parent blocked, export confirmation');
    stage='sharing';
    await page.getByRole('button',{name:'分享 '+web.original_name,exact:true}).click();
    const panel=page.getByRole('dialog',{name:'公开分享',exact:true});await panel.getByRole('button',{name:'开启公开分享（30 天）',exact:true}).click();
    const link=panel.getByRole('textbox',{name:'公开链接'});await link.waitFor();const publicUrl=await link.inputValue();
    await panel.getByRole('button',{name:'复制链接',exact:true}).click();await panel.getByRole('button',{name:'已复制',exact:true}).waitFor();
    await publicPage.goto(publicUrl);await exercise(publicPage);
    const oldSrc=await publicPage.locator('.web-presentation iframe').getAttribute('src');
    await panel.getByRole('button',{name:'关闭分享',exact:true}).click();await panel.getByText('已关闭',{exact:true}).waitFor();
    assert.equal((await guest.request.get(origin+oldSrc)).status(),404);assert.equal((await guest.request.head(origin+oldSrc)).status(),404);
    await publicPage.evaluate(()=>window.dispatchEvent(new Event('focus')));await publicPage.locator('.web-presentation iframe').waitFor({state:'detached'});
    await panel.getByRole('button',{name:'重新开启分享（30 天）',exact:true}).click();await link.waitFor();assert.equal(await link.inputValue(),publicUrl);
    assert.equal((await guest.request.get(origin+oldSrc)).status(),404);
    await publicPage.goto(publicUrl);await publicPage.frameLocator('.web-presentation iframe').locator('#add').waitFor();
    fixtures.setExpiry(web.id,new Date(Date.now()-1000).toISOString());
    assert.equal((await guest.request.head(`/api/files/${web.id}/preview/public`.replace(/^/,origin))).status(),404);
    await publicPage.evaluate(()=>window.dispatchEvent(new Event('focus')));await publicPage.locator('.web-presentation iframe').waitFor({state:'detached'});
    await page.keyboard.press('Escape');await page.getByRole('button',{name:'分享 '+web.original_name,exact:true}).click();await panel.getByText('已到期',{exact:true}).waitFor();
    await panel.getByRole('button',{name:'重新开启分享（30 天）',exact:true}).click();await link.waitFor();
    await panel.getByRole('button',{name:'续期 30 天',exact:true}).click();await panel.getByText(/剩余 30 天/).waitFor();
    checks.push('anonymous: enable/copy, all controls, revoke unload, old tickets rejected, expiry and fixed URL reopen/renew');
    await page.keyboard.press('Escape');await privatePage.close();
    stage='readers';
    for(const file of files.slice(1)){
      await page.goto(origin+`/files/${file.id}/preview`);await page.locator('.reader-text-container').waitFor();
      assert.equal(await page.locator('.file-preview-header').count(),1);await page.locator('.file-reader-settings-button').click();assert.equal(await page.getByRole('menuitem',{name:'分享',exact:true}).count(),0);
      await page.screenshot({path:path.join(work,`reader-${file.id}.png`)});
    }
    checks.push('reports/Markdown: existing header, body, settings and outline retained; sharing removed from reader');
    stage='manager';await page.goto(origin);if(await page.getByRole('button',{name:'打开侧栏',exact:true}).isVisible())await page.getByRole('button',{name:'打开侧栏',exact:true}).click();await page.locator('.account-profile').click();await page.getByRole('button',{name:'公开分享管理',exact:true}).click();
    const row=page.locator('.public-share-row').filter({hasText:web.original_name});await row.getByRole('button',{name:'管理分享'}).click();await panel.getByRole('button',{name:'关闭分享',exact:true}).click();await panel.getByText('已关闭',{exact:true}).waitFor();await page.keyboard.press('Escape');await row.getByText('已关闭',{exact:true}).waitFor();
    checks.push('manager: same panel, close without opening document, closed item retained');
    await row.getByRole('button',{name:'管理分享'}).click();await panel.locator('summary').click();
    const versionResponse=page.waitForResponse(r=>r.url()===origin+`/api/files/${web.id}/presentation-version`&&r.request().method()==='POST');
    await panel.getByRole('button',{name:'按阅读文档重新交付',exact:true}).click();
    const version=await(await versionResponse).json();fixtures.trackVersion(version.file.id,web.id);
    assert.equal(version.file.presentation_mode,'reader');assert.equal(version.share.enabled,false);
    assert.equal((await api(`/files/${web.id}/share`)).file.presentation_mode,'web');assert.equal((await api(`/files/${web.id}/share`)).share.status,'closed');
    await panel.getByText('已生成新的私有版本，原文件与原分享保持原样。',{exact:true}).waitFor();
    checks.push('type correction: new private immutable version, original mode/link/state unchanged');

    return checks;
    async function exercise(p){
      await p.locator('.web-presentation iframe').waitFor();const f=p.frameLocator('.web-presentation iframe');await f.locator('#add').click();assert.equal(await f.locator('#count').innerText(),'1');await f.locator('#filter').fill('苹果');assert.equal(await f.locator('article').count(),1);await f.locator('#next').click();assert.equal(await f.locator('#cards').innerText(),'第二页');await f.locator('#reset').click();assert.equal(await f.locator('article').count(),3);await f.locator('summary').click();await f.locator('details[open]').waitFor();
      assert.equal(await p.locator('.file-preview-header,.sidebar,.reader-selection-layer,.file-reader-outline').count(),0);assert.equal(await p.title(),'交互验收作品');
      const isolation=await f.locator('body').evaluate(async()=>{let parentBlocked=false,storageBlocked=false,cookieBlocked=false,fetchBlocked=false;try{void parent.document.body}catch{parentBlocked=true}try{localStorage.setItem('probe','1')}catch{storageBlocked=true}try{void document.cookie}catch{cookieBlocked=true}try{await fetch('/api/projects')}catch{fetchBlocked=true}return{parentBlocked,storageBlocked,cookieBlocked,fetchBlocked,origin:self.origin}});
      assert.deepEqual(isolation,{parentBlocked:true,storageBlocked:true,cookieBlocked:true,fetchBlocked:true,origin:'null'});
      await f.locator('#export').click();const exportPanel=p.getByRole('dialog',{name:'保存网页导出文件'});await exportPanel.waitFor();const download=p.waitForEvent('download');await exportPanel.getByRole('button',{name:'下载文件',exact:true}).click();const d=await download;assert.equal(d.suggestedFilename(),'结果.json');await d.saveAs(path.join(work,`export-${crypto.randomUUID()}.json`));
    }
  }catch(error){await page.screenshot({path:path.join(work,'web-failure.png')}).catch(()=>{});fs.writeFileSync(path.join(work,'web-failure.txt'),stage+'\n'+error.stack);throw error;}
  finally{await page.goto('about:blank');await guest.close();const failures=[];for(const id of conversations){const r=await context.request.delete(origin+'/api/conversations/'+id,{headers});if(!r.ok())failures.push(r.status());}fixtures.close();assert.deepEqual(failures,[]);}
}
