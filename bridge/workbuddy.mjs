// WorkBuddy 本地网关。
//
// WorkBuddy 桌面端在启动时会以一个常驻 sidecar 进程（codebuddy --serve）暴露本地 HTTP 网关，
// 该进程由桌面端注入登录凭据，因此它才是"已登录、可真实调用模型与智能体"的入口。
// 直接跑 CLI 子进程拿不到这份凭据，只会返回 Authentication required。
//
// 本模块负责：发现 sidecar -> 密码登录拿 token -> 用 Gateway 协议派发任务并读取 SSE 流。
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// 常驻服务由 launchd 拉起，PATH 里未必有 /usr/sbin，这里直接锁定绝对路径。
function firstExisting(paths, fallback) {
  for (const p of paths) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* 忽略探测失败 */
    }
  }
  return fallback;
}

const PS_BIN = firstExisting(['/bin/ps', '/usr/bin/ps'], 'ps');
const LSOF_BIN = firstExisting(['/usr/sbin/lsof', '/usr/bin/lsof'], 'lsof');

const SERVE_RE = /cli\/bin\/codebuddy\s+--serve/;
const SENDER = { id: 'requirement-cockpit', name: '需求协作台' };
const CONVERSATION = { id: 'requirement-cockpit', type: 'direct' };

let cached = null;

function spawnEnv() {
  return { ...process.env, LANG: process.env.LANG || 'en_US.UTF-8' };
}

async function findSidecarPids() {
  const { stdout } = await execFileAsync(PS_BIN, ['ax', '-o', 'pid=,command='], {
    maxBuffer: 16 * 1024 * 1024,
  });
  const pids = [];
  for (const line of stdout.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(.*)$/);
    if (m && SERVE_RE.test(m[2])) pids.push(Number(m[1]));
  }
  return pids;
}

async function readGatewayPassword(pid) {
  try {
    const { stdout } = await execFileAsync(PS_BIN, ['eww', String(pid)], {
      maxBuffer: 32 * 1024 * 1024,
    });
    const m = stdout.match(/CODEBUDDY_GATEWAY_PASSWORD=([^\s]+)/);
    return m ? m[1] : '';
  } catch {
    return '';
  }
}

async function listeningPorts(pid) {
  try {
    const { stdout } = await execFileAsync(
      LSOF_BIN,
      ['-nP', '-p', String(pid), '-a', '-iTCP', '-sTCP:LISTEN'],
      { maxBuffer: 8 * 1024 * 1024 }
    );
    const ports = new Set();
    for (const line of stdout.split('\n')) {
      const m = line.match(/127\.0\.0\.1:(\d+)\s+\(LISTEN\)/);
      if (m) ports.add(Number(m[1]));
    }
    return [...ports];
  } catch {
    return [];
  }
}

// 端口不好静态推断（桌面端用 --port 0 随机分配），改用行为探针：
// 逐个候选端口请求 /api/v1/auth/status，返回 authEnabled 的就是网关。
async function probeGatewayPort(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/auth/status`, {
      signal: AbortSignal.timeout(1200),
    });
    if (!res.ok) return null;
    const body = await res.json();
    if (body && body.authEnabled) return true;
  } catch {
    /* 该端口不是网关 */
  }
  return null;
}

async function login(baseUrl, password) {
  const res = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
    signal: AbortSignal.timeout(6000),
  });
  const body = await res.json().catch(() => ({}));
  if (!body || !body.token) throw new Error(body?.error?.message || '网关登录失败');
  return body.token;
}

// 发现并登录一个可用网关；结果缓存，失败时清缓存重试。
export async function ensureGateway(force = false) {
  if (!force && cached) return cached;

  const pids = await findSidecarPids();
  for (const pid of pids) {
    const password = await readGatewayPassword(pid);
    if (!password) continue;
    for (const port of await listeningPorts(pid)) {
      if (!(await probeGatewayPort(port))) continue;
      const baseUrl = `http://127.0.0.1:${port}`;
      try {
        const token = await login(baseUrl, password);
        cached = { baseUrl, token, pid, at: Date.now() };
        return cached;
      } catch {
        /* 试下一个端口 */
      }
    }
  }
  cached = null;
  return null;
}

export function gatewayStatus() {
  if (!cached) return { available: false, checkedAt: null, baseUrl: '' };
  return { available: true, checkedAt: new Date(cached.at).toISOString(), baseUrl: cached.baseUrl };
}

function authHeaders(gw) {
  return { Authorization: `Bearer ${gw.token}`, 'Content-Type': 'application/json' };
}

