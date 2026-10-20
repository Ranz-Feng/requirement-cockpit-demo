// 真实读取本机 WorkBuddy 的智能体目录与技能包，不写死清单。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const HOME = os.homedir();
const WB = path.join(HOME, '.workbuddy');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function listDirs(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() || d.isSymbolicLink())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

function catalogFile() {
  const root = path.join(WB, 'product-agent-runtime');
  const versions = listDirs(root).sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true })
  );
  const latest = versions[versions.length - 1];
  if (!latest) return null;
  return path.join(root, latest, 'catalog.json');
}

// WorkBuddy 的 6 个产品智能体 + 本地/市场技能包
export function loadAgents() {
  const file = catalogFile();
  const raw = file ? readJson(file) : null;
  const runtimeAgents = raw
    ? Object.entries(raw).map(([install, meta]) => ({
        id: meta.agent || install,
        name: meta.name || install,
        installName: meta.install_name || install,
        source: 'product-agent-runtime',
      }))
    : [];

  const marketplace = listDirs(path.join(WB, 'skills-marketplace', 'skills'));
  const localSkills = listDirs(path.join(WB, 'skills'));

  const unique = new Map();
  for (const item of runtimeAgents) unique.set(item.installName, item);
  for (const id of localSkills) {
    if (!unique.has(id)) unique.set(id, { id, name: id, installName: id, source: 'skills' });
  }
  for (const id of marketplace) {
    if (!unique.has(id)) {
      unique.set(id, { id, name: id, installName: id, source: 'skills-marketplace' });
    }
  }

  return {
    catalogFile: file,
    runtime: runtimeAgents,
    localSkillCount: localSkills.length,
    marketplaceSkillCount: marketplace.length,
    all: Array.from(unique.values()),
  };
}

export function hasSkill(name) {
  const dirs = [
    path.join(WB, 'skills', name),
    path.join(WB, 'skills-marketplace', 'skills', name),
    path.join(WB, 'plugins', 'marketplaces', 'my-experts', 'plugins', name),
    path.join(WB, 'plugins', 'cache', 'my-experts', name),
    path.join(HOME, '.codebuddy', 'skills', name),
  ];
  return dirs.some((d) => fs.existsSync(d));
}

// ---------- 技能包索引：给技术方案阶段挑选「环节 → 技能包」用 ----------

const SKILL_ROOTS = [
  path.join(WB, 'skills'),
  path.join(WB, 'skills-marketplace', 'skills'),
];

// 解析 SKILL.md 顶部的 frontmatter，取 name / description（description 可能是折行的）。
function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text || ''));
  if (!m) return {};
  const out = {};
  let key = null;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (kv) {
      key = kv[1];
      out[key] = kv[2].trim();
      continue;
    }
    if (key && /^\s+\S/.test(line)) out[key] = `${out[key]} ${line.trim()}`.trim();
  }
  return out;
}

let skillCatalogCache = null;

// 技能包可能在套装目录下一层（如 promo-creator-skills/promo-music-maker），这里一并扫到。
function collectSkills(root) {
  const out = [];
  for (const id of listDirs(root)) {
    const direct = path.join(root, id, 'SKILL.md');
    if (fs.existsSync(direct)) out.push({ id, file: direct });
    // 套装目录下的子技能包也要收进来。
    const nestedRoot = path.join(root, id);
    for (const child of listDirs(nestedRoot)) {
      const nested = path.join(nestedRoot, child, 'SKILL.md');
      if (fs.existsSync(nested)) out.push({ id: child, file: nested });
    }
  }
  return out;
}

// 本机真实存在的技能包清单（含一句话说明），结果缓存。
export function skillCatalog() {
  if (skillCatalogCache) return skillCatalogCache;
  const seen = new Set();
  const out = [];
  for (const root of SKILL_ROOTS) {
    for (const { id, file } of collectSkills(root)) {
      if (seen.has(id)) continue;
      seen.add(id);
      let meta = {};
      try {
        meta = parseFrontmatter(fs.readFileSync(file, 'utf8').slice(0, 4000));
      } catch {
        meta = {};
      }
      out.push({
        id,
        name: String(meta.name || id),
        description: String(meta.description || '').replace(/\s+/g, ' ').trim(),
      });
    }
  }
  skillCatalogCache = out;
  return out;
}

// 中文友好：按字符二元组切词，不需要分词器。
function bigrams(text) {
  const clean = String(text || '')
    .toLowerCase()
    .replace(/[^\p{Script=Han}a-z0-9]+/gu, '');
  const out = new Set();
  for (let i = 0; i + 2 <= clean.length; i += 1) out.add(clean.slice(i, i + 2));
  return out;
}

let skillIndexCache = null;

function skillIndex() {
  if (skillIndexCache) return skillIndexCache;
  const items = skillCatalog();
  const df = new Map();
  const docs = items.map((s) => {
    const grams = bigrams(`${s.name} ${s.description}`);
    for (const g of grams) df.set(g, (df.get(g) || 0) + 1);
    return grams;
  });
  skillIndexCache = { items, df, docs };
  return skillIndexCache;
}

// 按需求材料给技能包打分（IDF 加权，稀有词命中更有价值），返回最相关的若干条。
export function pickSkills(text, limit = 12) {
  const query = bigrams(text);
  if (!query.size) return [];
  const { items, df, docs } = skillIndex();
  const total = items.length || 1;
  return items
    .map((s, i) => {
      let score = 0;
      for (const g of query) {
        const d = df.get(g);
        if (!d) continue;
        if (docs[i].has(g)) score += Math.log(1 + total / d);
      }
      return { ...s, score: Number(score.toFixed(3)) };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, limit);
}

export const WB_DIR = WB;
