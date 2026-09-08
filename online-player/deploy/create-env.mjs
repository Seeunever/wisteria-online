import fs from 'node:fs';
import {randomBytes} from 'node:crypto';
// Generated only on the server. Do not print the code or package it with the application.
const settings=['APP_MODE=production','TEST_ASSIST=0','HOST=127.0.0.1','PORT=4310','PUBLIC_ORIGIN=https://47.81.210.196','STATE_DIR=/var/lib/wisteria-online/production','BACKUP_DIR=/var/backups/wisteria-online','SITE_ACCESS_CODE='+randomBytes(9).toString('base64url')];
fs.writeFileSync('/etc/wisteria-online.env',settings.join('\n')+'\n',{flag:'wx',mode:0o600});
