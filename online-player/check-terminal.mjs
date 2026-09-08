import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {createApp} from './server.mjs';
import {createLibrary} from './library-server.mjs';
const {chromium}=createRequire(import.meta.url)('../murder-mystery-html-builder/murder-mystery-html-builder/node_modules/playwright-core');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'terminal-art-'));
const server=createLibrary({createYingxie:createApp,yingxieOptions:{stateDir:path.join(temp,'yingxie')},zitengOptions:{stateDir:path.join(temp,'ziteng')}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
let browser;const errors=[];
async function fit(page,label){assert.deepEqual(await page.evaluate(()=>{
 const issues=[],w=document.documentElement.clientWidth;
 if(document.documentElement.scrollWidth>w+1)issues.push('horizontal overflow');
 for(const n of document.querySelectorAll('a,button,input,select,summary')){
  if(!n.checkVisibility())continue;const r=n.getBoundingClientRect();
  if(r.left< -1||r.right>w+1)issues.push(`${n.tagName} outside`);
  if(r.height<44)issues.push(`${n.tagName} small touch target`);
 }
 return issues;
}),[],label)}
try{
 browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',headless:true});
 for(const [width,height]of [[320,568],[390,844],[820,1180],[1440,1000]]){
  const context=await browser.newContext({viewport:{width,height}}),page=await context.newPage();
  page.on('pageerror',e=>errors.push(e.message));page.on('response',r=>{if(r.status()>=400&&r.url().endsWith('/terminal.css'))errors.push('theme stylesheet failed')});
  await page.goto(base);assert.equal(await page.locator('h1').evaluate(n=>getComputedStyle(n).fontFamily.includes('Segoe UI')),true);
  await fit(page,`${width} archive`);assert.equal(await page.locator('.case-file').count(),2);
  await page.screenshot({path:path.join(temp,`archive-${width}.png`),fullPage:true});
  await page.getByRole('link',{name:'选择剧本',exact:true}).click();assert.ok(page.url().endsWith('#cases'));
  await page.getByRole('link',{name:'进入紫藤夫人',exact:true}).click();await page.locator('#name').fill(`美术检查${width}`);await fit(page,`${width} login`);
  await page.screenshot({path:path.join(temp,`login-${width}.png`),fullPage:true});
  await page.getByRole('button',{name:'进入游戏',exact:true}).click();await page.locator('#roles .role').first().waitFor();await fit(page,`${width} roles`);
  await page.getByRole('button',{name:'选择并阅读',exact:true}).first().click();await page.locator('#roleTitle').filter({hasText:'第 1 幕'}).waitFor();
  await page.locator('#gamePages img').nth(1).evaluate(i=>i.decode());await fit(page,`${width} reader`);
  const visuals=await page.locator('#gamePages img').nth(1).evaluate(i=>({filter:getComputedStyle(i).filter,fit:getComputedStyle(i).objectFit}));assert.deepEqual(visuals,{filter:'none',fit:'contain'});
  await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:path.join(temp,`reader-${width}.png`)});
  await page.getByRole('link',{name:'← 选择其他剧本',exact:true}).click();await page.getByRole('link',{name:'进入应邪化仆',exact:true}).click();await page.locator('#name').waitFor();await fit(page,`${width} original game`);
  await context.close();console.log(`通过 ${width}：主题加载、首页/双本导航、登录选角、原图不变形、可点击尺寸。`);
 }
 assert.deepEqual(errors,[]);console.log(`美术截图：${temp}`);
}finally{await browser?.close();await new Promise(r=>server.close(r))}