async function createRun(gw, prompt, timeoutMs) {
  const id = `cockpit-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
  const res = await fetch(`${gw.baseUrl}/api/v1/runs`, {
    method: 'POST',
    headers: authHeaders(gw),
    body: JSON.stringify({
      version: '1.0',
      id,
      type: 'message',
      source: { platform: 'generic', sender: SENDER, conversation: CONVERSATION },
      text: prompt,
      timeoutMs,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) throw Object.assign(new Error('网关需要重新登录'), { relogin: true });
  if (!body?.data?.runId) {
    throw new Error(body?.error?.message || `派发失败（HTTP ${res.status}）`);
  }
  return { runId: body.data.runId, messageId: id };
}

// Node 内置 fetch（undici）默认 bodyTimeout 为 300s：长任务在首段输出到达前就会被切断，
// build 阶段实测 310s 抛 fetch failed，随后被兜底成本地模板。SSE 长连接改用 node:http 直读，
// socket 空闲超时关闭，整体时限只由本模块控制。
function openSse(url, headers) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: `${u.pathname}${u.search}`,
        method: 'GET',
        headers,
      },
      (res) => resolve({ res, req })
    );
    req.setTimeout(0);
    req.on('error', reject);
    req.end();
  });
}

// 读取 SSE 流，直到收到 completed / done。
// onProgress 会在每次拿到增量时被调用，用于把中间输出实时回显给页面。
async function streamRun(gw, runId, timeoutMs, onProgress) {
  let text = '';
  let failure = '';

  const emit = (value, final) => {
    if (typeof onProgress !== 'function') return;
    try {
      onProgress(value, final);
    } catch {
      /* 进度回调失败不影响主流程 */
    }
  };
  const { res, req } = await openSse(`${gw.baseUrl}/api/v1/runs/${runId}/stream`, {
    Authorization: `Bearer ${gw.token}`,
    Accept: 'text/event-stream',
  });
  const timer = setTimeout(() => {
    try {
      req.destroy(new Error(`读取执行流超时（${timeoutMs}ms）`));
    } catch {
      /* 连接已关闭 */
    }
  }, timeoutMs);
  try {
    if (res.statusCode === 401) throw Object.assign(new Error('网关需要重新登录'), { relogin: true });
    if (res.statusCode !== 200) throw new Error(`读取执行流失败（HTTP ${res.statusCode}）`);
    res.setEncoding('utf8');

    let buffer = '';
    let event = 'message';
    let done = false;

    const handle = (raw) => {
      const payload = raw.trim();
      if (!payload || payload === '{}') return false;
      let obj;
      try {
        obj = JSON.parse(payload);
      } catch {
        return false;
      }
      const content = obj?.content || {};
      const chunk = content.markdown || content.text || '';
      if (typeof chunk === 'string' && chunk) {
        // 完整消息覆盖累积值；增量消息追加。
        text = obj.status === 'completed' ? chunk : text && chunk.startsWith(text) ? chunk : text + chunk;
        emit(text, false);
      }
      const state = obj?.status || '';
      if (state === 'failed' || state === 'error') {
        failure = obj?.error?.message || obj?.message || '智能体执行失败';
        return true;
      }
      return state === 'completed';
    };

    for await (const part of res) {
      buffer += part;
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        if (line.startsWith('event:')) {
          event = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          if (handle(line.slice(5))) done = true;
        } else if (line === '' && event === 'done') {
          done = true;
        }
      }
      if (done) break;
    }
  } finally {
    clearTimeout(timer);
    try {
      req.destroy();
    } catch {
      /* 连接已关闭 */
    }
  }

  if (failure) throw new Error(failure);
  if (!text.trim()) throw new Error('智能体没有返回内容');
  emit(text, true);
  return text.trim();
}

// 对外统一入口：把一个阶段的提示词交给 WorkBuddy 里真实的智能体执行。
export async function runViaGateway(prompt, { timeoutMs = 240_000, onProgress } = {}) {
  let gw = await ensureGateway();
  if (!gw) throw new Error('未发现已登录的 WorkBuddy 桌面端，请先打开 WorkBuddy');
  try {
    const { runId } = await createRun(gw, prompt, timeoutMs);
    return await streamRun(gw, runId, timeoutMs, onProgress);
  } catch (err) {
    if (!err?.relogin) throw err;
    gw = await ensureGateway(true);
    if (!gw) throw new Error('WorkBuddy 网关登录失效，请重新打开桌面端');
    const { runId } = await createRun(gw, prompt, timeoutMs);
    return await streamRun(gw, runId, timeoutMs, onProgress);
  }
}

export async function probeGateway() {
  const gw = await ensureGateway(true);
  if (!gw) return { ok: false, reason: '未发现已登录的 WorkBuddy 桌面端' };
  try {
    const info = await fetch(`${gw.baseUrl}/api/v1/info`, { headers: authHeaders(gw) })
      .then((r) => r.json())
      .then((j) => j?.data || {});
    return { ok: true, baseUrl: gw.baseUrl, info };
  } catch (err) {
    return { ok: false, reason: String(err && err.message) };
  }
}
