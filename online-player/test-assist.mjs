// Explicit, click-triggered helpers for these two test packs; never a background bot.
function createRunner({db,roles,book,enabled,snapshot,advance}){
 if(enabled)db.exec('CREATE TABLE IF NOT EXISTS test_assist_requests (id TEXT PRIMARY KEY, name TEXT NOT NULL, result TEXT NOT NULL)');
 function fillSeats(){
  let count=0;
  for(const [i,r]of roles.entries()){
   if(db.prepare('SELECT name FROM players WHERE role=?').get(r.id))continue;
   const stem=`测试助手·${book}·${i+1}`;let name=stem,n=0;
   while(db.prepare('SELECT name FROM players WHERE name=?').get(name))name=stem+'-'+(++n);
   db.prepare('INSERT INTO players(name,role) VALUES(?,?)').run(name,r.id);count++;
  }
  return count;
 }
 return {enabled,run(player,body){
  if(!enabled)throw Error('测试辅助未启用');
  if(!roles.some(r=>r.id===player.role))throw Error('请先选择自己的角色');
  if(body.confirmed!==true||typeof body.requestId!=='string'||!/^[a-zA-Z0-9-]{16,80}$/.test(body.requestId))throw Error('请通过测试辅助按钮操作');
  const previous=db.prepare('SELECT name,result FROM test_assist_requests WHERE id=?').get(body.requestId);
  if(previous){if(previous.name!==player.name)throw Error('请求不属于当前账号');return JSON.parse(previous.result)}
  const before=snapshot(player.role);
  if(body.checkpoint!==before.checkpoint)throw Error('环节已变化，请刷新后再补完');
  if(before.ended)return {ok:true,message:'本局已结束，不再代操作。'};
  const added=fillSeats();let result;
  try{const outcome=advance(player.role,before);result={ok:true,message:`${added?`补齐 ${added} 个测试角色；`:''}${outcome}`}}
  catch{result={ok:false,error:'补完中止，已完成的动作已保留。请刷新查看当前环节。'}}
  db.prepare('INSERT INTO test_assist_requests VALUES(?,?,?)').run(body.requestId,player.name,JSON.stringify(result));return result;
 }};
}
const checkpoint=(phase,act,round)=>`${phase}/${act}/${round}`;
const keepEarlier=(cards,pending)=>cards.find(c=>c.mine&&!c.public&&!c.queued&&c.id!==pending)?.id||null;

export function createYingxieTestAssist({db,roles,search,progress,enabled}){
 const snapshot=role=>{const p=progress(),s=search.view(role);return {s,p,checkpoint:checkpoint(s?.phase||p.phase,s?.act||1,s?.round||0),ended:s?.phase==='act-3-ended'}};
 return createRunner({db,roles,book:'应邪',enabled,snapshot,advance(caller,initial){
  const first=initial.s;let actions=0;
  const done=reason=>`已代操作 ${actions} 次。${reason}`;
  for(let limit=0;limit<60;limit++){
   const {s,p}=snapshot(caller);
   if(!s){
    for(const r of roles)if(r.id!==caller&&!p.ready.includes(r.id)){db.prepare('INSERT OR IGNORE INTO readiness(phase,role) VALUES(?,?)').run('act-1-reading',r.id);actions++}
    progress();if(!p.ready.includes(caller))return done('其他人已确认，等待你确认阅读完成。');continue;
   }
   if(s.phase==='act-3-ended')return done('全员已确认，结局与真相已开放。');
   if(first&&(s.act!==first.act||s.round!==first.round))return done('本轮或本幕已完成，请查看新环节。');
   if(s.phase.endsWith('-search')){
    const actor=roles[s.turn]?.id;if(actor===caller)return done('轮到你拿牌或选择公开／隐藏。');
    const own=search.view(actor),card=own.cards.find(c=>c.available&&!c.forbidden);
    const body=own.pending?{action:'resolve',card:own.pending,keep:keepEarlier(own.cards,own.pending)}:card?{action:'take',card:card.id}:{action:'skip'};
    search.act(actor,{...body,revision:own.revision});actions++;continue;
   }
   if(first?.phase.endsWith('-search'))return done('本轮搜证已完成，请先讨论，再由你确认。');
   const final=s.phase==='act-3-discussion';
   if(final&&!s.ready.includes(caller))return done('请你先明确确认结束游戏，助手不会替你揭晓。');
   for(const r of roles)if(r.id!==caller&&!s.ready.includes(r.id)){
    search.act(r.id,{action:'confirm-phase',phase:s.phase,...(final?{confirmed:true}:{})});actions++;
   }
   if(!s.ready.includes(caller))return done('其他人已确认，等待你确认。');
   const now=search.view(caller);
   if(now.phase.endsWith('-reading'))return done('已进入下一幕，请先阅读自己的剧本。');
  }
  return done('已到本次补完上限，请查看进度后继续。');
 }});
}

export function createZitengTestAssist({db,roles,engine,enabled}){
 const snapshot=role=>{const s=engine.view(role);return {s,checkpoint:checkpoint(s.phase,s.day,s.round),ended:s.phase==='ended'}};
 return createRunner({db,roles,book:'紫藤',enabled,snapshot,advance(caller,initial){
  const first=initial.s;let actions=0;const done=reason=>`已代操作 ${actions} 次。${reason}`;
  const act=(role,body)=>{const s=engine.view(role);engine.act(role,{day:s.day,phase:s.phase,revision:s.revision,...body});actions++};
  for(let limit=0;limit<80;limit++){
   const s=engine.view(caller);
   if(s.phase==='ended')return done('全员已确认，结局与真相已开放。');
   if(s.day!==first.day||s.round!==first.round)return done('本轮或本幕已完成，请查看新环节。');
   if(['reading','discussion'].includes(s.phase)){
    if(['take','resolve','vote','tie'].includes(first.phase))return done('本轮搜证已完成，请先讨论，再由你确认。');
    const final=s.day===4&&s.phase==='discussion';
    if(final&&!s.ready.includes(caller))return done('请你先明确确认结束游戏，助手不会替你揭晓。');
    for(const r of roles)if(r.id!==caller&&!s.ready.includes(r.id))act(r.id,{action:'ready',...(final?{confirmed:true}:{})});
    if(!s.ready.includes(caller))return done('其他人已确认，等待你确认。');continue;
   }
   if(s.phase==='vote'){
    const area=s.votes[caller]||s.areas[0]?.id;
    for(const r of roles)if(r.id!==caller&&!s.votes[r.id])act(r.id,{action:'vote',area});
    if(!s.votes[caller])return done('其他人已投票，请你选择调查区域。');continue;
   }
   if(s.canResolve||s.actor===caller)return done('轮到你选择地点、拿牌或决定公开／隐藏。');
   if(s.phase==='tie'){act(s.actor,{action:'tie',area:s.ties[0]});continue}
   const own=engine.view(s.actor);
   if(s.phase==='resolve'){act(s.actor,{action:'resolve',keep:keepEarlier(own.cards,own.privatePending)});continue}
   if(s.phase==='take'){
    const card=own.cards.find(c=>c.available&&!c.forbidden);if(!card)return done('当前没有合法牌，已停止，请检查本轮规则。');
    act(s.actor,{action:'take',card:card.id});continue;
   }
   return done('当前没有需要代操作的环节。');
  }
  return done('已到本次补完上限，请查看进度后继续。');
 }});
}
