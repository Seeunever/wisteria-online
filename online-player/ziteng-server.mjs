import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
import {createZitengEngine} from './ziteng-engine.mjs';
import {createZitengTestAssist} from './test-assist.mjs';

const root=path.dirname(fileURLToPath(import.meta.url));
export function createZitengApp({stateDir=path.join(root,'state','ziteng'),privateDir=path.join(root,'private','ziteng'),testAssist=false,publicOrigin=null,secureCookie=process.env.COOKIE_SECURE==='1'}={}){
 const game=JSON.parse(fs.readFileSync(path.join(privateDir,'game.json')));
 fs.mkdirSync(stateDir,{recursive:true});const db=new DatabaseSync(path.join(stateDir,'game.sqlite'));
 db.exec(`PRAGMA journal_mode=WAL;CREATE TABLE IF NOT EXISTS players(name TEXT PRIMARY KEY,role TEXT UNIQUE);
 CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,name TEXT NOT NULL);`);
 const engine=createZitengEngine(db,game);
 const assistant=createZitengTestAssist({db,roles:game.roles,engine,enabled:testAssist});
 const json=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data))};
 const jpg=(res,file)=>{res.writeHead(200,{'Content-Type':'image/jpeg'});res.end(fs.readFileSync(path.join(privateDir,file)))};
 const server=http.createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
  try{
   const url=new URL(req.url,'http://localhost');const route=url.pathname;
   if(req.method==='GET'&&route==='/terminal.css'){
    res.writeHead(200,{'Content-Type':'text/css; charset=utf-8'});return res.end(fs.readFileSync(path.join(root,'terminal.css')));
   }
   if(req.method==='GET'&&['/ziteng/','/ziteng/ui.js','/test-assist-ui.js'].includes(route)){
    const file=route==='/test-assist-ui.js'?'test-assist-ui.js':route.endsWith('ui.js')?'ziteng-ui.js':'ziteng.html';
    res.writeHead(200,{'Content-Type':file.endsWith('.js')?'text/javascript; charset=utf-8':'text/html; charset=utf-8'});
    // Reuse the responsive base stylesheet, not the other game's content or state.
    const text=fs.readFileSync(path.join(root,file),'utf8');
    return res.end(file.endsWith('.html')?text.replace('<!-- shared-style -->',fs.readFileSync(path.join(root,'index.html'),'utf8').match(/<style>[\s\S]*?<\/style>/)[0]):text);
   }
   const token=/(?:^|;\s*)ziteng_session=([a-f0-9]+)/.exec(req.headers.cookie||'')?.[1];
   const player=token&&db.prepare('SELECT p.* FROM players p JOIN sessions s ON p.name=s.name WHERE s.token=?').get(token);
   if(req.method==='POST'){
    if(req.headers.origin&&!(publicOrigin?req.headers.origin===publicOrigin:['http://','https://'].some(p=>req.headers.origin===p+req.headers.host)))return json(res,403,{error:'请求来源不匹配'});
    let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>4096)return json(res,413,{error:'请求过长'})}
    let body;try{body=JSON.parse(raw)}catch{return json(res,400,{error:'请求格式不正确'})}
    if(!body||typeof body!=='object')return json(res,400,{error:'请求格式不正确'});
    if(route==='/ziteng/api/login'){
     const name=typeof body.name==='string'?body.name.trim().normalize('NFC'):'';
     if(!name||name.length>32||/[\u0000-\u001f\u007f]/.test(name))return json(res,400,{error:'用户名请输入1–32个字符'});
     db.prepare('INSERT OR IGNORE INTO players(name) VALUES(?)').run(name);const token=randomBytes(32).toString('hex');
     db.prepare('INSERT INTO sessions VALUES(?,?)').run(token,name);
     res.setHeader('Set-Cookie',`ziteng_session=${token}; HttpOnly; SameSite=Lax; Path=/ziteng; Max-Age=2592000${secureCookie?'; Secure':''}`);
     return json(res,200,{ok:true});
    }
    if(!player)return json(res,401,{error:'请先输入用户名'});
    if(route==='/ziteng/api/claim'){
     if(!game.roles.some(r=>r.id===body.role))return json(res,400,{error:'角色不存在'});
     if(player.role)return json(res,player.role===body.role?200:409,{error:player.role===body.role?undefined:'已经选定角色，不能换角'});
     try{db.prepare('UPDATE players SET role=? WHERE name=? AND role IS NULL').run(body.role,player.name)}catch(error){if(error.code?.includes('SQLITE_CONSTRAINT')||error.errcode===2067)return json(res,409,{error:'这个角色已被选走'});throw error}
     return json(res,200,{ok:true});
    }
    if(!player.role)return json(res,403,{error:'请先选择角色'});
    if(route==='/ziteng/api/test-assist'){
     if(!testAssist)return json(res,404,{error:'测试辅助未启用'});
     try{const result=assistant.run(player,body);return json(res,result.ok?200:409,result)}catch(error){return json(res,409,{error:error.message})}
    }
    try{
     if(route==='/ziteng/api/action'){engine.act(player.role,body);return json(res,200,{ok:true})}
     if(route==='/ziteng/api/memory/reveal'){engine.reveal(player.role,body);return json(res,200,{ok:true})}
    }catch(error){return json(res,409,{error:error.message})}
   }
   if(req.method==='GET'&&route==='/ziteng/api/state'){
    if(!player)return json(res,401,{error:'请先输入用户名'});
    const {day,phase}=engine.status(),role=game.roles.find(r=>r.id===player.role);
    const occupied=db.prepare('SELECT name,role FROM players WHERE role IS NOT NULL').all();
    return json(res,200,{title:game.title,name:player.name,role:player.role,testAssist,
     roles:game.roles.map(r=>({id:r.id,name:r.name,number:r.number,owner:occupied.find(p=>p.role===r.id)?.name||null})),
     flow:role?engine.view(role.id):null,
     pages:role?role.stages.slice(0,day).map((pages,i)=>({day:i+1,urls:pages.map((_,j)=>`/ziteng/api/page/${role.id}/${i+1}/${j}`)})):[],
     cover:role?`/ziteng/api/cover/${role.id}`:null,
     hasMemories:!!role&&game.memories.some(m=>m.role===role.id),
     publicPages:game.publicPages.map(p=>({title:p.title,url:`/ziteng/api/public/${p.id}`})),
     finale:role&&phase==='ended'?{ending:role.ending.map((_,i)=>`/ziteng/api/ending/${role.id}/${i}`),truth:game.truth.map((_,i)=>`/ziteng/api/truth/${i}`)}:null});
   }
   if(req.method==='GET'&&route==='/ziteng/api/memories'){
    if(!player?.role)return json(res,403,{error:'请先选择角色'});return json(res,200,{cards:engine.memories(player.role)});
   }
   if(req.method==='GET'&&route.startsWith('/ziteng/api/')){
    if(!player)return json(res,401,{error:'请先登录'});
    const parts=route.slice('/ziteng/api/'.length).split('/');let file=null;
    const {day,phase}=engine.status();const role=game.roles.find(r=>r.id===player.role);
    if(parts[0]==='public'&&parts.length===2)file=game.publicPages.find(p=>p.id===parts[1])?.file;
    if(role){
     if(parts[0]==='cover'&&parts.length===2&&parts[1]===role.id)file=role.cover;
     if(parts[0]==='page'&&parts.length===4&&parts[1]===role.id&&/^[1-4]$/.test(parts[2])&&/^\d+$/.test(parts[3])&&+parts[2]<=day)file=role.stages[+parts[2]-1]?.[+parts[3]];
     if(parts[0]==='clue'&&parts.length===3)file=engine.media(role.id,parts[1],parts[2]);
     if(parts[0]==='memory'&&parts.length===3)file=engine.memoryMedia(role.id,parts[1],parts[2]);
     if(phase==='ended'&&parts[0]==='ending'&&parts.length===3&&parts[1]===role.id&&/^\d+$/.test(parts[2]))file=role.ending[+parts[2]];
     if(phase==='ended'&&parts[0]==='truth'&&parts.length===2&&/^\d+$/.test(parts[1]))file=game.truth[+parts[1]];
    }
    if(file)return jpg(res,file);return json(res,403,{error:'这份材料当前不可阅读'});
   }
   json(res,404,{error:'不存在的入口'});
  }catch{json(res,500,{error:'服务暂时出错，请重试'})}
 });
 server.on('close',()=>db.close());return server;
}
