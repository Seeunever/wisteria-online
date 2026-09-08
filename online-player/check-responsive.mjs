import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createRequire} from 'node:module';
import {createApp} from './server.mjs';

const {chromium}=createRequire(import.meta.url)('../murder-mystery-html-builder/murder-mystery-html-builder/node_modules/playwright-core');
const game=JSON.parse(fs.readFileSync(new URL('./private/game.json',import.meta.url)));
// All fixtures and browser actions stay on an ephemeral port and temporary database.
const stateDir=fs.mkdtempSync(path.join(os.tmpdir(),'yingxie-responsive-'));
const server=createApp({stateDir});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${server.address().port}`;
const db=new DatabaseSync(path.join(stateDir,'game.sqlite'));
let browser;
const errors=[];
const call=async(route,cookie,body)=>{
 const response=await fetch(base+route,{headers:{cookie:cookie||'',connection:'close'},...(body?{method:'POST',body:JSON.stringify(body)}:{})});
 assert.equal(response.status,200,`${route}: ${response.status}`);return response;
};
const fixture=(phase,owned={})=>db.prepare('INSERT OR REPLACE INTO search_state VALUES(1,?)').run(JSON.stringify({phase,round:1,turn:0,revision:0,pending:null,ready:[],owned}));
async function fit(page,label){
 const issues=await page.evaluate(()=>{
  const bad=[];const width=document.documentElement.clientWidth;
  if(document.documentElement.scrollWidth>width+1)bad.push('document overflow');
  for(const node of document.querySelectorAll('button,select,input,summary,.roles,.role,.dialog-body,dialog[open]')){
   if(!node.checkVisibility())continue;
   const rect=node.getBoundingClientRect();
   if(rect.left < -1||rect.right>width+1)bad.push(`${node.tagName} ${node.id||node.className}: outside viewport`);
   // A single-line name input intentionally scrolls its text; its outer box must still fit.
   if(!node.matches('input')&&node.scrollWidth>node.clientWidth+1)bad.push(`${node.tagName} ${node.id||node.className}: text overflow`);
   if(node.matches('button,select,summary')&&rect.height<44)bad.push(`${node.tagName}: small touch target`);
  }
  const dialog=document.querySelector('dialog[open]');
  if(dialog){const rect=dialog.getBoundingClientRect();if(rect.top<0||rect.bottom>innerHeight+1)bad.push('dialog height');}
  return bad;
 });
 assert.deepEqual(issues,[],label);
}
async function modal(page,id){
 const dialog=page.locator(id),body=dialog.locator('.dialog-body');
 await dialog.locator('details').first().locator('summary').click();
 // Memory starts folded; endings start expanded. Ensure an image is actually visible.
 await dialog.locator('details').first().evaluate(d=>d.open=true);
 await dialog.locator('img').first().evaluate(img=>img.decode());
 await fit(page,`${id} expanded`);
 const close=dialog.getByRole('button',{name:'返回游戏'});
 const before=await close.boundingBox();
 await body.evaluate(node=>node.scrollTop=node.scrollHeight);
 const after=await close.boundingBox();
 assert.equal(Math.round(before.y),Math.round(after.y),'return button stays in fixed header');
 assert.ok(await close.evaluate(node=>{
  const r=node.getBoundingClientRect();return node.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));
 }),'return button is not covered');
 await close.click();assert.equal(await dialog.isVisible(),false);
}
try{
 const cookies=[];
 for(let i=0;i<game.roles.length;i++){
  const response=await call('/api/login',null,{name:`布局角色${i}`});const cookie=response.headers.get('set-cookie').split(';')[0];cookies.push(cookie);
  await call('/api/claim',cookie,{role:game.roles[i].id});
  await call('/api/ready',cookie,{phase:'act-1-reading'});
 }
 browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',headless:true});
 const sizes=[[320,568],[390,844],[768,1024],[820,1180],[1024,768],[844,390],[1280,900]];
 for(const [width,height] of sizes){
  const context=await browser.newContext({viewport:{width,height},isMobile:width<1100,hasTouch:width<1100});
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  await page.goto(base);await page.locator('#name').fill('ResponsiveLayoutLongUsername12345');
  await fit(page,`${width} login`);
  await page.getByRole('button',{name:'进入游戏',exact:true}).click();await page.locator('#roles .role').first().waitFor();
  await fit(page,`${width} role selection`);
  const expectedColumns=width<=600?1:width<=1100?2:4;
  assert.equal(await page.locator('#roles').evaluate(node=>getComputedStyle(node).gridTemplateColumns.split(' ').length),expectedColumns);
  await context.addCookies([{name:'session',value:cookies[0].split('=')[1],url:base}]);
  fixture('act-3-search');await page.reload();await page.locator('#search select').waitFor();
  await fit(page,`${width} clue backs`);
  if(width===768){await page.locator('#search select').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(stateDir,'clue-grid-768.png')});}
  // Use a non-mandatory hidden card as an earlier-act fixture, rather than changing game rules.
  const original=JSON.parse(fs.readFileSync(new URL('./private/search.json',import.meta.url)));
  const source=original.find(c=>!c.mandatory);
  fixture('act-3-search',{[source.id]:{owner:game.roles[0].id,public:false}});
  const state=await (await call('/api/state',cookies[0])).json();
  const choice=state.search.cards.find(c=>c.available&&!c.forbidden&&original.some(o=>o.id===c.id&&!o.mandatory));
  assert.ok(choice);
  await call('/api/search',cookies[0],{action:'take',card:choice.id,revision:state.search.revision});
  await page.reload();await page.getByRole('button',{name:/隐藏「/}).first().waitFor();
  await fit(page,`${width} long hidden/public choices`);
  if(width===390||width===768){await page.locator('#search').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(stateDir,`search-${width}.png`)});}
  await page.getByRole('button',{name:/隐藏「/}).first().click();
  await page.getByText('等待当前玩家完成本轮行动。',{exact:false}).waitFor();
  // Raw original remains available and browser pinch zoom is not disabled.
  const viewport=await page.locator('meta[name=viewport]').getAttribute('content');
  assert.ok(!/user-scalable=no|maximum-scale=1/.test(viewport));
  const popupPromise=page.waitForEvent('popup');
  await page.locator('#pages details[open] a').first().click();const popup=await popupPromise;
  await popup.waitForLoadState();await popup.locator('img').evaluate(img=>img.decode());await popup.close();
  await page.getByRole('button',{name:'我的回忆',exact:true}).click();await page.locator('#memoryCards summary').first().waitFor();
  await fit(page,`${width} memory triggers`);
  if(width===390||width===820)await page.screenshot({path:path.join(stateDir,`memory-${width}.png`)});
  if(width===390){
   await page.locator('#memoryCards summary').first().click();await page.getByRole('checkbox').first().check();
   await page.setViewportSize({width:844,height:390});await fit(page,'phone orientation change');
   assert.equal(await page.getByRole('checkbox').first().isChecked(),true);
   await page.setViewportSize({width,height});
  }
  await modal(page,'#memoryDialog');
  fixture('act-3-ended');await page.reload();await page.getByRole('button',{name:'我的结局',exact:true}).click();
  await modal(page,'#endingDialog');
  await page.getByRole('button',{name:'公共真相',exact:true}).click();
  await page.locator('#endingPages img').first().evaluate(img=>img.decode());
  await fit(page,`${width} public truth`);
  if(width===390||width===820||height===390)await page.screenshot({path:path.join(stateDir,`truth-${width}.png`)});
  await modal(page,'#endingDialog');
  await context.close();console.log(`通过 ${width}×${height}：登录、选角、牌背、长操作按钮、原图、回忆、结局、真相。`);
 }
 assert.deepEqual(errors,[]);console.log(`响应式截图：${stateDir}`);
}finally{await browser?.close();db.close();await new Promise(r=>server.close(r))}
