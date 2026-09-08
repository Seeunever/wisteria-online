import fs from 'node:fs';
const root=new URL('./private/',import.meta.url);
const html=fs.readFileSync(new URL('../output/应邪化仆-离线互动版.html',import.meta.url),'utf8');
const data=JSON.parse(html.match(/<script[^>]*id=["']content-data["'][^>]*>([\s\S]*?)<\/script>/)[1]);
const manifest=JSON.parse(fs.readFileSync(new URL('../.tools/build-records/yingxie-huapu-20260904/project.json',import.meta.url),'utf8'));
const write=(filename,media)=>{if(!media.data.startsWith('data:image/jpeg;base64,'))throw Error('图片格式不符');fs.writeFileSync(new URL(filename,root),Buffer.from(media.data.split(',')[1],'base64'),{flag:'wx'});return filename};
// Check the traced mapping before extracting any media; preserve source and existing imports.
for(const r of manifest.roles){const s=r.stages[4];if(s.id!==`${r.id}-ending`||s.items.length!==1||s.items[0].page!==11)throw Error('结局映射不符')}
const truthMap=manifest.manualSteps.find(s=>s.id==='final-truth');
if(truthMap.items.length!==8||truthMap.items.some((m,i)=>m.source!=='故事真相.pdf'||m.page!==i+5))throw Error('公共真相映射不符');
const guideMap=manifest.roles[0].stages[3].items[0];if(guideMap.source!=='故事真相.pdf'||guideMap.page!==4)throw Error('结束规则映射不符');
const roles=manifest.roles.map(r=>{const s=data.roles.find(x=>x.id===r.id).stages[4];if(s.id!==`${r.id}-ending`||s.items.length!==1)throw Error('结局媒体不符');return {id:r.id,pages:s.items.map((m,i)=>write(`${r.id}-ending-${i}.jpg`,m))}});
const finalTruth=data.manualSteps.find(s=>s.id==='final-truth');if(finalTruth.items.length!==8)throw Error('真相媒体不符');
const truth=finalTruth.items.map((m,i)=>write(`final-truth-${i}.jpg`,m));
const guide=write('ending-guide.jpg',data.roles[0].stages[3].items[0]);
fs.writeFileSync(new URL('ending.json',root),JSON.stringify({roles,truth,guide},null,2),{flag:'wx'});
console.log('已复用5张个人结局双页、8张公共真相、1张结束规则；未改变游戏存档。');
