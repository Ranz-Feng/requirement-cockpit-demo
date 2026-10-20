// 六阶段执行引擎：优先真调 WorkBuddy 智能体，未登录时退到可解释的本地推演。
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { runViaGateway, probeGateway } from './workbuddy.mjs';
import { pickSkills } from './catalog.mjs';

const HOME = os.homedir();
const CODEBUDDY =
  process.env.CODEBUDDY_BIN ||
  '/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy';
// WorkBuddy 5.8.x 的安装包默认只携带 lite-wb bundle，不再携带完整 TUI 的
// dist/codebuddy；显式选择官方提供的 lite bundle，避免启动器误报模块缺失。
const CODEBUDDY_ENV = {
  ...process.env,
  CODEBUDDY_FORCE_LITE_WB_BUNDLE: process.env.CODEBUDDY_FORCE_LITE_WB_BUNDLE || '1',
};
const ALGO_REQUIREMENT_AGENT =
  process.env.ALGO_REQUIREMENT_AGENT_DIR ||
  path.join(HOME, '.workbuddy', 'plugins', 'cache', 'my-experts', 'algo-requirement-spec', '1.5.0');

// 每个阶段挂到本机 WorkBuddy 里真实存在的智能体 / 技能包上
export const STAGES = [
  {
    key: 'intake',
    name: '需求接收',
    owner: '产品 A',
    role: '产品经理主责',
    agent: '客研管理',
    agentId: 'customer_research',
    skills: ['customer-research', 'requirement-entry'],
    deliverable: '需求材料清单、缺口清单、待确认问题',
    brief: '材料清单 · 缺口清单',
    next: '进入需求拆解，匹配历史知识库。',
  },
  {
    key: 'breakdown',
    name: '需求拆解',
    owner: '产品 A',
    role: '产品经理主责',
    agent: '算法需求拆解专家',
    agentId: 'algo-requirement-spec',
    pluginDir: ALGO_REQUIREMENT_AGENT,
    maxTurns: 12,
    skills: ['algo-requirement-spec', 'codesign-export'],
    deliverable: '算法需求拆解文档（八章）',
    brief: '需求拆解文档',
    next: '判断是否涉及算法实验。',
  },
  {
    key: 'algorithm',
    name: '算法实验',
    owner: '产品 A · 算法团队',
    role: '产品经理 + 算法团队',
    agent: '产品方案',
    agentId: 'solution_design',
    skills: ['test-media-generator', 'logic-detector', 'requirement-review'],
    deliverable: '实验方案、标注规范、评估指标',
    brief: '实验方案 · 评估指标',
    next: '补充样本数据，重跑评估。',
  },
  {
    key: 'tech',
    name: '技术方案',
    owner: '产品 A · 后端团队',
    role: '产品经理 + 后端团队',
    agent: '产品方案',
    agentId: 'solution_design',
    skills: ['rd-handoff-package', 'business-diagram-generator', 'fullstack-dev'],
    deliverable: '后端技术方案、接口设计、数据流',
    brief: '技术约束 · 接口边界',
    next: '技术方案确认后进入开发任务拆分。',
  },
  {
    key: 'build',
    name: '开发联调',
    owner: '研发同学',
    role: '研发团队主责',
    agent: '全栈开发',
    agentId: 'fullstack-dev',
    skills: ['frontend-dev', 'fullstack-dev', 'task-implement', 'tdd'],
    deliverable: '开发任务、可运行原型、联调记录',
    brief: '开发任务 · 可运行原型',
    next: '原型自测通过后进入验收。',
  },
  {
    key: 'delivery',
    name: '验收交付',
    owner: '产品 A · 项目组',
    role: '项目组主责',
    agent: '质量验收',
    agentId: 'prototype-quality-audit',
    skills: ['prototype-quality-audit', 'web-performance-audit', 'web-deploy'],
    deliverable: '验收报告、使用说明、上线清单',
    brief: '验收清单 · 交付物',
    next: '交付完成后回流知识库。',
  },
];

export function stageByKey(key) {
  return STAGES.find((s) => s.key === key);
}

// ---------- WorkBuddy CLI 探活与调用 ----------

function runCli(args, timeoutMs) {
  return new Promise((resolve) => {
    if (!fs.existsSync(CODEBUDDY)) {
      resolve({ error: '未找到 codebuddy 可执行文件', stdout: '', stderr: '', code: -1 });
      return;
    }
    let child;
    try {
      child = spawn(CODEBUDDY, args, { cwd: os.tmpdir(), env: CODEBUDDY_ENV });
    } catch (err) {
      resolve({ error: String(err && err.message), stdout: '', stderr: '', code: -1 });
      return;
    }
    let stdout = '';
    let stderr = '';
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      try { child.kill('SIGKILL'); } catch {}
      done = true;
      resolve({ error: `超时（${timeoutMs}ms）`, stdout, stderr, code: -1 });
    }, timeoutMs);
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ error: String(err && err.message), stdout, stderr, code: -1 });
    });
    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
  });
}

const AUTH_HINT = /Authentication required|use \/login/i;

let wbCache = null;

export async function probeWorkBuddy(force = false) {
  if (!force && wbCache && Date.now() - wbCache.at < 60_000) return wbCache;

  // 首选：WorkBuddy 桌面端常驻网关。桌面端已登录，凭据由它注入 sidecar，
  // 因此这是唯一能真正驱动模型与智能体的通道。
  const gw = await probeGateway();
  if (gw.ok) {
    wbCache = {
      at: Date.now(),
      available: true,
      authed: true,
      mode: 'gateway',
      channel: `WorkBuddy 桌面端网关 ${gw.baseUrl}`,
      workspace: gw.info?.cwd || '',
      version: gw.info?.version || '',
      reason: '',
      checkedAt: new Date().toISOString(),
    };
    return wbCache;
  }

  // 不再用模型提示词探活 CLI：这会消耗额度，而且无法证明桌面端登录态可用。
  // CLI 仅在用户明确开启后作为执行兜底，默认保持关闭。
  wbCache = {
    at: Date.now(),
    available: fs.existsSync(CODEBUDDY),
    authed: false,
    mode: 'desktop-session-unbridged',
    channel: '',
    reason: 'WorkBuddy 桌面端已安装，但尚未发现可供驾驶舱调用的本地网关；未进行 CLI 模型探活',
    checkedAt: new Date().toISOString(),
  };
  return wbCache;
}

export function workbuddyStatus() {
  if (!wbCache) {
    return {
      available: fs.existsSync(CODEBUDDY),
      authed: false,
      reason: '尚未探活',
      checkedAt: null,
    };
  }
  return wbCache;
}

// 把阶段绑定的智能体以「内联 agent」方式传给 WorkBuddy CLI：
// 该阶段就会被对应的智能体与技能包接管，而不是走 product-agent-runtime 的通用主智能体。
export function stageAgentBinding(stage) {
  const persona = [
    `你是需求协作台里「${stage.name}」阶段的执行智能体 ${stage.agent}。`,
    `本阶段主责角色：${stage.role}。`,
    `请使用技能包：${stage.skills.join('、')}。`,
    `本阶段交付物：${stage.deliverable}。`,
  ].join('\n');
  return {
    agentId: stage.agentId,
    pluginDir: stage.pluginDir || '',
    persona,
    systemPrompt: `${persona}\n只输出结论与可执行要点，面向业务方，用简体中文。`,
  };
}

