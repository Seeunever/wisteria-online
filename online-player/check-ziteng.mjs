import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createRequire} from 'node:module';
import {createApp} from './server.mjs';
import {createLibrary} from './library-server.mjs';
import {createZitengEngine} from './ziteng-engine.mjs';
const game=JSON.parse(fs.readFileSync(new URL('./private/ziteng/game.json',import.meta.url)));
const roles=game.roles.map(r=>r.id),temp=fs.mkdtempSync(path.join(os.tmpdir(),'ziteng-check-'));
const options={createYingxie:createApp,yingxieOptions:{stateDir:path.join(temp,'yingxie')},zitengOptions:{stateDir:path.join(temp,'ziteng')}};
let server,base,browser;
async function start(){server=createLibrary(options);await new Promise(r=>server.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${server.address().port}`}
const cookies=[];
async function call(route,cookie,body,status=200){const r=await fetch(base+route,{headers:{cookie:cookie||'',connection:'close'},...(body?{method:'POST',body:JSON.stringify(body)}:{})});assert.equal(r.status,status,`${route}: ${await r.clone().text().then(t=>t.slice(0,120))}`);return r}
const state=async(i=0)=>(await call('/ziteng/api/state',cookies[i])).json();
async function action(i,body,status=200){const {flow:f}=await state(i);return call('/ziteng/api/action',cookies[i],{day:f.day,phase:f.phase,revision:f.revision,...body},status)}
async function readyAll(){for(let i=0;i<6;i++)await action(i,{action:'ready',confirmed:true})}
async function finishSearch(){let steps=0;while(true){assert.ok(++steps<150);const s=await state(),f=s.flow;if(f.phase==='discussion')break;const i=roles.indexOf(f.actor),own=(await state(i)).flow;
 if(f.phase==='take'){const c=own.cards.find(c=>c.available&&!c.forbidden);assert.ok(c);await action(i,{action:'take',card:c.id})}
 else {assert.equal(f.phase,'resolve');const hidden=own.cards.filter(c=>c.mine&&!c.public&&!c.queued);await action(i,{action:'resolve',keep:hidden[0]?.id||null})}
}}
async function fit(page,label){assert.deepEqual(await page.evaluate(()=>{const out=[],w=document.documentElement.clientWidth;if(document.documentElement.scrollWidth>w+1)out.push('overflow');for(const n of document.querySelectorAll('button,select,summary,dialog[open]')){if(!n.checkVisibility())continue;const r=n.getBoundingClientRect();if(r.left< -1||r.right>w+1)out.push(n.tagName+' outside');if(n.scrollWidth>n.clientWidth+1)out.push(n.tagName+' text');if(n.matches('button,select,summary')&&r.height<44)out.push(n.tagName+' target')}return out}),[],label)}
try{
 await start();
 assert.match(await (await call('/',null)).text(),/紫藤夫人/);await call('/yingxie/',null);
 const old=await call('/api/login',null,{name:'跨本测试'}),oldCookie=old.headers.get('set-cookie').split(';')[0];
 const oldBefore=await (await call('/api/state',oldCookie)).json();
 for(let i=0;i<6;i++){const r=await call('/ziteng/api/login',null,{name:`测试${i}`});cookies.push(r.headers.get('set-cookie').split(';')[0]);await call('/ziteng/api/claim',cookies[i],{role:roles[i]})}
 const twin=(await call('/ziteng/api/login',null,{name:'测试0'})).headers.get('set-cookie').split(';')[0];
 assert.deepEqual(await (await call('/ziteng/api/state',twin)).json(),await state());
 await call('/ziteng/api/claim',cookies[1],{role:roles[0]},409);
 await call('/ziteng/api/page/role-2/1/0',cookies[0],null,403);await call('/ziteng/api/page/role-1/2/0',cookies[0],null,403);
 await call('/ziteng/api/truth/0',cookies[0],null,403);await call('/ziteng/api/ending/role-1/0',cookies[0],null,403);
 await call('/ziteng/api/state',oldCookie,null,401);await call('/private/ziteng/game.json',cookies[0],null,404);
 const observer=await state(0);await call('/ziteng/api/memory/reveal',cookies[5],{card:game.memories[0].id,confirmed:true});assert.deepEqual(await state(0),observer);
 await call(`/ziteng/api/memory/${game.memories[0].id}/content`,cookies[0],null,403);
 await call(`/ziteng/api/memory/${game.memories[0].id}/content`,cookies[5]);
 for(let i=0;i<5;i++)await action(i,{action:'ready'});await call('/ziteng/api/action',twin,{action:'ready',day:1,phase:'reading'});assert.equal((await state()).flow.phase,'reading');await action(5,{action:'ready'});
 for(let i=0;i<6;i++)await action(i,{action:'vote',area:i<3?'east':'west'});
 assert.equal((await state()).flow.phase,'tie');await action(1,{action:'tie',area:'east'},409);await action(0,{action:'tie',area:'east'});
 const first=(await state()).flow.cards.find(c=>c.available);await action(1,{action:'take',card:first.id},409);
 await action(0,{action:'take',card:first.id});assert.equal((await state()).flow.phase,'resolve');assert.equal((await state()).flow.canResolve,true);
 await action(1,{action:'take',card:first.id},409);
 await call(`/ziteng/api/clue/${first.id}/content`,cookies[1],null,403);
 await action(0,{action:'resolve',keep:first.id});await action(0,{action:'resolve',keep:first.id},409);
 assert.equal((await state()).flow.actor,'role-2');
 for(let i=1;i<6;i++){
  const c=(await state(i)).flow.cards.find(c=>c.available);await action(i,{action:'take',card:c.id});
  assert.equal((await state(i)).flow.canResolve,true);assert.equal((await state(i)).flow.actor,roles[i]);
  assert.equal((await state(0)).flow.cards.filter(c=>c.public).length,0,'no early publication before last decision');
  await action(i,{action:'resolve',keep:null});
  if(i===1){const queued=await state(i);await new Promise(r=>server.close(r));await start();assert.deepEqual(await state(i),queued,'mid-round private decisions survive restart');}
 }
 assert.equal((await state()).flow.cards.filter(c=>c.public).length,5);
 assert.equal((await state()).flow.phase,'discussion');await readyAll();assert.equal((await state()).flow.day,2);
 await readyAll();for(let i=0;i<6;i++)await action(i,{action:'vote',area:'ge'});await finishSearch();await readyAll();await readyAll();
 assert.equal((await state()).flow.first,'role-6','11-card region preserves cyclic turn across days');
 for(let i=0;i<6;i++)await action(i,{action:'vote',area:'grave'});await finishSearch();await readyAll();await readyAll();
 assert.equal((await state()).flow.day,4);assert.equal((await state()).flow.phase,'take');await finishSearch();
 const final=(await state()).flow;assert.equal(final.phase,'discussion');
 const db=new DatabaseSync(path.join(temp,'ziteng','game.sqlite'));const stored=JSON.parse(db.prepare('SELECT data FROM flow').get().data);assert.equal(Object.keys(stored.owned).length,48);db.close();
 for(const r of roles)assert.ok(Object.values(stored.owned).filter(o=>o.owner===r&&!o.public).length<=1);
 await action(0,{action:'ready'},409);for(let i=0;i<5;i++)await action(i,{action:'ready',confirmed:true});await call('/ziteng/api/truth/0',cookies[0],null,403);await action(5,{action:'ready',confirmed:true});
 assert.equal((await state()).flow.phase,'ended');await call('/ziteng/api/ending/role-1/0',cookies[0]);await call('/ziteng/api/ending/role-2/0',cookies[0],null,403);await call('/ziteng/api/truth/0',cookies[0]);
 assert.deepEqual(await (await call('/api/state',oldCookie)).json(),oldBefore,'switching books does not touch original state');
 const persisted=await state();await new Promise(r=>server.close(r));await start();assert.deepEqual(await state(),persisted);assert.ok((await (await call('/ziteng/api/memories',cookies[5])).json()).cards[0].unlocked);
 console.log('通过：六人全四幕、平票、跨幕轮序、末轮、隐藏额度、回忆与原页权限、结局门禁、双端与重启、两本存档隔离。');
 // Narrow fixtures exercise conditional restrictions without changing the live database.
 const unit=new DatabaseSync(':memory:'),engine=createZitengEngine(unit,game);
 function seed(ids,turn=0,extra={}){const owned=Object.fromEntries(game.cards.filter(c=>!ids.includes(c.id)).map(c=>[c.id,{owner:'role-2',public:true}]));unit.prepare('UPDATE flow SET data=?').run(JSON.stringify({day:4,phase:'take',revision:0,ready:[],votes:{},ties:[],area:null,turn,first:turn,round:1,batch:[],resolved:[],owned,...extra}))}
 seed(['clue-8-1','clue-2-1']);assert.ok(engine.view('role-1').cards.find(c=>c.id==='clue-8-1').forbidden);
 seed(['clue-8-1']);assert.equal(engine.view('role-1').cards.find(c=>c.id==='clue-8-1').forbidden,false);
 seed(['clue-6-4','clue-11-1']);assert.ok(!engine.view('role-1').cards.some(c=>c.id==='clue-11-1'&&c.available));
 engine.act('role-1',{action:'take',card:'clue-6-4',day:4,phase:'take',revision:0});assert.equal(engine.view('role-1').phase,'resolve');assert.equal(engine.media('role-2','clue-6-4','content'),null);
 assert.throws(()=>engine.act('role-1',{action:'resolve',keep:'clue-6-4',day:4,phase:'resolve',revision:1}),/只能保留/);
 engine.act('role-1',{action:'resolve',keep:null,day:4,phase:'resolve',revision:1});assert.ok(engine.view('role-2').cards.find(c=>c.id==='clue-11-1').available);
 seed(['clue-6-1','clue-6-7','clue-2-1'],3);assert.equal(engine.view('role-4').cards.find(c=>c.id==='clue-6-7').forbidden,false);assert.equal(engine.view('role-4').cards.find(c=>c.id==='clue-6-1').forbidden,true);
 seed(['clue-2-1'],0);const privateFixture=JSON.parse(unit.prepare('SELECT data FROM flow').get().data);privateFixture.owned['clue-2-2']={owner:'role-2',public:false};unit.prepare('UPDATE flow SET data=?').run(JSON.stringify(privateFixture));
 const visibleBefore=engine.view('role-1');engine.act('role-2',{action:'publish',card:'clue-2-2',day:4,phase:'take'});assert.deepEqual(engine.view('role-1'),visibleBefore,'private queue does not leak even through current actor revision');
 const oldBatch={day:1,phase:'take',revision:20,ready:[],votes:{},ties:[],area:'east',turn:2,first:0,round:1,batch:[{role:'role-1',card:'clue-1-1'},{role:'role-2',card:'clue-1-2'}],resolved:[],owned:{'clue-1-1':{owner:'role-1',public:false},'clue-1-2':{owner:'role-2',public:false}}};
 unit.prepare('UPDATE flow SET data=?').run(JSON.stringify(oldBatch));
 assert.equal(engine.view('role-2').canResolve,true,'existing second player can decide without waiting for first');
 assert.deepEqual(JSON.parse(unit.prepare('SELECT data FROM flow').get().data),oldBatch,'reading compatibility does not rewrite progress');
 engine.act('role-2',{action:'resolve',keep:'clue-1-2',day:1,phase:'resolve',revision:20});assert.equal(engine.view('role-1').actor,'role-1');
 engine.act('role-1',{action:'resolve',keep:null,day:1,phase:'resolve',revision:21});assert.equal(engine.view('role-3').phase,'take');assert.equal(engine.view('role-3').actor,'role-3');assert.equal(engine.media('role-3','clue-1-1','content'),null,'old batch also waits for round end');unit.close();
 console.log('通过：禁搜例外、只剩禁区解除、钥匙批次之后开放药品室、强制公开不能隐藏。');
 const {chromium}=createRequire(import.meta.url)('../murder-mystery-html-builder/murder-mystery-html-builder/node_modules/playwright-core');
 browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',headless:true});const errors=[];
 const fixtureDb=new DatabaseSync(path.join(temp,'ziteng','game.sqlite'));
 const fixture=s=>fixtureDb.prepare('UPDATE flow SET data=?').run(JSON.stringify(s));
 for(const [width,height]of [[390,844],[820,1180],[1280,900]]){
  const context=await browser.newContext({viewport:{width,height}}),page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base);await page.getByRole('link',{name:'进入紫藤夫人'}).click();await page.locator('#name').fill('布局测试');await page.getByRole('button',{name:'进入游戏',exact:true}).click();await page.locator('#roles .role').first().waitFor();await fit(page,`${width} selection`);
  await context.addCookies([{name:'ziteng_session',value:cookies[5].split('=')[1],url:base+'/ziteng/'}]);
  await page.reload();await page.getByRole('button',{name:'我的回忆',exact:true}).click();await page.locator('#materials summary').first().waitFor();await fit(page,`${width} memory`);
  await page.locator('#materials details').first().evaluate(d=>d.open=true);await page.locator('#materials img').first().evaluate(i=>i.decode());await page.screenshot({path:path.join(temp,`memory-${width}.png`)});await page.getByRole('button',{name:'返回游戏',exact:true}).click();
  for(const name of ['我的结局','公共真相','公共说明与地图']){await page.getByRole('button',{name,exact:true}).click();await page.locator('#materials img').first().evaluate(i=>i.decode());await fit(page,`${width} ${name}`);await page.getByRole('button',{name:'返回游戏',exact:true}).click()}
  const endingState=JSON.parse(fixtureDb.prepare('SELECT data FROM flow').get().data);
  fixture({...endingState,day:1,phase:'vote',ready:[],votes:{},ties:[],owned:{},area:null,turn:5,first:5,batch:[],resolved:[]});
  await page.reload();await page.getByRole('button',{name:'投给 宝殊镇东',exact:true}).click();await page.getByText('乐婉：宝殊镇东',{exact:true}).waitFor();await fit(page,`${width} vote`);
  fixture({...endingState,day:1,phase:'take',round:1,ready:[],votes:{},ties:[],owned:{},area:'east',turn:5,first:5,batch:[],resolved:[]});
  await page.reload();await page.locator('#locations').waitFor();await fit(page,`${width} take`);await page.locator('#flow img').first().evaluate(i=>i.decode());
  await page.getByRole('button',{name:/领取 ·/}).first().click();await page.locator('#clues details[open] img').first().evaluate(i=>i.decode());
  await page.getByRole('button',{name:/^隐藏「/}).first().waitFor();await fit(page,`${width} immediate resolve`);await page.screenshot({path:path.join(temp,`resolve-${width}.png`)});
  await page.getByRole('button',{name:/^隐藏「/}).first().click();await page.getByRole('button',{name:'加入待公开（不可撤回）',exact:true}).waitFor();
  await page.locator('#clues details[open] img').first().evaluate(i=>i.dataset.readingMarker='kept');
  const nextCard=(await state(0)).flow.cards.find(c=>c.available&&!c.forbidden);await action(0,{action:'take',card:nextCard.id});
  await page.getByText('等待 葛月萝 选择公开或隐藏。选好后交给下一人，公开内容在轮末统一发布。',{exact:true}).waitFor();
  assert.equal(await page.locator('#clues details[open] img').first().getAttribute('data-reading-marker'),'kept','other turns do not replace the image being read');
  fixture({...oldBatch,turn:1,batch:[{role:'role-1',card:'clue-1-1'},{role:'role-6',card:'clue-1-2'}],owned:{'clue-1-1':{owner:'role-1',public:false},'clue-1-2':{owner:'role-6',public:false}}});
  await page.reload();await page.getByRole('button',{name:/^隐藏「/}).first().waitFor();await page.getByRole('button',{name:/^隐藏「/}).first().click();await page.getByText('等待 葛月萝 选择公开或隐藏。选好后交给下一人，公开内容在轮末统一发布。',{exact:true}).waitFor();
  fixture(endingState);await context.close();console.log(`Chrome通过 ${width}×${height}：剧本选择、登录、选角、地点投票、拿牌与隐藏、回忆和终局原图。`);
 }
 fixtureDb.close();assert.deepEqual(errors,[]);console.log(`截图与独立测试库：${temp}`);
}
finally{await browser?.close();if(server?.listening)await new Promise(r=>server.close(r))}
