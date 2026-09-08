import assert from 'node:assert/strict';
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {createZitengEngine} from './ziteng-engine.mjs';
import {createZitengTestAssist} from './test-assist.mjs';
const game=JSON.parse(fs.readFileSync(new URL('./private/ziteng/game.json',import.meta.url),'utf8'));
const roles=game.roles;
function fixture(caller){
 const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE players(name TEXT PRIMARY KEY,role TEXT UNIQUE)');db.prepare('INSERT INTO players VALUES(?,?)').run('human',caller);
 const engine=createZitengEngine(db,game),seen=new Set();let assisting=false;
 const act=(role,body)=>{
  const s=engine.view(role);seen.add(`${s.day}/${s.phase}`);
  if(assisting){
   assert.notEqual(role,caller,'helper never acts for caller');
   if(body.action==='take')assert.equal(body.card,s.cards.find(c=>c.available&&!c.forbidden).id,'first legal card, including day-four restrictions');
   if(body.action==='resolve')assert.equal(body.keep,s.cards.find(c=>c.mine&&!c.public&&!c.queued&&c.id!==s.privatePending)?.id||null,'keep earlier hidden card');
  }
  engine.act(role,{day:s.day,phase:s.phase,revision:s.revision,...body});
 };
 const assistant=createZitengTestAssist({db,roles,engine:{view:engine.view,act},enabled:true});
 const help=()=>{const s=engine.view(caller);assisting=true;try{const r=assistant.run({name:'human',role:caller},{confirmed:true,requestId:randomUUID(),checkpoint:`${s.phase}/${s.day}/${s.round}`});assert.equal(r.ok,true,r.error);return r}finally{assisting=false}};
 return {db,engine,seen,act,help};
}
// Each seat must be able to finish alone, not only the role used in the original UI test.
for(const role of roles){
 const {db,engine,seen,act,help}=fixture(role.id);
 try{
  for(let step=0;step<300;step++){
   const s=engine.view(role.id);seen.add(`${s.day}/${s.phase}`);if(s.phase==='ended')break;
   if(['reading','discussion'].includes(s.phase)){
    if(!s.ready.includes(role.id)){
     if(s.day===4&&s.phase==='discussion'){const before=db.prepare('SELECT data FROM flow').get().data;help();assert.equal(db.prepare('SELECT data FROM flow').get().data,before,'must not reveal before caller confirmation')}
     act(role.id,{action:'ready',confirmed:true});
    }else help();
   }else if(s.phase==='vote'){
    if(!s.votes[role.id])act(role.id,{action:'vote',area:s.areas[0].id});else help();
   }else if(s.phase==='tie'&&s.actor===role.id)act(role.id,{action:'tie',area:s.ties[0]});
   else if(s.canResolve)act(role.id,{action:'resolve',keep:s.cards.find(c=>c.mine&&!c.public&&!c.queued)?.id||null});
   else if(s.actor===role.id)act(role.id,{action:'take',card:s.cards.find(c=>c.available&&!c.forbidden).id});
   else help();
   assert.ok(step<299,'whole game must finish');
  }
  assert.equal(engine.view(role.id).phase,'ended');
  for(let day=1;day<=4;day++)for(const phase of ['reading','take','resolve','discussion',...(day<4?['vote']:[])])assert.ok(seen.has(`${day}/${phase}`),`missing ${day}/${phase}`);
  assert.equal(db.prepare('SELECT count(*) n FROM memories').get().n,0,'memories stay manual and private');
  console.log(`紫藤角色 ${role.number}：单人走完四幕与揭晓，各幕确认/投区/搜证/处理均覆盖。`);
 }finally{db.close()}
}
// Force the real voting engine into a tied result; check both caller and other-player tie breakers.
for(const caller of [roles[0].id,roles[1].id]){
 const {db,engine,act,help}=fixture(caller);
 try{
  for(const r of roles)act(r.id,{action:'ready'});
  const areas=engine.view(caller).areas;assert.ok(areas.length>=2);
  for(const [i,r]of roles.entries())act(r.id,{action:'vote',area:areas[i<3?0:1].id});
  const s=engine.view(caller);assert.equal(s.phase,'tie');const before=db.prepare('SELECT data FROM flow').get().data;
  help();
  if(s.actor===caller)assert.equal(db.prepare('SELECT data FROM flow').get().data,before,'human tie breaker is not overridden');
  else{const after=engine.view(caller);assert.equal(after.area,s.ties[0]);assert.equal(after.actor,caller)}
 }finally{db.close()}
}
console.log('通过：平票轮到别人可补、轮到本人则停；所有数据仅在内存，不推进在线游戏。');
