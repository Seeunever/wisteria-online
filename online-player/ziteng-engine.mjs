// Explicit rules for this pack, intentionally separate from Yingxie's search engine.
export function createZitengEngine(db,game){
 const roles=game.roles.map(r=>r.id);
 db.exec(`CREATE TABLE IF NOT EXISTS flow (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS memories (card TEXT PRIMARY KEY, role TEXT NOT NULL);`);
 const read=()=>{
  const s=JSON.parse(db.prepare('SELECT data FROM flow WHERE id=1').get().data);
  // Older sessions may already have several cards taken before anyone resolved.
  // Expose those existing decisions immediately, without rewriting or discarding them.
  if(s.phase==='take'&&s.batch.some(x=>!s.resolved.includes(x.role)))s.phase='resolve';
  return s;
 };
 const save=s=>db.prepare('INSERT OR REPLACE INTO flow VALUES(1,?)').run(JSON.stringify(s));
 if(!db.prepare('SELECT id FROM flow WHERE id=1').get())save({day:1,phase:'reading',revision:0,ready:[],votes:{},ties:[],area:null,turn:0,first:0,round:1,batch:[],resolved:[],owned:{}});
 const pool=s=>game.cards.filter(c=>c.day<=s.day&&!s.owned[c.id]&&(!c.requires||s.owned[c.requires]?.public)&&(s.day===4||c.area===s.area));
 const choices=(s,role)=>{
  const all=pool(s);const bans=s.day===4?game.bans[role]||[]:[];
  // The book explicitly lifts a personal ban when only those places remain.
  return all.some(c=>!bans.includes(c.id))?all.filter(c=>!bans.includes(c.id)):all;
 };
 const areas=s=>game.groups.filter(g=>g.day<=s.day&&game.cards.some(c=>c.area===g.id&&!s.owned[c.id]));
 const pending=(s,role)=>s.batch.some(x=>x.role===role)&&!s.resolved.includes(role);
 const current=s=>s.phase==='take'?roles[s.turn]:s.phase==='resolve'?s.batch.find(x=>!s.resolved.includes(x.role))?.role:s.phase==='tie'?roles[s.first]:null;
 function flush(s){for(const o of Object.values(s.owned))if(o.queued){o.public=true;delete o.queued}}
 function startRound(s){s.batch=[];s.resolved=[];s.phase=pool(s).length?'take':'discussion';s.ready=[]}
 function beginArea(s,area){s.area=area;s.votes={};s.ties=[];s.round=1;startRound(s)}
 function act(role,body){
  if(!roles.includes(role))throw Error('请先选择角色');
  db.exec('BEGIN IMMEDIATE');
  try{
   const s=read();
   if(body.day!==s.day||body.phase!==s.phase)throw Error('环节已变化，请查看当前进度');
   if(s.phase==='ended')throw Error('游戏已结束');
   if(body.action==='ready'){
    if(!['reading','discussion'].includes(s.phase))throw Error('当前不是阶段确认环节');
    if(s.day===4&&s.phase==='discussion'&&body.confirmed!==true)throw Error('请明确确认准备揭晓结局与真相');
    if(!s.ready.includes(role))s.ready.push(role);
    if(s.ready.length===roles.length){
     flush(s);s.ready=[];
     if(s.phase==='reading'){
      s.first=s.turn;s.round=1;
      if(s.day===4){s.area=null;startRound(s)}else{s.phase='vote';s.votes={};s.ties=[]}
     }else if(s.day===4)s.phase='ended';
     else{s.day++;s.phase='reading';s.area=null;s.votes={};s.batch=[];s.resolved=[]}
    }
   }else if(body.action==='vote'){
    if(s.phase!=='vote'||!areas(s).some(g=>g.id===body.area))throw Error('请选择本日开放且未调查的区域');
    s.votes[role]=body.area;
    if(Object.keys(s.votes).length===roles.length){
     const counts=Object.values(s.votes).reduce((all,id)=>(all[id]=(all[id]||0)+1,all),{});
     const max=Math.max(...Object.values(counts));const winners=Object.keys(counts).filter(id=>counts[id]===max);
     if(winners.length===1)beginArea(s,winners[0]);else{s.ties=winners;s.phase='tie'}
    }
   }else if(body.action==='publish'){
    const item=s.owned[body.card];
    if(!item||item.owner!==role||item.public||item.queued)throw Error('只能公开自己的隐藏线索');
    if(s.batch.some(item=>item.role===role)&&!s.resolved.includes(role))throw Error('请在本轮公开/隐藏处理时作出选择');
    item.queued=true;
   }else{
    if(body.revision!==s.revision)throw Error('进度已更新，请重试当前操作');
    if(current(s)!==role&&!(body.action==='resolve'&&s.phase==='resolve'&&pending(s,role)))throw Error('还没轮到你');
    if(body.action==='tie'){
     if(s.phase!=='tie'||!s.ties.includes(body.area))throw Error('只能选择并列最高票区域');beginArea(s,body.area);
    }else if(body.action==='take'){
     const card=s.phase==='take'&&choices(s,role).find(c=>c.id===body.card);
     if(!card)throw Error('这张卡尚未开放、已被领取或当前禁止调查');
     s.owned[card.id]={owner:role,public:false,queued:card.mandatory};
     s.batch.push({role,card:card.id});s.turn=(s.turn+1)%roles.length;
     s.phase='resolve';
    }else if(body.action==='resolve'){
     if(s.phase!=='resolve'||!pending(s,role))throw Error('请先领取本轮线索，再选择公开或隐藏');
     const hidden=Object.entries(s.owned).filter(([,o])=>o.owner===role&&!o.public&&!o.queued).map(([id])=>id);
     if(body.keep!==null&&!hidden.includes(body.keep))throw Error('只能保留自己的未公开卡');
     for(const id of hidden)if(id!==body.keep)s.owned[id].queued=true;
     s.resolved.push(role);
     if(s.resolved.length===s.batch.length){
      if(s.batch.length===roles.length||!pool(s).length){flush(s);s.round++;startRound(s)}
      else s.phase='take';
     }
    }else throw Error('未知行动');
   }
   // Queuing a hidden card must not change another player's visible turn token.
   if(body.action!=='publish')s.revision++;save(s);db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error}
 }
 function view(role){
  const s=read(),actor=current(s),choosing=s.phase==='take'&&actor===role,canResolve=s.phase==='resolve'&&pending(s,role);
  const allowed=choosing?new Set(choices(s,role).map(c=>c.id)):new Set();
  const poolIds=choosing?new Set(pool(s).map(c=>c.id)):new Set();
  const ownBatch=s.batch.find(x=>x.role===role);
  return {day:s.day,phase:s.phase,ready:s.ready,round:s.round,area:s.area,actor,first:roles[s.first],
   revision:actor===role||canResolve?s.revision:null,canResolve,
   votes:['vote','tie'].includes(s.phase)?s.votes:{},ties:s.ties,
   areas:['vote','tie'].includes(s.phase)?areas(s).map(g=>({id:g.id,title:g.title})):[],
   canPublish:!(ownBatch&&!s.resolved.includes(role))&&s.phase!=='ended',
   privatePending:ownBatch&&!s.resolved.includes(role)?ownBatch.card:null,
   cards:game.cards.filter(c=>{const o=s.owned[c.id];return o?(o.public||o.owner===role):poolIds.has(c.id)}).map(c=>{
    const o=s.owned[c.id],mine=o?.owner===role;
    return {id:c.id,area:c.area,title:c.title,mine:!!mine,public:!!o?.public,queued:mine&&!!o.queued,
     available:!o,forbidden:!o&&!allowed.has(c.id),mandatory:o?c.mandatory:false,
     front:o?null:`/ziteng/api/clue/${c.id}/front`,content:o?`/ziteng/api/clue/${c.id}/content`:null};
   })};
 }
 function media(role,id,side){
  const c=game.cards.find(c=>c.id===id);if(!roles.includes(role)||!c)return null;
  const s=read(),o=s.owned[id];
  if(side==='content'&&(o?.public||o?.owner===role))return c.content;
  if(side==='front'&&s.phase==='take'&&current(s)===role&&pool(s).some(x=>x.id===id))return c.front;
  return null;
 }
 function memories(role){return game.memories.filter(c=>c.role===role).map(c=>{
  const unlocked=!!db.prepare('SELECT card FROM memories WHERE card=? AND role=?').get(c.id,role);
  return {id:c.id,number:c.number,trigger:c.trigger,unlocked,front:`/ziteng/api/memory/${c.id}/front`,content:unlocked?`/ziteng/api/memory/${c.id}/content`:null};
 })}
 function reveal(role,body){
  if(body.confirmed!==true||!game.memories.some(c=>c.role===role&&c.id===body.card))throw Error('请按本人的关键词条件确认回忆');
  db.prepare('INSERT OR IGNORE INTO memories VALUES(?,?)').run(body.card,role);
 }
 function memoryMedia(role,id,side){
  const c=game.memories.find(c=>c.id===id&&c.role===role);if(!c)return null;
  if(side==='front')return c.front;
  return side==='content'&&db.prepare('SELECT card FROM memories WHERE card=? AND role=?').get(id,role)?c.content:null;
 }
 return {act,view,media,memories,reveal,memoryMedia,status:()=>{const s=read();return {day:s.day,phase:s.phase}}};
}
