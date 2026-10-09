// 零依赖静态服务：node server.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8899);
const TITLE = "一键成片-AI音乐-素材成曲验证";

const server = http.createServer((req, res) => {
  if (req.url === '/api/status') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ ok: true, title: TITLE, service: '可运行 Demo', time: new Date().toISOString() }));
  }
  const file = path.join(HERE, req.url === '/' ? 'index.html' : req.url.replace(/^\//, ''));
  if (!file.startsWith(HERE) || !fs.existsSync(file)) {
    res.writeHead(404);
    return res.end('not found');
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  fs.createReadStream(file).pipe(res);
});

server.listen(PORT, () => {
  console.log('可运行 Demo 已启动：http://127.0.0.1:' + PORT);
});
