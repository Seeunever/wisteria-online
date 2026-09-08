let searchSignature='',selectedLocation='';
function renderSearch(state){
  let section=document.getElementById('search');
  if(!section){section=document.createElement('section');section.id='search';document.getElementById('pages').before(section)}
  const s=state.search;if(!s){section.hidden=true;return}section.hidden=false;
  const sig=JSON.stringify([s,state.role]);if(sig===searchSignature)return;searchSignature=sig;
  section.replaceChildren();
  const el=(tag,text,parent=section)=>{const node=document.createElement(tag);if(text)node.textContent=text;parent.append(node);return node};
  const action=async(body,button)=>{
    if(body.action==='confirm-phase'&&body.phase==='act-3-discussion'){
      if(!window.confirm('确认讨论和个人回答已完成？全员确认后将结束游戏，开放个人结局与公共真相，不能返回未揭晓状态。'))return;
      body={...body,confirmed:true};
    }
    button.disabled=true;try{await api('/api/search',{...body,revision:s.revision});signature='';await refresh()}catch(error){$('error').textContent=error.message;button.disabled=false;signature='';}
  };
  const btn=(text,body,parent=section)=>{const b=el('button',text,parent);b.className='search-action';b.onclick=()=>action(body,b);return b};
  const current=state.roles[s.turn];const mine=current?.id===state.role;const pending=s.pending&&s.cards.find(c=>c.id===s.pending);
  const actName=['','第一','第二','第三'][s.act];
  el('h2',s.phase==='act-3-ended'?'游戏已结束 · 结局与复盘':s.phase.endsWith('-search')?`第 ${s.round}${s.act===3?'':` / ${s.act===2?1:2}`} 轮 · 轮到${current.name}`:s.phase.endsWith('-reading')?`${actName}幕 · 阅读与交流`:`${actName}幕搜证结束 · 讨论时间`);
  if(s.act===3&&s.phase.endsWith('-search'))el('p','连续调查所有剩余合法线索，不设固定轮数；不能调查自己的住处和随身物品。回忆请使用上方独立入口。');
  if(s.phase.endsWith('-search'))el('p',`本轮已完成：${s.completed.map(id=>state.roles.find(r=>r.id===id).name).join('、')||'暂无'}。公开线索将在本轮结束后统一显示，不标记领取者。`);
  const gates={
    'act-1-discussion':['先完成本幕讨论；全员确认后才开放第二幕。','讨论结束，进入第二幕'],
    'act-2-reading':['请阅读下方第03–04页，并集体交流。调查前不可私聊，调查结束后才可私聊。','第二幕读完并交流好，开始搜证'],
    'act-2-discussion':['第二幕一轮搜证已结束，现在可以私聊。完成讨论后，全员确认进入第三幕。','讨论结束，进入第三幕'],
    'act-3-reading':['请阅读下方第05–08页，可以私聊。回忆关键词与编号见自己的07页；符合条件时使用“我的回忆”。','第三幕读完并交流好，开始搜证'],
    'act-3-discussion':['请先完成最终讨论，并口头或自行记录个人“你知道吗？”的回答、核对任务。不是搜证完就立刻揭晓；全员确认后才开放结局和公共真相。','讨论与个人回答已完成，确认结束游戏']
  };
  if(gates[s.phase]){
    el('p',gates[s.phase][0]);
    if(s.phase==='act-3-discussion'){const link=el('a','查看原始结束规则');link.href='/api/end-guide';link.target='_blank';link.rel='noopener';}
    el('p',`已确认 ${s.ready.length} / 5 人`);
    btn(s.ready.includes(state.role)?'已确认，等待大家':gates[s.phase][1],{action:'confirm-phase',phase:s.phase}).disabled=s.ready.includes(state.role);
  }else if(s.phase==='act-3-ended')el('p','五名角色已确认结束。使用上方“我的结局”和“公共真相”查看原页；结局按实际达成条件自行对照，多个满足条件的结局可以叠加。隐藏线索和回忆不会自动公开。');
  else if(pending){
    el('p',mine?'先阅读刚取得的卡，再决定保留哪张。最多隐藏一张，处理完才轮到下一人。':'等待当前玩家阅读并处理线索。');
    if(mine){
      if(pending.queued)el('p','这张卡已加入待公开区，轮末统一公开；现在只有你能读。');
      if(pending.public)el('p','这张卡已公开。');
      const hidden=s.cards.filter(c=>c.mine&&!c.public&&!c.queued);
      const label=c=>`第${c.act}幕 ${c.location} · ${c.id.slice(-2)}`;
      if(hidden.length===1&&hidden[0].id===s.pending){
        el('p','隐藏：只有你能看。选择公开：先暂存，轮末统一给所有人看，不能撤回隐藏。');
        btn('隐藏这张',{action:'resolve',card:s.pending,keep:s.pending});
        btn('公开这张（不可撤回）',{action:'resolve',card:s.pending,keep:null});
      }else if(hidden.length>1){
        el('p','你已有一张隐藏线索。请选择保留哪张，另一张将在轮末统一公开。');
        for(const c of hidden){const other=hidden.find(item=>item.id!==c.id);btn(`隐藏「${label(c)}」，公开「${label(other)}」`,{action:'resolve',card:s.pending,keep:c.id});}
        btn('两张全部公开（不可撤回）',{action:'resolve',card:s.pending,keep:null});
      }else if(hidden.length===1){
        btn('保留原来的隐藏线索，结束本次行动',{action:'resolve',card:s.pending,keep:hidden[0].id});
        btn('也公开原来的隐藏线索（不可撤回）',{action:'resolve',card:s.pending,keep:null});
      }else btn('阅读完毕，轮到下一人',{action:'resolve',card:s.pending,keep:null});
    }
  }else if(!mine){
    el('p','等待当前玩家完成本轮行动。为避免暴露谁拿了哪张牌，轮到你时才显示可选牌背。');
  }else{
    el('p','先选地点，再挑一张牌背。只有你能看到本次选择和私读内容。');
    const available=s.cards.filter(c=>c.available);
    const locations=[...new Set(available.map(c=>c.location))];
    if(!locations.includes(selectedLocation))selectedLocation=locations[0]||'';
    const label=el('label','调查地点');const select=el('select',null,label);
    locations.forEach(location=>{const option=el('option',location,select);option.value=location});select.value=selectedLocation;
    select.onchange=()=>{selectedLocation=select.value;searchSignature='';renderSearch(state)};
    const grid=el('div');grid.className='roles';
    for(const c of available.filter(c=>c.location===selectedLocation)){
      const card=el('article',null,grid);card.className='role';const img=el('img',null,card);img.src=c.front;img.alt=`${c.location} 牌背 ${c.id.slice(-2)}`;img.className='page';
      btn(c.forbidden?'本幕禁止你调查':`领取这张 · ${c.id.slice(-2)}`,{action:'take',card:c.id},card).disabled=!mine||c.forbidden;
    }
    if(mine&&!available.some(c=>!c.forbidden))btn('没有合法可拿线索，跳过',{action:'skip'});
  }
  for(const [title,cards] of [['我的私密线索',s.cards.filter(c=>c.mine&&!c.public&&!c.queued)],['待统一公开（仅自己可见）',s.cards.filter(c=>c.mine&&c.queued&&!c.public)],['公开线索',s.cards.filter(c=>c.public)]]){
    el('h2',`${title}（${cards.length}）`);
    if(!cards.length)el('p','暂无');
    for(const c of cards){
      const details=el('details');details.open=c.id===s.pending&&mine;
      el('summary',`第${c.act}幕 ${c.location} · ${c.id.slice(-2)}${c.id===s.pending?' · 刚取得':''}`,details);
      const img=el('img',null,details);img.src=c.content;img.alt=`${title} ${c.id.slice(-2)}`;img.className='page';img.style.maxWidth='620px';
      const link=el('a','打开原图',details);link.href=c.content;link.target='_blank';link.rel='noopener';
      if(s.phase!=='act-3-ended'&&!c.public&&!c.queued&&!(pending&&mine))btn('加入待公开（不可撤回）',{action:'publish',card:c.id},details);
    }
  }
  el('p',s.phase==='act-3-ended'?'普通线索公开状态已固定，仍可查看自己已有的材料。':'待公开内容在轮末统一发布；非搜证期间追加的公开选择，在下一次全员阶段确认时统一发布。');
}
