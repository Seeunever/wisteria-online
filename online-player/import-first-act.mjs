// Reuse the accepted offline render; never expose its complete embedded payload.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.dirname(fileURLToPath(import.meta.url));
const source = path.resolve(root, '../output/应邪化仆-离线互动版.html');
const html = fs.readFileSync(source, 'utf8');
const match = html.match(/<script[^>]*id=["']content-data["'][^>]*>([\s\S]*?)<\/script>/);
if (!match) throw new Error('找不到已验证成品的数据区');
const data = JSON.parse(match[1]);
const destination = path.join(root, 'private');
if (fs.existsSync(path.join(destination, 'game.json'))) throw new Error('已有导入材料，停止覆盖');
fs.mkdirSync(destination, { recursive: true });
const roles = data.roles.map((role, index) => {
  const first = role.stages[0];
  if (!first.id.endsWith('act-one') || first.items.length !== 1) throw new Error('第一幕映射与记录不符');
  const pages = first.items.map((item, page) => {
    if (!item.data.startsWith('data:image/jpeg;base64,')) throw new Error('非预期图片格式');
    const filename = `role-${index + 1}-act-1-${page + 1}.jpg`;
    fs.writeFileSync(path.join(destination, filename), Buffer.from(item.data.split(',')[1], 'base64'), { flag: 'wx' });
    return filename;
  });
  return { id: role.id, name: role.name, number: index + 1, pages };
});
fs.writeFileSync(path.join(destination, 'game.json'), JSON.stringify({ title: data.title, roles }, null, 2), { flag: 'wx' });
console.log(`已复用 ${roles.length} 个角色的第一幕图片；未导入后续剧情、线索或真相。`);
