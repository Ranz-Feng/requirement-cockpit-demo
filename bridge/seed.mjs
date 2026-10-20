// 演示数据种子：生成 8 条覆盖不同客户、负责人、阶段与风险的需求，
// 并按同一套阶段规则跑出各阶段交付物，落到 data/runs/<id>/。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { STAGES, localStage, writePrototype } from './engine.mjs';
import * as kb from './knowledge.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const DATA = path.join(ROOT, 'data');
const RUNS = path.join(DATA, 'runs');
const REQ_FILE = path.join(DATA, 'requirements.json');

const SEEDS = [
  {
    id: 'req-jiyao',
    name: '会议纪要自动生成与待办推送',
    client: '某政企客户',
    owner: '产品 A',
    done: 6,
    material: [
      '客户希望上传会议录音后自动生成纪要并提取待办。',
      '当前没有原始录音，只有会议转写文本和需求说明。',
      '纪要需要包含摘要、关键决议、待办事项，待办要保留负责人和截止时间。',
      '期望 30 分钟内出初稿，中英文混合会议也需要支持。',
      '验收标准尚未确认。',
    ].join('\n'),
  },
  {
    id: 'req-summary',
    name: '云盘文档批量摘要',
    client: '集团内部',
    owner: '产品 B',
    done: 4,
    material: [
      '客户要把云盘里的文档批量生成摘要，支持按文件夹一键处理。',
      '文档类型包括 Word、PDF、表格和在线文档，单文件最大 200MB。',
      '需要摘要模型抽取核心结论，并生成可检索的标签。',
      '处理进度要能看到，长文档需要异步任务。',
      '期望准确率不低于 85%，验收标准待确认。',
    ].join('\n'),
  },
  {
    id: 'req-dedup',
    name: '图片重复检测与去重',
    client: '某省公司',
    owner: '产品 C',
    done: 3,
    material: [
      '客户图库里有大量重复和近似图片，希望自动检测并去重。',
      '需要识别平移、缩放、裁剪后的相似图片。',
      '去重结果要能人工确认，避免误删。',
      '涉及相似度算法和特征提取，需要先做实验。',
      '接口需要支持批量上传和结果导出。',
    ].join('\n'),
  },
  {
    id: 'req-sentiment',
    name: '客服会话舆情预警',
    client: '某互联网客户',
    owner: '产品 D',
    done: 2,
    material: [
      '客户希望实时分析客服会话，识别负面情绪和投诉风险。',
      '需要按会话打标，并对高风险会话预警。',
      '涉及情绪分类模型，需要标注样本和评估口径。',
      '预警要能推送到值班群，支持人工复核。',
      '样本量预计 5000 条，尚未提供标注数据。',
    ].join('\n'),
  },
  {
    id: 'req-validate',
    name: '表格数据智能校验',
    client: '某金融客户',
    owner: '产品 A',
    done: 1,
    material: [
      '客户上传的表格经常有格式和逻辑错误，希望自动校验。',
      '校验规则包括必填、枚举、金额范围、跨列一致性。',
      '需要输出错误定位和修改建议。',
      '表格可能上千行，要求校验在 1 分钟内完成。',
      '验收标准与错误提示措辞待确认。',
    ].join('\n'),
  },
  {
    id: 'req-contract',
    name: '合同关键条款抽取',
    client: '某法务客户',
    owner: '产品 B',
    done: 0,
    running: 'intake',
    material: [
      '客户希望从合同 PDF 中自动抽取关键条款。',
      '关注付款方式、违约条款、有效期、甲乙方信息。',
      '抽取结果要能定位到原文位置，方便人工核对。',
      '合同多为扫描件，涉及 OCR 识别。',
    ].join('\n'),
  },
  {
    id: 'req-voice',
    name: '语音工单自动归类',
    client: '某电信客户',
    owner: '产品 C',
    done: 5,
    running: 'delivery',
    material: [
      '客户希望把语音工单转写后自动归类到对应处理部门。',
      '需要识别工单类型、紧急程度和关键诉求。',
      '涉及语音转写与文本分类，转写准确率要求 90% 以上。',
      '结果要回写工单系统，并保留人工修正入口。',
      '上线前需要在测试环境完成验证。',
    ].join('\n'),
  },
  {
    id: 'req-faq',
    name: '多语言 FAQ 自动问答',
    client: '某出海客户',
    owner: '产品 D',
    done: 2,
    running: 'algorithm',
    material: [
      '客户希望基于历史 FAQ 做多语言自动问答。',
      '支持中英文，后续扩展到东南亚语种。',
      '需要检索增强，回答要引用来源条目。',
      '涉及检索与生成模型，需要评估召回和准确性。',
      '知识库条目约 3000 条，未提供多语言语料。',
    ].join('\n'),
  },
];

