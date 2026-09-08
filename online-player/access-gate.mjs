import {createHash,createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
const hash=s=>createHash('sha256').update(s).digest();
const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const lifetime=7*24*60*60;
export function createAccessGate({accessCode,publicOrigin}){
 const sign=s=>createHmac('sha256',accessCode).update(s).digest('hex');
 const valid=token=>{
  const m=/^(\d+)\.([a-f0-9]{24})\.([a-f0-9]{64})$/.exec(token||'');if(!m)return false;
  const expiry=Number(m[1]),now=Math.floor(Date.now()/1000);
  return expiry>now&&expiry<=now+lifetime&&timingSafeEqual(Buffer.from(m[3],'hex'),Buffer.from(sign(m[1]+'.'+m[2]),'hex'));
 };
 function page(res,next,error=''){
  res.writeHead(error?403:200,{'Content-Type':'text/html; charset=utf-8'});
  res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>同行 · 熟人访问</title><link rel="stylesheet" href="/terminal.css"><style>body{margin:0;min-height:100dvh;font-family:system-ui,"Microsoft YaHei",sans-serif}main{width:min(480px,calc(100% - 40px));margin:10vh auto;padding:24px;box-sizing:border-box;background:#19232b;border-top:4px solid #85d8ef}h1{font-size:32px;color:#e9f0f2}p{line-height:1.7;color:#b9c8ce}label{display:block;color:#e9f0f2}input,button{box-sizing:border-box;width:100%;min-height:48px;margin-top:12px;padding:12px;font:inherit}input{background:#10191f;color:#fff;border:1px solid #83969e}button{background:#85d8ef;color:#08141b;border:0;cursor:pointer}.error{color:#f3c86c}</style><main><small>PRIVATE ACCESS / 熟人访问</small><h1>同行</h1><p>这里是朋友们的剧本档案。<br>输入大家共用的访问口令，然后选择剧本。</p><form method="post" action="/access"><input type="hidden" name="next" value="${escape(next)}"><label for="code">访问口令</label><input id="code" name="code" type="password" required autocomplete="current-password" maxlength="128"><button type="submit">进入档案馆</button></form><p class="error" role="alert">${escape(error)}</p><p>本设备记住 7 天。游戏账号仍然只需用户名。</p></main></html>`);
 }
 return async(req,res)=>{
  const pathname=new URL(req.url,'http://localhost').pathname;
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Robots-Tag','noindex, nofollow, noarchive');
  if(req.method==='GET'&&pathname==='/terminal.css')return false;
  if(req.method==='POST'&&pathname==='/access'){
   if(req.headers.origin&&req.headers.origin!==(publicOrigin||`http://${req.headers.host}`)){res.writeHead(403);res.end('请求来源不匹配');return true}
   let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>4096){res.writeHead(413);res.end('请求过长');return true}}
   const form=new URLSearchParams(raw),next=['/yingxie/','/ziteng/'].includes(form.get('next'))?form.get('next'):'/';
   if(!timingSafeEqual(hash(form.get('code')||''),hash(accessCode))){page(res,next,'口令不正确，请再试一次。');return true}
   const payload=Math.floor(Date.now()/1000)+lifetime+'.'+randomBytes(12).toString('hex');
   res.setHeader('Set-Cookie',`site_access=${payload}.${sign(payload)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${lifetime}${publicOrigin?.startsWith('https:')?'; Secure':''}`);
   res.writeHead(303,{Location:next});res.end();return true;
  }
  if(valid(/(?:^|;\s*)site_access=([^;]+)/.exec(req.headers.cookie||'')?.[1]))return false;
  if(pathname.startsWith('/api/')||pathname.startsWith('/ziteng/api/')){
   res.writeHead(401,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify({error:'请先输入网站访问口令',accessRequired:true}));return true;
  }
  page(res,['/yingxie/','/ziteng/'].includes(pathname)?pathname:'/');return true;
 };
}
