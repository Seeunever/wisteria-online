// Private progress is deliberately separate from shared search revisions and turns.
export function createMemories(db,cards,currentAct){
  db.exec('CREATE TABLE IF NOT EXISTS memories (role TEXT NOT NULL, card TEXT NOT NULL, PRIMARY KEY(role,card))');
  const own=(role,id)=>currentAct()>=3&&cards.find(c=>c.role===role&&c.id===id);
  const unlocked=(role,id)=>!!db.prepare('SELECT 1 FROM memories WHERE role=? AND card=?').get(role,id);
  function view(role){
    if(!role||currentAct()<3)return {enabled:false,cards:[]};
    return {enabled:true,cards:cards.filter(c=>c.role===role).map(c=>({id:c.id,number:c.number,trigger:c.trigger,unlocked:unlocked(role,c.id),front:`/api/memory/${c.id}/front`,content:unlocked(role,c.id)?`/api/memory/${c.id}/content`:null}))};
  }
  function reveal(role,body){
    if(!own(role,body.card))throw Error('这张回忆当前不可触发');
    if(body.confirmed!==true)throw Error('请先确认原文中的关键词条件已经满足');
    db.prepare('INSERT OR IGNORE INTO memories(role,card) VALUES (?,?)').run(role,body.card);
  }
  function media(role,id,side){const card=own(role,id);if(!card)return null;return side==='front'?card.front:unlocked(role,id)?card.content:null}
  return {view,reveal,media};
}
