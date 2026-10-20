// 阶段沉淀策略：飞书是协作层（给人看、要评审、要发出去），iMa 是复用层（给下一条需求检索）。
// 所以不是每个阶段都值得进知识库，只沉淀"下一条别的需求会想搜到"的那部分：
// 模板、规范口径、踩坑复盘、历史基线。
// 不沉淀：一次性清单、本次具体数字、代码、业务敏感原文。

export const SINK_KIND = {
  TEMPLATE: '模板',
  SPEC: '规范口径',
  PITFALL: '踩坑复盘',
  BASELINE: '历史基线',
  NONE: '不沉淀',
};

// 每个阶段的沉淀策略。sink=false 时，产物仍会落盘成交付物，只是不写知识库。
export const STAGE_SINK_POLICY = {
  intake: {
    sink: false,
    kind: SINK_KIND.NONE,
    label: '不沉淀',
    reason: '材料清单、缺口清单只对本次有效，下一条需求用不上。',
    reusable: [],
  },
  breakdown: {
    sink: true,
    kind: SINK_KIND.TEMPLATE,
    label: `进 iMa · ${SINK_KIND.TEMPLATE} / 字段定义`,
    reason: '沉淀可复用的字段定义、验收标准写法、异常场景清单。',
    reusable: ['字段定义', '验收标准', '验收口径', '异常场景', '功能边界', '边界条件', '流程', '规则'],
    exclude: '本次具体需求内容与业务原文',
  },
  algorithm: {
    sink: true,
    kind: SINK_KIND.SPEC,
    label: `进 iMa · ${SINK_KIND.SPEC} / ${SINK_KIND.BASELINE}`,
    reason: '沉淀标注规范、评估口径与可对比的历史基线。',
    reusable: ['标注规范', '标注', '评估口径', '评估指标', '指标', '样本', '数据集', '准确率', 'F1', '召回'],
    exclude: '仅对本次有效的实验过程数据',
  },
  tech: {
    sink: true,
    kind: SINK_KIND.PITFALL,
    label: `进 iMa · ${SINK_KIND.PITFALL} / 技术决策`,
    reason: '沉淀可复用的技术决策与踩坑，接口定义本身不复用。',
    reusable: ['技术约束', '约束', '踩坑', '风险', '边界', '决策', '性能', '超时', '并发', '兼容'],
    exclude: '本次业务专属的接口字段定义',
  },
  build: {
    sink: false,
    kind: SINK_KIND.NONE,
    label: '不沉淀',
    reason: '代码与可运行原型的版本管理在 Git，知识库不重复存一份。',
    reusable: [],
  },
  delivery: {
    sink: true,
    kind: SINK_KIND.PITFALL,
    label: `进 iMa · ${SINK_KIND.PITFALL} / 风险预警`,
    reason: '沉淀复盘问题、风险预警与可复用的验收清单。',
    reusable: ['复盘', '问题', '风险', '预警', '验收清单', '上线清单', '改进', '建议'],
    exclude: '本次验收数字与考核结果',
  },
};

export function sinkPolicy(stageKey) {
  return STAGE_SINK_POLICY[stageKey] || STAGE_SINK_POLICY.intake;
}

function plainText(html) {
  return String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

// 从阶段产出里挑出"可复用要点"：按关键词命中打分，去重后取前若干条。
// 带具体数字的"本次专属"句子直接排除，避免把一次性结果当成可复用经验。
const EPHEMERAL_RE = /(本次|这一次|该项目本次|本项目本次)[^。；;]{0,20}\d|\d[^。；;]{0,20}(本次|这一次)/;

function extractReusable(text, keywords, limit = 6) {
  const chunks = String(text || '')
    .split(/[\n。；;!?！？]+/)
    .map((s) => s.replace(/^[#>\-*\s\d.、]+/, '').trim())
    .filter((s) => s.length >= 8 && s.length <= 160 && !EPHEMERAL_RE.test(s));

  const scored = chunks
    .map((value, index) => ({
      value,
      index,
      hit: keywords.reduce((n, k) => n + (value.includes(k) ? 1 : 0), 0),
    }))
    .filter((c) => c.hit > 0)
    .sort((a, b) => b.hit - a.hit || a.index - b.index);

  const seen = new Set();
  const out = [];
  for (const c of scored) {
    const key = c.value.slice(0, 20);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c.value);
    if (out.length >= limit) break;
  }
  return out;
}

// 生成"知识卡"：不是全文副本，而是可检索要点 + 原文溯源。
export function buildKnowledgeCard(req, stage, result, options = {}) {
  const policy = sinkPolicy(stage.key);
  const body = plainText(result?.html);
  // 没命中关键词时退回本阶段结论摘要，宁可少而准，也不塞本次专属内容。
  let points = extractReusable(body, policy.reusable);
  if (!points.length && result?.summary) {
    const fallback = String(result.summary).split(/[\n。；;]+/)[0].trim();
    if (fallback && !EPHEMERAL_RE.test(fallback)) points = [fallback];
  }
  const artifactHref = options.artifactHref || '';
  const docUrl = options.docUrl || '';

  const lines = [
    `# ${req.name} · ${stage.name}`,
    '',
    `类型：${policy.label}`,
    `标签：${[stage.name, policy.kind, req.client || '内部', '可复用'].join(', ')}`,
    `来源需求：${req.name}（${req.client || '内部'}）`,
    `产出智能体：${stage.agent}（${stage.skills.join('、')}）`,
    '',
    '## 可复用要点',
    ...(points.length ? points.map((p) => `- ${p}`) : ['- 暂未提取到可复用要点，请人工补充。']),
    '',
    '## 本次专属（不要复用）',
    `- ${policy.exclude || '本次具体内容'}`,
    '',
    '## 溯源',
    `- 交付物：${artifactHref || '见需求运行目录'}`,
    `- 飞书文档：${docUrl || '未配置飞书凭证，暂以本地交付物为准'}`,
    '',
    '---',
    '',
    '## 本阶段结论摘要',
    result?.summary || '',
  ];

  return {
    policy,
    title: `${req.name} · ${stage.name}`,
    tags: [stage.name, policy.kind, req.client || '内部', '可复用'],
    summary: result?.summary || `${stage.name}阶段可复用结论`,
    body: lines.join('\n'),
    reusableCount: points.length,
  };
}
