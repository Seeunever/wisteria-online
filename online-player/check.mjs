import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createApp } from './server.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require('../murder-mystery-html-builder/murder-mystery-html-builder/node_modules/playwright-core');
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yingxie-first-act-'));
let server;
async function start(){server=createApp({stateDir});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return `http://127.0.0.1:${server.address().port}`}
let base=await start();
const login=async name=>{const res=await fetch(base+'/api/login',{method:'POST',body:JSON.stringify({name})});assert.equal(res.status,200);return res.headers.get('set-cookie').split(';')[0]};
const request=(route,cookie,body)=>fetch(base+route,{headers:{cookie},...(body?{method:'POST',body:JSON.stringify(body)}:{})});
let browser;
try {
  const a=await login('测试甲'), a2=await login('测试甲'), b=await login('测试乙');
  const initial=await (await request('/api/state',a)).json();const id=initial.roles[0].id;
  const claims=await Promise.all([request('/api/claim',a,{role:id}),request('/api/claim',b,{role:id})]);
  assert.deepEqual(claims.map(r=>r.status).sort(),[200,409]);
  const owner=claims[0].status===200?a:b;const other=owner===a?b:a;
  assert.equal((await request('/api/ready',other,{phase:'act-1-reading'})).status,403);
  assert.equal((await request('/api/ready',owner,{phase:'act-2-reading'})).status,409);
  assert.equal((await request(`/api/page/${id}/0`,owner)).status,200);
  assert.equal((await request(`/api/page/${id}/0`,other)).status,403);
  assert.equal((await request(`/api/page/${id}/1`,owner)).status,404);
  assert.equal((await fetch(base+'/private/game.json')).status,404);
  assert.equal((await fetch(base+`/api/page/${id}/0`)).status,401);
  assert.equal((await (await request('/api/state',a)).json()).role,(await (await request('/api/state',a2)).json()).role);
  await new Promise(resolve=>server.close(resolve));base=await start();
  assert.equal((await (await request('/api/state',owner)).json()).role,id);
  browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',headless:true});
  const desktop=await browser.newContext({viewport:{width:1280,height:900}});
  const mobile=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  const pages=await Promise.all([desktop.newPage(),mobile.newPage()]);
  const errors=[];pages.forEach(p=>p.on('pageerror',e=>errors.push(e.message)));
  for(const page of pages){await page.goto(base);await page.getByLabel('用户名').fill('浏览器测试');await page.getByRole('button',{name:'进入游戏'}).click();await page.getByRole('heading',{name:'选择你的角色'}).waitFor()}
  await pages[0].getByRole('button',{name:'选择并阅读'}).first().click();
  for(const page of pages){await page.locator('#reader').waitFor({state:'visible'});await page.locator('.page').evaluate(img=>img.decode());assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true)}
  await pages[1].reload();await pages[1].locator('#reader').waitFor({state:'visible'});
  await pages[0].getByRole('button',{name:'我已读完并交流好，准备搜证'}).click();
  await pages[1].waitForFunction(()=>document.getElementById('readyCount').textContent==='已确认 1 / 5 人');
  assert.equal(await pages[1].getByRole('button',{name:'已确认，等待其他玩家'}).isDisabled(),true);
  await pages[1].evaluate(()=>fetch('/api/ready',{method:'POST',body:JSON.stringify({phase:'act-1-reading'})}));
  assert.equal((await (await request('/api/state',owner)).json()).progress.ready.length,1);
  assert.equal(await pages[1].locator('.page').isVisible(),true);
  await request('/api/ready',owner,{phase:'act-1-reading'});
  const current=await (await request('/api/state',owner)).json();
  const remaining=[];
  for(const role of current.roles.filter(role=>!role.owner)){
    const cookie=await login(`补位${role.number}`);await request('/api/claim',cookie,{role:role.id});remaining.push(cookie);
  }
  for(const cookie of remaining.slice(0,-1))await request('/api/ready',cookie,{phase:'act-1-reading'});
  const beforeLast=await (await request('/api/state',owner)).json();
  assert.equal(beforeLast.progress.ready.length,4);assert.equal(beforeLast.progress.phase,'act-1-reading');
  const last=remaining.at(-1);
  await Promise.all([request('/api/ready',last,{phase:'act-1-reading'}),request('/api/ready',last,{phase:'act-1-reading'})]);
  for(const page of pages)await page.waitForFunction(()=>document.getElementById('search')?.textContent.includes('第 1 / 2 轮'));
  const afterLast=await (await request('/api/state',owner)).json();
  assert.equal(afterLast.progress.ready.length,5);assert.equal(afterLast.progress.phase,'act-1-search-preparation');
  const actorContext=await browser.newContext();
  await actorContext.addCookies([{name:'session',value:owner.split('=')[1],url:base}]);
  const actor=await actorContext.newPage();await actor.goto(base);
  await actor.getByRole('button',{name:'领取这张 · 01'}).click();
  await actor.getByRole('button',{name:'公开这张（不可撤回）',exact:true}).waitFor({state:'visible'});
  await actor.getByRole('button',{name:'隐藏这张',exact:true}).click();
  await pages[1].waitForFunction(()=>document.querySelector('#search h2')?.textContent.includes('小姐'));
  assert.equal(await pages[1].locator('img[src$="act-one-clue-01/content"]').count(),0);
  await pages[1].getByLabel('调查地点').selectOption('副楼北侧－地上');
  await pages[1].getByRole('button',{name:'领取这张 · 02'}).click();
  await pages[1].getByRole('button',{name:'阅读完毕，轮到下一人'}).waitFor();
  await pages[0].waitForFunction(()=>!!document.querySelector('img[src$="act-one-clue-02/content"]'));
  await actor.reload();await actor.locator('#search').waitFor({state:'visible'});
  assert.equal(await actor.locator('img[src$="act-one-clue-02/content"]').count(),0);
  assert.equal(await actor.getByLabel('调查地点').count(),0);
  await pages[1].getByRole('button',{name:'阅读完毕，轮到下一人'}).click();
  await new Promise(resolve=>server.close(resolve));base=await start();
  assert.equal((await (await request('/api/state',owner)).json()).progress.phase,'act-1-search-preparation');
  // Capture both sizes after the gate has changed, without populating the real game.
  for(const page of pages)assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await pages[1].screenshot({path:path.join(stateDir,'mobile.png'),fullPage:true});
  await pages[0].screenshot({path:path.join(stateDir,'desktop.png'),fullPage:true});
  assert.deepEqual(errors,[]);
  console.log('通过：原有登录/选角/私页检查；未选角不能确认；同名两端确认只算一人；4人不推进、5人同步进入搜证准备；重复点击无重复计数；重启保留；Chrome 双尺寸检查。');
  console.log(`试玩截图（独立测试数据）：${stateDir}`);
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve))}
