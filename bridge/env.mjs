// 极简 .env 读取：让飞书 / iMa 等凭证可以写在 bridge/.env 里，而不是每次启动都塞环境变量。
// 必须被 server.mjs 第一个 import，保证其它模块读取 process.env 之前已完成注入。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(HERE, '.env');

try {
  const text = fs.readFileSync(FILE, 'utf8');
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    // 真实环境变量优先，方便临时覆盖。
    if (!process.env[key]) process.env[key] = value;
  }
} catch {
  /* 没有 .env 就按系统环境变量走 */
}
