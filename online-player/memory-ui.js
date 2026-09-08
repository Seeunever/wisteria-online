let memoryRole=null,memorySignature='',memoryLoading=false;
function configureMemories(state){
  memoryRole=state.role;
  const enabled=!!state.role&&state.search?.act>=3;
  document.getElementById('memoryButton').disabled=!enabled;
  document.getElementById('memoryHint').textContent=enabled?'独立于搜证：仅本人可见，不占次数或隐藏额度。':'第三幕开放后，按自己剧本中的关键词条件触发。';
}
async function refreshMemories(){
  const dialog=document.getElementById('memoryDialog');if(!dialog.open||memoryLoading)return;memoryLoading=true;
  try{
    const data=await api('/api/memories');const sig=JSON.stringify([memoryRole,data]);if(sig===memorySignature)return;memorySignature=sig;
    const host=document.getElementById('memoryCards');const opened=new Set([...host.querySelectorAll('details[open]')].map(d=>d.dataset.card));host.replaceChildren();
    const el=(tag,text,parent=host)=>{const node=document.createElement(tag);if(text)node.textContent=text;parent.append(node);return node};
    if(!data.enabled){el('p','第三幕尚未开放。');return}
    const rule=el('a','查看自己的关键词与回忆编号（第 07–08页原图）');rule.href=`/api/act-page/${memoryRole}/3/1`;rule.target='_blank';rule.rel='noopener';
    for(const card of data.cards){
      const box=el('details');box.dataset.card=card.id;box.open=opened.has(card.id);
      const summary=el('summary',null,box);
      el('span',`回忆 ${String(card.number).padStart(2,'0')} · ${card.unlocked?'已触发':'未触发'}`,summary);
      const trigger=el('span',`触发词：${card.trigger}`,summary);trigger.className='memory-trigger';
      const img=el('img',null,box);img.src=card.unlocked?card.content:card.front;img.alt=`我的回忆 ${card.number} ${card.unlocked?'内容':'牌背'}`;img.className='page';
      if(card.unlocked){const link=el('a','打开回忆原图',box);link.href=card.content;link.target='_blank';link.rel='noopener';continue}
      const label=el('label',null,box);const check=el('input',null,label);check.type='checkbox';
      label.append(document.createTextNode(`我已听到其他玩家提及“${card.trigger}”，或在线索上看到了这个触发词（不是自己说出）。`));
      const button=el('button',`触发回忆 ${String(card.number).padStart(2,'0')}`,box);button.disabled=true;check.onchange=()=>{button.disabled=!check.checked};
      button.onclick=async()=>{button.disabled=true;try{await api('/api/memory/reveal',{card:card.id,confirmed:check.checked});memorySignature='';await refreshMemories();[...host.querySelectorAll('details')].find(d=>d.querySelector('summary').textContent.startsWith(`回忆 ${String(card.number).padStart(2,'0')}`)).open=true;document.getElementById('memoryError').textContent=''}catch(error){document.getElementById('memoryError').textContent=error.message;button.disabled=!check.checked}};
    }
  }catch(error){document.getElementById('memoryError').textContent=error.message}finally{memoryLoading=false}
}
document.getElementById('memoryButton').onclick=()=>{document.getElementById('memoryDialog').showModal();refreshMemories()};
document.getElementById('memoryClose').onclick=()=>document.getElementById('memoryDialog').close();
setInterval(refreshMemories,1500);
