import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';

const root=path.dirname(fileURLToPath(import.meta.url));
const sourceRoot=path.resolve(root,'../murderScripts/246-紫藤夫人（6人半开放）');
const dest=path.join(root,'private','ziteng');
if(fs.existsSync(dest))throw Error('已有紫藤导入目录，停止覆盖');
const html=fs.readFileSync(path.resolve(root,'../output/豪门10-紫藤夫人-无主持人流程版-v2.html'),'utf8');
const data=JSON.parse(html.match(/<script[^>]*id=["']content-data["'][^>]*>([\s\S]*?)<\/script>/)[1]);
assert.equal(data.roles.length,6);assert.equal(data.clueGroups.length,11);
assert.deepEqual(data.roles.map(r=>r.name),['葛月萝','张太太','薛达财','吕松年','于彦诚','乐婉']);
assert.deepEqual(data.clueGroups.map(g=>g.cards.length),[6,6,11,1,2,7,9,3,2,6,1]);
for(const r of data.roles)assert.deepEqual(r.stages.map(s=>s.items.length),[3,2,2,2,2]);
fs.mkdirSync(dest,{recursive:true});
const media=(item,name)=>{
 assert.ok(item.data.startsWith('data:image/jpeg;base64,'));
 const file=name+'.jpg';fs.writeFileSync(path.join(dest,file),Buffer.from(item.data.split(',')[1],'base64'),{flag:'wx'});return file;
};
const roles=data.roles.map((r,i)=>({id:r.id,name:r.name,number:i+1,
 cover:media(r.cover,`role-${i+1}-cover`),
 stages:r.stages.slice(0,4).map((s,j)=>s.items.map((x,k)=>media(x,`role-${i+1}-day-${j+1}-${k}`))),
 ending:r.stages[4].items.map((x,k)=>media(x,`role-${i+1}-ending-${k}`))
}));
const groups=[
 ['east','宝殊镇东',1],['west','宝殊镇西',1],['ge','葛家',2],['zhang','张家',4],['yu','于家',4],
 ['tavern','吕家酒馆',4],['grave','坟场及周围',3],['old','葛家旧屋',4],['other','其他地点',4],['memory','回忆',1],['medicine','张家药品室',4]
];
const titles=[
 ['小树林','李记寿材店','樵夫阿荣家','猎户贵仔家','猎户阿发家','货运佬阿耀家'],
 ['居民高佬王家','李记铁匠铺','王记胭脂铺','薛记布铺','薛记米粮铺','黄记鲜肉铺'],
 ['书房','下人房 A','下人房 B','东耳房','空屋','葛月曼房','葛月萝房','葛继先房','大门口','西耳房','厨房'],
 ['张家客厅'],['于家厢房','于家正房'],['住所','厨房','柜台','窗边桌子','角落','酒馆门外','酒馆外山上'],
 ['入口','无名墓地','石碑','葛家墓地','薛家墓地','宝殊塔','张家邻居','野鹿林','鱼头山下'],
 ['旧屋外屋','旧屋库房','旧屋里屋'],['莲花溪溪畔','镇口'],[],['张家药品室']
];
const mandatory=new Set(['clue-6-4','clue-7-5','clue-7-8','clue-8-3','clue-9-1']);
const cards=data.clueGroups.flatMap((g,i)=>i===9?[]:g.cards.map((c,j)=>{
 const content=i===2&&j===5?g.cards[6].back:i===2&&j===6?g.cards[5].back:c.back;
 return {id:c.id,area:groups[i][0],title:titles[i][j],day:groups[i][2],mandatory:mandatory.has(c.id),
  requires:c.id==='clue-11-1'?'clue-6-4':null,
  front:media(c.front,`${c.id}-front`),content:media(content,`${c.id}-content`)};
}));
const triggers=['机关锁','水鹿皮','罗公子','许多年前的油画','飞翼花纹','Opium'];
const memoryOrder=[1,2,3,5,0,4];
const memories=data.clueGroups[9].cards.map((c,i)=>({id:c.id,role:'role-6',number:i+1,trigger:triggers[i],
 front:media(c.front,`${c.id}-front`),content:media(data.clueGroups[9].cards[memoryOrder[i]].back,`${c.id}-content`)}));
const steps=Object.fromEntries(data.manualSteps.map(s=>[s.id,s]));
const publicRefs=[steps['manual-cover'].items[1],...steps['manual-rules'].items.slice(0,4)];
const publicTitles=['背景与地图','开始前的说明与四幕流程','调查、回忆与结束规则','角色关系','名词解释与局部地图'];
const publicPages=publicRefs.map((x,i)=>({id:`public-${i}`,title:publicTitles[i],file:media(x,`public-${i}`)}));
const truth=steps['manual-truth'].items.slice(2).map((x,i)=>media(x,`truth-${i}`));
const config={id:'ziteng',title:'紫藤夫人',roles,groups:groups.filter(g=>g[0]!=='memory').map(([id,title,day])=>({id,title,day})),cards,memories,publicPages,truth,
 bans:{'role-1':['clue-8-1','clue-8-2','clue-8-3'],'role-2':[],'role-3':['clue-2-4','clue-2-5'],
 'role-4':cards.filter(c=>c.area==='tavern'&&c.id!=='clue-6-7').map(c=>c.id),'role-5':['clue-5-1','clue-5-2'],'role-6':['clue-5-1','clue-5-2']}};
assert.equal(cards.length,48);assert.equal(truth.length,4);
fs.writeFileSync(path.join(dest,'game.json'),JSON.stringify(config,null,2),{flag:'wx'});
const inventory=JSON.parse(fs.readFileSync(path.resolve(root,'../.tools/review-cache/ziteng-online/inventory.json')));
const ledger=inventory.files.map(f=>{
 const r=/人物剧本\/(\d)[^/]+\/(\d+)\.jpg/.exec(f.path);
 if(r){const n=+r[2];return {source:f.path,status:'mapped',target:`role-${r[1]}`,section:n===1?'cover':n<=4?'day-1':n<=6?'day-2':n<=8?'day-3':n<=10?'day-4':'ending',printedPage:n>=3?n-2:null};}
 if(f.path==='游戏说明.pdf')return {source:f.path,status:'mapped',pages:[{physical:1,target:'public-0',note:'背景/地图重复材料'},{physical:2,target:'public-1'},{physical:3,target:'public-2'},{physical:4,target:'public-4',note:'右侧仅真相警示封面'},{physical:5,target:['truth-0','truth-1'],note:'与独立真相页相同内容'},{physical:6,target:['truth-2','truth-3'],note:'与独立真相页相同内容'}]};
 if(f.path.includes('海报'))return {source:f.path,status:'excluded',reason:'装饰/系列宣传海报，不作为游戏线索；原文件保留'};
 if(f.path.includes('线索'))return {source:f.path,status:'mapped',note:'依据卡面标题/编号配对，见cards；重复印刷面及空白不重复计牌。'};
 return {source:f.path,status:'mapped',target:f.path.includes('真相')?'truth':f.path.includes('角色关系')?'public-3':'public-0'};
});
const sheets={east:'镇东+记忆.jpg',west:'镇西+记忆.jpg',ge:'葛家.jpg',zhang:'其他1.jpg',yu:'其他1.jpg',tavern:'其他2.jpg',grave:'坟场.jpg',old:'其他1.jpg',other:'其他2.jpg',medicine:'其他1.jpg'};
fs.writeFileSync(path.join(dest,'coverage.json'),JSON.stringify({sourceRoot,files:ledger,
 cards:cards.map(c=>({id:c.id,title:c.title,area:c.area,sourceContent:`线索打印/${c.id==='clue-3-9'?'坟场.jpg':c.id==='clue-9-2'?'其他1.jpg':sheets[c.area]}`,front:`offline:${c.id}.front`,content:`offline:${c.id==='clue-3-6'?'clue-3-7':c.id==='clue-3-7'?'clue-3-6':c.id}.back`,day:c.day,requires:c.requires,mandatory:c.mandatory})),
 memories:memories.map((m,i)=>({id:m.id,number:m.number,trigger:m.trigger,sourceRule:'人物剧本/6乐婉/4.jpg',sourceContent:'线索卡背/乐婉记忆/乐婉记忆 正.jpg',offlineBack:`clue-10-${memoryOrder[i]+1}.back`})),
 counts:{sourceFiles:98,rolePages:72,ordinaryCards:48,memories:6,publicPages:5,truthPages:4}},null,2),{flag:'wx'});
console.log('紫藤导入：6角色、4幕、48普通卡、6回忆、5公共页、4真相页；源文件和旧成品均未改动。');
