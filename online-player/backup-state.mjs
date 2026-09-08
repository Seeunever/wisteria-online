import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync,backup} from 'node:sqlite';
import {runtimeSettings} from './runtime-settings.mjs';

// SQLite's online backup includes committed WAL data. Never copy a live .sqlite file alone.
export async function backupState(stateDir,backupDir){
 const files=['game.sqlite',path.join('ziteng','game.sqlite')];
 for(const file of files)if(!fs.existsSync(path.join(stateDir,file)))throw Error('两本存档尚未就绪，未生成备份');
 fs.mkdirSync(backupDir,{recursive:true});
 const target=fs.mkdtempSync(path.join(backupDir,new Date().toISOString().replace(/[:.]/g,'-')+'-'));
 for(const file of files){
  const output=path.join(target,file);fs.mkdirSync(path.dirname(output),{recursive:true});
  const db=new DatabaseSync(path.join(stateDir,file),{readOnly:true});
  try{await backup(db,output)}finally{db.close()}
 }
 // Only folders with this marker are complete. Each book is a separate consistent snapshot.
 fs.writeFileSync(path.join(target,'complete.json'),JSON.stringify({createdAt:new Date().toISOString(),files},null,2));
 return target;
}

export function scheduleBackups(stateDir,backupDir,{intervalMs=60*60*1000,onError=()=>console.error('存档备份失败，请检查磁盘空间和目录权限。')}={}){
 let running=null;
 const run=()=>running||(running=backupState(stateDir,backupDir).finally(()=>{running=null}));
 const timer=setInterval(()=>{run().catch(onError)},intervalMs);timer.unref();
 return {run,async stop(){clearInterval(timer);if(running)await running}};
}

if(process.argv[1]&&fs.realpathSync(path.resolve(process.argv[1]))===fileURLToPath(import.meta.url)){
 try{const config=runtimeSettings();if(!config.backupDir)throw Error('请配置 BACKUP_DIR');console.log('备份已完成：'+await backupState(config.stateDir,config.backupDir))}
 catch(error){console.error(error.message);process.exitCode=1}
}
