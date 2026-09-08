let endingState=null;
function configureEnding(state){
  endingState=state.finale;
  let entry=document.getElementById('endingEntry');
  if(!entry){
    entry=document.createElement('section');entry.id='endingEntry';
    entry.innerHTML='<button id="ownEndingButton">我的结局</button> <button id="truthButton">公共真相</button><p>结局按实际游戏结果自行对照，满足条件的结局可以叠加。</p>';
    document.getElementById('roleTitle').after(entry);
    document.getElementById('ownEndingButton').onclick=()=>openEnding('ending');
    document.getElementById('truthButton').onclick=()=>openEnding('truth');
  }
  entry.hidden=!endingState;
}
function openEnding(kind){
  if(!endingState)return;
  const title=kind==='ending'?'我的结局':'公共真相与复盘';
  document.getElementById('endingTitle').textContent=title;
  document.getElementById('endingNote').textContent=kind==='ending'?'仅显示你所选角色的结局原页。请按达成条件自行对照；多个满足条件的结局可以叠加，不由程序自动判定。':'全员确认结束后开放的完整公共真相，按原文页序阅读。';
  const host=document.getElementById('endingPages');host.replaceChildren();
  endingState[kind].forEach((url,i)=>{
    const details=document.createElement('details');details.open=i===0;
    const summary=document.createElement('summary');summary.textContent=kind==='ending'?'个人结局 · 第 09–10页':`公共真相 · 第 ${String(i+3).padStart(2,'0')} 页`;
    const link=document.createElement('a');link.textContent='打开原图';link.href=url;link.target='_blank';link.rel='noopener';
    const img=document.createElement('img');img.className='page';img.alt=`${title}原页 ${i+1}`;img.src=url;
    details.append(summary,link,img);host.append(details);
  });
  const dialog=document.getElementById('endingDialog');dialog.showModal();dialog.querySelector('.dialog-body').scrollTop=0;
}
document.getElementById('endingClose').onclick=()=>document.getElementById('endingDialog').close();
