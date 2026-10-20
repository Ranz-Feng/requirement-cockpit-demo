// 飞书云文档适配层：配置了飞书应用凭证时，把交付物真实写入飞书在线文档；
// 未配置时返回明确状态，由前端降级为「本地文档查看 / 下载」。
//
// 需要的环境变量（二选一）：
//   FEISHU_APP_ID / FEISHU_APP_SECRET   —— 自建应用，写入应用所在租户的云空间
//   FEISHU_USER_ACCESS_TOKEN            —— 用户身份，写入该用户自己的云空间
// 可选：FEISHU_BASE（默认 open.feishu.cn，可指向私有化域名）

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const APP_ID = process.env.FEISHU_APP_ID || '';
const APP_SECRET = process.env.FEISHU_APP_SECRET || '';
const USER_TOKEN = process.env.FEISHU_USER_ACCESS_TOKEN || '';
const BASE = (process.env.FEISHU_BASE || 'https://open.feishu.cn').replace(/\/+$/, '');
const AUTH_BASE = (process.env.FEISHU_AUTH_BASE || 'https://accounts.feishu.cn').replace(/\/+$/, '');

// OAuth 拿到的用户令牌落盘保存，重启服务后仍以「你本人」身份写入飞书。
const HERE = path.dirname(fileURLToPath(import.meta.url));
const USER_FILE = path.join(HERE, '.feishu-user.json');

export function readUser() {
  try {
    const j = JSON.parse(fs.readFileSync(USER_FILE, 'utf8'));
    if (j && j.access_token) return j;
  } catch {
    /* 未授权过 */
  }
  return null;
}

function saveUser(j) {
  fs.writeFileSync(USER_FILE, JSON.stringify(j, null, 2), 'utf8');
}

export function clearUser() {
  try {
    fs.unlinkSync(USER_FILE);
  } catch {
    /* 本来就不存在 */
  }
}

// 生成用户授权链接：用户在浏览器点开后授权，飞书带 code 回调。
export function oauthAuthorizeUrl(redirectUri, scope, state = crypto.randomBytes(8).toString('hex')) {
  const s = scope || 'docx:document drive:drive offline_access';
  const q = new URLSearchParams({
    client_id: APP_ID,
    redirect_uri: redirectUri,
    scope: s,
    state,
  });
  return { url: `${AUTH_BASE}/open-apis/authen/v1/authorize?${q.toString()}`, state };
}

// 用回调 code 换用户令牌，并补一份用户信息（名字 / open_id）。
export async function exchangeCode(code, redirectUri) {
  const body = { grant_type: 'authorization_code', client_id: APP_ID, client_secret: APP_SECRET, code, redirect_uri: redirectUri };
  let j;
  try {
    j = await fetch(`${BASE}/open-apis/authen/v2/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
    }).then((r) => r.json());
  } catch (err) {
    return { ok: false, reason: String(err && err.message ? err.message : err) };
  }
  if (!j || j.code !== 0 || !j.access_token) {
    return { ok: false, reason: `换取用户令牌失败：${(j && (j.error_description || j.msg || j.code)) || '未知错误'}` };
  }
  const rec = {
    access_token: j.access_token,
    refresh_token: j.refresh_token || '',
    expires_at: Date.now() + (Number(j.expires_in) || 7200) * 1000,
    refresh_expires_at: Date.now() + (Number(j.refresh_token_expires_in) || 30 * 24 * 3600) * 1000,
    scope: j.scope || '',
  };
  const info = await fetch(`${BASE}/open-apis/authen/v1/user_info`, {
    headers: { authorization: `Bearer ${rec.access_token}` },
  })
    .then((r) => r.json())
    .catch(() => null);
  if (info && info.code === 0 && info.data) {
    rec.name = info.data.name || '';
    rec.open_id = info.data.open_id || '';
  }
  saveUser(rec);
  return { ok: true, user: { name: rec.name, openId: rec.open_id } };
}

async function refreshUser(rec) {
  if (!rec.refresh_token) return null;
  const j = await fetch(`${BASE}/open-apis/authen/v2/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: APP_ID,
      client_secret: APP_SECRET,
      refresh_token: rec.refresh_token,
    }),
  })
    .then((r) => r.json())
    .catch(() => null);
  if (!j || j.code !== 0 || !j.access_token) return null;
  const fresh = {
    ...rec,
    access_token: j.access_token,
    refresh_token: j.refresh_token || rec.refresh_token,
    expires_at: Date.now() + (Number(j.expires_in) || 7200) * 1000,
  };
  saveUser(fresh);
  return fresh;
}

// 当前可用的用户令牌：没过期直接用，过期用 refresh_token 自动续期。
async function currentUserToken() {
  const rec = readUser();
  if (!rec) return null;
  if (rec.expires_at && Date.now() < rec.expires_at - 60_000) return rec.access_token;
  const fresh = await refreshUser(rec);
  return fresh ? fresh.access_token : null;
}

