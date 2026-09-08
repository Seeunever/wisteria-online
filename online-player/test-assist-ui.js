let assistState=null,assistRefresh=null,assistEndpoint='',assistPending=null,assistBusy=false;
function configureTestAssist(state,refresh,endpoint){
 assistState=state;assistRefresh=refresh;assistEndpoint=endpoint;
 const box=document.getElementById('testAssist');box.hidden=!state.testAssist||!state.role;
 const ended=state.search?.phase==='act-3-ended'||state.flow?.phase==='ended';
 document.getElementById('testAssistButton').disabled=assistBusy||ended;
 if(ended)document.getElementById('testAssistResult').textContent='本局已结束，测试辅助不会重置游戏。';
}
document.getElementById('testAssistButton').onclick=async()=>{
 if(assistBusy||!assistState?.role)return;
 const s=assistState.flow||assistState.search;
 if(!assistPending)assistPending={requestId:crypto.randomUUID(),confirmed:true,checkpoint:`${s?.phase||assistState.progress.phase}/${s?.day||s?.act||1}/${s?.round||0}`};
 assistBusy=true;const button=document.getElementById('testAssistButton'),result=document.getElementById('testAssistResult');button.disabled=true;result.textContent='正在补完其他角色…';
 try{
  const response=await fetch(assistEndpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(assistPending)});
  const data=await response.json();assistPending=null;
  result.textContent=response.ok?data.message:data.error;
 }catch{result.textContent='连接中断，请再点一次重试；同一次请求不会重复执行。'}
 finally{assistBusy=false;await assistRefresh();configureTestAssist(assistState,assistRefresh,assistEndpoint)}
};
