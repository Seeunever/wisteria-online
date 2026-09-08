import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { createSearch } from './search.mjs';
import { createMemories } from './memories.mjs';
import { createYingxieTestAssist } from './test-assist.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
export function createApp({ privateDir = path.join(root, 'private'), stateDir = path.join(root, 'state'), testAssist = false, publicOrigin = null, secureCookie = process.env.COOKIE_SECURE === '1' } = {}) {
  const game = JSON.parse(fs.readFileSync(path.join(privateDir, 'game.json'), 'utf8'));
  fs.mkdirSync(stateDir, { recursive: true });
  const db = new DatabaseSync(path.join(stateDir, 'game.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS players (name TEXT PRIMARY KEY, role TEXT UNIQUE);
    CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS readiness (phase TEXT NOT NULL, role TEXT NOT NULL, PRIMARY KEY (phase,role));`);
  const readingPhase = 'act-1-reading';
  const secondAct=JSON.parse(fs.readFileSync(path.join(privateDir,'act-two.json'),'utf8'));
  const thirdAct=JSON.parse(fs.readFileSync(path.join(privateDir,'act-three.json'),'utf8'));
  const ending=JSON.parse(fs.readFileSync(path.join(privateDir,'ending.json'),'utf8'));
  const search=createSearch(db,[...JSON.parse(fs.readFileSync(path.join(privateDir,'search.json'),'utf8')).map(c=>({...c,act:1})),...secondAct.cards,...thirdAct.cards],game.roles);
  const triggers=JSON.parse(fs.readFileSync(path.join(privateDir,'memory-triggers.json'),'utf8'));
  const memoryCards=thirdAct.memories.map(card=>{
    const trigger=triggers[card.id];
    if(typeof trigger!=='string'||!trigger.trim())throw Error(`缺少回忆触发词映射：${card.id}`);
    return {...card,trigger};
  });
  const memories=createMemories(db,memoryCards,search.currentAct);
  function progress() {
    const confirmed = db.prepare('SELECT role FROM readiness WHERE phase=?').all(readingPhase).map(row => row.role);
    const ready = game.roles.filter(role => confirmed.includes(role.id)).map(role => role.id);
    if(ready.length===game.roles.length)search.start();
    return { phase: ready.length === game.roles.length ? 'act-1-search-preparation' : readingPhase, ready };
  }
  const assistant=createYingxieTestAssist({db,roles:game.roles,search,progress,enabled:testAssist});
  const reply = (res, code, data) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
  };
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      const url = new URL(req.url, 'http://localhost');
      const token = /(?:^|;\s*)session=([a-f0-9]+)/.exec(req.headers.cookie || '')?.[1];
      const player = token && db.prepare('SELECT p.* FROM players p JOIN sessions s ON p.name=s.name WHERE s.token=?').get(token);
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(fs.readFileSync(path.join(root, 'index.html')));
      }
      if(req.method==='GET'&&url.pathname==='/terminal.css'){
        res.writeHead(200,{'Content-Type':'text/css; charset=utf-8'});return res.end(fs.readFileSync(path.join(root,'terminal.css')));
      }
      if(req.method==='GET'&&['/search-ui.js','/memory-ui.js','/ending-ui.js','/test-assist-ui.js'].includes(url.pathname)){
        res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8'});return res.end(fs.readFileSync(path.join(root,url.pathname.slice(1))));
      }
      if (req.method === 'POST') {
        if (req.headers.origin && !(publicOrigin ? req.headers.origin === publicOrigin : [`http://${req.headers.host}`,`https://${req.headers.host}`].includes(req.headers.origin))) return reply(res, 403, { error: '请求来源不匹配' });
        let raw = '';
        for await (const chunk of req) {
          raw += chunk;
          if (Buffer.byteLength(raw) > 4096) return reply(res, 413, { error: '请求过长' });
        }
        let body;
        try { body = JSON.parse(raw); } catch { return reply(res, 400, { error: '请求格式不正确' }); }
        if (url.pathname === '/api/login') {
          const name = typeof body.name === 'string' ? body.name.trim().normalize('NFC') : '';
          if (!name || name.length > 32 || /[\u0000-\u001f\u007f]/.test(name)) return reply(res, 400, { error: '用户名请输入 1–32 个字符' });
          db.prepare('INSERT OR IGNORE INTO players(name) VALUES (?)').run(name);
          const session = randomBytes(32).toString('hex');
          db.prepare('INSERT INTO sessions VALUES (?,?)').run(session, name);
          res.setHeader('Set-Cookie', `session=${session}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${secureCookie ? '; Secure' : ''}`);
          return reply(res, 200, { ok: true });
        }
        if (!player) return reply(res, 401, { error: '请先输入用户名' });
        if(url.pathname==='/api/test-assist'){
          if(!testAssist)return reply(res,404,{error:'测试辅助未启用'});
          try{const result=assistant.run(player,body);return reply(res,result.ok?200:409,result)}catch(error){return reply(res,409,{error:error.message})}
        }
        if(url.pathname==='/api/memory/reveal'){
          try{memories.reveal(player.role,body);return reply(res,200,{ok:true})}
          catch(error){return reply(res,409,{error:error.message})}
        }
        if(url.pathname==='/api/search'){
          progress();
          try{search.act(player.role,body);return reply(res,200,{ok:true})}
          catch(error){return reply(res,409,{error:error.message})}
        }
        if (url.pathname === '/api/ready') {
          if (!player.role) return reply(res, 403, { error: '请先选择角色' });
          if (body.phase !== readingPhase) return reply(res, 409, { error: '阶段已变化，请刷新后确认' });
          // A fixed phase and unique role make retries and a second device harmless.
          db.prepare('INSERT OR IGNORE INTO readiness(phase,role) VALUES (?,?)').run(readingPhase, player.role);
          return reply(res, 200, progress());
        }
        if (url.pathname === '/api/claim') {
          if (!game.roles.some(role => role.id === body.role)) return reply(res, 400, { error: '角色不存在' });
          if (player.role) return reply(res, player.role === body.role ? 200 : 409, { error: player.role === body.role ? undefined : '已经选定角色，不能换角' });
          try { db.prepare('UPDATE players SET role=? WHERE name=? AND role IS NULL').run(body.role, player.name); }
          catch (error) {
            if (error.code?.includes('SQLITE_CONSTRAINT') || error.errcode === 2067) return reply(res, 409, { error: '这个角色已被选走，请选其他角色' });
            throw error;
          }
          return reply(res, 200, { ok: true });
        }
      }
      if (req.method === 'GET' && url.pathname === '/api/state') {
        if (!player) return reply(res, 401, { error: '请先输入用户名' });
        const occupied = db.prepare('SELECT name,role FROM players WHERE role IS NOT NULL').all();
        const role = game.roles.find(role => role.id === player.role);
        return reply(res, 200, {
          title: game.title, name: player.name, role: player.role, testAssist,
          progress: progress(),
          search: player.role ? search.view(player.role) : null,
          finale: role&&search.currentPhase()==='act-3-ended'?{
            ending:ending.roles.find(r=>r.id===role.id).pages.map((_,i)=>`/api/ending/${role.id}/${i}`),
            truth:ending.truth.map((_,i)=>`/api/truth/${i}`)
          }:null,
          roles: game.roles.map(role => ({ id: role.id, name: role.name, number: role.number, owner: occupied.find(p => p.role === role.id)?.name || null })),
          pages: role ? [...role.pages.map((_, index) => `/api/page/${role.id}/${index}`),...[secondAct,thirdAct].flatMap((act,i)=>search.currentAct()>=i+2?act.roles.find(r=>r.id===role.id).pages.map((_,index)=>`/api/act-page/${role.id}/${i+2}/${index}`):[])] : [],
        });
      }
      const endingMatch=/^\/api\/ending\/([^/]+)\/(\d+)$/.exec(url.pathname);
      const truthMatch=/^\/api\/truth\/(\d+)$/.exec(url.pathname);
      if(req.method==='GET'&&(endingMatch||truthMatch||url.pathname==='/api/end-guide')){
        if(!player?.role)return reply(res,403,{error:'请先选择角色'});
        const phase=search.currentPhase();let filename;
        if(url.pathname==='/api/end-guide'){
          if(['act-3-discussion','act-3-ended'].includes(phase))filename=ending.guide;
        }else if(phase==='act-3-ended'){
          if(endingMatch&&endingMatch[1]===player.role)filename=ending.roles.find(r=>r.id===player.role)?.pages[Number(endingMatch[2])];
          if(truthMatch)filename=ending.truth[Number(truthMatch[1])];
        }
        if(!filename)return reply(res,403,{error:'这份结束材料当前不可阅读'});
        res.writeHead(200,{'Content-Type':'image/jpeg'});return res.end(fs.readFileSync(path.join(privateDir,filename)));
      }
      if(req.method==='GET'&&url.pathname==='/api/memories'){
        if(!player)return reply(res,401,{error:'请先登录'});
        return reply(res,200,memories.view(player.role));
      }
      const memoryMatch=/^\/api\/memory\/([^/]+)\/(front|content)$/.exec(url.pathname);
      if(req.method==='GET'&&memoryMatch){
        const filename=player?.role&&memories.media(player.role,memoryMatch[1],memoryMatch[2]);
        if(!filename)return reply(res,403,{error:'这张回忆当前不可阅读'});
        res.writeHead(200,{'Content-Type':'image/jpeg'});return res.end(fs.readFileSync(path.join(privateDir,filename)));
      }
      const pageMatch = /^\/api\/page\/([^/]+)\/(\d+)$/.exec(url.pathname);
      const actPageMatch=/^\/api\/act-page\/([^/]+)\/([23])\/(\d+)$/.exec(url.pathname);
      if(req.method==='GET'&&actPageMatch){
        if(!player?.role||player.role!==actPageMatch[1])return reply(res,403,{error:'只能阅读自己的剧本'});
        const act=Number(actPageMatch[2]);
        const filename=search.currentAct()>=act&&(act===2?secondAct:thirdAct).roles.find(r=>r.id===player.role)?.pages[Number(actPageMatch[3])];
        if(!filename)return reply(res,404,{error:'当前页面未开放'});
        res.writeHead(200,{'Content-Type':'image/jpeg'});return res.end(fs.readFileSync(path.join(privateDir,filename)));
      }
      const clueMatch=/^\/api\/clue\/([^/]+)\/(front|content)$/.exec(url.pathname);
      if(req.method==='GET'&&clueMatch){
        const filename=player&&search.media(player.role,clueMatch[1],clueMatch[2]);
        if(!filename)return reply(res,403,{error:'这张线索当前不可阅读'});
        res.writeHead(200,{'Content-Type':'image/jpeg'});return res.end(fs.readFileSync(path.join(privateDir,filename)));
      }
      if (req.method === 'GET' && pageMatch) {
        if (!player) return reply(res, 401, { error: '请先登录' });
        if (player.role !== pageMatch[1]) return reply(res, 403, { error: '只能阅读自己的剧本' });
        const role = game.roles.find(role => role.id === player.role);
        const filename = role?.pages[Number(pageMatch[2])];
        if (!filename) return reply(res, 404, { error: '当前页面未开放' });
        res.writeHead(200, { 'Content-Type': 'image/jpeg' });
        return res.end(fs.readFileSync(path.join(privateDir, filename)));
      }
      reply(res, 404, { error: '不存在的入口' });
    } catch {
      reply(res, 500, { error: '服务暂时出错，请重试' });
    }
  });
  server.on('close', () => db.close());
  return server;
}
if (process.argv[1] && fs.realpathSync(path.resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  const {createLibrary}=await import('./library-server.mjs');
  const {runtimeSettings}=await import('./runtime-settings.mjs');
  const {scheduleBackups}=await import('./backup-state.mjs');
  let server,backups;
  try{
    const config=runtimeSettings();
    // Back up existing production data before opening game engines. A first launch has no old data.
    let backedUp=false;
    if(config.production){
      const exists=['game.sqlite',path.join('ziteng','game.sqlite')].map(f=>fs.existsSync(path.join(config.stateDir,f)));
      if(exists.some(Boolean)&&!exists.every(Boolean))throw Error('正式存档不完整，停止启动以避免误开新局');
      backups=scheduleBackups(config.stateDir,config.backupDir);
      if(exists.every(Boolean)){await backups.run();backedUp=true}
    }
    server=createLibrary({createYingxie:createApp,...config.libraryOptions});
    if(backups&&!backedUp)await backups.run();
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(config.port,config.host,resolve)});
    console.log(`${config.production?`正式版（${config.libraryOptions.yingxieOptions.testAssist?'应邪测试辅助已启用':'测试辅助已关闭'}）`:'本地测试版'}：${config.publicOrigin||`http://${config.host}:${config.port}`}`);
    let stopping=false;
    const stop=async()=>{if(stopping)return;stopping=true;server.closeIdleConnections();await new Promise(r=>server.close(r));await backups?.stop()};
    process.once('SIGINT',()=>{stop().catch(()=>{process.exitCode=1})});
    process.once('SIGTERM',()=>{stop().catch(()=>{process.exitCode=1})});
  }catch(error){
    console.error('启动失败：'+error.message);process.exitCode=1;
    if(server)server.close();await backups?.stop().catch(()=>{});
  }
}
