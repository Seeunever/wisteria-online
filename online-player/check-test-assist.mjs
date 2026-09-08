import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {createRequire} from 'node:module';
import {createApp} from './server.mjs';
import {createLibrary} from './library-server.mjs';
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'test-assist-check-'));
let server,base,browser,location;
const specs=[{book:'yingxie',api:'/api/',url:'/yingxie/',role:'r02-qiqiao',count:5},{book:'ziteng',api:'/ziteng/api/',url:'/ziteng/',role:'role-2',count:6}];
async function start(label,enabled=true){location=path.join(temp,label);server=createLibrary({createYingxie:createApp,testAssist:enabled,yingxieOptions:{stateDir:path.join(location,'yingxie')},zitengOptions:{stateDir:path.join(location,'ziteng')}});await new Promise(r=>server.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${server.address().port}`}
const close=()=>new Promise(r=>server.close(r));
async function request(spec,route,body,status=200){const r=await fetch(base+spec.api+route,{headers:{cookie:spec.cookie||'',connection:'close','Content-Type':'application/json'},...(body?{method:'POST',body:JSON.stringify(body)}:{})});const data=await r.json();assert.equal(r.status,status,`${spec.book}/${route}: ${JSON.stringify(data).slice(0,150)}`);return {data,cookie:r.headers.get('set-cookie')?.split(';')[0]}}
const state=async spec=>(await request(spec,'state')).data;
const key=s=>{const f=s.flow||s.search;return `${f?.phase||s.progress.phase}/${f?.day||f?.act||1}/${f?.round||0}`};
async function assist(spec,body){body ||= {confirmed:true,requestId:randomUUID(),checkpoint:key(await state(spec))};return {body,...await request(spec,'test-assist',body)}}
async function ready(spec){const s=await state(spec),f=s.flow||s.search;if(spec.book==='ziteng')return request(spec,'action',{action:'ready',day:f.day,phase:f.phase,confirmed:true});if(!f)return request(spec,'ready',{phase:'act-1-reading'});return request(spec,'search',{action:'confirm-phase',phase:f.phase,confirmed:true})}
async function playerAction(spec,body){const s=await state(spec),f=s.flow||s.search;return request(spec,spec.book==='ziteng'?'action':'search',{day:f.day,phase:f.phase,revision:f.revision,...body})}
const flow=s=>s.flow||s.search;
const actor=(spec,s)=>spec.book==='ziteng'?s.flow.actor:s.roles[s.search?.turn]?.id;
function saved(spec){const d=new DatabaseSync(path.join(location,spec.book,'game.sqlite'),{readOnly:true});const row=d.prepare('SELECT data FROM '+(spec.book==='ziteng'?'flow':'search_state')).get();d.close();return row?JSON.parse(row.data):null}
try{
 await start('api');
 for(const spec of specs){
  await request(spec,'test-assist',{confirmed:true,requestId:randomUUID(),checkpoint:'bad'},401);
  spec.cookie=(await request(spec,'login',{name:'真人测试'})).cookie;await request(spec,'claim',{role:spec.role});
  assert.equal((await state(spec)).testAssist,true);
  const first=await assist(spec);let s=await state(spec);assert.equal(s.roles.filter(r=>r.owner).length,spec.count);
  const readyIds=s.flow?.ready||s.search?.ready||s.progress.ready;assert.ok(!readyIds.includes(spec.role));assert.equal(readyIds.length,spec.count-1);
  const snapshot=saved(spec);await Promise.all([request(spec,'test-assist',first.body),request(spec,'test-assist',first.body)]);assert.deepEqual(saved(spec),snapshot,'duplicate click does not advance');
  await ready(spec);if(spec.book==='ziteng')await playerAction(spec,{action:'vote',area:'east'});
  await assist(spec);s=await state(spec);assert.equal(actor(spec,s),spec.role);assert.equal(flow(s).cards.filter(c=>c.mine).length,0,'helper never takes for caller');
  const source=JSON.parse(fs.readFileSync(new URL(spec.book==='yingxie'?'./private/search.json':'./private/ziteng/game.json',import.meta.url),'utf8'));
  const mandatory=new Set((Array.isArray(source)?source:source.cards).filter(c=>c.mandatory).map(c=>c.id));
  const c=flow(s).cards.find(c=>c.available&&!c.forbidden&&!mandatory.has(c.id));assert.ok(c,'fixture has a legal optional card');await playerAction(spec,{action:'take',card:c.id});
  const ownPending=saved(spec);await assist(spec);assert.deepEqual(saved(spec),ownPending,'helper never resolves caller card');
  await playerAction(spec,{action:'resolve',card:c.id,keep:c.id});const afterOwn=await assist(spec);s=await state(spec);assert.ok(flow(s).cards.some(x=>x.id===c.id&&x.mine&&!x.public));
  assert.ok(flow(s).round!==1||flow(s).phase.endsWith('discussion'),'stops at round boundary');
  const afterRound=saved(spec);await request(spec,'test-assist',afterOwn.body);assert.deepEqual(saved(spec),afterRound,'same request remains idempotent after round changed');
  await request(spec,'test-assist',{confirmed:true,requestId:randomUUID(),checkpoint:'old/0/0'},409);assert.deepEqual(saved(spec),afterRound);
  // Play only the human role ourselves; the button must perform all other roles through the whole game.
  for(let limit=0;limit<180;limit++){
   s=await state(spec);const f=flow(s);if(f.phase==='ended'||f.phase==='act-3-ended')break;
   if(['reading','discussion'].includes(f.phase)||f.phase.endsWith('-reading')||f.phase.endsWith('-discussion')){
    if(!f.ready.includes(spec.role)){
     if(f.phase==='act-3-discussion'||f.day===4&&f.phase==='discussion'){const pre=saved(spec);await assist(spec);assert.deepEqual(saved(spec),pre,'final reveal waits for explicit human confirmation')}
     await ready(spec);
    }else await assist(spec);
   }else if(f.phase==='vote'){
    if(!f.votes[spec.role])await playerAction(spec,{action:'vote',area:f.areas[0].id});else await assist(spec);
   }else if(f.phase==='tie'&&f.actor===spec.role)await playerAction(spec,{action:'tie',area:f.ties[0]});
   else if(f.canResolve||actor(spec,s)===spec.role){
    const pending=f.privatePending||f.pending;
    if(pending){const keep=f.cards.find(c=>c.mine&&!c.public&&!c.queued)?.id||null;await playerAction(spec,{action:'resolve',card:pending,keep})}
    else {const c=f.cards.find(c=>c.available&&!c.forbidden);await playerAction(spec,c?{action:'take',card:c.id}:{action:'skip'})}
   }else await assist(spec);
   assert.ok(limit<179,'helper completes full game');
  }
  assert.ok(['ended','act-3-ended'].includes(flow(await state(spec)).phase));
  const ended=saved(spec);await assist(spec);assert.deepEqual(saved(spec),ended,'ended games are never reset');
  const d=new DatabaseSync(path.join(location,spec.book,'game.sqlite'),{readOnly:true});
  const tables=d.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();const memory=tables.find(t=>['memories','memory_state'].includes(t.name));
  if(memory)assert.equal(d.prepare(`SELECT count(*) n FROM ${memory.name}`).get().n,0,'helper does not trigger memories');d.close();
  console.log(`${spec.book} 通过：单人补位、全流程其他角色代操作、轮次/门禁、私人卡保留、重复请求、最终本人确认。`);
 }
 await close();await start('disabled',false);
 for(const original of specs){const spec={...original};spec.cookie=(await request(spec,'login',{name:'禁用检查'})).cookie;await request(spec,'claim',{role:spec.role});assert.equal((await state(spec)).testAssist,false);await request(spec,'test-assist',{confirmed:true,requestId:randomUUID(),checkpoint:key(await state(spec))},404)}
 await close();await start('browser');
 const {chromium}=createRequire(import.meta.url)('../murder-mystery-html-builder/murder-mystery-html-builder/node_modules/playwright-core');
 browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',headless:true});const errors=[];
 for(const original of specs){
  const spec={...original};spec.cookie=(await request(spec,'login',{name:'浏览器真人'})).cookie;await request(spec,'claim',{role:spec.role});
  for(const [width,height]of [[390,844],[820,1180]]){
   const context=await browser.newContext({viewport:{width,height}});await context.addCookies([{name:spec.cookie.split('=')[0],value:spec.cookie.split('=')[1],url:base}]);const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
   await page.goto(base+spec.url);const button=page.getByRole('button',{name:'测试中，帮我一键补完本轮其他人的选择和确认',exact:true});await button.click();await page.locator('#testAssistResult').filter({hasText:'等待你确认'}).waitFor();
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth),true);
   const box=await button.boundingBox();assert.ok(box.width<=width&&box.height>=44);await page.locator('#testAssist').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(temp,`${spec.book}-${width}.png`)});
   assert.ok(!((await state(spec)).flow?.ready||(await state(spec)).progress.ready).includes(spec.role));await context.close();
  }
  console.log(`${spec.book} Chrome手机/平板按钮实点通过。`);
 }
 assert.deepEqual(errors,[]);console.log(`测试辅助截图：${temp}`);
}finally{await browser?.close();if(server?.listening)await close()}
