// 需求协作台本地桥接服务：把页面接到真实智能体、真实知识库和真实产物上。
import './env.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { STAGES, stageByKey, probeWorkBuddy, workbuddyStatus, callCodeBuddy, stageAgentBinding, localStage, buildStagePrompt, buildBatchPrompt, BUILD_BATCHES, writePrototype, writeStageArtifact, writeDemoApp, writeDemoCode, writeCodeFiles, fileLooksComplete, gitInitCommit, parseCodeFiles, stripCodeBlocks } from './engine.mjs';
import { loadAgents, hasSkill } from './catalog.mjs';
import * as kb from './knowledge.mjs';
import { sinkPolicy, buildKnowledgeCard } from './sink.mjs';
import { createDoc, feishuStatus, oauthAuthorizeUrl, exchangeCode, readUser, clearUser } from './feishu.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const DATA = path.join(ROOT, 'data');
const RUNS = path.join(DATA, 'runs');
const PROTOTYPE_READS = path.join(DATA, 'prototype-reads');
const REQ_FILE = path.join(DATA, 'requirements.json');
const PORT = Number(process.env.PORT || 8788);
const HOST = process.env.HOST || '127.0.0.1';

fs.mkdirSync(RUNS, { recursive: true });
fs.mkdirSync(PROTOTYPE_READS, { recursive: true });

async function readPrototype(body) {
  const rawUrl = String(body.url || '').trim();
  const password = String(body.password || '');
  let share;
  try { share = new URL(rawUrl); } catch { throw new Error('请输入有效的 CoDesign 原型分享链接'); }
  if (share.protocol !== 'https:' || !['codesign.qq.com', 'www.codesign.qq.com'].includes(share.hostname)) {
    throw new Error('目前仅支持 CoDesign（codesign.qq.com）原型链接');
  }
  if (password.length > 256) throw new Error('原型密码长度超出限制');

  const skillDir = path.join(os.homedir(), '.workbuddy', 'skills', 'codesign-export');
  const scriptsDir = path.join(skillDir, 'scripts');
  const exportFile = path.join(scriptsDir, 'export.mjs');
  const reviewFile = path.join(scriptsDir, 'review.py');
  if (!fs.existsSync(path.join(skillDir, 'SKILL.md')) || !fs.existsSync(exportFile)) {
    throw new Error('WorkBuddy 尚未安装 codesign-export 技能');
  }
  const readId = newId();
  const outDir = path.join(PROTOTYPE_READS, readId);
  const reviewDir = path.join(outDir, 'visual-review');
  fs.mkdirSync(outDir, { recursive: true });

  const skillRequire = createRequire(path.join(scriptsDir, 'package.json'));
  const { chromium } = skillRequire('playwright');
  const { run } = await import(pathToFileURL(exportFile).href);
  const browserPath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const browserType = {
    launch: (options) => chromium.launch({
      ...options,
      executablePath: fs.existsSync(browserPath) ? browserPath : undefined,
    }),
  };
  const exported = await run({ url: rawUrl, password, out: outDir, format: 'png' }, browserType);
  const resultFile = path.join(outDir, 'export-result.json');
  fs.writeFileSync(resultFile, JSON.stringify(exported, null, 2), 'utf8');
  if (!exported.exported?.length) {
    throw new Error(exported.fatal || exported.failed?.[0]?.error || '原型没有可读取的画板');
  }

  const reviewPrep = await runBin(PYTHON3, [reviewFile, 'prepare', resultFile, reviewDir], 60_000);
  let reviewPrepResult = null;
  try { reviewPrepResult = JSON.parse(reviewPrep.stdout); } catch { /* 交给下方显式错误 */ }
  if (reviewPrep.err || !reviewPrepResult?.report || !Array.isArray(reviewPrepResult.pages)) {
    throw new Error(`原型画板已导出，但准备逐页审查失败：${reviewPrepResult?.error || reviewPrep.stderr || 'review.py prepare failed'}`);
  }

  const pages = (exported.exported || []).map((page) => ({
    pageId: page.pageId,
    name: page.name,
    href: `/data/prototype-reads/${readId}/${path.basename(page.file)}`,
    file: page.file,
  }));
  const reviewReport = JSON.parse(fs.readFileSync(reviewPrepResult.report, 'utf8'));
  const tiles = (reviewReport.pages || []).flatMap((page) => [
    { page: page.name, id: 'overview', file: page.overview },
    ...(page.tiles || []).filter((tile) => tile.file).map((tile) => ({ page: page.name, id: tile.id, file: tile.file })),
  ]);
  const prompt = [
    '请使用 WorkBuddy 技能 codesign-export，对已导出的 CoDesign 原型进行逐页内容分析。不要再次导出，也不要在任何输出中复述原型访问密码。',
    `技能说明：${path.join(skillDir, 'SKILL.md')}`,
    `输出目录：${outDir}`,
    `导出结果：${resultFile}`,
    `视觉审查记录：${path.join(reviewDir, 'review.json')}`,
    `原型标题：${exported.projectTitle || '未识别'}`,
    `画板清单：${JSON.stringify(pages.map(({ pageId, name }) => ({ pageId, name })))}`,
    `逐页审查分块（必须逐一打开和阅读，不得抽样）：${JSON.stringify(tiles)}`,
    '先阅读每页 overview，再读取该页所有非纯色 tiles。结合实际画板内容，输出结构化报告：产品目标与用户、页面/模块清单、关键字段和规则、主流程与分支、页面间跳转关系、异常/空态/权限状态、原型中不一致或缺失的信息、需求拆解时需要确认的问题。只陈述画面证据支持的结论，推测要标为推测。',
    '请把完整报告保存为输出目录下 prototype-analysis.md。完成后按 codesign-export 技能填写 visual-review/review.json 的逐页审查状态和已读分块，再运行 review.py validate；若无法完成源 iframe 对照，标记 unverified 并说明，不得伪报通过。最后返回可读的报告正文及审查结论。',
  ].join('\n\n');
  const breakdownStage = stageByKey('breakdown');
  const breakdownBinding = stageAgentBinding(breakdownStage);
  const binding = {
    ...breakdownBinding,
    maxTurns: 16,
    persona: `${breakdownBinding.persona}\n你负责调用 codesign-export 的产物，将业务原型转化为可追溯的算法需求拆解输入，必须逐页读取截图并给出证据化分析。`,
    systemPrompt: `${breakdownBinding.systemPrompt}\n只基于实际读取到的原型内容输出简体中文，不臆测未展示的功能。`,
  };
  const agent = await callCodeBuddy(prompt, binding, 900_000);
  if (!agent.ok) throw new Error(`原型已导出，但 WorkBuddy 分析失败：${agent.error}`);

  const analysis = String(agent.text || '').trim();
  if (!analysis) throw new Error('WorkBuddy 没有返回原型分析内容');
  const analysisFile = path.join(outDir, 'prototype-analysis.md');
  if (!fs.existsSync(analysisFile)) fs.writeFileSync(analysisFile, analysis, 'utf8');
  const reviewJson = path.join(reviewDir, 'review.json');
  let reviewStatus = 'unverified';
  if (fs.existsSync(reviewJson)) {
    const validation = await runBin(PYTHON3, [reviewFile, 'validate', reviewJson], 60_000);
    let validated;
    try { validated = JSON.parse(validation.stdout); } catch { validated = null; }
    if (!validation.err && Array.isArray(validated)) {
      reviewStatus = validated.every((p) => p.status === 'passed') ? 'passed' : 'issues-found';
    }
  }
  return {
    ok: true,
    readId,
    title: exported.projectTitle || 'CoDesign 原型',
    pages: pages.map(({ pageId, name, href }) => ({ pageId, name, href })),
    analysis,
    analysisHref: `/data/prototype-reads/${readId}/prototype-analysis.md`,
    reviewStatus,
    warnings: exported.warnings || [],
  };
}