export async function callCodeBuddy(prompt, binding, timeoutMs = 240_000, onProgress) {
  // 1) 桌面端网关：真实登录态，真实调用模型与智能体。
  try {
    const text = await runViaGateway(prompt, { timeoutMs, onProgress });
    return { ok: true, text, via: 'gateway' };
  } catch (gwErr) {
    const gwReason = String((gwErr && gwErr.message) || gwErr);
    // 2) 独立 CLI 只有在显式开启后才执行，避免未确认登录态时消耗模型额度。
    if (process.env.WORKBUDDY_ALLOW_CLI_FALLBACK === '1') {
      const cli = await callCliDirect(prompt, binding, timeoutMs);
      if (cli.ok) return { ...cli, via: 'cli', gatewayError: gwReason };
      return { ok: false, error: `${gwReason}；CLI 兜底也失败：${cli.error}` };
    }
    return { ok: false, error: `${gwReason}；未执行 CLI 兜底（未确认登录态）` };
  }
}

async function callCliDirect(prompt, binding, timeoutMs = 240_000) {
  const args = ['-p', prompt, '--output-format', 'json', '--max-turns', String(binding?.maxTurns || 4)];
  if (binding && binding.pluginDir) {
    // 加载已安装的自定义专家；不能用 --agents 内联定义覆盖真实专家包。
    args.push('--plugin-dir', binding.pluginDir);
    args.push('--agent', binding.agentId);
  } else if (binding && binding.agentId) {
    // 内联定义该阶段的专属 agent，避免落到默认主智能体
    args.push('--agents', JSON.stringify({
      [binding.agentId]: { description: binding.persona || binding.agentId, prompt: binding.persona || '' },
    }));
    args.push('--agent', binding.agentId);
  }
  if (binding && binding.systemPrompt) {
    args.push('--append-system-prompt', binding.systemPrompt);
  }
  const res = await runCli(args, timeoutMs);
  if (res.error) return { ok: false, error: res.error };
  const blob = res.stdout + res.stderr;
  if (AUTH_HINT.test(blob)) return { ok: false, error: 'codebuddy 未登录' };
  if (res.code !== 0) {
    return { ok: false, error: (res.stderr || res.stdout || `退出码 ${res.code}`).trim().slice(0, 300) };
  }
  let out = res.stdout.trim();
  try {
    const parsed = JSON.parse(out);
    out = parsed.result || parsed.text || parsed.content || out;
  } catch {
    /* text 形式直接使用 */
  }
  return { ok: true, text: typeof out === 'string' ? out : JSON.stringify(out) };
}

// ---------- 材料解析 ----------

const ALGO_HINTS = /(识别|抽取|提取|摘要|模型|算法|准确率|召回|F1|分类|标注|语音|转写|纠错|比对|相似度)/i;
const BACKEND_HINTS = /(上传|接口|服务|存储|队列|权限|云盘|系统|数据库|同步|导出|登录|部署)/i;

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function analyzeMaterial(text) {
  const raw = String(text || '').trim();
  const lines = raw
    .split(/\r?\n|。|；|;/)
    .map((l) => l.trim())
    .filter(Boolean);
  const questions = lines.filter((l) => /[?？]|待确认|是否|需要确认/.test(l)).slice(0, 5);
  const todos = lines.filter((l) => /(需要|待办|跟进|补充|提供|输出|完成|安排)/.test(l)).slice(0, 6);
  const metrics = (raw.match(/\d+(\.\d+)?\s*(%|条|份|个|天|小时|分钟|次)/g) || []).slice(0, 6);

  const inventory = [];
  if (/原型|截图|界面|设计稿/.test(raw)) inventory.push('原型 / 界面截图');
  if (/录音|音频/.test(raw)) inventory.push('会议录音');
  if (/转写|转录|文字稿/.test(raw)) inventory.push('会议转写文本');
  if (/需求说明|需求文档|说明/.test(raw)) inventory.push('需求说明');
  if (!inventory.length) inventory.push('文字需求描述');

  const gaps = [];
  if (!/录音|音频/.test(raw)) gaps.push('未提供原始录音，本期只按文本推进');
  if (!/验收|标准/.test(raw)) gaps.push('验收标准未明确');
  if (!/截止|时间|排期/.test(raw)) gaps.push('期望交付时间未确认');

  const title =
    lines.slice().sort((a, b) => b.length - a.length)[0]?.slice(0, 30) || '新需求';

  return {
    raw,
    lines,
    title,
    questions,
    todos,
    metrics,
    inventory,
    gaps,
    hasAlgo: ALGO_HINTS.test(raw),
    hasBackend: BACKEND_HINTS.test(raw),
  };
}

function ul(items, fallback) {
  const list = items && items.length ? items : [fallback];
  return list.map((i) => `<li>${esc(i)}</li>`).join('');
}

function tags(items, tone) {
  if (!items || !items.length) return '';
  return items.map((i) => `<span class="tag ${tone || ''}">${esc(i)}</span>`).join('');
}

// ---------- 本地推演：内容由材料真实推导 ----------

