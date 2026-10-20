// 知识库适配层：本地 Markdown 库真读真写；若配置了 iMa 凭证则叠加 iMa 检索与回写。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const KB_DIR = path.join(HERE, '..', 'data', 'knowledge');

const IMA_MCP = process.env.IMA_MCP_URL || 'https://ima.qq.com/mcp';
const IMA_TOKEN = process.env.IMA_MCP_TOKEN || '';
const IMA_OPENAPI = 'https://ima.qq.com/openapi/wiki/v1';
const IMA_NOTE_API = 'https://ima.qq.com/openapi';
const IMA_CLIENT_ID = process.env.IMA_OPENAPI_CLIENTID || readConfig('client_id');
const IMA_API_KEY = process.env.IMA_OPENAPI_APIKEY || readConfig('api_key');
const IMA_KB_ID = process.env.IMA_KNOWLEDGE_BASE_ID || readConfig('knowledge_base_id');

function readConfig(name) {
  try {
    return fs.readFileSync(path.join(os.homedir(), '.config', 'ima', name), 'utf8').trim();
  } catch {
    return '';
  }
}

function ensureDir() {
  fs.mkdirSync(KB_DIR, { recursive: true });
}

function parseDoc(file) {
  const text = fs.readFileSync(file, 'utf8');
  const name = path.basename(file, '.md');
  const titleMatch = text.match(/^#\s+(.+)$/m);
  const tagsMatch = text.match(/^tags:\s*(.+)$/m);
  const summaryMatch = text.match(/^summary:\s*(.+)$/m);
  return {
    id: name,
    title: titleMatch ? titleMatch[1].trim() : name,
    tags: tagsMatch ? tagsMatch[1].split(/[,，、]/).map((t) => t.trim()).filter(Boolean) : [],
    summary: summaryMatch ? summaryMatch[1].trim() : '',
    body: text,
    file,
    mtime: fs.statSync(file).mtime.toISOString(),
    source: 'local',
  };
}

export function listDocs() {
  ensureDir();
  return fs
    .readdirSync(KB_DIR)
    .filter((f) => f.endsWith('.md'))
    .map((f) => parseDoc(path.join(KB_DIR, f)))
    .sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
}

// 中文按二元组切分 + 英文按词，做余弦相似度；结果真实可解释，不是随机数
function tokens(text) {
  const s = String(text || '').toLowerCase();
  const out = (s.match(/[a-z0-9]{2,}/g) || []).slice();
  for (const run of s.match(/[\u4e00-\u9fa5]+/g) || []) {
    if (run.length === 1) out.push(run);
    for (let i = 0; i + 2 <= run.length; i += 1) out.push(run.slice(i, i + 2));
  }
  return out;
}

function bag(text) {
  const m = new Map();
  for (const t of tokens(text)) m.set(t, (m.get(t) || 0) + 1);
  return m;
}

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [k, v] of a) {
    na += v * v;
    const w = b.get(k);
    if (w) dot += v * w;
  }
  for (const v of b.values()) nb += v * v;
  if (!na || !nb) return 0;
  return dot / Math.sqrt(na * nb);
}

function score(query, doc) {
  const q = bag(query);
  if (!q.size) return 0;
  const hay = bag(`${doc.title} ${doc.title} ${doc.summary} ${doc.tags.join(' ')} ${doc.body}`);
  return Math.min(0.95, cosine(q, hay) * 2.1);
}