// ---------- 存储 ----------

function loadReqs() {
  try {
    return JSON.parse(fs.readFileSync(REQ_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function saveReqs(list) {
  fs.writeFileSync(REQ_FILE, JSON.stringify(list, null, 2), 'utf8');
}

// 需求记录会被多个并发执行的任务改写（一条需求跑阶段时另一条可能新建/更新），
// 所以统一走这把锁：每次写入前重新读盘，只改动自己的那条，避免互相覆盖。
let reqWriteChain = Promise.resolve();

function withReqLock(fn) {
  const run = reqWriteChain.then(fn, fn);
  reqWriteChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

// 只更新指定需求：读最新列表 → 就地改这一条 → 写回。
function patchReq(id, mutate) {
  return withReqLock(() => {
    const list = loadReqs();
    const item = list.find((r) => r.id === id);
    if (!item) return null;
    mutate(item, list);
    saveReqs(list);
    return item;
  });
}

function newId() {
  return crypto.randomBytes(4).toString('hex');
}

function runDir(id) {
  const dir = path.join(RUNS, id);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readStageResult(id, stageKey) {
  try {
    return JSON.parse(fs.readFileSync(path.join(RUNS, id, `${stageKey}.json`), 'utf8'));
  } catch {
    return null;
  }
}

function writeStageResult(id, stageKey, payload) {
  runDir(id);
  fs.writeFileSync(path.join(RUNS, id, `${stageKey}.json`), JSON.stringify(payload, null, 2), 'utf8');
}

function nowIso() {
  return new Date().toISOString();
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// 阶段负责人跟随需求实际负责人：产品侧阶段沿用该需求的负责人，研发侧保留原角色。
function stageOwnerLabel(stageOwner, reqOwner) {
  if (!stageOwner) return reqOwner || '产品 A';
  if (stageOwner.indexOf('产品 A') === -1) return stageOwner;
  return stageOwner.replace('产品 A', reqOwner || '产品 A');
}

function decorate(req, withHtml) {
  const stages = STAGES.map((s) => {
    const r = readStageResult(req.id, s.key);
    const policy = sinkPolicy(s.key);
    const base = {
      key: s.key,
      name: s.name,
      owner: stageOwnerLabel(s.owner, req.owner),
      role: s.role,
      agent: s.agent,
      skills: s.skills,
      deliverable: s.deliverable,
      brief: s.brief,
      next: s.next,
      status: r?.status || '未开始',
      riskLevel: r?.riskLevel || 'low',
      risk: r?.risk || '尚未开始，暂无风险记录。',
      blindSpot: r?.blindSpot || '',
      summary: r?.summary || '',
      engine: r?.engine || null,
      generatedAt: r?.generatedAt || null,
      streaming: Boolean(r?.streaming),
      prototype: Boolean(r?.prototype),
      prototypeHref: r?.prototypeHref || null,
      artifact: r?.artifact || null,
      demoHref: r?.demoHref || null,
      demoEntry: r?.demoEntry || null,
      docUrl: r?.docUrl || null,
      deliverableDoc: r?.deliverableDoc || null,
      feishu: r?.feishu || null,
      knowledgeSink: r?.knowledgeSink || null,
      imaPush: r?.imaPush || null,
      sink: r?.sink || null,
      sinkPolicy: {
        sink: policy.sink,
        kind: policy.kind,
        label: policy.label,
        reason: policy.reason,
      },
      fallbackReason: r?.fallbackReason || null,
    };
    if (withHtml) base.html = r?.html || '';
    return base;
  });
  return {
    ...req,
    prototypeRead: req.prototypeRead || null,
    imaFolderName: req.imaFolderName || kb.requirementFolderName(req.name, req.created),
    imaFolderStatus: req.imaFolderStatus || '待定位',
    stages,
  };
}

// ---------- 阶段执行 ----------

// 阶段结论回流沉淀：按沉淀策略只把"下一条需求会复用"的部分写进知识库。
// 飞书是协作层（全量交付物），iMa 是复用层（只有模板 / 口径 / 踩坑 / 基线）。
async function sinkStageKnowledge(req, stage, result) {
  if (!result || result.status !== '已完成') return null;
  const policy = sinkPolicy(stage.key);

  // 不沉淀的阶段：明确记下原因，不再往知识库塞一次性清单或代码产物。
  if (!policy.sink) {
    return {
      skipped: true,
      kind: policy.kind,
      reason: policy.reason,
      doc: null,
      push: { ok: false, reason: policy.reason },
    };
  }

  const card = buildKnowledgeCard(req, stage, result, {
    artifactHref: result.deliverableDoc?.href || '',
    docUrl: result.docUrl || '',
  });
  const doc = kb.saveDoc(
    { title: card.title, tags: card.tags, summary: card.summary, body: card.body },
    `requirement:${req.id}/${stage.key}`
  );
  const folderName = req.imaFolderName || kb.requirementFolderName(req.name, req.created);
  const folder = await kb.findImaFolder(folderName);
  let push;
  if (folder.found) {
    push = await kb.pushToIma(doc, { folderId: folder.folderId });
  } else {
    // 公开 OpenAPI 不支持在知识库内新建文件夹。同名需求文件夹还没建好时，
    // 先把文档落到「项目文档」根目录，保证知识确实沉淀下来，再把目录名提示给用户。
    const rootPush = await kb.pushToIma(doc);
    push = Object.assign({}, rootPush, {
      folderFallback: true,
      folderName,
      rootPush: Boolean(rootPush && rootPush.ok),
      reason: rootPush && rootPush.ok
        ? `未找到同名需求文件夹「${folderName}」，本次已写入「项目文档」根目录；在 iMa 里建好同名文件夹后重新执行本阶段即可归档。`
        : (rootPush && rootPush.reason) || folder.reason || '知识沉淀失败',
    });
  }
  return {
    skipped: false,
    kind: policy.kind,
    label: policy.label,
    reason: policy.reason,
    reusableCount: card.reusableCount,
    doc: doc.title,
    folderName,
    folder,
    push,
  };
}

// 开发联调：按文件分批真实调用智能体。
// 单次网关输出约 2 万字符就会截断，一次性产出整个工程必然后半段残缺；
// 改成每批只产出一个文件、独立落盘，已经完整的文件直接复用，不重复消耗长任务。
async function runBuildBatches({ req, stage, material, appDir, onProgress }) {
  fs.mkdirSync(appDir, { recursive: true });
  const written = [];
  const reused = [];
  const batches = [];
  const log = [];
  const total = BUILD_BATCHES.length;

  const ordered = () => {
    const out = [];
    for (const b of BUILD_BATCHES) {
      for (const f of b.files) if (written.includes(f) && !out.includes(f)) out.push(f);
    }
    return out;
  };
  const doc = (note) =>
    [
      `# ${stage.name} · ${req.name}`,
      '',
      '## 一、本阶段结论',
      '',
      note,
      '',
      '## 二、分批执行记录',
      '',
      ...log,
    ].join('\n');

  for (let i = 0; i < total; i += 1) {
    const batch = BUILD_BATCHES[i];
    const no = `${i + 1}/${total}`;

    if (batch.files.every((f) => fileLooksComplete(appDir, f))) {
      reused.push(...batch.files);
      written.push(...batch.files);
      batches.push({ key: batch.key, files: batch.files, status: '复用' });
      log.push(`- 第 ${no} 批 · ${batch.key}：检测到完整文件，直接复用（${batch.files.join('、')}）`);
      continue;
    }

    let context = '';
    for (const cf of batch.context || []) {
      try {
        context += `\n===FILE: ${cf}===\n${fs.readFileSync(path.join(appDir, cf), 'utf8')}\n`;
      } catch {
        /* 上下文文件缺失时按无上下文推进 */
      }
    }

    const banner = `第 ${no} 批 · ${batch.key} · 由「${stage.agent}」智能体生成 ${batch.files.join('、')}`;
    if (typeof onProgress === 'function') onProgress(banner, false);

    const prompt = buildBatchPrompt(req, stage, material, batch, context || undefined);
    const cli = await callCodeBuddy(prompt, stageAgentBinding(stage), 900_000, (text, final) => {
      if (typeof onProgress === 'function') onProgress(`${banner}\n\n${text}`, final);
    });
    if (!cli.ok) {
      batches.push({ key: batch.key, files: batch.files, status: '失败', reason: cli.error || '调用失败' });
      log.push(`- 第 ${no} 批 · ${batch.key}：调用失败（${cli.error || '未知原因'}）`);
      return {
        ok: false,
        error: cli.error || '开发联调智能体调用失败',
        produced: ordered(),
        reused,
        batches,
        log,
        docText: doc(`本阶段未跑完：第 ${no} 批（${batch.key}）调用失败。已完成文件会在重新执行时自动复用，只重跑缺失部分。`),
      };
    }

    const parsed = parseCodeFiles(cli.text);
    const saved = writeCodeFiles(appDir, parsed, batch.files);
    if (!saved.length) {
      batches.push({ key: batch.key, files: batch.files, status: '未解析', reason: '输出未包含约定文件' });
      log.push(`- 第 ${no} 批 · ${batch.key}：输出未解析到 ${batch.files.join('、')}`);
      return {
        ok: false,
        error: `${batch.key} 批次未解析到文件`,
        produced: ordered(),
        reused,
        batches,
        log,
        docText: doc(`本阶段未跑完：第 ${no} 批（${batch.key}）输出未解析到约定文件。已完成文件会在重新执行时自动复用。`),
      };
    }
    const complete = saved.filter((f) => fileLooksComplete(appDir, f));
    written.push(...saved);
    batches.push({
      key: batch.key,
      files: saved,
      status: complete.length === saved.length ? '完成' : '不完整',
      chars: cli.text.length,
    });
    log.push(`- 第 ${no} 批 · ${batch.key}：生成 ${saved.join('、')}（输出 ${cli.text.length} 字符）`);
  }

  const produced = ordered();
  const docText = doc(
    [
      `1. 由「${stage.agent}」智能体按文件分批真实生成，共 ${total} 批，产出文件：${produced.join('、')}。`,
      `2. 本次直接复用已完成文件：${reused.length ? reused.join('、') : '无'}。`,
      '3. 每批独立调用、独立落盘，规避单次输出上限造成的代码截断。',
    ].join('\n')
  );
  return { ok: true, error: '', produced, reused, batches, log, docText };
}

async function runStage(reqId, stageKey, extraMaterial) {
  const list = loadReqs();
  const req = list.find((r) => r.id === reqId);
  if (!req) throw new Error('需求不存在');
  const stage = stageByKey(stageKey);
  if (!stage) throw new Error('阶段不存在');

  req.imaFolderName = req.imaFolderName || kb.requirementFolderName(req.name, req.created);
  req.imaFolderStatus = '待定位';

  writeStageResult(reqId, stageKey, {
    status: '进行中',
    engine: workbuddyStatus().authed ? 'workbuddy' : 'local-deterministic',
    generatedAt: nowIso(),
    summary: '正在执行…',
    html: '<div class="doc-block"><h3>正在执行</h3><p>智能体正在基于当前材料产出本阶段交付物。</p></div>',
  });

  let material = extraMaterial
    ? `${req.material || ''}\n\n【补充材料】\n${extraMaterial}`
    : req.material || '';
  // 开发联调要照着技术方案落地：只给原始材料，智能体容易产出与方案脱节的代码。
  if (stageKey === 'build') {
    try {
      const techDoc = fs.readFileSync(path.join(runDir(reqId), 'tech.md'), 'utf8').slice(0, 3600);
      material = `${String(req.material || '').slice(0, 4400)}\n\n【技术方案阶段结论（开发依据，请据此实现）】\n${techDoc}`;
    } catch {
      /* 技术方案缺失时按原始材料推进 */
    }
  }

  const kbRes = await kb.search(`${req.name} ${material}`.slice(0, 400), 4);
  req.knowledgeHits = kbRes.hits.map((h) => ({ title: h.title, score: h.score, source: h.source }));

  const status = await probeWorkBuddy();
  let result;
  let buildOutcome = null;
  if (status.authed) {
    const startedAt = Date.now();
    let lastProgressAt = 0;
    // 流式进度：把智能体的中间输出边跑边写进阶段记录，页面轮询即可看到真实输出过程。
    const writeStreaming = (text) => {
      writeStageResult(reqId, stageKey, {
        status: '进行中',
        engine: 'workbuddy',
        generatedAt: new Date(startedAt).toISOString(),
        streaming: true,
        summary: '智能体正在输出…',
        html:
          `<div class="doc-block"><h3>${stage.name} · 智能体实时输出</h3>` +
          '<p class="stream-note">正在实时生成，完成后自动回填交付物。</p>' +
          (text
            ? `<p style="white-space:pre-wrap">${escapeHtml(text)}</p>`
            : '<p class="stream-note">已把材料交给智能体，正在等待第一段输出…</p>') +
          '</div>',
      });
    };
    // 先落一版占位，保证页面一进来就能看到"正在跑"，不必等第一段增量。
    writeStreaming('');
    const onProgress = (text, final) => {
      if (final) return;
      const now = Date.now();
      if (now - lastProgressAt < 700) return;
      lastProgressAt = now;
      writeStreaming(text);
    };
    if (stageKey === 'build') {
      // 开发联调要真实产出完整工程，单次调用必被截断，改走按文件分批。
      buildOutcome = await runBuildBatches({
        req,
        stage,
        material,
        appDir: path.join(runDir(reqId), 'build', 'app'),
        onProgress,
      });
      result = buildOutcome.ok
        ? {
            status: '已完成',
            engine: 'workbuddy',
            generatedAt: nowIso(),
            modelText: buildOutcome.docText,
            summary: `${stage.name}：由「${stage.agent}」智能体分批真实生成 ${buildOutcome.produced.length} 个工程文件（${buildOutcome.produced.join('、')}）。`,
            riskLevel: 'low',
            risk: '由 WorkBuddy 智能体产出，请人工复核结论。',
            blindSpot: '智能体输出需要业务复核后再生效。',
            html: `<div class="doc-block"><h3>${stage.name} · 智能体输出</h3><p style="white-space:pre-wrap">${escapeHtml(buildOutcome.docText)}</p></div>`,
            codeFiles: buildOutcome.produced,
            buildBatches: buildOutcome.batches,
          }
        : {
            status: '进行中',
            engine: 'workbuddy',
            generatedAt: nowIso(),
            partial: true,
            modelText: buildOutcome.docText,
            summary: `开发联调未跑完：${buildOutcome.error}。已产出 ${buildOutcome.produced.length} 个文件，重新执行本阶段会从已完成文件继续。`,
            riskLevel: 'medium',
            risk: buildOutcome.error,
            blindSpot: '分批生成支持断点续跑：完整文件直接复用，只重跑缺失部分。',
            html: `<div class="doc-block"><h3>${stage.name} · 分批生成记录</h3><p style="white-space:pre-wrap">${escapeHtml(buildOutcome.docText)}</p></div>`,
            codeFiles: buildOutcome.produced,
            buildBatches: buildOutcome.batches,
          };
    } else {
      const prompt = buildStagePrompt(req, stage, material, kbRes.hits);
      const cli = await callCodeBuddy(prompt, stageAgentBinding(stage), 300_000, onProgress);
      result = cli.ok
        ? {
            status: '已完成',
            engine: 'workbuddy',
            generatedAt: nowIso(),
            modelText: cli.text,
            summary: cli.text.slice(0, 220),
            riskLevel: 'low',
            risk: '由 WorkBuddy 智能体产出，请人工复核结论。',
            blindSpot: '智能体输出需要业务复核后再生效。',
            html: `<div class="doc-block"><h3>${stage.name} · 智能体输出</h3><p style="white-space:pre-wrap">${escapeHtml(cli.text)}</p></div>`,
          }
        : { ...localStage(req, stageKey, material), engine: 'local-deterministic', fallbackReason: cli.error };
    }
  } else {
    result = { ...localStage(req, stageKey, material), fallbackReason: status.reason };
  }

  // 开发联调：从智能体输出里抽出真实代码文件，文档部分去掉代码块（代码单独落盘）。
  if (stageKey === 'build' && result.modelText) {
    const files = parseCodeFiles(result.modelText);
    if (files.length) {
      const cleaned = stripCodeBlocks(result.modelText) || `${stage.name}：代码已生成，见下方工程目录。`;
      result.summary = cleaned.slice(0, 220);
      result.html = `<div class="doc-block"><h3>${stage.name} · 智能体输出</h3><p style="white-space:pre-wrap">${escapeHtml(cleaned)}</p></div>`;
      result.codeFiles = files.map((f) => f.path);
    }
  }

  const rdir = runDir(reqId);

  // 每个阶段都真实落盘一份交付物文档，供页面查看 / 下载 / 写飞书。
  const art = writeStageArtifact(rdir, req, stage, result);
  result.deliverableDoc = { name: art.name, rel: art.rel, href: `/runs/${reqId}/${art.rel}` };
  result.artifact = result.deliverableDoc;

  // 开发联调额外产出：可运行原型页 + 可运行 Demo 工程目录。
  if (stageKey === 'build') {
    const file = writePrototype(rdir, req);
    result.prototypeFile = file;
    result.prototypeHref = `/runs/${reqId}/build/prototype.html`;

    result.demoDir = path.join(rdir, 'build', 'app');
    result.demoHref = `/runs/${reqId}/build/app/`;
    result.demoEntry = `/runs/${reqId}/build/app/index.html`;

    if (buildOutcome) {
      // 分批路径已经把文件写在目标目录里，这里只登记结果，不能再整目录清空。
      result.demoCodeFiles = buildOutcome.produced;
      result.demoCodeSource = 'agent';
    } else {
      // 优先落盘智能体真写的代码；没解析到代码时才回退模板工程。
      const code = result.engine === 'workbuddy' && result.modelText ? writeDemoCode(rdir, req, result.modelText) : null;
      if (!code) writeDemoApp(rdir, req);
      result.demoCodeFiles = code ? code.files : null;
      result.demoCodeSource = code ? 'agent' : 'template';
    }

    const git = gitInitCommit(result.demoDir, req);
    result.demoGit = git;
  }

  // 交付物写入飞书在线文档（配置了凭证才真实创建，否则返回明确状态）。
  result.feishu = await createDoc({
    title: `${req.name} · ${stage.name}`,
    body: fs.readFileSync(art.file, 'utf8'),
  });
  if (result.feishu && result.feishu.ok && result.feishu.url) result.docUrl = result.feishu.url;

  const sink = await sinkStageKnowledge(req, stage, result);
  if (sink) {
    result.sink = sink;
    result.knowledgeSink = sink.skipped ? null : sink.doc;
    result.imaPush = sink.push;
    if (sink.folder) {
      req.imaFolderStatus = sink.folder.found
        ? '已归档到需求文件夹'
        : sink.push && sink.push.folderFallback && sink.push.ok
          ? '已写入项目文档根目录'
          : '待在 iMa 创建';
    }
  }
  writeStageResult(reqId, stageKey, result);

  const done = STAGES.filter((s) => readStageResult(reqId, s.key)?.status === '已完成').length;
  const firstOpen = STAGES.findIndex((s) => readStageResult(reqId, s.key)?.status !== '已完成');
  await patchReq(reqId, (item) => {
    item.updated = nowIso().slice(0, 16).replace('T', ' ');
    item.stageIndex = firstOpen < 0 ? 6 : firstOpen;
    item.progress = done;
    item.riskTone = result.riskLevel === 'medium' ? '中风险' : '低风险';
    if (req.knowledgeHits) item.knowledgeHits = req.knowledgeHits;
    if (req.imaFolderStatus) item.imaFolderStatus = req.imaFolderStatus;
  });
  return result;
}

// ---------- HTTP ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.md': 'text/markdown; charset=utf-8',
};

function sendJson(res, code, body) {
  const text = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'cache-control': 'no-store',
  });
  res.end(text);
}

function sendHtml(res, code, html) {
  res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(html);
}

function oauthResultPage(ok, message) {
  const color = ok ? '#3f9d5a' : '#d7441d';
  const title = ok ? '授权成功' : '授权未完成';
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{margin:0;font-family:-apple-system,"PingFang SC",sans-serif;background:#fbf7f3;color:#2b2724}
.box{max-width:520px;margin:14vh auto;background:#fff;border:1px solid #f0e2d6;border-radius:12px;padding:28px 26px}
h1{font-size:20px;margin:0 0 10px;color:${color}}p{color:#6b625b;line-height:1.7;margin:0}</style></head>
<body><div class="box"><h1>${title}</h1><p>${escapeHtml(message || '')}</p>
<p style="margin-top:14px">可以关闭本页，回到需求协作台继续操作。</p></div></body></html>`;
}

function sendFile(res, file) {
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    sendJson(res, 404, { error: 'not found', file });
    return;
  }
  res.writeHead(200, {
    'content-type': MIME[path.extname(file)] || 'application/octet-stream',
    'access-control-allow-origin': '*',
    'cache-control': 'no-store',
  });
  fs.createReadStream(file).pipe(res);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve({ text: data });
      }
    });
  });
}

// ---------- 需求材料解析 ----------
// 业务方提交的材料不止文本：原型是 PDF、需求说明可能是 docx、评审会是录音。
// 上传后先解析成正文再进材料池，避免智能体只看到一个文件名。

function firstBin(paths) {
  for (const p of paths) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* 忽略 */
    }
  }
  return '';
}

const PDFTOTEXT = firstBin(['/opt/homebrew/bin/pdftotext', '/usr/local/bin/pdftotext', '/usr/bin/pdftotext']);
const PYTHON3 = firstBin(['/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3']);

const TEXT_EXT_RE = /\.(txt|md|markdown|csv|tsv|json|log|srt|vtt)$/i;
const AUDIO_EXT_RE = /\.(mp3|wav|m4a|aac|flac|amr|ogg|wma|opus)$/i;
const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|bmp|heic)$/i;

function runBin(bin, args, timeout = 30_000) {
  return new Promise((resolve) => {
    execFile(bin, args, { maxBuffer: 32 * 1024 * 1024, timeout }, (err, stdout, stderr) => {
      resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

async function extractPdf(buf) {
  if (!PDFTOTEXT) return { ok: false, reason: '本机没有安装 pdftotext，暂时无法解析 PDF' };
  const tmp = path.join(os.tmpdir(), `cockpit-pdf-${crypto.randomBytes(6).toString('hex')}.pdf`);
  try {
    fs.writeFileSync(tmp, buf);
    const r = await runBin(PDFTOTEXT, ['-layout', '-enc', 'UTF-8', tmp, '-']);
    if (r.err && !r.stdout.trim()) return { ok: false, reason: `PDF 解析失败：${r.stderr.trim().slice(0, 120)}` };
    const text = r.stdout.trim();
    if (!text) return { ok: false, reason: 'PDF 里没有可提取的文字层，可能是扫描件' };
    return { ok: true, text };
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* 临时文件已被清理 */
    }
  }
}

async function extractDocx(buf) {
  if (!PYTHON3) return { ok: false, reason: '本机没有 python3，暂时无法解析 docx' };
  const tmp = path.join(os.tmpdir(), `cockpit-docx-${crypto.randomBytes(6).toString('hex')}.docx`);
  const script = [
    'import sys, zipfile, re',
    "d = zipfile.ZipFile(sys.argv[1]).read('word/document.xml').decode('utf-8')",
    "d = re.sub(r'</w:p>', '\\n', d)",
    "d = re.sub(r'<w:tab[^>]*/>', '\\t', d)",
    "print(re.sub(r'<[^>]+>', '', d))",
  ].join('\n');
  try {
    fs.writeFileSync(tmp, buf);
    const r = await runBin(PYTHON3, ['-c', script, tmp]);
    const text = r.stdout.trim();
    if (!text) return { ok: false, reason: 'docx 内容为空或无法读取' };
    return { ok: true, text };
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* 临时文件已被清理 */
    }
  }
}

async function extractMaterial(name, buf) {
  const ext = (String(name).match(/\.[^.]+$/) || [''])[0].toLowerCase();
  if (TEXT_EXT_RE.test(name) || !ext) {
    return { ok: true, kind: 'text', text: buf.toString('utf8') };
  }
  if (ext === '.pdf') {
    const r = await extractPdf(buf);
    return r.ok ? { ok: true, kind: 'pdf', text: r.text } : { ok: false, kind: 'pdf', reason: r.reason };
  }
  if (ext === '.docx') {
    const r = await extractDocx(buf);
    return r.ok ? { ok: true, kind: 'docx', text: r.text } : { ok: false, kind: 'docx', reason: r.reason };
  }
  if (AUDIO_EXT_RE.test(name)) {
    return {
      ok: false,
      kind: 'audio',
      reason: '录音文件已收到。当前环境没有配置本地语音转写，请同时提供录音转写文本或摘要。',
    };
  }
  if (IMAGE_EXT_RE.test(name)) {
    return { ok: false, kind: 'image', reason: '图片已附为附件，正文信息请用文字补充。' };
  }
  return { ok: false, kind: 'binary', reason: `暂不支持解析 ${ext || '该'} 格式，已作为附件记录。` };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'content-type',
    });
    return res.end();
  }

  try {
    if (p === '/api/health') {
      // 健康检查也刷新过期的 WorkBuddy 探活结果，避免登录后页面仍显示启动时缓存。
      await probeWorkBuddy();
      return sendJson(res, 200, {
        ok: true,
        service: '需求协作台桥接服务',
        time: nowIso(),
        engine: workbuddyStatus(),
        knowledge: kb.imaStatus(),
        feishu: feishuStatus(),
      });
    }

    // 真实读取 CoDesign 原型：导出画板后交给 WorkBuddy 做逐页分析。
    if (p === '/api/prototype/read' && req.method === 'POST') {
      const body = await readBody(req);
      const result = await readPrototype(body);
      return sendJson(res, 200, result);
    }

    // 飞书用户授权：让文档以「你本人」身份创建、落进你的云空间。
    if (p === '/api/feishu/oauth/start') {
      const redirectUri = `http://${req.headers.host}/api/feishu/oauth/callback`;
      const { url, state } = oauthAuthorizeUrl(redirectUri);
      return sendJson(res, 200, { url, redirectUri, state });
    }

    if (p === '/api/feishu/oauth/callback') {
      const code = url.searchParams.get('code') || '';
      const err = url.searchParams.get('error') || '';
      if (err || !code) {
        return sendHtml(res, 400, oauthResultPage(false, err ? `授权被拒绝或出错：${err}` : '回调缺少 code'));
      }
      const redirectUri = `http://${req.headers.host}/api/feishu/oauth/callback`;
      const r = await exchangeCode(code, redirectUri);
      return sendHtml(res, r.ok ? 200 : 400, oauthResultPage(r.ok, r.ok ? `授权成功，当前身份：${r.user.name || r.user.openId}` : r.reason));
    }

    if (p === '/api/feishu/logout' && req.method === 'POST') {
      clearUser();
      return sendJson(res, 200, { ok: true, feishu: feishuStatus() });
    }

    if (p === '/api/agents') {
      const status = await probeWorkBuddy();
      const agents = loadAgents();
      return sendJson(res, 200, {
        engine: status,
        catalogFile: agents.catalogFile,
        runtime: agents.runtime,
        skillCounts: {
          local: agents.localSkillCount,
          marketplace: agents.marketplaceSkillCount,
        },
        stages: STAGES.map((s) => ({
          key: s.key,
          name: s.name,
          agent: s.agent,
          agentId: s.agentId,
          skills: s.skills.map((k) => ({ name: k, installed: hasSkill(k) })),
        })),
      });
    }

    // 在系统里打开某个运行产物（文件夹 / 文件），仅限本机运行目录内。
    if (p === '/api/open' && req.method === 'POST') {
      const body = await readBody(req);
      const rel = String(body.path || '');
      const base = body.base === 'data' ? DATA : RUNS;
      const target = path.resolve(base, rel);
      if (!target.startsWith(base) || !fs.existsSync(target)) {
        return sendJson(res, 404, { error: '路径不存在或不允许打开', path: rel });
      }
      if (process.platform !== 'darwin') {
        return sendJson(res, 200, { ok: false, reason: `当前系统不支持自动打开：${process.platform}`, target });
      }
      spawn('open', [target], { detached: true, stdio: 'ignore' }).unref();
      return sendJson(res, 200, { ok: true, opened: target, rel });
    }

    if (p === '/api/knowledge' && req.method === 'GET') {
      const q = url.searchParams.get('q') || '';
      if (q) {
        const r = await kb.search(q, 8);
        return sendJson(res, 200, { query: q, hits: r.hits, ima: r.ima });
      }
      return sendJson(res, 200, { docs: kb.listDocs(), ima: kb.imaStatus() });
    }

    if (p === '/api/knowledge' && req.method === 'POST') {
      const body = await readBody(req);
      const doc = kb.saveDoc(
        {
          title: body.title || '未命名知识',
          tags: body.tags || [],
          summary: body.summary || '',
          body: body.body || '',
        },
        body.origin || 'dashboard'
      );
      const pushed = await kb.pushToIma(doc);
      return sendJson(res, 200, { doc, push: pushed });
    }

    // 上传的需求材料（原型 PDF / 需求 docx / 录音等）先解析成正文再进材料池。
    if (p === '/api/extract' && req.method === 'POST') {
      const body = await readBody(req);
      const name = String(body.name || '材料');
      let buf = Buffer.alloc(0);
      try {
        buf = Buffer.from(String(body.data || ''), 'base64');
      } catch {
        buf = Buffer.alloc(0);
      }
      if (!buf.length) return sendJson(res, 400, { ok: false, name, reason: '文件内容为空' });
      const r = await extractMaterial(name, buf);
      return sendJson(res, 200, { name, size: buf.length, ...r });
    }

    if (p === '/api/requirements' && req.method === 'GET') {
      return sendJson(res, 200, { requirements: loadReqs().map((r) => decorate(r, false)) });
    }

    if (p === '/api/requirements' && req.method === 'POST') {
      const body = await readBody(req);
      const item = {
        id: newId(),
        name: body.name || '未命名需求',
        client: body.client || '内部',
        owner: body.owner || '产品 A',
        material: body.material || '',
        prototypeRead: body.prototypeRead ? {
          id: String(body.prototypeRead.id || ''),
          analysisHref: String(body.prototypeRead.analysisHref || ''),
          reviewStatus: String(body.prototypeRead.reviewStatus || 'unverified'),
          pages: Array.isArray(body.prototypeRead.pages) ? body.prototypeRead.pages.map((p) => ({
            name: String(p.name || ''),
            href: String(p.href || ''),
          })) : [],
        } : null,
        stageIndex: 0,
        progress: 0,
        riskTone: '低风险',
        created: nowIso(),
        updated: nowIso().slice(0, 16).replace('T', ' '),
        imaFolderName: kb.requirementFolderName(body.name || '未命名需求'),
        imaFolderStatus: '待在 iMa 创建',
      };
      await withReqLock(() => {
        const list = loadReqs();
        list.unshift(item);
        saveReqs(list);
      });
      return sendJson(res, 201, { requirement: decorate(item, true) });
    }

    const mReq = p.match(/^\/api\/requirements\/([^/]+)$/);
    if (mReq && req.method === 'GET') {
      const item = loadReqs().find((r) => r.id === mReq[1]);
      if (!item) return sendJson(res, 404, { error: '需求不存在' });
      return sendJson(res, 200, { requirement: decorate(item, true) });
    }

    const mMaterials = p.match(/^\/api\/requirements\/([^/]+)\/materials$/);
    if (mMaterials && req.method === 'POST') {
      const body = await readBody(req);
      const addition = body.text || body.material || '';
      const item = await patchReq(mMaterials[1], (target) => {
        target.material = `${target.material || ''}\n\n【补充材料 ${new Date().toLocaleString('zh-CN')}】\n${addition}`;
        target.updated = nowIso().slice(0, 16).replace('T', ' ');
        target.lastSupplement = addition;
      });
      if (!item) return sendJson(res, 404, { error: '需求不存在' });
      const kbDoc = kb.saveDoc(
        {
          title: `${item.name} · 补充材料`,
          tags: ['补充材料', item.client],
          summary: addition.slice(0, 80),
          body: addition,
        },
        `requirement:${item.id}`
      );
      const push = await kb.pushToIma(kbDoc);
      return sendJson(res, 200, {
        requirement: decorate(item, true),
        knowledge: kbDoc,
        push,
        impact: {
          affectedStages: STAGES.map((s) => s.name),
          note: push.ok
            ? '补充材料已写入需求记录，并同步沉淀到知识库，相关阶段可重新执行。'
            : '补充材料已写入需求记录并沉淀到本机知识库，相关阶段可重新执行。',
        },
      });
    }

    const mRun = p.match(/^\/api\/requirements\/([^/]+)\/stages\/([^/]+)\/run$/);
    if (mRun && req.method === 'POST') {
      const body = await readBody(req);
      const result = await runStage(mRun[1], mRun[2], body.material);
      const item = loadReqs().find((r) => r.id === mRun[1]);
      return sendJson(res, 200, { result, requirement: item ? decorate(item, true) : null });
    }

    const mRunAll = p.match(/^\/api\/requirements\/([^/]+)\/run-all$/);
    if (mRunAll && req.method === 'POST') {
      const id = mRunAll[1];
      for (const s of STAGES) {
        await runStage(id, s.key);
      }
      const item = loadReqs().find((r) => r.id === id);
      return sendJson(res, 200, { requirement: item ? decorate(item, true) : null });
    }

    if (p.startsWith('/runs/')) {
      const rel = p.replace(/^\/runs\//, '');
      const file = path.join(RUNS, rel);
      if (!file.startsWith(RUNS)) return sendJson(res, 403, { error: 'forbidden' });
      return sendFile(res, file);
    }

    if (p.startsWith('/data/')) {
      const rel = p.replace(/^\/data\//, '');
      const file = path.join(DATA, rel);
      if (!file.startsWith(DATA)) return sendJson(res, 403, { error: 'forbidden' });
      return sendFile(res, file);
    }

    // 静态页面
    const page = p === '/' ? 'index.html' : p.replace(/^\//, '');
    const file = path.join(ROOT, page);
    if (!file.startsWith(ROOT)) return sendJson(res, 403, { error: 'forbidden' });
    return sendFile(res, file);
  } catch (err) {
    return sendJson(res, 500, { error: String(err && err.message ? err.message : err) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[需求协作台] 桥接服务已启动 http://${HOST}:${PORT}`);
  console.log(`[需求协作台] 页面地址     http://${HOST}:${PORT}/index.html`);
  probeWorkBuddy(true).then((s) => {
    console.log(
      s.authed
        ? '[需求协作台] 智能体通道：WorkBuddy 已登录，将真实调用'
        : `[需求协作台] 智能体通道：本地推演兜底（${s.reason}）`
    );
  });
});
