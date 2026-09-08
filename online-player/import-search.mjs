import fs from 'node:fs';
const root=new URL('./private/',import.meta.url);
const html=fs.readFileSync(new URL('../output/应邪化仆-离线互动版.html',import.meta.url),'utf8');
const data=JSON.parse(html.match(/<script[^>]*id=["']content-data["'][^>]*>([\s\S]*?)<\/script>/)[1]);
const group=data.clueGroups.find(g=>g.id==='investigation-act-one');
const locations=['副楼二层－太太房','副楼北侧－地上','主楼一层','主楼二层','少爷房－外屋','少爷房－里屋','女佣房','女佣房','厨房','男仆房'];
if(group.cards.length!==10)throw Error('第一幕应为10张');
const cards=group.cards.map((card,i)=>{
  if(card.id!==`act-one-clue-${String(i+1).padStart(2,'0')}`)throw Error('卡号顺序不符');
  const result={id:card.id,location:locations[i],mandatory:[1,2].includes(i),forbidden:i===3?['r01-xiunong']:i===5?['r03-qigong']:[]};
  for(const [side,field] of [['front','front'],['content','back']]){
    result[side]=`${card.id}-${side}.jpg`;
    fs.writeFileSync(new URL(result[side],root),Buffer.from(card[field].data.split(',')[1],'base64'),{flag:'wx'});
  }
  return result;
});
fs.writeFileSync(new URL('search.json',root),JSON.stringify(cards,null,2),{flag:'wx'});
console.log('第一幕10张卡双面已复用；必须公开：02、03；禁搜：角色1/卡04、角色3/卡06。');