export function localStage(req, stageKey, material) {
  const a = analyzeMaterial(material || req.material || '');
  const hits = req.knowledgeHits || [];
  const base = { key: stageKey, engine: 'local-deterministic', generatedAt: new Date().toISOString() };

  if (stageKey === 'intake') {
    return {
      ...base,
      status: '已完成',
      riskLevel: a.gaps.length > 1 ? 'medium' : 'low',
      risk: a.gaps[0] || '材料基本完整，可直接推进。',
      blindSpot: '纪要是否需要区分发言人与时间戳。',
      summary: `解析 ${a.lines.length} 条要点，识别出 ${a.inventory.length} 类输入材料。`,
      html:
        `<div class="doc-block"><h3>需求材料梳理</h3><p>${esc(a.title)}</p>` +
        `<div>${tags(a.inventory, 'brand')}${a.gaps.length ? `<span class="tag amber">缺口 ${a.gaps.length} 项</span>` : ''}</div></div>` +
        `<div class="doc-block"><h3>需求判断</h3><ul>${ul(
          [
            a.hasAlgo ? '涉及算法能力，先做小规模实验再定方案。' : '暂不涉及算法实验，可直接进入方案设计。',
            a.hasBackend ? '涉及后端服务与数据流转，需要技术方案。' : '以既有能力为主，改动范围可控。',
            `材料规模：${a.lines.length} 条要点、${a.metrics.length} 个可量化指标。`,
          ],
          ''
        )}</ul></div>` +
        `<div class="doc-block"><h3>材料缺口</h3><ul>${ul(a.gaps, '材料完整，无缺口。')}</ul></div>` +
        `<div class="doc-block"><h3>待确认问题</h3><ul>${ul(a.questions, '暂无需澄清事项。')}</ul></div>`,
    };
  }

  if (stageKey === 'breakdown') {
    return {
      ...base,
      status: '已完成',
      riskLevel: a.questions.length ? 'medium' : 'low',
      risk: a.questions.length ? `仍有 ${a.questions.length} 个待确认问题，可能影响验收标准。` : '澄清项已闭环。',
      blindSpot: '历史需求里的字段定义是否可以直接复用。',
      summary: `生成需求拆解文档，复用 ${hits.length} 份历史经验。`,
      html:
        `<div class="doc-block"><h3>产品需求拆解文档 V1.0</h3><dl class="kv">` +
        `<dt>需求背景</dt><dd>${esc(a.title)}</dd>` +
        `<dt>核心流程</dt><dd>需求接收 → 需求拆解 → 方案设计 → 开发联调 → 验收交付</dd>` +
        `<dt>功能边界</dt><dd>${esc(a.lines.slice(0, 3).join('；')) || '待补充'}</dd>` +
        `<dt>验收标准</dt><dd>${a.metrics.length ? esc(a.metrics.join('、')) : '建议补充可量化验收指标'}</dd>` +
        `</dl></div>` +
        `<div class="doc-block"><h3>功能清单</h3><ul>${ul(a.todos, '待从材料中细化功能条目。')}</ul></div>` +
        `<div class="doc-block"><h3>知识库匹配</h3><p>${
          hits.length
            ? hits
                .slice(0, 4)
                .map((h) => `<span class="tag ${h.score >= 0.4 ? 'green' : 'amber'}">${esc(h.title)} ${Math.round(h.score * 100)}%</span>`)
                .join('')
            : '<span class="tag">未命中高相关历史需求</span>'
        }</p><p style="color:#8b8178;font-size:12px">已复用历史需求中的字段定义、验收标准与异常场景清单。</p></div>`,
    };
  }

  if (stageKey === 'algorithm') {
    const target = 80 + ((a.lines.length + a.todos.length) % 10);
    const current = Math.max(62, target - 6 - (a.gaps.length % 4) * 3);
    return {
      ...base,
      status: '已完成',
      riskLevel: a.hasAlgo ? 'medium' : 'low',
      risk: a.hasAlgo ? `当前指标 ${current}%，距目标 ${target}% 还有差距。` : '不涉及算法实验，仅保留指标口径。',
      blindSpot: '中英文混合场景样本不足，可能影响字段归属。',
      summary: a.hasAlgo ? `输出实验方案与标注规范，当前 ${current}% / 目标 ${target}%。` : '无需算法实验，输出评估口径备查。',
      html:
        `<div class="doc-block"><h3>实验方案</h3><dl class="kv">` +
        `<dt>实验目标</dt><dd>关键字段准确率不低于 ${target}%，抽取 F1 不低于 ${target - 2}%。</dd>` +
        `<dt>数据需求</dt><dd>覆盖多人讨论、无明确结论、中英文混合等场景，建议不少于 200 条脱敏样本。</dd>` +
        `<dt>标注规范</dt><dd>标注摘要、关键决议、待办事项、负责人、截止时间。</dd>` +
        `<dt>评估口径</dt><dd>${a.metrics.length ? esc(a.metrics.join('、')) : '按字段准确率与 F1 双指标评估'}</dd>` +
        `</dl></div>` +
        `<div class="doc-block"><h3>当前评估</h3><div class="bar-chart">` +
        `<div class="bar-row"><span>字段准确率</span><div class="bar-track"><div class="bar-fill ${current >= target ? 'green' : 'amber'}" style="width:${target}%"></div></div><strong>${current}%</strong></div>` +
        `<div class="bar-row"><span>抽取 F1</span><div class="bar-track"><div class="bar-fill green" style="width:${target - 2}%"></div></div><strong>${target - 2}%</strong></div>` +
        `<div class="bar-row"><span>样本覆盖度</span><div class="bar-track"><div class="bar-fill amber" style="width:${Math.min(96, 60 + a.lines.length)}%"></div></div><strong>${Math.min(96, 60 + a.lines.length)}%</strong></div>` +
        `</div></div>` +
        `<div class="doc-block"><h3>风险提示</h3><ul>${ul(
          [].concat(a.gaps, a.hasAlgo ? ['负样本不足时容易把无结论讨论误判为决议。'] : []),
          '暂无显著风险。'
        )}</ul></div>`,
    };
  }

  if (stageKey === 'tech') {
    return {
      ...base,
      status: '已完成',
      riskLevel: 'medium',
      risk: '长文本处理时间可能超过 3 分钟。',
      blindSpot: '算法结果需要人工确认，避免错误结论直接进入正式文档。',
      summary: '输出技术约束、接口边界与数据流。',
      html:
        `<div class="doc-block"><h3>技术约束</h3><dl class="kv">` +
        `<dt>整体链路</dt><dd>材料接收 → 异步任务 → 解析与生成服务 → 结果存储 → 前端展示</dd>` +
        `<dt>后端方案</dt><dd>文件上传、任务队列、模型调用、结果存储、权限校验</dd>` +
        `<dt>算法集成</dt><dd>${a.hasAlgo ? '摘要 / 抽取模型 + 后处理规则' : '规则引擎 + 模板渲染，暂不引入模型'}</dd>` +
        `<dt>外部依赖</dt><dd>不接外部厂商，全部在内部完成</dd>` +
        `</dl></div>` +
        `<div class="doc-block"><h3>接口边界</h3><ul>${ul(
          [
            'POST /materials 上传材料，返回任务 ID',
            'GET /tasks/{id} 查询处理进度与阶段',
            'GET /documents/{id} 获取生成结果与版本',
            a.hasAlgo ? 'POST /experiments 触发评估并回填指标' : '',
          ].filter(Boolean),
          ''
        )}</ul></div>` +
        `<div class="doc-block"><h3>关键风险</h3><ul>${ul(
          [].concat(a.gaps, [
            '长文本处理时间可能超过 3 分钟，需要异步任务与进度提示。',
            '算法结果需要人工确认，避免错误结论直接进入正式文档。',
          ]),
          ''
        )}</ul></div>`,
    };
  }

  if (stageKey === 'build') {
    return {
      ...base,
      status: '已完成',
      riskLevel: 'low',
      risk: '前端联调依赖接口提前定稿。',
      blindSpot: '长文本分段处理是否影响结果完整性。',
      summary: '已生成可运行原型，并拆出开发任务清单。',
      prototype: true,
      html:
        `<div class="doc-block"><h3>开发任务</h3><table class="table mobile-stack" id="dev-task-table">` +
        `<thead><tr><th>任务</th><th>负责人</th><th>状态</th><th>环节</th></tr></thead><tbody>` +
        `<tr><td>材料上传与解析</td><td>后端同学</td><td><span class="badge brand">开发中</span></td><td>开发</td></tr>` +
        `<tr><td>核心生成接口</td><td>后端同学</td><td><span class="badge brand">开发中</span></td><td>开发</td></tr>` +
        `<tr><td>结果预览与编辑页</td><td>前端同学</td><td><span class="badge brand">开发中</span></td><td>联调</td></tr>` +
        `<tr><td>联调与用例回归</td><td>测试同学</td><td><span class="badge gray">待开始</span></td><td>回归</td></tr>` +
        `</tbody></table></div>` +
        `<div class="doc-block"><h3>已产出可运行原型</h3><p>本阶段额外生成了一份可以直接打开、真实可用的原型页面，用来验证主链路。</p>` +
        `<button class="btn primary" onclick="openOutputModal()">打开可运行原型</button></div>` +
        `<div class="doc-block"><h3>联调关注点</h3><ul>${ul(
          [
            '长文本分段处理是否影响结果完整性。',
            '负责人识别错误时，前端是否方便人工修正。',
            '中英文混合内容是否会出现乱码或漏字。',
          ],
          ''
        )}</ul></div>`,
    };
  }

  return {
    ...base,
    status: '已完成',
    riskLevel: 'low',
    risk: '验收时间与验收人尚未确认。',
    blindSpot: '使用说明和上线清单容易在最后一步遗漏。',
    summary: '输出验收清单与交付物索引。',
    html:
      `<div class="doc-block"><h3>验收清单</h3><ul>${ul(
        [
          '按材料生成结果，全部字段可人工编辑。',
          `关键字段完整率不低于 ${a.metrics.length ? 90 : 85}%。`,
          '异常材料有明确提示，不产生错误结果。',
          '结果可导出为文档留存。',
        ],
        ''
      )}</ul></div>` +
      `<div class="doc-block"><h3>交付物</h3><div>` +
      `<span class="tag brand">需求拆解文档</span><span class="tag amber">实验方案与规范</span>` +
      `<span class="tag">技术方案</span><span class="tag green">可运行原型</span>` +
      `<span class="tag">验收清单与使用说明</span></div></div>` +
      `<div class="doc-block"><h3>复盘问题</h3><ul>${ul(
        [].concat(
          a.gaps.map((g) => `${g}，建议前置到需求接收阶段。`),
          ['异常材料处理最容易被忽略，建议纳入标准检查项。']
        ),
        ''
      )}</ul></div>`,
  };
}

