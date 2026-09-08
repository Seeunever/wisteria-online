import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createRequire} from 'node:module';
import {createApp} from './server.mjs';
import {createSearch} from './search.mjs';
const {chromium}=createRequire(import.meta.url)('../murder-mystery-html-builder/murder-mystery-html-builder/node_modules/playwright-core');
const read=name=>JSON.parse(fs.readFileSync(new URL(`./private/${name}.json`,import.meta.url)));
const game=read('game'),third=read('act-three');
const expectedTriggers=[['求医','忘伤','蛋糕坯'],['讨厌','法国胭脂','小吴'],['小布袋','蛋糕坯','time’s torrent'],['欧款','命运难料','生产'],['深色药瓶','小布袋','躺着的人']];
const cards=[...read('search').map(c=>({...c,act:1})),...read('act-two').cards,...third.cards];
const roles=game.roles.map(r=>r.id);
const id=n=>`act-three-clue-${String(n).padStart(2,'0')}`;
// Each role's exact third-act bans, including earlier unclaimed cards, in isolated state.
const bans=[[3,18],[1,19,24],[5,20],[4,21],[9,22]];
for(let i=0;i<5;i++){
 const db=new DatabaseSync(':memory:');const engine=createSearch(db,cards,game.roles);
 const fixture={phase:'act-3-search',turn:i,round:1,revision:0,pending:null,owned:{},ready:[]};
 db.prepare('INSERT INTO search_state VALUES(1,?)').run(JSON.stringify(fixture));
 const view=engine.view(roles[i]);
 assert.deepEqual(view.cards.filter(c=>c.act===3&&c.forbidden).map(c=>c.id),bans[i].map(id).sort());
 if(i===3)assert.equal(view.cards.find(c=>c.id==='act-one-clue-05').forbidden,true);
 if(i===4)for(const n of [14,15])assert.equal(view.cards.find(c=>c.id===id(n)).forbidden,false);
 for(const n of bans[i])assert.throws(()=>engine.act(roles[i],{action:'take',card:id(n),revision:0}));
 // Leave only an earlier card: third act must pick it up, then finish this partial round.
 fixture.owned=Object.fromEntries(cards.filter(c=>c.id!=='act-one-clue-09').map(c=>[c.id,{owner:roles[0],public:true}]));
 db.prepare('UPDATE search_state SET data=? WHERE id=1').run(JSON.stringify(fixture));
 engine.act(roles[i],{action:'take',card:'act-one-clue-09',revision:0});
 engine.act(roles[i],{action:'resolve',card:'act-one-clue-09',keep:null,revision:1});
 assert.equal(engine.view(roles[i]).phase,'act-3-discussion');db.close();
}
// Skip only when this role cannot take the final card; another role can still finish.
{
 const db=new DatabaseSync(':memory:');const engine=createSearch(db,cards,game.roles);
 db.prepare('INSERT INTO search_state VALUES(1,?)').run(JSON.stringify({phase:'act-3-search',turn:0,round:1,revision:0,pending:null,ready:[],owned:Object.fromEntries(cards.filter(c=>c.id!==id(3)).map(c=>[c.id,{owner:roles[0],public:true}]))}));
 engine.act(roles[0],{action:'skip',revision:0});assert.equal(engine.view(roles[1]).turn,1);
 engine.act(roles[1],{action:'take',card:id(3),revision:1});engine.act(roles[1],{action:'resolve',card:id(3),keep:null,revision:2});assert.equal(engine.view(roles[1]).phase,'act-3-discussion');db.close();
}
const stateDir=fs.mkdtempSync(path.join(os.tmpdir(),'yingxie-third-'));
let server=createApp({stateDir}),browser;
await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port,base=`http://127.0.0.1:${port}`;
const cookies=[];
const call=(route,cookie,body)=>fetch(base+route,{headers:{cookie:cookie||'',connection:'close'},...(body?{method:'POST',body:JSON.stringify(body)}:{})});
const state=async(i=0)=>(await call('/api/state',cookies[i])).json();
const mem=async(i=0)=>(await call('/api/memories',cookies[i])).json();
const act=async(i,body,expected=200)=>{const s=await state(i);const r=await call('/api/search',cookies[i],{revision:s.search?.revision,...body});assert.equal(r.status,expected,await r.text())};
try{
 for(let i=0;i<5;i++){const r=await call('/api/login',null,{name:`回忆测试${i}`});cookies.push(r.headers.get('set-cookie').split(';')[0]);await call('/api/claim',cookies[i],{role:roles[i]})}
 assert.deepEqual(await mem(),{enabled:false,cards:[]});
 assert.equal((await state()).finale,null);
 assert.equal((await call(`/api/ending/${roles[0]}/0`,cookies[0])).status,403);
 assert.equal((await call('/api/truth/0',cookies[0])).status,403);
 assert.equal((await call('/api/end-guide',cookies[0])).status,403);
 await act(0,{action:'confirm-phase',phase:'act-3-discussion',confirmed:true},409);
 const memoryId=third.memories[0].id;
 assert.equal((await call(`/api/memory/${memoryId}/front`,cookies[0])).status,403);
 assert.equal((await call('/api/memory/reveal',cookies[0],{card:memoryId,confirmed:true})).status,409);
 // Test-only fixture starts at act-two discussion, never touches the live database.
 await new Promise(r=>server.close(r));
 const db=new DatabaseSync(path.join(stateDir,'game.sqlite'));
 for(const role of roles)db.prepare('INSERT INTO readiness VALUES (?,?)').run('act-1-reading',role);
 db.prepare('INSERT INTO search_state VALUES(1,?)').run(JSON.stringify({phase:'act-2-discussion',round:1,turn:5,revision:0,pending:null,ready:[],owned:Object.fromEntries(cards.filter(c=>c.act<3).map(c=>[c.id,{owner:roles[0],public:true}]))}));db.close();
 server=createApp({stateDir});await new Promise(r=>server.listen(port,'127.0.0.1',r));
 for(let i=0;i<4;i++)await act(i,{action:'confirm-phase',phase:'act-2-discussion'});
 assert.equal((await state()).pages.length,2);assert.equal((await mem()).enabled,false);
 await act(4,{action:'confirm-phase',phase:'act-2-discussion'});
 assert.equal((await state()).search.phase,'act-3-reading');assert.equal((await state()).pages.length,4);
 assert.equal((await call(`/api/act-page/${roles[0]}/3/1`,cookies[0])).status,200);
 assert.equal((await call(`/api/act-page/${roles[0]}/3/1`,cookies[1])).status,403);
 assert.equal((await call(`/api/act-page/${roles[0]}/4/0`,cookies[0])).status,404);
 assert.equal((await call(`/api/clue/${id(1)}/front`,cookies[0])).status,403);
 assert.equal((await state()).finale,null);
 assert.equal((await call('/api/truth/0',cookies[0])).status,403);
 await act(0,{action:'confirm-phase',phase:'act-3-discussion',confirmed:true},409);
 for(let i=0;i<5;i++){
  const m=await mem(i);assert.equal(m.cards.length,3);assert.deepEqual(m.cards.map(c=>c.id),third.memories.filter(c=>c.role===roles[i]).map(c=>c.id));
  assert.deepEqual(m.cards.map(c=>c.trigger),expectedTriggers[i],'仅返回本人07页中对应编号的触发词');
  for(const c of m.cards){
   assert.equal((await call(c.front,cookies[i])).status,200);
   assert.equal((await call(`/api/memory/${c.id}/content`,cookies[i])).status,403);
   assert.equal((await call(c.front,cookies[(i+1)%5])).status,403);
   assert.equal((await call('/api/memory/reveal',cookies[(i+1)%5],{card:c.id,confirmed:true})).status,409);
  }
 }
 assert.equal((await call('/api/memory/reveal',cookies[0],{card:memoryId})).status,409);
 browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',headless:true});
 const another=await call('/api/login',null,{name:'回忆测试0'});const otherCookie=another.headers.get('set-cookie').split(';')[0];
 const contexts=await Promise.all([browser.newContext({viewport:{width:1280,height:900}}),browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true})]);
 const pages=[],errors=[];
 for(let i=0;i<2;i++){await contexts[i].addCookies([{name:'session',value:(i?otherCookie:cookies[0]).split('=')[1],url:base}]);const p=await contexts[i].newPage();p.on('pageerror',e=>errors.push(e.message));await p.goto(base);pages.push(p);await p.getByRole('button',{name:'我的回忆',exact:true}).click();await p.getByText('回忆 01 · 未触发',{exact:true}).click();await p.locator('#memoryCards img').first().evaluate(img=>img.decode());assert.equal(await p.getByRole('button',{name:'触发回忆 01',exact:true}).isDisabled(),true)}
 const before=await Promise.all(roles.map((_,i)=>state(i)));
 for(let i=0;i<2;i++){
  const p=pages[i];assert.deepEqual(await p.locator('.memory-trigger').allTextContents(),expectedTriggers[0].map(t=>`触发词：${t}`));
  await p.locator('#memoryCards details').first().evaluate(d=>d.open=false);
  assert.equal(await p.getByText('触发词：求医',{exact:true}).isVisible(),true,'折叠时也显示触发词');
  await p.screenshot({path:path.join(stateDir,`memory-triggers-${i}.png`)});
  await p.getByText('回忆 01 · 未触发',{exact:true}).click();
 }
 await pages[0].getByRole('checkbox').first().check();await pages[0].getByRole('button',{name:'触发回忆 01',exact:true}).click();
 for(const p of pages)await p.getByText('回忆 01 · 已触发',{exact:true}).waitFor();
 assert.deepEqual(await Promise.all(roles.map((_,i)=>state(i))),before,'回忆触发不改变任何人的搜证、轮次、共享版本和普通线索');
 assert.equal((await call(`/api/memory/${memoryId}/content`,cookies[1])).status,403);
 assert.equal((await call(`/api/memory/${memoryId}/content`,otherCookie)).status,200);
 assert.equal((await call('/api/memory/reveal',otherCookie,{card:memoryId,confirmed:true})).status,200);
 for(let i=0;i<2;i++){
  const p=pages[i];await p.locator('#memoryCards details').first().evaluate(d=>d.open=true);await p.locator('#memoryCards img').first().evaluate(img=>img.decode());
  assert.equal(await p.locator('#memoryDialog').getByRole('button',{name:/公开|隐藏/}).count(),0);
  assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth&&document.getElementById('memoryDialog').scrollWidth<=document.getElementById('memoryDialog').clientWidth),true);
  await p.screenshot({path:path.join(stateDir,`memory-${i}.png`)});await p.getByRole('button',{name:'返回游戏'}).click();
 }
 for(let i=0;i<4;i++)await act(i,{action:'confirm-phase',phase:'act-3-reading'});
 assert.equal((await state()).search.phase,'act-3-reading');
 await pages[0].getByRole('button',{name:'已确认，等待大家'}).waitFor();
 await act(4,{action:'confirm-phase',phase:'act-3-reading'});
 await act(0,{action:'confirm-phase',phase:'act-3-discussion',confirmed:true},409);
 await act(0,{action:'take',card:memoryId},409);await act(0,{action:'publish',card:memoryId},409);
 let count=0;
 while((await state()).search.phase==='act-3-search'){
  assert.ok(count<30);const s=(await state()).search;const i=s.turn,own=(await state(i)).search;
  const card=own.cards.find(c=>c.available&&!c.forbidden);if(!card){await act(i,{action:'skip'});continue}
  const observer=(i+1)%5,prior=(await state(observer)).search;
  await act(i,{action:'take',card:card.id});assert.deepEqual((await state(observer)).search,prior);
  const after=(await state(i)).search;const taken=after.cards.find(c=>c.id===card.id);
  assert.equal(taken.queued,[id(1),id(23)].includes(card.id));
  assert.equal((await call(`/api/clue/${card.id}/content`,cookies[observer])).status,403);
  if(count===0){
   const snapshot=(await state(i)).search;
   assert.equal((await call('/api/memory/reveal',cookies[i],{card:third.memories[1].id,confirmed:true})).status,200);
   assert.deepEqual((await state(i)).search,snapshot,'搜证过程中触发回忆不会使手中待处理操作过期');
  }
  const hidden=after.cards.filter(c=>c.mine&&!c.public&&!c.queued);
  await act(i,{action:'resolve',card:card.id,keep:taken.queued?(hidden[0]?.id||null):card.id});count++;
  assert.ok((await state(i)).search.cards.filter(c=>c.mine&&!c.public&&!c.queued).length<=1);
 }
 assert.equal(count,24);const final=(await state()).search;assert.equal(final.phase,'act-3-discussion');assert.equal(final.round,5);
 for(const n of [1,23])assert.equal(final.cards.find(c=>c.id===id(n)).public,true);
 for(let i=0;i<5;i++)assert.equal((await state(i)).search.cards.some(c=>c.queued),false,'最后不足五人的一轮也必须发布全部待公开');
 await act(0,{action:'confirm-phase',phase:'act-3-discussion'},409);
 const saved=await mem();await new Promise(r=>server.close(r));server=createApp({stateDir});await new Promise(r=>server.listen(port,'127.0.0.1',r));assert.deepEqual(await mem(),saved);assert.deepEqual((await state()).search,final);
 for(const p of pages){await p.reload();await p.getByText('第三幕搜证结束 · 讨论时间',{exact:true}).waitFor();assert.equal(await p.locator('#pages img').count(),4)}
 // End-game gate: cancel safely, four roles do not unlock, fifth role reveals to both devices.
 const endButton='讨论与个人回答已完成，确认结束游戏';
 assert.equal((await state()).finale,null);
 assert.equal((await call('/api/end-guide',cookies[0])).status,200);
 assert.equal((await call('/api/truth/0',cookies[0])).status,403);
 assert.equal((await call(`/api/ending/${roles[0]}/0`,cookies[0])).status,403);
 for(const p of pages){assert.equal(await p.locator('#endingPages img').count(),0);assert.equal(await p.getByRole('button',{name:'我的结局',exact:true}).isVisible(),false)}
 pages[0].once('dialog',d=>d.dismiss());await pages[0].getByRole('button',{name:endButton,exact:true}).click();
 assert.equal((await state()).search.ready.length,0,'取消确认不能写入结束票');
 const keepHidden=(await state()).search.cards.find(c=>c.mine&&!c.public&&!c.queued);
 await act(0,{action:'publish',card:keepHidden.id});
 assert.equal((await call(`/api/clue/${keepHidden.id}/content`,cookies[1])).status,403);
 for(let i=1;i<5;i++)await act(i,{action:'confirm-phase',phase:'act-3-discussion',confirmed:true});
 const duplicateLogin=await call('/api/login',null,{name:'回忆测试1'});const duplicateCookie=duplicateLogin.headers.get('set-cookie').split(';')[0];
 assert.equal((await call('/api/search',duplicateCookie,{action:'confirm-phase',phase:'act-3-discussion',confirmed:true})).status,200);
 assert.equal((await state()).search.ready.length,4);assert.equal((await state()).finale,null);
 assert.equal((await call('/api/truth/0',cookies[0])).status,403);
 assert.equal((await call(`/api/ending/${roles[0]}/0`,cookies[0])).status,403);
 await new Promise(r=>server.close(r));server=createApp({stateDir});await new Promise(r=>server.listen(port,'127.0.0.1',r));assert.equal((await state()).search.ready.length,4);
 pages[0].once('dialog',d=>d.accept());await pages[0].getByRole('button',{name:endButton,exact:true}).click();
 for(const p of pages)await p.getByRole('button',{name:'我的结局',exact:true}).waitFor();
 const ended=await state();assert.equal(ended.search.phase,'act-3-ended');assert.equal(ended.search.ready.length,5);
 assert.equal(ended.finale.ending.length,1);assert.equal(ended.finale.truth.length,8);assert.equal(ended.pages.length,4);
 assert.equal((await call(`/api/clue/${keepHidden.id}/content`,cookies[1])).status,200,'结束确认发布讨论期追加的待公开');
 for(let i=0;i<5;i++){
  const own=(await state(i)).finale;assert.deepEqual(own.ending,[`/api/ending/${roles[i]}/0`]);
  assert.equal((await call(own.ending[0],cookies[i])).status,200);
  assert.equal((await call(own.ending[0],cookies[(i+1)%5])).status,403);
 }
 for(const url of ended.finale.truth)assert.equal((await call(url,cookies[4])).status,200);
 assert.equal((await call('/api/truth/0')).status,403);
 const spectator=await call('/api/login',null,{name:'未选角旁观测试'});assert.equal((await call('/api/truth/0',spectator.headers.get('set-cookie').split(';')[0])).status,403);
 const privateCard=(await state(1)).search.cards.find(c=>c.mine&&!c.public);
 assert.equal((await call(`/api/clue/${privateCard.id}/content`,cookies[0])).status,403);
 assert.equal((await call(`/api/memory/${memoryId}/content`,cookies[1])).status,403);
 await act(1,{action:'publish',card:privateCard.id},409);
 await act(0,{action:'take',card:id(1)},409);
 await act(0,{action:'confirm-phase',phase:'act-3-discussion',confirmed:true},409);
 for(let i=0;i<2;i++){
  const p=pages[i];await p.getByRole('button',{name:'我的结局',exact:true}).click();
  await p.locator('#endingPages img').first().evaluate(img=>img.decode());
  assert.equal(await p.locator('#endingPages img').count(),1);
  await p.screenshot({path:path.join(stateDir,`ending-${i}.png`)});
  await p.locator('#endingDialog').getByRole('button',{name:'返回游戏'}).click();
  await p.getByRole('button',{name:'公共真相',exact:true}).click();
  assert.equal(await p.locator('#endingPages img').count(),8);
  for(const img of await p.locator('#endingPages img').all())await img.evaluate(img=>img.decode());
  assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth&&document.getElementById('endingDialog').scrollWidth<=document.getElementById('endingDialog').clientWidth),true);
  await p.screenshot({path:path.join(stateDir,`truth-${i}.png`)});
  await p.locator('#endingDialog').getByRole('button',{name:'返回游戏'}).click();
 }
 await new Promise(r=>server.close(r));server=createApp({stateDir});await new Promise(r=>server.listen(port,'127.0.0.1',r));
 assert.deepEqual(await state(),ended,'结束状态及终局入口重启保留');
 assert.deepEqual(errors,[]);
 console.log('第三幕通过：逐角色禁搜、旧卡续搜、合法跳过、两次全员门禁、24卡连续五轮、末轮批量公开、无提前结局。');
 console.log('回忆通过：15卡归属与门禁、关键词确认、无公开入口、与搜证状态隔离、同名两端同步、重启保留、Chrome桌面与手机。');
 console.log('结束通过：禁止提前确认、确认取消、4人仍锁定、同名设备去重、5人开放、个人结局隔离、8页公共真相、待公开批次、私人卡不自动公开、重启保留和Chrome双端。');
 console.log(`截图：${stateDir}`);
}finally{await browser?.close();await new Promise(r=>server.close(r))}
