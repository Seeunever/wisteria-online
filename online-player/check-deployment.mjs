import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {runtimeSettings} from './runtime-settings.mjs';
import {backupState,scheduleBackups} from './backup-state.mjs';
import {createApp} from './server.mjs';
import {createLibrary} from './library-server.mjs';
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'deployment-check-'));
const entry=path.join(temp,'release-link');fs.symlinkSync(process.cwd(),entry,process.platform==='win32'?'junction':'dir');
const viaLink=spawnSync(process.execPath,[path.join(entry,'server.mjs')],{env:{...process.env,APP_MODE:'invalid'},encoding:'utf8'});assert.equal(viaLink.status,1,'symlink entry runs startup validation');
const env={APP_MODE:'production',PUBLIC_ORIGIN:'https://game.example.test',SITE_ACCESS_CODE:'独立验收用',STATE_DIR:path.join(temp,'production'),BACKUP_DIR:path.join(temp,'backups')};
const config=runtimeSettings(env);
assert.equal(config.libraryOptions.testAssist,false);
assert.throws(()=>runtimeSettings({...env,SITE_ACCESS_CODE:''}));
assert.throws(()=>runtimeSettings({...env,SITE_ACCESS_CODE:'短口令'}));
assert.equal(runtimeSettings({}).libraryOptions.testAssist,true);
assert.ok(runtimeSettings({}).stateDir.endsWith(path.join('online-player','state')));
for(const invalid of [{TEST_ASSIST:'1'},{STATE_DIR:''},{STATE_DIR:path.resolve('state')},{STATE_DIR:'relative'},{PUBLIC_ORIGIN:'http://example.test'},{PUBLIC_ORIGIN:''},{PUBLIC_ORIGIN:'https://example.test/path'},{BACKUP_DIR:env.STATE_DIR},{BACKUP_DIR:''},{APP_MODE:'test',NODE_ENV:'production'}])assert.throws(()=>runtimeSettings({...env,...invalid}));
let server,browser;
const start=async options=>{server=createLibrary({createYingxie:createApp,...options});await new Promise(r=>server.listen(0,'127.0.0.1',r));return `http://127.0.0.1:${server.address().port}`};
const close=()=>new Promise(r=>server.close(r));
const specs=[{api:'/api/',book:'yingxie',role:'r02-qiqiao',file:'game.sqlite',url:'/yingxie/'},{api:'/ziteng/api/',book:'ziteng',role:'role-2',file:path.join('ziteng','game.sqlite'),url:'/ziteng/'}];
let base,accessCookie='';
async function call(spec,route,body,origin=env.PUBLIC_ORIGIN){
 const r=await fetch(base+spec.api+route,{headers:{connection:'close',cookie:[accessCookie,spec.cookie].filter(Boolean).join('; '),origin},...(body?{method:'POST',body:JSON.stringify(body)}:{})});
 const data=await r.json();return {status:r.status,data,cookie:r.headers.get('set-cookie')};
}
try{
 base=await start(config.libraryOptions);
 const gate=await fetch(base);assert.match(await gate.text(),/访问口令/);
 assert.equal((await call(specs[0],'login',{name:'未通过入口'})).status,401);
 const unlock=async code=>fetch(base+'/access',{method:'POST',redirect:'manual',headers:{origin:env.PUBLIC_ORIGIN,connection:'close'},body:new URLSearchParams({code})});
 const wrong=await unlock('wrong');assert.equal(wrong.status,403);await wrong.text();
 const unlocked=await unlock(env.SITE_ACCESS_CODE);assert.equal(unlocked.status,303);assert.match(unlocked.headers.get('set-cookie'),/; Secure/);accessCookie=unlocked.headers.get('set-cookie').split(';')[0];await unlocked.text();
 const genuine=accessCookie;accessCookie=accessCookie.slice(0,-1)+(accessCookie.endsWith('0')?'1':'0');assert.equal((await call(specs[0],'login',{name:'篡改口令会话'})).status,401);accessCookie=genuine;
 for(const spec of specs){
  const login=await call(spec,'login',{name:'部署验收'});assert.equal(login.status,200);assert.match(login.cookie,/; Secure/);assert.match(login.cookie,/HttpOnly/);spec.cookie=login.cookie.split(';')[0];
  assert.equal((await call(spec,'claim',{role:spec.role})).status,200);
  const second=await call(spec,'login',{name:'部署验收'});assert.equal((await call({...spec,cookie:second.cookie.split(';')[0]},'state')).data.role,spec.role);
  const s=(await call(spec,'state')).data;assert.equal(s.testAssist,false);assert.equal(s.roles.filter(r=>r.owner).length,1,'production starts without mock players');
  assert.equal((await call(spec,'test-assist',{confirmed:true})).status,404);
  assert.equal((await call(spec,'login',{name:'外站'},'https://other.example.test')).status,403);
  const confirmation=spec.book==='yingxie'?await call(spec,'ready',{phase:'act-1-reading'}):await call(spec,'action',{action:'ready',day:1,phase:'reading'});assert.equal(confirmation.status,200);
  const progress=(await call(spec,'state')).data;assert.ok((progress.flow?.ready||progress.progress.ready).includes(spec.role));
 }
 // Live WAL databases stay open while creating the snapshots.
 const folder=await backupState(env.STATE_DIR,env.BACKUP_DIR);assert.ok(fs.existsSync(path.join(folder,'complete.json')));
 for(const spec of specs){const d=new DatabaseSync(path.join(folder,spec.file),{readOnly:true});assert.equal(d.prepare('SELECT role FROM players WHERE name=?').get('部署验收').role,spec.role);assert.equal(d.prepare('PRAGMA quick_check').get().quick_check,'ok');d.close()}
 const timer=scheduleBackups(env.STATE_DIR,env.BACKUP_DIR,{intervalMs:20});await timer.run();await timer.stop();
 await close();base=await start(config.libraryOptions);
 for(const spec of specs)assert.equal((await call(spec,'state')).data.role,spec.role,'restart retains sessions and role');
 await close();
 const restored=path.join(temp,'restored');
 for(const spec of specs){const dest=path.join(restored,spec.file);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(path.join(folder,spec.file),dest,fs.constants.COPYFILE_EXCL)}
 base=await start(runtimeSettings({...env,STATE_DIR:restored}).libraryOptions);
 for(const spec of specs){const s=(await call(spec,'state')).data;assert.equal(s.role,spec.role,'backup restores both books and their sessions');assert.ok((s.flow?.ready||s.progress.ready).includes(spec.role),'backup restores committed game progress')}
 for(const route of ['/private/game.json','/state/game.sqlite','/backups/complete.json','/.env.production']){const r=await fetch(base+route,{headers:{cookie:accessCookie}});assert.equal(r.status,404);await r.text()}
 console.log('通过：共用口令门禁及签名会话、正式模式隔离、禁止测试接口、HTTPS配置与安全Cookie、代理来源检查、双端/重启保存、在线WAL备份及恢复、私有目录不开放。');
 await close();
 // Browser recovery on isolated state. This is not a claim of real-device or public HTTPS testing.
 for(const [yingxie,ziteng] of [['1','0'],['0','1'],['1','1']]){
  const assisted=runtimeSettings({...env,YINGXIE_TEST_ASSIST:yingxie,ZITENG_TEST_ASSIST:ziteng,STATE_DIR:path.join(temp,'assisted-'+yingxie+ziteng)});
  base=await start(assisted.libraryOptions);
  for(const spec of specs){
   const enabled=(spec.book==='yingxie'?yingxie:ziteng)==='1',count=spec.book==='yingxie'?5:6;
   const login=await call(spec,'login',{name:'辅助验收'});spec.cookie=login.cookie.split(';')[0];await call(spec,'claim',{role:spec.role});
   const s=(await call(spec,'state')).data;assert.equal(s.testAssist,enabled);
   const result=await call(spec,'test-assist',{confirmed:true,requestId:crypto.randomUUID(),checkpoint:spec.book==='yingxie'?'act-1-reading/1/0':'reading/1/1'});
   assert.equal(result.status,enabled?200:404);
   if(enabled){const next=(await call(spec,'state')).data,ready=next.flow?.ready||next.progress.ready;assert.equal(ready.length,count-1);assert.ok(!ready.includes(spec.role));assert.equal(next.roles.filter(r=>r.owner).length,count)}
  }
  await close();
 }
 console.log('通过：正式模式下两本可分别或同时开放辅助；补齐其他角色、不替本人确认。');
 base=await start({accessCode:env.SITE_ACCESS_CODE,yingxieOptions:{stateDir:path.join(temp,'browser','yingxie')},zitengOptions:{stateDir:path.join(temp,'browser','ziteng')}});
 const {chromium}=createRequire(import.meta.url)('../murder-mystery-html-builder/murder-mystery-html-builder/node_modules/playwright-core');
 browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',headless:true});
 for(const spec of specs){
  const login=await call(spec,'login',{name:'断线验收'},base);spec.cookie=login.cookie.split(';')[0];await call(spec,'claim',{role:spec.role},base);
  const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});const i=spec.cookie.indexOf('=');await context.addCookies([{name:spec.cookie.slice(0,i),value:spec.cookie.slice(i+1),url:base}]);
  const page=await context.newPage();await page.goto(base+spec.url);
  await page.getByLabel('访问口令',{exact:true}).fill('wrong');await page.getByRole('button',{name:'进入档案馆'}).click();await page.getByRole('alert').filter({hasText:'口令不正确'}).waitFor();
  await page.getByLabel('访问口令',{exact:true}).fill(env.SITE_ACCESS_CODE);await page.getByRole('button',{name:'进入档案馆'}).click();
  await page.locator('.page:visible').first().waitFor();await page.locator('.page:visible').first().evaluate(img=>img.decode());
  assert.equal(await page.locator('#testAssist').isHidden(),true);
  await context.setOffline(true);const notice=page.locator(spec.book==='yingxie'?'#error':'#connection');await notice.filter({hasText:'连接暂时中断'}).waitFor();assert.equal(await page.locator('.page:visible').first().isVisible(),true);
  await context.setOffline(false);await page.waitForFunction(id=>document.querySelector(id).textContent==='',spec.book==='yingxie'?'#error':'#connection');
  assert.equal(await page.locator('#login').isHidden(),true);await page.reload();await page.locator('.page:visible').first().waitFor();assert.equal((await call(spec,'state')).data.role,spec.role);await context.close();
 }
 console.log('通过：Chrome手机模拟断线保留原页、恢复连接与刷新保留身份；未做真实手机异网测试。');
 console.log('独立验收数据：'+temp);
}finally{await browser?.close();if(server?.listening)await close()}