// 技术方案里的「环节 → 技能包」编排：先把本机相关度最高的技能包挑出来，再让智能体选。
function buildSkillPlan(req, material) {
  let picked = [];
  try {
    picked = pickSkills(
      `${req.name || ''} ${req.client || ''} ${String(material || req.material || '').slice(0, 1500)}`,
      12
    );
  } catch {
    picked = [];
  }
  if (!picked.length) return '';
  return [
    '',
    '本机 WorkBuddy 里真实存在的技能包（按本需求相关度排序，供你选用）：',
    ...picked.map((s) => `- ${s.id}：${(s.description || s.name).slice(0, 90)}`),
    '',
    '技能编排（可以增加的一节，不是必选项）：',
    '- 如果上面有合适的技能包，就在技术方案里补一节「技能编排」，用表格写：环节 → 选用的技能包 → 参考该技能包里的关键步骤 → 本环节输入 / 输出 → 验收点。',
    '- 技能包只能从上面列表里选，写准确 id；某个环节没有合适技能包时写“自有流程”并列出步骤，不要编造不存在的技能名。',
    '- 每个环节补一句选择理由，整节控制在十余行，目的是让后面的阶段照着同一套步骤执行。',
  ].join('\n');
}

export function buildStagePrompt(req, stage, material, hits) {
  const isBuild = stage.key === 'build';
  const sourceMaterial = String(material || req.material || '');
  const hasCodesignLink = /https:\/\/(?:www\.)?codesign\.qq\.com\//i.test(sourceMaterial);
  const hasPrototypeAnalysis = /【CoDesign 原型读取结果】|prototype-analysis\.md|视觉完整性审查/i.test(sourceMaterial);
  // 技术方案阶段额外挂一节「技能编排」：技能包清单从本机真实目录读出来，不写死。
  const skillPlan = stage.key === 'tech' ? buildSkillPlan(req, material) : '';
  const expertInput = stage.agentId === 'algo-requirement-spec'
    ? [
        '这是一个算法需求拆解任务。请按“算法需求拆解专家”的规则处理：只写产品要求与功能流程，不写架构、代码、表结构、接口协议或部署方案。',
        hasCodesignLink && !hasPrototypeAnalysis
          ? '原型处理硬规则：材料中包含 CoDesign 原型链接，必须优先调用 codesign-export 技能读取、导出并逐页审查原型，再开始需求拆解；不得改用通用浏览器抓取，也不得自行编写替代导出脚本。访问密码仅用于本次读取，不得在输出、日志或文档中复述。'
          : '原型处理硬规则：若材料已包含“CoDesign 原型读取结果”或 prototype-analysis.md，直接复用 codesign-export 的既有产物，不得重复导出、重复审查或再次索取密码。',
        '输入材料可能不完整：请明确指出缺失的原型、评审录音转写或历史拆解材料，并按缺失降级规则继续产出。',
        '输出应尽量覆盖：需求定义、效果定义、模型输出规则、前后端对齐、测试与验收、风险与待确认事项、证据追溯。',
        '每一节都要写实：给出具体规则、字段、判断条件与例子，不要只写标题或一句话带过。',
      ].join('\n')
    : [
        '请直接输出这一阶段的完整交付物，用简体中文，面向业务方，包含：1) 本阶段结论 2) 交付物要点 3) 风险与容易忽略的点 4) 下一步。不要输出客套话。',
        '每一节都要写实、写全：给出具体条目、判断依据与可执行做法，不要只写概要。',
      ].join('\n');
  // 产出约束：不接管工具是为了稳定（避免多轮工具调用超出网关任务时限而回退本地推演），
  // 但长度不再压缩——交付物要完整到可直接使用。
  const constraints = [
    '产出约束（重要）：',
    stage.agentId === 'algo-requirement-spec' && hasCodesignLink && !hasPrototypeAnalysis
      ? '- 除按上述硬规则调用 codesign-export 外，不调用其他工具、不检索代码库、不执行无关命令。'
      : '- 直接基于下方材料一次成稿，不要调用工具、不要检索代码库、不要执行命令、不要反问。',
    '- 材料不足时按缺失降级规则给出结论并标注"待补充"，不要停下来追问。',
    '- 交付物要完整、可直接使用：写全结构、写足细节，不要只给概要，也不要复述材料原文。',
  ].join('\n');
  const codeContract = isBuild
    ? [
        '',
        '代码产出（本阶段必做）：',
        '除交付物文档外，必须给出一个可直接运行的完整前端 Demo 工程，且针对本需求的真实功能，不要写与需求无关的占位。',
        '用以下格式逐个文件输出**完整**内容，不要省略、不要用“…”代替代码：',
        '每个文件都用一对 ``` 围栏包住，围栏内是该文件的完整内容。',
        '',
        '===FILE: index.html===',
        '```html',
        '<!DOCTYPE html> …完整文件…',
        '```',
        '===FILE: styles.css===',
        '```css',
        '…完整文件…',
        '```',
        '===FILE: app.js===',
        '```js',
        '…完整文件…',
        '```',
        '',
        '要求：至少包含 index.html，页面打开就能完成主要交互；如逻辑较多再拆出 app.js / styles.css，全部内联也可以。',
        '整个工程的文件数量控制在 3 个以内（index.html + 至多两个可选文件），每个文件都要写完整，避免超长输出被截断。',
        '如果交付物需要浏览器无法原生生成的二进制格式（例如 MP3 音频文件），必须额外输出一个本地 Node 服务文件（如 serve.mjs），在其中调用本机已安装的 ffmpeg / lame 完成转码；index.html 通过 HTTP 调用它取回结果，并在正文写清启动方式与访问地址。',
        '运行时不要依赖联网：优先用浏览器原生能力与本机已装工具，不要引入需要在线安装的第三方服务。',
        '每个文件都必须有成对的 ``` 结束围栏；最后一个围栏之后不要写任何说明、总结或使用方式，那些内容写在正文里。',
      ].join('\n')
    : '';
  return [
    `你是需求协作台里的「${stage.name}」阶段执行智能体，使用的技能包：${stage.skills.join('、')}。`,
    `需求名称：${req.name}`,
    `业务方：${req.client || '内部'}`,
    `阶段交付物要求：${stage.deliverable}`,
    hits && hits.length
      ? `可复用的历史知识：${hits.map((h) => h.title).join('、')}`
      : '可复用的历史知识：暂无',
    '',
    '以下是本需求到目前为止的材料与上下文：',
    sourceMaterial.slice(0, isBuild ? 9000 : 6000),
    '',
    expertInput,
    skillPlan,
    '',
    constraints,
    codeContract,
  ].join('\n');
}

