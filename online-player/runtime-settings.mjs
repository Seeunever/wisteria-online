import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));
// Resolve existing parents as well as the final component, including directory junctions.
const real=p=>{if(fs.existsSync(p))return fs.realpathSync(p);const parent=path.dirname(p);if(parent===p)throw Error('配置路径所在磁盘不可用');return path.join(real(parent),path.basename(p))};
const inside=(a,b)=>{const rel=path.relative(real(a),real(b));return rel===''||(!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel))};
export function runtimeSettings(env=process.env){
 const mode=env.APP_MODE||(env.NODE_ENV==='production'?'production':'test');
 if(!['test','production'].includes(mode))throw Error('APP_MODE 只能为 test 或 production');
 if(env.NODE_ENV==='production'&&mode!=='production')throw Error('NODE_ENV=production 时不能启动测试模式');
 const production=mode==='production',host=env.HOST||'127.0.0.1',port=Number(env.PORT||4310);
 if(!Number.isInteger(port)||port<1||port>65535)throw Error('PORT 必须为有效端口');
 if(production&&env.TEST_ASSIST==='1')throw Error('正式模式禁止启用测试代操作');
 if(production&&(!env.STATE_DIR||!path.isAbsolute(env.STATE_DIR)))throw Error('正式模式必须指定持久化存档绝对路径 STATE_DIR');
 const stateDir=path.resolve(env.STATE_DIR||path.join(root,'state'));
 if(production&&(inside(root,stateDir)||inside(stateDir,root)))throw Error('正式存档必须位于代码目录之外，不能复用现有测试存档');
 let publicOrigin=null;
 if(env.PUBLIC_ORIGIN){
  const url=new URL(env.PUBLIC_ORIGIN);
  if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw Error('PUBLIC_ORIGIN 必须为不含路径的 HTTPS 网站地址');
  publicOrigin=url.origin;
 }
 if(production&&!publicOrigin)throw Error('正式模式必须配置 PUBLIC_ORIGIN，并通过 HTTPS 反向代理访问');
 const accessCode=env.SITE_ACCESS_CODE||null;
 if(production&&(!accessCode||[...accessCode].length<5||[...accessCode].length>128||/[\u0000-\u001f\u007f]/.test(accessCode)))throw Error('正式模式必须配置5–128个字符的共用访问口令 SITE_ACCESS_CODE，支持中文');
 if(production&&(!env.BACKUP_DIR||!path.isAbsolute(env.BACKUP_DIR)))throw Error('正式模式必须指定备份绝对路径 BACKUP_DIR');
 const backupDir=env.BACKUP_DIR?path.resolve(env.BACKUP_DIR):null;
 if(backupDir&&(inside(stateDir,backupDir)||inside(backupDir,stateDir)||inside(root,backupDir)))throw Error('备份目录必须独立于代码和存档目录');
 const testAssist=!production&&env.TEST_ASSIST!=='0'&&['127.0.0.1','localhost','::1'].includes(host);
 // Explicit user-authorized exceptions for these two packs, not a global production bypass.
 const packAssist=name=>{if(env[name]!==undefined&&!['0','1'].includes(env[name]))throw Error(name+' 只能为 0 或 1');return env[name]===undefined?testAssist:env[name]==='1'};
 const yingxieTestAssist=packAssist('YINGXIE_TEST_ASSIST'),zitengTestAssist=packAssist('ZITENG_TEST_ASSIST');
 const shared={publicOrigin,secureCookie:production||env.COOKIE_SECURE==='1'};
 return {mode,production,host,port,stateDir,backupDir,publicOrigin,libraryOptions:{testAssist,accessCode,publicOrigin,
  yingxieOptions:{...shared,stateDir,testAssist:yingxieTestAssist},zitengOptions:{...shared,stateDir:path.join(stateDir,'ziteng'),testAssist:zitengTestAssist}}};
}
