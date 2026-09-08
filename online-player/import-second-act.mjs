import fs from 'node:fs';
const root=new URL('./private/',import.meta.url);
const html=fs.readFileSync(new URL('../output/应邪化仆-离线互动版.html',import.meta.url),'utf8');
const data=JSON.parse(html.match(/<script[^>]*id=["']content-data["'][^>]*>([\s\S]*?)<\/script>/)[1]);
const write=(filename,media)=>{if(!media.data.startsWith('data:image/jpeg;base64,'))throw Error('图片格式不符');fs.writeFileSync(new URL(filename,root),Buffer.from(media.data.split(',')[1],'base64'),{flag:'wx'});return filename};
const roles=data.roles.map(role=>{const stage=role.stages[1];if(!stage.id.endsWith('act-two')||stage.items.length!==1)throw Error('第二幕映射不符');return {id:role.id,pages:stage.items.map((m,i)=>write(`${role.id}-act-2-${i}.jpg`,m))}});
const group=data.clueGroups.find(g=>g.id==='investigation-act-two');if(group.cards.length!==5)throw Error('第二幕卡数不符');
const locations=['治疗室北屋窗外','花园','女人','男人','单人间'];
const cards=group.cards.map((c,i)=>{
 if(c.id!==`act-two-clue-${String(i+1).padStart(2,'0')}`)throw Error('卡号不符');
 return {id:c.id,act:2,location:locations[i],mandatory:i===0,forbidden:i===4?['r03-qigong']:[],front:write(`${c.id}-front.jpg`,c.front),content:write(`${c.id}-content.jpg`,c.back)};
});
fs.writeFileSync(new URL('act-two.json',root),JSON.stringify({roles,cards},null,2),{flag:'wx'});
console.log('已复用5名角色第二幕与5张线索双面；单人间禁搜按用户确认，未导入第三幕。');
