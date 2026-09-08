// Explicit flow for this pack. Existing first-act saves need no destructive migration.
export function createSearch(db,cards,roles){
  db.exec('CREATE TABLE IF NOT EXISTS search_state (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL)');
  const read=()=>{const row=db.prepare('SELECT data FROM search_state WHERE id=1').get();return row?JSON.parse(row.data):null};
  const save=s=>db.prepare('INSERT OR REPLACE INTO search_state VALUES (1,?)').run(JSON.stringify(s));
  // User removed the round-break gate. Preserve all cards and only resume that obsolete phase.
  const previous=read();
  if(previous?.phase==='act-1-round-discussion'){
    previous.phase='act-1-search';previous.round=2;previous.turn=0;previous.ready=[];previous.revision++;save(previous);
  }
  const actNumber=s=>Number(s.phase.split('-')[1]);
  const released=(s,c)=>c.act<actNumber(s)||(c.act===actNumber(s)&&!s.phase.endsWith('-reading'));
  const inPool=(s,c)=>actNumber(s)===3?c.act<=3:c.act===actNumber(s);
  // Third-act restrictions are its current residences/items, not the earlier act's temporary bans.
  const homes={'r01-xiunong':'主楼二层','r02-qiqiao':'副楼二层－小姐房','r03-qigong':'少爷房－里屋','r04-jiawu':'少爷房－外屋','r05-tong':'客房'};
  const forbidden=(s,c,role)=>actNumber(s)===3?(c.act===3?c.forbidden.includes(role):c.location===homes[role]):c.forbidden.includes(role);
  const legal=(s,role)=>cards.filter(c=>inPool(s,c)&&!s.owned[c.id]&&!forbidden(s,c,role));
  function start(){if(!read())save({phase:'act-1-search',round:1,turn:0,revision:0,pending:null,owned:{},ready:[]})}
  function publishBatch(s){for(const item of Object.values(s.owned))if(item.queued){item.public=true;delete item.queued}}
  function advance(s){
    s.pending=null;s.turn++;
    if(actNumber(s)===3&&!roles.some(r=>legal(s,r.id).length)){
      publishBatch(s);s.phase='act-3-discussion';s.ready=[];return;
    }
    if(s.turn===roles.length){
      publishBatch(s);
      if(actNumber(s)===1&&s.round===1){s.round=2;s.turn=0}
      else if(actNumber(s)===3){s.round++;s.turn=0}
      else s.phase=actNumber(s)===2?'act-2-discussion':'act-1-discussion';
      s.ready=[];
    }
  }
  function act(role,body){
    db.exec('BEGIN IMMEDIATE');
    try{
      const s=read();if(!s)throw Error('尚未开始搜证');
      if(!roles.some(r=>r.id===role))throw Error('请先选择角色');
      if(body.action==='publish'){
        if(s.phase==='act-3-ended')throw Error('游戏已结束，线索公开状态不再改变');
        const item=s.owned[body.card];if(!item||item.owner!==role)throw Error('只能公开自己的线索');
        if(!item.public)item.queued=true;
      }else{
        if(body.action!=='confirm-phase'&&body.revision!==s.revision)throw Error('状态已更新，请查看最新进度后操作');
        if(body.action==='confirm-phase'){
          const next={'act-1-discussion':'act-2-reading','act-2-reading':'act-2-search','act-2-discussion':'act-3-reading','act-3-reading':'act-3-search','act-3-discussion':'act-3-ended'}[s.phase];
          if(!next||body.phase!==s.phase)throw Error('阶段已变化或尚未开放，请查看最新进度');
          if(next==='act-3-ended'&&body.confirmed!==true)throw Error('请先确认讨论与个人回答已完成，准备揭晓结局和真相');
          if(!s.ready.includes(role))s.ready.push(role);
          if(s.ready.length===roles.length){publishBatch(s);s.phase=next;if(next!=='act-3-ended'){s.round=1;s.turn=0;s.ready=[]}}
        }else{
          if(!['act-1-search','act-2-search','act-3-search'].includes(s.phase)||roles[s.turn]?.id!==role)throw Error('还没轮到你搜证');
          if(body.action==='take'){
            if(s.pending)throw Error('请先处理刚取得的线索');
            const card=legal(s,role).find(c=>c.id===body.card);if(!card)throw Error('这张卡已被拿走或不允许你调查');
            s.owned[card.id]={owner:role,public:false,queued:card.mandatory};
            // Even mandatory cards wait for the same anonymous round-end batch.
            s.pending=card.id;
          }else if(body.action==='resolve'){
            if(!s.pending||body.card!==s.pending)throw Error('没有对应的待处理线索');
            const hidden=Object.entries(s.owned).filter(([,v])=>v.owner===role&&!v.public&&!v.queued).map(([id])=>id);
            if(body.keep!==null&&!hidden.includes(body.keep))throw Error('只能保留自己尚未公开的卡');
            for(const id of hidden)if(id!==body.keep)s.owned[id].queued=true;
            advance(s);
          }else if(body.action==='skip'){
            if(s.pending||legal(s,role).length)throw Error('还有可拿的卡，不能跳过');
            advance(s);
          }else throw Error('未知操作');
        }
      }
      s.revision++;save(s);db.exec('COMMIT');
    }catch(e){db.exec('ROLLBACK');throw e}
  }
  function choosing(s,role){return s.phase.endsWith('-search')&&roles[s.turn]?.id===role&&!s.pending}
  function view(role){
    const s=read();if(!s)return null;
    const isTurn=s.phase.endsWith('-search')&&roles[s.turn]?.id===role;
    // Explicit allow-list: never spread private server state into a player response.
    return {phase:s.phase,round:s.round,turn:s.turn,act:actNumber(s),ready:s.ready,
      revision:isTurn?s.revision:null,pending:isTurn?s.pending:null,
      completed:roles.slice(0,s.turn).map(r=>r.id),
      cards:cards.filter(c=>released(s,c)).filter(c=>{
        const item=s.owned[c.id];return item?(item.public||item.owner===role):(choosing(s,role)&&inPool(s,c));
      }).map(c=>{
        const item=s.owned[c.id],mine=item?.owner===role,available=!item;
        return {id:c.id,act:c.act,location:c.location,mine,available,public:!!item?.public,
          queued:mine&&!!item?.queued,forbidden:available&&forbidden(s,c,role),
          front:available?`/api/clue/${c.id}/front`:null,
          content:item?`/api/clue/${c.id}/content`:null};
      })};
  }
  function media(role,id,side){const s=read(),card=cards.find(c=>c.id===id);if(!s||!role||!card||!released(s,card))return null;const owned=s.owned[id];if(side==='front'&&choosing(s,role)&&!owned&&inPool(s,card))return card.front;if(side==='content'&&owned&&(owned.public||owned.owner===role))return card.content;return null}
  return {start,act,view,media,currentAct:()=>read()?actNumber(read()):1,currentPhase:()=>read()?.phase};
}
