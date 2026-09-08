const $=id=>document.getElementById(id);
let state=null,stateKey='',pageKey='',flowKey='',clueKey='',selectedArea='',loading=false,modalKind='',memoryKey='';
const node=(tag,text,parent)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(parent)parent.append(n);return n};
async function api(route,body){const r=await fetch('/ziteng/api/'+route,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});const d=await r.json();if(d.accessRequired)location.reload();if(!r.ok){const e=Error(d.error);e.status=r.status;throw e}return d}
async function refresh(){if(loading)return;loading=true;try{
 const next=await api('state');$('connection').textContent='';$('login').hidden=true;
 const key=JSON.stringify(next);if(key!==stateKey){state=next;stateKey=key;render()}
}catch(e){if(e.status===401){$('login').hidden=false;$('selection').hidden=true;$('game').hidden=true;stateKey=''}else $('connection').textContent='连接暂时中断，正在重试；已显示的原页仍可阅读。'}finally{loading=false}}
const roleName=id=>state.roles.find(r=>r.id===id)?.name||'玩家';
const areaNames={east:'宝殊镇东',west:'宝殊镇西',ge:'葛家',grave:'坟场及周围',zhang:'张家',yu:'于家',tavern:'吕家酒馆',old:'葛家旧屋',other:'其他地点',medicine:'张家药品室'};
const cardTitle=c=>`${areaNames[c.area]} · ${c.title}`;
function button(text,body,parent){const b=node('button',text,parent);b.onclick=async()=>{
 if(body.action==='ready'&&state.flow.day===4&&state.flow.phase==='discussion'){
  if(!confirm('讨论和个人回答已完成？全员确认后将开放结局与真相，不能退回未揭晓状态。'))return;
  body={...body,confirmed:true};
 }
 const {day,phase,revision}=state.flow;b.disabled=true;
 try{await api('action',{day,phase,revision,...body});$('error').textContent='';await refresh()}catch(e){$('error').textContent=e.message;b.disabled=false;await refresh()}
};return b}
function imagePage(url,title,parent){const link=node('a','打开原图',parent);link.href=url;link.target='_blank';link.rel='noopener';const img=node('img',undefined,parent);img.src=url;img.alt=title;img.className='page';return img}
function detail(id,title,parent,open=false){const d=node('details',undefined,parent);d.dataset.key=id;d.open=open;node('summary',title,d);return d}
function render(){
 configureTestAssist(state,async()=>{stateKey='';await refresh()},'/ziteng/api/test-assist');
 $('selection').hidden=!!state.role;$('game').hidden=!state.role;
 if(!state.role){$('identity').textContent=`当前账号：${state.name}`;$('roles').replaceChildren();for(const role of state.roles){const box=node('article',undefined,$('roles'));box.className='role';node('h2',`${role.number} · ${role.name}`,box);node('p',role.owner?`已由 ${role.owner} 选择`:'等待选择',box);const b=node('button',role.owner?'已被选择':'选择并阅读',box);b.disabled=!!role.owner;b.onclick=async()=>{b.disabled=true;try{await api('claim',{role:role.id});await refresh()}catch(e){$('error').textContent=e.message;b.disabled=false}}}return}
 const f=state.flow;$('roleTitle').textContent=`${roleName(state.role)} · ${f.phase==='ended'?'游戏已结束':`第 ${f.day} 幕`}`;
 $('dayNote').textContent=f.day===4?'9月4日：可以私聊。按角色顺序调查所有剩余地点；本人的限制地点仅在只剩这些地点时解除。':'9月'+f.day+'日：不可私聊。阅读和交流完成后，集体投票选一个区域，调查到该区域没有剩余牌。';
 $('memoryButton').hidden=!state.hasMemories;$('endingButton').hidden=$('truthButton').hidden=!state.finale;
 const nextPages=JSON.stringify(state.pages);if(nextPages!==pageKey){pageKey=nextPages;$('gamePages').replaceChildren();const cover=detail('cover','角色封面',$('gamePages'));imagePage(state.cover,'我的角色封面',cover);for(const group of state.pages){const d=detail(`day-${group.day}`,`第 ${group.day} 幕 · ${group.day===1?'背景与第01–02页':`第${String(group.day*2-1).padStart(2,'0')}–${String(group.day*2).padStart(2,'0')}页`}`,$('gamePages'),group.day===f.day);for(const [i,url]of group.urls.entries())imagePage(url,`本人第${group.day}幕原页 ${i+1}`,d)}}
 renderFlow();
}
function renderFlow(){
 const f=state.flow,key=JSON.stringify(f);if(key===flowKey)return;flowKey=key;
 $('flow').replaceChildren();const host=$('flow');
 const titles={reading:'阅读与交流',vote:'共同选择调查区域',tie:'平票，等待首位调查者决定',take:`第 ${f.round} 轮 · 取牌`,resolve:`第 ${f.round} 轮 · 公开／隐藏处理`,discussion:f.day===4?'最终讨论':'本日调查结束 · 讨论',ended:'结束与复盘'};
 node('h2',titles[f.phase],host);
 if(['reading','discussion'].includes(f.phase)){
  node('p',f.phase==='reading'?'每位角色读完并交流好后确认。确认后仍可阅读。':f.day===4?'请先完成讨论与个人回答，自行核对任务；这里不做答题投票或自动判分。':'本日所选区域已搜完，完成集体讨论后再进入下一天。',host);
  node('p',`已确认 ${f.ready.length} / ${state.roles.length} 人`,host);
  const list=node('ul',undefined,host);for(const r of state.roles)node('li',`${r.number} · ${r.name}：${!r.owner?'尚未选角':f.ready.includes(r.id)?'已确认':'等待确认'}`,list);
  const actions=node('div',undefined,host);actions.className='actions';
  button(f.ready.includes(state.role)?'已确认，等待大家':f.phase==='reading'?'读完并交流好，开始调查':f.day===4?'讨论与个人回答已完成，确认结束游戏':'讨论结束，进入下一幕',{action:'ready'},actions).disabled=f.ready.includes(state.role);
 }else if(['vote','tie'].includes(f.phase)){
  node('p',`每人一票，全部投完后取最高票；平票由今天首先调查的 ${roleName(f.first)} 决定。`,host);
  const votes=node('ul',undefined,host);for(const r of state.roles)node('li',`${r.name}：${f.votes[r.id]?f.areas.find(a=>a.id===f.votes[r.id])?.title:'尚未选择'}`,votes);
  const actions=node('div',undefined,host);actions.className='actions';for(const area of f.areas.filter(a=>f.phase==='vote'||f.ties.includes(a.id))){const b=button(`${f.phase==='tie'?'决定调查':'投给'} ${area.title}`,{action:f.phase==='tie'?'tie':'vote',area:area.id},actions);b.disabled=f.phase==='tie'&&f.actor!==state.role;if(f.votes[state.role]===area.id)b.className='chosen'}
 }else if(f.phase==='take'){
  node('p',`轮到 ${roleName(f.actor)} 选择一张牌背。拿完即可选择公开或隐藏，选好后交给下一人；公开内容在轮末统一发布。`,host);
  if(f.actor===state.role){
   const available=f.cards.filter(c=>c.available),areas=[...new Set(available.map(c=>c.area))];
   if(!areas.includes(selectedArea))selectedArea=areas[0]||'';
   const label=node('label','调查地点',host);label.htmlFor='locations';const select=node('select',undefined,host);select.id='locations';
   for(const a of areas){const o=node('option',areaNames[a]||a,select);o.value=a}select.value=selectedArea;select.onchange=()=>{selectedArea=select.value;flowKey='';renderFlow()};
   const grid=node('div',undefined,host);grid.className='roles';for(const c of available.filter(c=>c.area===selectedArea)){
    const box=node('article',undefined,grid);box.className='role';const img=node('img',undefined,box);img.className='page';img.src=c.front;img.alt=`${c.title} 牌背`;
    button(c.forbidden?'当前禁止调查（还有其他地点）':`领取 · ${c.title}`,{action:'take',card:c.id},box).disabled=c.forbidden;
   }
  }else node('p','只有当前行动者能看到可选牌背；自己的已获线索仍可在下方阅读。',host);
 }else if(f.phase==='resolve'){
  node('p',f.canResolve?'你已拿到线索，现在可以选择隐藏或公开。公开选择会暂存，整轮结束后统一发布，不显示领取者。':`等待 ${roleName(f.actor)} 选择公开或隐藏。选好后交给下一人，公开内容在轮末统一发布。`,host);
  if(f.canResolve){const hidden=f.cards.filter(c=>c.mine&&!c.public&&!c.queued);const actions=node('div',undefined,host);actions.className='actions';
   for(const c of hidden)button(hidden.length>1?`隐藏「${cardTitle(c)}」，其余公开`:`隐藏「${cardTitle(c)}」`,{action:'resolve',keep:c.id},actions);
   button(hidden.length?'全部公开（不可撤回）':'阅读完毕，完成本轮处理',{action:'resolve',keep:null},actions);
  }
 }else node('p','个人结局和公共真相已开放。私人回忆和隐藏卡不会自动公开。',host);
 renderClues();
}
function renderClues(){
 const f=state.flow,key=JSON.stringify([f.cards.filter(c=>!c.available),f.canPublish,f.privatePending]);if(key===clueKey)return;clueKey=key;
 const previous=new Set([...$('clues').querySelectorAll('details')].map(d=>d.dataset.key));
 const opened=new Set([...$('clues').querySelectorAll('details[open]')].map(d=>d.dataset.key));$('clues').replaceChildren();
 for(const [title,cards]of [['我的私密线索',f.cards.filter(c=>c.mine&&!c.public&&!c.queued)],['待统一公开（仅自己可见）',f.cards.filter(c=>c.mine&&c.queued&&!c.public)],['公开线索',f.cards.filter(c=>c.public)]]){
  node('h2',`${title}（${cards.length}）`,$('clues'));if(!cards.length)node('p','暂无',$('clues'));
  for(const c of cards){const d=detail(c.id,cardTitle(c),$('clues'),opened.has(c.id)||(f.privatePending===c.id&&!previous.has(c.id)));imagePage(c.content,`${title} · ${cardTitle(c)}`,d);if(c.mine&&!c.public&&!c.queued&&f.canPublish){const actions=node('div',undefined,d);actions.className='actions';button('加入待公开（不可撤回）',{action:'publish',card:c.id},actions)}}
 }
}
function openModal(kind){modalKind=kind;memoryKey='';const host=$('materialsBody');host.replaceChildren();
 const titles={public:'公共说明与地图',memory:'我的回忆',ending:'我的结局',truth:'公共真相与复盘'};$('materialsTitle').textContent=titles[kind];
 if(kind==='memory')loadMemories();
 else{const pages=kind==='public'?state.publicPages:state.finale?.[kind]?.map((url,i)=>({url,title:kind==='ending'?`我的结局 · 第${9+i}页`:`公共真相 · 第${7+i}页`}))||[];
  node('p',kind==='public'?'公共规则保留原页；在线调整：幕间六人全员确认，拿牌后立即选择隐藏或公开，轮末统一发布。':kind==='ending'?'请按实际结果对照原文结局条件，自行判断。':'按原文顺序阅读公共真相。',host);
  for(const [i,p]of pages.entries())imagePage(p.url,p.title,detail(`${kind}-${i}`,p.title,host,i===0));
 }
 $('materials').showModal();host.scrollTop=0;
}
let memoryLoading=false;
async function loadMemories(){if(memoryLoading)return;memoryLoading=true;try{
 const data=await api('memories'),key=JSON.stringify(data);if(key===memoryKey)return;memoryKey=key;
 const host=$('materialsBody'),opened=new Set([...host.querySelectorAll('details[open]')].map(d=>d.dataset.key));host.replaceChildren();
 node('p','回忆从第一幕即可按条件触发，只能自己阅读，可以转述或编造。自己说出关键词不能触发；不占普通搜证或隐藏额度。',host);
 for(const c of data.cards){const d=detail(c.id,`回忆 ${String(c.number).padStart(2,'0')} · ${c.unlocked?'已触发':'未触发'}`,host,opened.has(c.id));node('span',`触发词：${c.trigger}`,d.querySelector('summary')).className='memory-trigger';imagePage(c.unlocked?c.content:c.front,`我的回忆 ${c.number}`,d);
  if(!c.unlocked){const label=node('label',undefined,d);const checkbox=node('input',undefined,label);checkbox.type='checkbox';label.append(document.createTextNode(`我已听到其他玩家提及“${c.trigger}”，或在线索上看到了它。`));const b=node('button',`触发回忆 ${String(c.number).padStart(2,'0')}`,d);b.disabled=true;checkbox.onchange=()=>b.disabled=!checkbox.checked;b.onclick=async()=>{b.disabled=true;try{await api('memory/reveal',{card:c.id,confirmed:checkbox.checked});memoryKey='';await loadMemories()}catch(e){$('error').textContent=e.message;b.disabled=false}}}
 }
}catch(e){$('error').textContent=e.message}finally{memoryLoading=false}}
$('loginForm').onsubmit=async event=>{event.preventDefault();const b=event.target.querySelector('button');b.disabled=true;try{await api('login',{name:$('name').value});$('error').textContent='';await refresh()}catch(e){$('error').textContent=e.message}finally{b.disabled=false}};
for(const [id,kind]of [['publicButton','public'],['memoryButton','memory'],['endingButton','ending'],['truthButton','truth']])$(id).onclick=()=>openModal(kind);
$('materialsClose').onclick=()=>{$('materials').close();modalKind=''};
$('materials').addEventListener('close',()=>modalKind='');
refresh();setInterval(()=>{refresh();if($('materials').open&&modalKind==='memory')loadMemories()},1500);