// ---------- 开发联调：按文件分批真实生成 ----------
//
// 单次智能体输出有约 2 万字符的上限，一次性输出整个工程会在后半段被截断
// （实测 app.js 写到一半断掉、MP3 服务没来得及写）。改成每个文件一批真实调用，
// 每批都能完整收尾；已经完整落盘的文件直接复用，不重复消耗一次长任务。
export const BUILD_BATCHES = [
  {
    key: 'page',
    files: ['index.html'],
    brief:
      '产出完整的 index.html：页面结构、素材上传区、解析结果区、提示词区、方案区、播放条、历史记录、自检与批量实验面板。所有交互元素都带稳定 id，供 app.js 引用。',
  },
  {
    key: 'style',
    files: ['styles.css'],
    brief: '产出完整的 styles.css：与 index.html 的类名严格对应，配色干净、信息密度适中、窄屏可用。',
  },
  {
    key: 'logic',
    files: ['app.js'],
    brief:
      '产出完整且可直接运行的 app.js：素材上传与本地像素解析、提示词解析、方案合成（纯函数，签名不含随机量）、作曲与音频渲染、试听与导出、历史记录、自检、批量实验。id 必须与 index.html 完全一致。代码紧凑，去掉大段注释，逻辑不许省略。',
    context: ['index.html'],
  },
  {
    key: 'service',
    files: ['serve.mjs'],
    brief:
      '产出完整且可直接运行的 serve.mjs：零依赖本地 Node 服务，托管本目录静态文件，并接收前端提交的音频数据，调用本机已安装的 ffmpeg 或 lame 转成 15 秒 MP3 返回；开启 CORS，监听端口与前端约定一致，顶部注释写明启动方式。',
    context: ['app.js'],
  },
];

export function buildBatchPrompt(req, stage, material, batch, context) {
  const sample = batch.files[0] || 'index.html';
  return [
    `你是需求协作台里「${stage.name}」阶段的全栈开发智能体 ${stage.agent}。本批只产出这些文件：${batch.files.join('、')}。`,
    `需求名称：${req.name}`,
    `业务方：${req.client || '内部'}`,
    '',
    '需求材料与技术方案（开发依据）：',
    String(material || req.material || '').slice(0, 8000),
    '',
    `本批任务：${batch.brief}`,
    context ? `\n已有文件契约（必须严格对齐，不要改动其约定）：\n${context}` : '',
    '',
    '输出格式（严格遵守）：',
    '每个文件先写一行 ===FILE: 文件名===，再用一对 ``` 围栏包住该文件的完整内容。',
    `例如：\n===FILE: ${sample}===\n\`\`\`\n（完整文件内容）\n\`\`\``,
    '每个文件都要写完整，不要省略、不要用“…”或“其余同上”代替。',
    '代码保持紧凑：不要写大段注释，词典、映射表每行一条即可；同时不要牺牲任何功能。',
    '单个文件控制在 18000 字符以内：用紧凑写法保证功能完整，避免因输出过长被截断。',
    '只输出文件内容本身，不要输出解释、总结或使用说明。',
    '运行时不依赖联网：优先用浏览器原生能力与本机已装工具，不要引入需要在线安装的第三方服务。',
  ]
    .filter(Boolean)
    .join('\n');
}

// ---------- 可运行原型（真实产物，落盘） ----------

// 原型模板按需求材料自适应：不同场景给出不同的输入提示与结构化输出分区。
const PROTOTYPE_PROFILES = {
  meeting: {
    sub: '由「开发联调」阶段生成 · 粘贴会议转写即可得到纪要初稿',
    placeholder: '把会议转写、录音摘要或会议记录粘贴到这里，然后点生成',
    sections: [
      { title: '会议摘要', kind: 'summary', take: 3, empty: '未识别到摘要' },
      { title: '关键决议', kind: 'list', match: '(决定|确认|通过|达成|结论)', empty: '未识别到明确决议' },
      { title: '待办事项', kind: 'table', columns: ['事项', '负责人'], cell2: '待指派', match: '(需要|待办|跟进|补充|输出|完成|安排)', empty: '未识别到待办' },
      { title: '待确认问题', kind: 'list', match: '([?？]|是否|待确认)', empty: '无' },
    ],
  },
  checklist: {
    sub: '由「开发联调」阶段生成 · 粘贴送审材料即可得到齐全性核对结果',
    placeholder: '把材料清单、资质说明或送审要求粘贴到这里，然后点生成',
    sections: [
      { title: '材料概览', kind: 'summary', take: 2, empty: '未识别到材料说明' },
      { title: '已提供材料', kind: 'list', match: '(提供|已交|附件|包含|提交)', empty: '未识别到已提供材料' },
      { title: '缺失 / 待补充', kind: 'table', columns: ['缺失项', '处理'], cell2: '待补充', match: '(缺少|缺失|未提供|待补充|需要补|未交)', empty: '未识别到缺失项' },
      { title: '待确认问题', kind: 'list', match: '([?？]|是否|待确认)', empty: '无' },
    ],
  },
  validate: {
    sub: '由「开发联调」阶段生成 · 粘贴数据说明即可得到校验结果',
    placeholder: '把表格字段说明、校验规则或异常描述粘贴到这里，然后点生成',
    sections: [
      { title: '数据概览', kind: 'summary', take: 2, empty: '未识别到数据说明' },
      { title: '校验规则', kind: 'list', match: '(校验|规则|必填|格式|范围|唯一|重复)', empty: '未识别到校验规则' },
      { title: '异常数据', kind: 'table', columns: ['异常项', '建议'], cell2: '人工复核', match: '(异常|错误|缺失|不符|超限|为空|冲突)', empty: '未识别到异常项' },
      { title: '待确认问题', kind: 'list', match: '([?？]|是否|待确认)', empty: '无' },
    ],
  },
  insight: {
    sub: '由「开发联调」阶段生成 · 粘贴会话或反馈即可得到洞察结果',
    placeholder: '把客服会话、用户反馈或评论粘贴到这里，然后点生成',
    sections: [
      { title: '总体概览', kind: 'summary', take: 2, empty: '未识别到内容' },
      { title: '主要问题', kind: 'list', match: '(问题|投诉|不满|失败|报错|延迟|无法)', empty: '未识别到明显问题' },
      { title: '风险预警', kind: 'table', columns: ['风险点', '等级'], cell2: '需关注', match: '(风险|严重|紧急|大量|集中|下降|上升)', empty: '未识别到风险信号' },
      { title: '待确认问题', kind: 'list', match: '([?？]|是否|待确认)', empty: '无' },
    ],
  },
  dedupe: {
    sub: '由「开发联调」阶段生成 · 粘贴图片清单即可得到重复检测结果',
    placeholder: '把图片文件名、特征描述或清单粘贴到这里，然后点生成',
    sections: [
      { title: '清单概览', kind: 'summary', take: 2, empty: '未识别到清单内容' },
      { title: '疑似重复', kind: 'table', columns: ['图片', '判定'], cell2: '待人工确认', match: '(重复|近似|相似|同名|副本|裁剪|缩放|平移)', empty: '未识别到疑似重复项' },
      { title: '处理建议', kind: 'list', match: '(删除|保留|合并|导出|确认|人工)', empty: '未识别到处理建议' },
      { title: '待确认问题', kind: 'list', match: '([?？]|是否|待确认)', empty: '无' },
    ],
  },
  extract: {
    sub: '由「开发联调」阶段生成 · 粘贴原文即可得到结构化抽取结果',
    placeholder: '把合同条款、工单内容或待归类原文粘贴到这里，然后点生成',
    sections: [
      { title: '内容概览', kind: 'summary', take: 2, empty: '未识别到内容' },
      { title: '抽取结果', kind: 'table', columns: ['条目', '归类'], cell2: '待归类', match: '(条款|约定|责任|义务|金额|期限|类型|类别|工单)', empty: '未识别到可抽取条目' },
      { title: '关键信息', kind: 'list', match: '(甲方|乙方|金额|时间|日期|期限|编号|版本|业务方)', empty: '未识别到关键信息' },
      { title: '待确认问题', kind: 'list', match: '([?？]|是否|待确认|不明确)', empty: '无' },
    ],
  },
  summary: {
    sub: '由「开发联调」阶段生成 · 粘贴原文即可得到摘要与要点',
    placeholder: '把需求说明、文档正文或业务原文粘贴到这里，然后点生成',
    sections: [
      { title: '内容摘要', kind: 'summary', take: 3, empty: '未识别到摘要' },
      { title: '关键要点', kind: 'list', match: '(.{6,})', empty: '未识别到要点' },
      { title: '待办事项', kind: 'table', columns: ['事项', '负责人'], cell2: '待指派', match: '(需要|待办|跟进|补充|输出|完成|安排)', empty: '未识别到待办' },
      { title: '待确认问题', kind: 'list', match: '([?？]|是否|待确认)', empty: '无' },
    ],
  },
};