function nowIso() {
  return new Date().toISOString();
}

function stamp(minutesAgo) {
  const d = new Date(Date.now() - minutesAgo * 60_000);
  return d.toISOString().slice(0, 16).replace('T', ' ');
}

function resetRun(id) {
  const dir = path.join(RUNS, id);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'build'), { recursive: true });
  return dir;
}

function cleanSunkDocs() {
  fs.mkdirSync(kb.KB_DIR, { recursive: true });
  for (const f of fs.readdirSync(kb.KB_DIR)) {
    if (/结论\.md$/.test(f) || /补充材料\.md$/.test(f)) {
      fs.rmSync(path.join(kb.KB_DIR, f), { force: true });
    }
  }
}

function build() {
  fs.mkdirSync(RUNS, { recursive: true });
  cleanSunkDocs();
  const requirements = [];

  SEEDS.forEach((seed, index) => {
    const req = {
      id: seed.id,
      name: seed.name,
      client: seed.client,
      owner: seed.owner,
      material: seed.material,
    };
    const hits = kb.searchLocal(`${seed.name} ${seed.material}`, 4);
    req.knowledgeHits = hits.map((h) => ({ title: h.title, score: h.score, source: h.source }));

    resetRun(seed.id);
    const stageState = [];
    STAGES.forEach((stage, i) => {
      const isRunning = seed.running === stage.key;
      if (i >= seed.done && !isRunning) return;
      const result = localStage(req, stage.key, seed.material);
      if (isRunning) {
        result.status = '进行中';
        result.summary = `正在推进：${result.summary}`;
      } else if (i < seed.done) {
        // 已走过的阶段统一为已完成，避免出现「后面的阶段先完成」的矛盾
        result.status = '已完成';
      }
      if (stage.key === 'build') {
        const file = writePrototype(path.join(RUNS, seed.id), req);
        result.artifact = `/runs/${seed.id}/build/prototype.html`;
        result.prototypeFile = file;
      }
      fs.writeFileSync(
        path.join(RUNS, seed.id, `${stage.key}.json`),
        JSON.stringify(result, null, 2),
        'utf8'
      );
      stageState.push({ key: stage.key, status: result.status, riskLevel: result.riskLevel || 'low' });
    });

    const doneCount = stageState.filter((s) => s.status === '已完成').length;
    const firstOpen = stageState.findIndex((s) => s.status !== '已完成');
    const riskStage = stageState.find((s) => s.status !== '已完成' && s.riskLevel !== 'low');
    const riskTone = riskStage
      ? riskStage.riskLevel === 'high'
        ? '高风险'
        : '中风险'
      : '低风险';

    requirements.push({
      id: seed.id,
      name: seed.name,
      client: seed.client,
      owner: seed.owner,
      material: seed.material,
      stageIndex: firstOpen < 0 ? stageState.length : firstOpen,
      progress: doneCount,
      riskTone,
      created: nowIso(),
      updated: stamp(index * 3 + 4),
      knowledgeHits: req.knowledgeHits,
    });
  });

  fs.writeFileSync(REQ_FILE, JSON.stringify(requirements, null, 2), 'utf8');
  console.log(`已生成 ${requirements.length} 条演示需求 -> ${REQ_FILE}`);
  requirements.forEach((r) =>
    console.log(`  - ${r.id}  ${r.owner}  ${r.progress}/6  ${r.riskTone}  ${r.name}`)
  );
}

build();
