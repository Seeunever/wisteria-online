import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createZitengApp} from './ziteng-server.mjs';
import {createAccessGate} from './access-gate.mjs';
const root=path.dirname(fileURLToPath(import.meta.url));

// Keep the accepted Yingxie API/cookies/database intact. New packs have explicit routes.
export function createLibrary({createYingxie,yingxieOptions={},zitengOptions={},testAssist=false,accessCode=null,publicOrigin=null}){
 const yingxie=createYingxie({testAssist,...yingxieOptions}),ziteng=createZitengApp({testAssist,...zitengOptions});
 const gate=accessCode?createAccessGate({accessCode,publicOrigin}):null;
 const server=http.createServer(async(req,res)=>{
  try{if(gate&&await gate(req,res))return}catch{res.writeHead(400);res.end('请求未完成，请刷新重试');return}
  const pathname=new URL(req.url,'http://localhost').pathname;
  if(req.method==='GET'&&pathname==='/'){
   res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});
   return res.end(fs.readFileSync(path.join(root,'library.html'),'utf8').replace('<!-- shared-style -->',fs.readFileSync(path.join(root,'index.html'),'utf8').match(/<style>[\s\S]*?<\/style>/)[0]));
  }
  if(['/yingxie','/ziteng'].includes(pathname)){res.writeHead(302,{Location:pathname+'/'});return res.end()}
  if(pathname.startsWith('/ziteng/'))return ziteng.emit('request',req,res);
  if(pathname==='/yingxie/')req.url='/';
  return yingxie.emit('request',req,res);
 });
 server.on('close',()=>{yingxie.emit('close');ziteng.emit('close')});return server;
}