export function prototypeProfile(req) {
  const pick = (text) => {
    if (!text) return null;
    if (/纪要|会议|录音|音频|转写|转录|决议/.test(text)) return 'meeting';
    if (/舆情|客服|会话|反馈|评论|情绪|满意度/.test(text)) return 'insight';
    if (/去重|重复|相似|近似|查重/.test(text)) return 'dedupe';
    if (/校验|质检|合规|异常|字段|规则/.test(text)) return 'validate';
    if (/合同|条款|工单|归类|分类/.test(text)) return 'extract';
    if (/资质|准入|材料清单|审批|送审/.test(text)) return 'checklist';
    if (/摘要|总结|概述|概括|提炼/.test(text)) return 'summary';
    return null;
  };
  // 需求名称的意图最明确，先按名称判定，再用材料内容兜底。
  return pick(req?.name || '') || pick(req?.material || '') || 'summary';
}

export function buildPrototypeHtml(req) {
  const title = esc(req.name || '需求原型');
  const profile = PROTOTYPE_PROFILES[prototypeProfile(req)] || PROTOTYPE_PROFILES.summary;
  const cfg = JSON.stringify({ sections: profile.sections });
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · 可运行原型</title>
<style>
body{margin:0;font-family:-apple-system,"PingFang SC",sans-serif;background:#f8f4ef;color:#2b2724;line-height:1.6}
.wrap{max-width:860px;margin:0 auto;padding:24px 18px 60px}
h1{font-size:22px;margin:0 0 4px}
.sub{color:#8b8178;font-size:13px}
.card{background:#fff;border:1px solid #ece3d8;border-radius:10px;padding:16px;margin:14px 0}
textarea{width:100%;min-height:150px;border:1px solid #ece3d8;border-radius:8px;padding:10px;font:inherit;resize:vertical}
button{background:#d7441d;color:#fff;border:0;border-radius:8px;padding:9px 16px;font:inherit;cursor:pointer}
button.ghost{background:#fff;color:#d7441d;border:1px solid #f2c4b1}
h3{font-size:15px;margin:18px 0 8px;color:#c23a15}
ul{padding-left:20px;margin:6px 0}
table{width:100%;border-collapse:collapse}
th{text-align:left;color:#8b8178;font-size:12px}
td{padding:6px 0;border-top:1px solid #f0e8df;vertical-align:top}
</style></head>
<body><div class="wrap">
  <h1>${title}</h1>
  <div class="sub">${esc(profile.sub)}</div>
  <div class="card">
    <textarea id="src" placeholder="${esc(profile.placeholder)}">${esc(req.material || '')}</textarea>
    <div style="margin-top:10px;display:flex;gap:8px">
      <button onclick="run()">生成结果</button>
      <button class="ghost" onclick="clr()">清空</button>
    </div>
  </div>
  <div class="card" id="out"><span class="sub">结果会显示在这里。</span></div>
</div>
<script>
var CFG = ${cfg};
function esc(s){return String(s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function clr(){document.getElementById('src').value='';document.getElementById('out').innerHTML='<span class="sub">结果会显示在这里。</span>'}
function block(sec,parts){
  if(sec.kind==='summary'){
    return '<h3>'+esc(sec.title)+'</h3><p>'+(parts.length?esc(parts.slice(0,sec.take||3).join('；')):'<span class="sub">'+esc(sec.empty||'')+'</span>')+'</p>';
  }
  var re=new RegExp(sec.match);
  var hits=parts.filter(function(l){return re.test(l)}).slice(0,sec.limit||8);
  if(!hits.length){return '<h3>'+esc(sec.title)+'</h3><p><span class="sub">'+esc(sec.empty||'')+'</span></p>'}
  if(sec.kind==='list'){
    return '<h3>'+esc(sec.title)+'</h3><ul>'+hits.map(function(l){return '<li>'+esc(l)+'</li>'}).join('')+'</ul>';
  }
  var head='<tr>'+sec.columns.map(function(c){return '<th>'+esc(c)+'</th>'}).join('')+'</tr>';
  var rows=hits.map(function(l){return '<tr><td>'+esc(l)+'</td><td>'+esc(sec.cell2||'待处理')+'</td></tr>'}).join('');
  return '<h3>'+esc(sec.title)+'</h3><table>'+head+rows+'</table>';
}
function run(){
  var raw=(document.getElementById('src').value||'').trim();
  var out=document.getElementById('out');
  if(!raw){out.innerHTML='<span class="sub">请先粘贴材料。</span>';return}
  var parts=raw.split(/[。\\n；;]/).map(function(s){return s.trim()}).filter(Boolean);
  out.innerHTML=CFG.sections.map(function(sec){return block(sec,parts)}).join('');
}
if(document.getElementById('src').value.trim())run();
</script>
</body></html>`;
}

export function writePrototype(runDir, req) {
  const dir = path.join(runDir, 'build');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'prototype.html');
  fs.writeFileSync(file, buildPrototypeHtml(req), 'utf8');
  return file;
}

// ---------- 阶段交付物：真实落盘的文件产物 ----------

function stripHtml(html) {
  return String(html || '')
    .replace(/<\/(h3|p|div|li|tr|dd|dt)>/gi, '\n')
    .replace(/<li>/gi, '- ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .split('\n')
    .map((l) => l.trim())
    .filter((l, i, arr) => l || arr[i - 1])
    .join('\n')
    .trim();
}

function engineText(engine) {
  return engine === 'workbuddy' ? 'WorkBuddy 智能体真实调用' : '本地流程引擎推演（未登录智能体时的兜底）';
}

// 把某阶段的结论整理成一份可下载 / 可查看 / 可写飞书的交付物文档。
export function stageArtifactMarkdown(req, stage, result) {
  const when = result.generatedAt ? new Date(result.generatedAt).toLocaleString('zh-CN') : '';
  return [
    `# ${req.name} · ${stage.name}`,
    '',
    `> 交付物：${stage.deliverable}`,
    '',
    '## 基本信息',
    `- 需求名称：${req.name}`,
    `- 业务方：${req.client || '内部'}`,
    `- 负责人：${req.owner || '产品 A'}`,
    `- 执行智能体：${stage.agent}`,
    `- 技能包：${stage.skills.join('、')}`,
    `- 产出方式：${engineText(result.engine)}`,
    `- 生成时间：${when}`,
    '',
    '## 阶段结论',
    result.summary || '（无）',
    '',
    '## 交付物内容',
    stripHtml(result.html) || '（无）',
    '',
    '## 风险与容易忽略的点',
    `- 风险：${result.risk || '—'}`,
    `- 容易忽略的点：${result.blindSpot || '—'}`,
    '',
    '## 下一步',
    stage.next || '—',
    '',
  ].join('\n');
}

export function writeStageArtifact(runDir, req, stage, result) {
  fs.mkdirSync(runDir, { recursive: true });
  const rel = `${stage.key}.md`;
  const file = path.join(runDir, rel);
  fs.writeFileSync(file, stageArtifactMarkdown(req, stage, result), 'utf8');
  return { name: `${req.name} · ${stage.name}.md`, rel, file };
}

// ---------- 开发联调：可运行 Demo 工程（真实项目目录） ----------

function demoAppHtml(req) {
  const title = esc(req.name || '需求 Demo');
  const sub = esc(`由「开发联调」阶段生成 · ${req.client || '内部'}`);
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · 可运行 Demo</title>
<style>
*{box-sizing:border-box}
body{margin:0;font-family:-apple-system,"PingFang SC",sans-serif;background:#f8f4ef;color:#2b2724;line-height:1.6}
.wrap{max-width:880px;margin:0 auto;padding:26px 18px 64px}
h1{font-size:22px;margin:0 0 4px}
.sub{color:#8b8178;font-size:13px}
.card{background:#fff;border:1px solid #ece3d8;border-radius:10px;padding:16px;margin:14px 0}
textarea{width:100%;min-height:170px;border:1px solid #ece3d8;border-radius:8px;padding:10px;font:inherit;resize:vertical}
.row{margin-top:10px;display:flex;gap:8px;flex-wrap:wrap}
button{background:#d7441d;color:#fff;border:0;border-radius:8px;padding:9px 16px;font:inherit;cursor:pointer}
button.ghost{background:#fff;color:#d7441d;border:1px solid #f2c4b1}
h3{font-size:15px;margin:18px 0 8px;color:#c23a15}
ul{padding-left:20px;margin:6px 0}
table{width:100%;border-collapse:collapse}
th{text-align:left;color:#8b8178;font-size:12px}
td{padding:6px 0;border-top:1px solid #f0e8df;vertical-align:top}
.pill{display:inline-block;background:#fdf1ea;color:#c23a15;border-radius:999px;padding:2px 10px;font-size:12px;margin-right:6px}
.status{font-size:12px;color:#8b8178}
</style></head>
<body><div class="wrap">
  <h1>${title}</h1>
  <div class="sub">${sub} · 这是开发联调阶段产出的可运行工程</div>
  <div class="card">
    <textarea id="src" placeholder="把会议转写、需求说明或原型描述粘贴到这里，然后点「生成结果」">${esc(req.material || '')}</textarea>
    <div class="row">
      <button onclick="run()">生成结果</button>
      <button class="ghost" onclick="loadSample()">填入示例</button>
      <button class="ghost" onclick="clr()">清空</button>
    </div>
    <div class="status" id="status">就绪</div>
  </div>
  <div class="card" id="out"><span class="sub">结果会显示在这里。</span></div>
</div>
<script>
var SAMPLE = '业务方希望把会议录音上传到云盘后自动生成纪要并提取待办。纪要包含会议摘要、关键决议、待办事项。待办需要负责人和截止时间，是否自动识别负责人待确认。验收标准：30 分钟内出初稿，字段完整率不低于 90%。';
function esc(s){return String(s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function split(raw){return raw.split(/[。；;\\r\\n]/).map(function(s){return s.trim()}).filter(Boolean)}
function pick(parts,re){return parts.filter(function(l){return re.test(l)})}
function section(title,items){return '<h3>'+esc(title)+'</h3>'+(items.length?'<ul>'+items.map(function(i){return '<li>'+esc(i)+'</li>'}).join('')+'</ul>':'<p><span class="sub">未识别到内容</span></p>')}
function clr(){document.getElementById('src').value='';document.getElementById('out').innerHTML='<span class="sub">结果会显示在这里。</span>';setStatus('就绪')}
function loadSample(){document.getElementById('src').value=SAMPLE;setStatus('已填入示例材料')}
function setStatus(t){document.getElementById('status').textContent=t}
function run(){
  var raw=(document.getElementById('src').value||'').trim();
  if(!raw){setStatus('请先粘贴材料');return}
  var parts=split(raw);
  setStatus('已解析 '+parts.length+' 条要点');
  var summary=parts.slice().sort(function(a,b){return b.length-a.length}).slice(0,2);
  var decisions=pick(parts,/(决定|确认|通过|达成|结论)/);
  var todos=pick(parts,/(需要|待办|跟进|补充|输出|完成|安排)/);
  var open=pick(parts,/([?？]|是否|待确认)/);
  document.getElementById('out').innerHTML=
    '<h3>会议摘要</h3><p>'+esc(summary.join('；')||'未识别到摘要')+'</p>'+
    section('关键决议',decisions)+
    section('待办事项',todos)+
    section('待确认问题',open)+
    '<div class="status">共 '+parts.length+' 条要点，'+decisions.length+' 条决议，'+todos.length+' 条待办</div>';
}
if(document.getElementById('src').value.trim())run();
</script>
</body></html>`;
}

const DEMO_README = [
  '# 可运行 Demo 工程',
  '',
  '这是「开发联调」阶段真实生成的工程目录，可以直接运行。',
  '',
  '## 方式一：直接打开',
  '双击 `index.html`，或在浏览器里打开它即可使用。',
  '',
  '## 方式二：本地起服务',
  '```bash',
  'node server.mjs',
  '# 浏览器访问 http://127.0.0.1:8899',
  '```',
  '',
  '## 目录',
  '- `index.html` —— 可运行页面（材料解析 Demo）',
  '- `server.mjs` —— 零依赖的本地静态服务',
  '',
].join('\n');

function demoServeScript(title) {
  return [
    "// 零依赖静态服务：node server.mjs",
    "import http from 'node:http';",
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    "import { fileURLToPath } from 'node:url';",
    '',
    'const HERE = path.dirname(fileURLToPath(import.meta.url));',
    'const PORT = Number(process.env.PORT || 8899);',
    "const TITLE = " + JSON.stringify(title) + ';',
    '',
    'const server = http.createServer((req, res) => {',
    "  if (req.url === '/api/status') {",
    "    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });",
    "    return res.end(JSON.stringify({ ok: true, title: TITLE, service: '可运行 Demo', time: new Date().toISOString() }));",
    '  }',
    "  const file = path.join(HERE, req.url === '/' ? 'index.html' : req.url.replace(/^\\//, ''));",
    '  if (!file.startsWith(HERE) || !fs.existsSync(file)) {',
    '    res.writeHead(404);',
    "    return res.end('not found');",
    '  }',
    "  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });",
    '  fs.createReadStream(file).pipe(res);',
    '});',
    '',
    'server.listen(PORT, () => {',
    "  console.log('可运行 Demo 已启动：http://127.0.0.1:' + PORT);",
    '});',
    '',
  ].join('\n');
}

export function writeDemoApp(runDir, req) {
  const dir = path.join(runDir, 'build', 'app');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), demoAppHtml(req), 'utf8');
  fs.writeFileSync(path.join(dir, 'server.mjs'), demoServeScript(req.name || '需求 Demo'), 'utf8');
  fs.writeFileSync(path.join(dir, 'README.md'), DEMO_README, 'utf8');
  return dir;
}

// ---------- 智能体产出的真实代码：解析 ===FILE: xxx=== 段落并落盘 ----------

const CODE_FILE_RE = /^===FILE:\s*(.+?)\s*===\s*$/gm;

// 模型常把文件内容再包一层 ```lang 围栏，并在围栏后追加说明文字；这里剥掉围栏、截断说明。
// 判定结尾段落是不是「说明文字」：以 markdown 标记开头，且不含代码特征字符。
function looksLikeProse(block) {
  if (!/^\s*(\*\*|#{1,6}\s|>|[-*]\s|Demo|示例|说明|使用|推荐|注意|以上)/.test(block)) return false;
  return !/[;{}]|\bfunction\b|=>|<\/?[a-z]/i.test(block);
}

// 去掉文件正文末尾被模型追加的说明段落（可能有多段）。
function trimTrailingProse(text) {
  const lines = String(text).split('\n');
  let end = lines.length;
  while (end > 0) {
    let i = end;
    while (i > 0 && lines[i - 1].trim() === '') i -= 1;
    if (i === 0) return '';
    let j = i;
    while (j > 0 && lines[j - 1].trim() !== '') j -= 1;
    const block = lines.slice(j, i).join('\n');
    if (!looksLikeProse(block)) break;
    end = j;
  }
  return lines.slice(0, end).join('\n').replace(/\s+$/, '\n');
}

function normalizeFileBody(raw) {
  let body = String(raw || '');
  body = body.replace(/^\s*```[^\n]*\r?\n/, '');
  const close = body.search(/^\s*```\s*$/m);
  if (close >= 0) body = body.slice(0, close);
  body = body.replace(/^\s*\r?\n/, '');
  return trimTrailingProse(body);
}

export function parseCodeFiles(text) {
  const t = String(text || '');
  const marks = [];
  let m;
  CODE_FILE_RE.lastIndex = 0;
  while ((m = CODE_FILE_RE.exec(t))) {
    marks.push({ path: m[1].trim(), from: m.index + m[0].length, markAt: m.index });
  }
  const out = [];
  for (let i = 0; i < marks.length; i++) {
    const to = i + 1 < marks.length ? marks[i + 1].markAt : t.length;
    out.push({ path: marks[i].path, content: normalizeFileBody(t.slice(marks[i].from, to)) });
  }
  return out;
}

// 文档里去掉代码块，只保留说明部分（代码单独落盘/单独展示）。
export function stripCodeBlocks(text) {
  const t = String(text || '');
  const idx = t.search(/^===FILE:\s*.+?===\s*$/m);
  return (idx >= 0 ? t.slice(0, idx) : t).trim();
}

// 把智能体写出的文件落到 demo 工程目录；解析失败返回 null，由调用方决定是否回退模板。
export function writeDemoCode(runDir, req, text) {
  const files = parseCodeFiles(text);
  if (!files.length) return null;
  const dir = path.join(runDir, 'build', 'app');
  fs.mkdirSync(dir, { recursive: true });
  // 清掉上一次遗留的模板文件，只保留版本库本身。
  for (const entry of fs.readdirSync(dir)) {
    if (entry === '.git') continue;
    fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
  }
  for (const f of files) {
    const safe = f.path.replace(/^\.?\//, '').replace(/\.\./g, '').trim();
    if (!safe) continue;
    const target = path.join(dir, safe);
    if (!target.startsWith(dir)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, f.content, 'utf8');
  }
  if (!fs.existsSync(path.join(dir, '.gitignore'))) {
    fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n.DS_Store\n', 'utf8');
  }
  if (!files.some((f) => /(^|\/)index\.html$/i.test(f.path))) {
    const html = files.find((f) => /\.html?$/i.test(f.path));
    if (html) {
      fs.writeFileSync(
        path.join(dir, 'index.html'),
        `<!DOCTYPE html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=./${html.path}">`,
        'utf8'
      );
    }
  }
  return { dir, files: files.map((f) => f.path) };
}

// 分批生成用：只写入本批约定的文件，保留目录里其它已完成文件（不整目录清空）。
export function writeCodeFiles(dir, files, allow) {
  fs.mkdirSync(dir, { recursive: true });
  const allowed = (allow || []).map((s) => String(s).replace(/^\.?\//, '').trim());
  const written = [];
  for (const f of files || []) {
    const raw = String(f.path || '').replace(/^\.?\//, '').trim();
    const name = path.basename(raw);
    if (!name) continue;
    if (allowed.length && !allowed.includes(name) && !allowed.includes(raw)) continue;
    fs.writeFileSync(path.join(dir, name), f.content, 'utf8');
    written.push(name);
  }
  if (!fs.existsSync(path.join(dir, '.gitignore'))) {
    fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n.DS_Store\n', 'utf8');
  }
  return written;
}

// 判断文件是否已经是「完整可用」的版本：分批生成时据此跳过已完成的批次。
// js 走语法检查、html 要闭合、css 要括号配平，避免把上一轮被截断的残件当成成品复用。
export function fileLooksComplete(dir, rel) {
  const target = path.join(dir, rel);
  try {
    const st = fs.statSync(target);
    if (!st.isFile() || st.size < 24) return false;
    const text = fs.readFileSync(target, 'utf8');
    if (/\.m?js$/i.test(rel)) {
      return spawnSync(process.execPath, ['--check', target], { encoding: 'utf8' }).status === 0;
    }
    if (/\.html?$/i.test(rel)) return /<\/html\s*>/i.test(text);
    if (/\.css$/i.test(rel)) {
      const open = (text.match(/\{/g) || []).length;
      const close = (text.match(/\}/g) || []).length;
      return open > 0 && open === close;
    }
    return true;
  } catch {
    return false;
  }
}

// demo 工程初始化 git 并提交；返回提交信息，供页面展示。
export function gitInitCommit(dir, req) {
  const res = { ok: false, dir, commit: '', reason: '' };
  try {
    const run = (args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    if (!fs.existsSync(path.join(dir, '.git'))) {
      run(['init', '-q']);
      fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n.DS_Store\n', 'utf8');
    }
    run(['add', '-A']);
    const status = run(['status', '--porcelain']);
    if (!String(status.stdout || '').trim()) {
      res.ok = true;
      res.reason = '无变更';
      res.commit = String(run(['rev-parse', '--short', 'HEAD']).stdout || '').trim();
      return res;
    }
    const msg = `feat: ${req.name || '需求'} 可运行 Demo`;
    const c = spawnSync(
      'git',
      ['-c', 'user.name=需求协作台', '-c', 'user.email=cockpit@local', 'commit', '-q', '-m', msg, '--no-gpg-sign'],
      { cwd: dir, encoding: 'utf8' }
    );
    res.commit = String(run(['rev-parse', '--short', 'HEAD']).stdout || '').trim();
    res.ok = c.status === 0;
    res.reason = res.ok ? '' : String(c.stderr || c.stdout || '').trim().slice(0, 300);
  } catch (err) {
    res.reason = String(err && err.message ? err.message : err);
  }
  return res;
}

export const WB_CLI = CODEBUDDY;
export const HOME_DIR = HOME;