export function searchLocal(query, limit = 6) {
  return listDocs()
    .map((doc) => ({ ...doc, score: score(query, doc) }))
    .filter((d) => d.score > 0.05)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export function saveDoc({ title, tags = [], summary = '', body = '' }, origin = 'dashboard') {
  ensureDir();
  const stamp = new Date().toISOString().slice(0, 10);
  const slug =
    String(title || 'note')
      .replace(/[^\w\u4e00-\u9fa5]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'note';
  const file = path.join(KB_DIR, `${stamp}-${slug}.md`);
  const content = [
    `# ${title || '未命名知识'}`,
    `tags: ${(tags || []).join(', ')}`,
    `summary: ${summary || ''}`,
    `origin: ${origin}`,
    `created: ${new Date().toISOString()}`,
    '',
    body || '',
    '',
  ].join('\n');
  fs.writeFileSync(file, content, 'utf8');
  return parseDoc(file);
}

// ---------- iMa（可选通道） ----------

export function imaStatus() {
  const openapi = Boolean(IMA_CLIENT_ID && IMA_API_KEY);
  return {
    endpoint: openapi ? IMA_OPENAPI : IMA_MCP,
    configured: openapi || Boolean(IMA_TOKEN),
    mode: openapi ? 'openapi' : IMA_TOKEN ? 'mcp-token' : 'local-fallback',
    knowledgeBaseConfigured: Boolean(IMA_KB_ID),
    reason: openapi && !IMA_KB_ID ? 'iMa 已认证，但尚未指定目标知识库；配置 IMA_KNOWLEDGE_BASE_ID 后启用知识库读写' : '',
  };
}

function imaFolderName(name, created) {
  const date = new Date(created || Date.now());
  const stamp = Number.isNaN(date.getTime())
    ? new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')
    : date.toISOString().slice(0, 16).replace(/[-:T]/g, '');
  const clean = String(name || '未命名需求').replace(/[\\/:*?"<>|]/g, '-').trim().slice(0, 80);
  return `${stamp}-${clean || '未命名需求'}`;
}

export function requirementFolderName(name, created) {
  return imaFolderName(name, created);
}

async function imaOpenApi(apiPath, body, timeoutMs = 15_000, base = IMA_OPENAPI) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/${apiPath}`, {
      method: 'POST',
      headers: {
        'ima-openapi-clientid': IMA_CLIENT_ID,
        'ima-openapi-apikey': IMA_API_KEY,
        'ima-openapi-ctx': 'skill_version=1.1.10',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body || {}),
      signal: ctrl.signal,
    });
    const data = await res.json();
    if (!res.ok || data.code !== 0) throw new Error(data.msg || `iMa ${res.status}`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

// iMa 当前公开 OpenAPI 没有创建知识库文件夹的接口，只能定位用户已创建的文件夹。
export async function findImaFolder(name) {
  if (!(IMA_CLIENT_ID && IMA_API_KEY && IMA_KB_ID)) {
    return { ok: false, found: false, name, reason: 'iMa 未完成知识库配置' };
  }
  try {
    const res = await imaOpenApi('get_knowledge_list', {
      knowledge_base_id: IMA_KB_ID,
      cursor: '',
      limit: 50,
    });
    const folders = (res?.data?.knowledge_list || []).filter((item) => item.folder_id || item.type === 'folder');
    const exact = folders.find((item) => String(item.name || '') === name);
    if (exact) {
      return { ok: true, found: true, name, folderId: exact.folder_id || exact.media_id };
    }

    const searched = await imaOpenApi('search_knowledge', {
      knowledge_base_id: IMA_KB_ID,
      query: name,
      cursor: '',
    });
    const match = (searched?.data?.info_list || []).find((item) =>
      String(item.title || item.name || '') === name && (item.folder_id || item.type === 'folder')
    );
    if (match) {
      return { ok: true, found: true, name, folderId: match.folder_id || match.media_id };
    }
    return { ok: true, found: false, name, reason: 'iMa 中尚未找到同名需求文件夹，请先在“项目文档”中创建。' };
  } catch (err) {
    return { ok: false, found: false, name, reason: String(err.message || err) };
  }
}

async function imaRpc(method, params, timeoutMs = 15_000) {
  if (!IMA_TOKEN) throw new Error('未配置 IMA_MCP_TOKEN');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(IMA_MCP, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${IMA_TOKEN}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`iMa ${res.status}: ${text.slice(0, 200)}`);
    const line = text
      .split('\n')
      .map((l) => l.replace(/^data:\s*/, '').trim())
      .filter(Boolean)
      .pop();
    return JSON.parse(line || text);
  } finally {
    clearTimeout(timer);
  }
}

export async function search(query, limit = 6) {
  const local = searchLocal(query, limit);
  if (IMA_CLIENT_ID && IMA_API_KEY) {
    if (!IMA_KB_ID) return { hits: local, ima: imaStatus() };
    try {
      const res = await imaOpenApi('search_knowledge', {
        knowledge_base_id: IMA_KB_ID,
        query,
        cursor: '',
      });
      const raw = res?.data?.info_list || res?.data?.list || [];
      const imaHits = raw.slice(0, limit).map((item, i) => ({
        id: `ima-${item.media_id || i}`,
        title: item.title || item.name || `iMa 结果 ${i + 1}`,
        summary: String(item.summary || item.description || '').slice(0, 200),
        body: String(item.content || item.summary || ''),
        tags: [],
        score: 0.8,
        source: 'ima',
        mtime: new Date().toISOString(),
      }));
      return { hits: [...imaHits, ...local].slice(0, limit), ima: imaStatus() };
    } catch (err) {
      return { hits: local, ima: { ...imaStatus(), error: String(err.message || err) } };
    }
  }
  if (!IMA_TOKEN) return { hits: local, ima: imaStatus() };
  try {
    const res = await imaRpc('tools/call', {
      name: 'search',
      arguments: { query, top_k: limit },
    });
    const raw = res?.result?.content;
    const imaHits = Array.isArray(raw)
      ? raw.map((c, i) => ({
          id: `ima-${i}`,
          title: c.title || c.name || `iMa 结果 ${i + 1}`,
          summary: String(c.text || c.content || '').slice(0, 200),
          body: String(c.text || c.content || ''),
          tags: c.tags || [],
          score: typeof c.score === 'number' ? c.score : 0.7,
          source: 'ima',
          mtime: new Date().toISOString(),
        }))
      : [];
    return { hits: [...imaHits, ...local].slice(0, limit), ima: imaStatus() };
  } catch (err) {
    return { hits: local, ima: { ...imaStatus(), error: String(err.message || err) } };
  }
}

export async function pushToIma(doc, options = {}) {
  if (IMA_CLIENT_ID && IMA_API_KEY) {
    if (!IMA_KB_ID) return { ok: false, reason: 'iMa 已认证，但未指定目标知识库' };
    try {
      const note = await imaOpenApi('note/v1/import_doc', {
        content_format: 1,
        content: `# ${doc.title || '需求协作台阶段结论'}\n\n${doc.body || ''}`,
      }, 15_000, IMA_NOTE_API);
      const noteId = note?.data?.note_id || note?.data?.doc_id || note?.note_id;
      if (!noteId) throw new Error('iMa 新建笔记未返回 note_id');
      const linked = await imaOpenApi('add_knowledge', {
        media_type: 11,
        note_info: { content_id: noteId },
        title: doc.title || '需求协作台阶段结论',
        knowledge_base_id: IMA_KB_ID,
        ...(options.folderId ? { folder_id: options.folderId } : {}),
      });
      return {
        ok: linked?.code === 0,
        noteId,
        knowledgeBaseId: IMA_KB_ID,
        folderId: options.folderId || null,
        reason: linked?.code === 0 ? '' : linked?.msg || 'iMa 关联知识库失败',
      };
    } catch (err) {
      return { ok: false, reason: String(err.message || err) };
    }
  }
  if (!IMA_TOKEN) return { ok: false, reason: '未配置 iMa 凭证，已存本地知识库' };
  try {
    await imaRpc('tools/call', {
      name: 'write_note',
      arguments: { title: doc.title, content: doc.body, tags: doc.tags },
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: String(err.message || err) };
  }
}
