import './env.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const requirementsFile = path.join(HERE, '..', 'data', 'requirements.json');

if (!fs.existsSync(requirementsFile)) {
  console.log('[需求协作台] 首次启动，正在生成本地演示数据');
  await import('./seed.mjs');
}

await import('./server.mjs');