export function feishuStatus() {
  const rec = readUser();
  const configured = Boolean((APP_ID && APP_SECRET) || USER_TOKEN || rec);
  return {
    configured,
    mode: rec ? 'user-oauth' : USER_TOKEN ? 'user-token' : APP_ID && APP_SECRET ? 'app' : 'none',
    user: rec ? { name: rec.name || '', openId: rec.open_id || '' } : null,
    reason: configured
      ? ''
      : '未配置飞书凭证：设置 FEISHU_APP_ID / FEISHU_APP_SECRET，或完成用户授权后即可写入飞书在线文档',
  };
}

let tokenCache = { token: '', exp: 0 };

async function tenantToken() {
  if (!APP_ID || !APP_SECRET) return { ok: false, error: '缺少 FEISHU_APP_ID / FEISHU_APP_SECRET' };
  if (tokenCache.token && Date.now() < tokenCache.exp) return { ok: true, token: tokenCache.token };
  try {
    const r = await fetch(`${BASE}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
    });
    const j = await r.json();
    if (j.code !== 0) return { ok: false, error: `获取 tenant_access_token 失败：${j.msg || j.code}` };
    tokenCache = { token: j.tenant_access_token, exp: Date.now() + (j.expire - 120) * 1000 };
    return { ok: true, token: j.tenant_access_token };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
}

async function accessToken() {
  // 优先用「你本人」的用户令牌：文档归属你、写进你的云空间。
  const userTok = await currentUserToken();
  if (userTok) return { ok: true, token: userTok, user: true };
  if (USER_TOKEN) return { ok: true, token: USER_TOKEN, user: true };
  return tenantToken();
}

function blocksFromText(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 400)
    .map((line) => {
      const heading = /^#{1,3}\s+/.test(line);
      const content = line.replace(/^#{1,3}\s+/, '').slice(0, 1800);
      return {
        // docx 的 block_type：2=普通文本，4=二级标题（3 是一级标题，字段与类型必须匹配，否则报 invalid param）
        block_type: heading ? 4 : 2,
        ...(heading
          ? { heading2: { elements: [{ text_run: { content } }] } }
          : { text: { elements: [{ text_run: { content } }] } }),
      };
    });
}

// 创建一篇飞书云文档并写入正文，返回可跳转链接。
// 用应用身份创建时，文档默认归应用所有，需显式放开权限，链接才能被别人打开。
async function openLinkShare(base, auth, docId) {
  try {
    const r = await fetch(
      `${base}/open-apis/drive/v1/permissions/${docId}/public?type=docx`,
      {
        method: 'PATCH',
        headers: auth,
        body: JSON.stringify({ link_share_entity: 'tenant_readable', external_access: false }),
      }
    );
    const j = await r.json();
    return { ok: j.code === 0, reason: j.code === 0 ? '' : `开放链接权限失败：${j.msg || j.code}` };
  } catch (err) {
    return { ok: false, reason: String(err && err.message ? err.message : err) };
  }
}

export async function createDoc({ title, body } = {}) {
  const status = feishuStatus();
  if (!status.configured) return { ok: false, configured: false, reason: status.reason };

  const tk = await accessToken();
  if (!tk.ok) return { ok: false, configured: true, reason: tk.error };

  const auth = { authorization: `Bearer ${tk.token}`, 'content-type': 'application/json; charset=utf-8' };
  try {
    const created = await fetch(`${BASE}/open-apis/docx/v1/documents`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ title: title || '未命名文档' }),
    });
    const cj = await created.json();
    if (cj.code !== 0) return { ok: false, configured: true, reason: `创建文档失败：${cj.msg || cj.code}` };
    const docId = cj.data?.document?.document_id;
    if (!docId) return { ok: false, configured: true, reason: '创建文档未返回 document_id' };

    // 应用身份创建的文档归应用所有，放开成“公司内可读”，保证链接能打开。
    let permReason = '';
    if (!tk.user) {
      const perm = await openLinkShare(BASE, auth, docId);
      if (!perm.ok) permReason = perm.reason;
    }

    const blocks = blocksFromText(body);
    for (let i = 0; i < blocks.length; i += 40) {
      const children = blocks.slice(i, i + 40);
      const r = await fetch(
        `${BASE}/open-apis/docx/v1/documents/${docId}/blocks/${docId}/children`,
        { method: 'POST', headers: auth, body: JSON.stringify({ children, index: i }) }
      );
      const rj = await r.json();
      if (rj.code !== 0) {
        return {
          ok: true,
          configured: true,
          partial: true,
          documentId: docId,
          url: `${BASE.replace('open.feishu.cn', 'feishu.cn')}/docx/${docId}`,
          reason: `正文写入中断：${rj.msg || rj.code}`,
          permReason,
        };
      }
    }
    return {
      ok: true,
      configured: true,
      documentId: docId,
      url: `${BASE.replace('open.feishu.cn', 'feishu.cn')}/docx/${docId}`,
      permReason,
    };
  } catch (err) {
    return { ok: false, configured: true, reason: String(err && err.message ? err.message : err) };
  }
}
