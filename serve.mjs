/* serve.mjs —— 素材成曲验证 · 零依赖本地服务（与前端约定：http://127.0.0.1:7777）
 * 启动方式：cd 到本工程目录后执行  node serve.mjs  然后浏览器访问 http://127.0.0.1:7777
 * 职责：① 托管本目录静态文件（index.html / app.js / styles.css）
 *       ② GET  /ping  探测（返回 {ok, ffmpeg, lame}，前端据此决定 MP3 或降级 WAV）
 *       ③ POST /mp3  body 为 WAV 二进制 → 调本机 ffmpeg（优先）或 lame 转码 → 返回 128k MP3
 * 依赖：Node ≥16；本机已装 ffmpeg（macOS: brew install ffmpeg；Windows: ffmpeg.org 下载加入 PATH）或 lame
 * 未检测到 ffmpeg/lame 时 /mp3 返回 503 与安装指引，前端自动降级下载 WAV，不阻塞、不报错。
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = 7777, HOST = '127.0.0.1';
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg'
};

const tool = { ffmpeg: false, lame: false };
function checkBin(bin, args, key) {
  try {
    const p = spawn(bin, args);
    p.on('error', () => { tool[key] = false; });
    p.on('close', c => { tool[key] = c === 0; });
  } catch (e) { tool[key] = false; }
}
function refreshTools() {
  checkBin('ffmpeg', ['-version'], 'ffmpeg');
  checkBin('lame', ['--version'], 'lame');
}
refreshTools();

const send = (res, status, body, type) => {
  res.writeHead(status, Object.assign({ 'Content-Type': type || 'application/json; charset=utf-8' }, CORS));
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};

async function serveStatic(res, url) {
  let p = decodeURIComponent(url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(ROOT, p));
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) return send(res, 403, { error: 'forbidden' });
  try {
    const st = await stat(file);
    if (!st.isFile()) throw new Error('not a file');
    const buf = await readFile(file);
    res.writeHead(200, Object.assign({
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': buf.length, 'Cache-Control': 'no-cache'
    }, CORS));
    res.end(buf);
  } catch (e) { send(res, 404, { error: 'not found' }); }
}

function encodeMp3(res, chunks) {
  const useFf = tool.ffmpeg;
  if (!useFf && !tool.lame) {
    return send(res, 503, {
      error: '未检测到 ffmpeg 或 lame',
      guide: '请安装 ffmpeg（macOS: brew install ffmpeg；Windows: ffmpeg.org 下载并加入 PATH）或 lame 后重新运行 node serve.mjs；期间前端会自动降级下载 WAV'
    });
  }
  const bin = useFf ? 'ffmpeg' : 'lame';
  const args = useFf
    ? ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-codec:a', 'libmp3lame', '-b:a', '128k', '-f', 'mp3', 'pipe:1']
    : ['--silent', '-b', '128', '-', '-'];
  const ff = spawn(bin, args);
  const out = [];
  let errTxt = '', responded = false;
  const fail = (status, obj) => { if (responded) return; responded = true; send(res, status, obj); };
  ff.on('error', () => fail(500, { error: '无法启动 ' + bin + '，请确认已安装并在 PATH 中' }));
  ff.stderr.on('data', d => { errTxt += d.toString(); });
  ff.stdout.on('data', d => out.push(d));
  ff.on('close', code => {
    if (responded) return;
    if (code === 0 && out.length) {
      responded = true;
      const buf = Buffer.concat(out);
      res.writeHead(200, Object.assign({ 'Content-Type': 'audio/mpeg', 'Content-Length': buf.length }, CORS));
      res.end(buf);
    } else {
      fail(500, { error: bin + ' 转码失败（退出码 ' + code + '）', detail: errTxt.slice(0, 400) });
    }
  });
  for (const c of chunks) ff.stdin.write(c);
  ff.stdin.end();
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  if (req.method === 'GET' && (req.url === '/ping' || req.url === '/ping/')) {
    if (!tool.ffmpeg && !tool.lame) refreshTools();
    return send(res, 200, { ok: true, ffmpeg: tool.ffmpeg, lame: tool.lame, port: PORT });
  }
  if (req.method === 'POST' && (req.url === '/mp3' || req.url === '/mp3/')) {
    const chunks = [];
    let size = 0, aborted = false;
    req.on('data', c => {
      size += c.length;
      if (size > 80 * 1024 * 1024) {
        aborted = true;
        send(res, 413, { error: 'body too large' });
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('error', () => {});
    req.on('end', () => {
      if (aborted) return;
      if (size < 64) return send(res, 400, { error: 'empty or invalid WAV body' });
      encodeMp3(res, chunks);
    });
    return;
  }
  if (req.method === 'GET') return serveStatic(res, req.url);
  send(res, 404, {
    error: 'not found',
    usage: { 'GET /': '静态页面（index.html）', 'GET /ping': '探测 ffmpeg/lame 可用性', 'POST /mp3': 'WAV 二进制 → 128k MP3（audio/mpeg）' }
  });
});

server.listen(PORT, HOST, () => {
  console.log('[serve] 已启动: http://' + HOST + ':' + PORT + '（托管本目录静态文件）');
  console.log('[serve] GET /ping 探测；POST /mp3 转码（ffmpeg 优先，lame 兜底，均未装返回 503 指引）');
  console.log('[serve] ffmpeg/lame 状态以 /ping 返回为准，启动后可重跑 node serve.mjs 刷新检测');
});
