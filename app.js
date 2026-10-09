'use strict';
/* ================================================================
 * 素材成曲 · 可行性验证 —— 应用逻辑
 * 架构：七模块（图片解析/提示词解析/方案合成/Prompt生成/作曲/渲染导出/历史）
 *       + 验证专用批量实验模块 + 规则自检
 * 分层约束：synthPlan 为纯函数（签名不含任何随机量）；
 *           种子只注入 composeMusic（细节层）。
 * ================================================================ */

/* ---------- 配置 ---------- */
const CFG = {
  durSec: 15, sr: 44100, maxSide: 2048, thumbSide: 200,
  histMax: 20, mp3Base: 'http://127.0.0.1:7777'
};

/* ---------- 词典（数据化，可独立调整不改逻辑） ---------- */
const EMO = {
  '温暖': { style:'氛围电子', bpm:[70,100],  mode:'maj', energy:45, warm: 1, bright: 1 },
  '治愈': { style:'氛围电子', bpm:[65,95],   mode:'maj', energy:35, warm: 1, bright: 1 },
  '科技': { style:'电子',    bpm:[100,125], mode:'min', energy:60, warm: 0, bright:-1 },
  '轻快': { style:'流行',    bpm:[110,135], mode:'maj', energy:75, warm: 0, bright: 1 },
  '活力': { style:'流行',    bpm:[115,140], mode:'maj', energy:85, warm: 0, bright: 1 },
  '紧张': { style:'电子',    bpm:[100,130], mode:'min', energy:70, warm: 0, bright:-1 },
  '悲伤': { style:'钢琴叙事',bpm:[55,80],   mode:'min', energy:25, warm:-1, bright:-1 },
  '大气': { style:'管弦',    bpm:[80,105],  mode:'maj', energy:65, warm: 0, bright: 1 },
  '恢弘': { style:'管弦',    bpm:[85,110],  mode:'maj', energy:80, warm: 0, bright: 1 },
  '神秘': { style:'氛围电子',bpm:[70,95],   mode:'min', energy:40, warm: 0, bright:-1 },
  '俏皮': { style:'流行',    bpm:[115,140], mode:'maj', energy:80, warm: 1, bright: 1 },
  '深沉': { style:'钢琴叙事',bpm:[60,85],   mode:'min', energy:35, warm:-1, bright:-1 },
  '热血': { style:'摇滚',    bpm:[125,150], mode:'maj', energy:90, warm: 1, bright: 1 },
  '激昂': { style:'摇滚',    bpm:[120,150], mode:'maj', energy:90, warm: 0, bright: 1 },
  '宁静': { style:'氛围电子',bpm:[55,80],   mode:'maj', energy:25, warm: 1, bright: 0 },
  '浪漫': { style:'钢琴叙事',bpm:[70,95],   mode:'maj', energy:45, warm: 1, bright: 1 },
  '忧郁': { style:'钢琴叙事',bpm:[58,82],   mode:'min', energy:30, warm:-1, bright:-1 },
  '兴奋': { style:'电子',    bpm:[120,145], mode:'maj', energy:85, warm: 0, bright: 1 },
  '空灵': { style:'氛围电子',bpm:[60,85],   mode:'min', energy:30, warm: 0, bright: 1 },
  '复古': { style:'复古电子',bpm:[95,120],  mode:'min', energy:55, warm: 0, bright: 0 }
};
const SCENE = {
  '产品发布': { add:['轻鼓'],   bpm:  5 },
  '宣传片':   { add:['弦乐Pad'],bpm:  0 },
  '活动':     { add:['轻鼓'],   bpm:  8 },
  '旅行':     { add:['拨弦'],   bpm:  5 },
  'vlog':     { add:['拨弦'],   bpm:  8 },
  '纪录':     { add:['钢琴'],   bpm: -5 },
  '游戏':     { add:['合成贝斯'],bpm:12 },
  '派对':     { add:['轻鼓'],   bpm: 15 }
};
/* 节奏 4 档（顺序即匹配优先级，长词优先防误配） */
const TEMPO_LIST = [
  ['缓慢',[55,85]],['舒缓',[55,85]],['中速',[85,110]],['轻快',[110,130]],
  ['激烈',[130,160]],['卡点',[130,160]],['慢',[55,85]],['快',[130,160]]
];
/* 禁用 6 类 */
const BAN_RULES = [
  { name:'人声', kw:['人声','歌声','哼唱','唱'] },
  { name:'鼓',   kw:['鼓','打击'] },
  { name:'贝斯', kw:['贝斯','低音'] },
  { name:'钢琴', kw:['钢琴'] },
  { name:'弦乐', kw:['弦乐'] },
  { name:'吵闹', kw:['吵','嘈杂','闹'] }
];
const STYLE_EN = {
  '氛围电子':'ambient electronic','电子':'electronic','流行':'pop',
  '钢琴叙事':'emotional piano','管弦':'orchestral','摇滚':'rock','复古电子':'retro synthwave'
};
const INST_EN = {
  '钢琴':'piano','合成Pad':'warm synth pad','弦乐Pad':'string pad','拨弦':'plucked strings',
  '合成贝斯':'synth bass','贝斯':'bass','轻鼓':'soft drums','鼓':'drums'
};
const MOOD_EN = {
  '温暖':'warm','治愈':'healing','科技':'techy','轻快':'light-hearted','活力':'energetic',
  '紧张':'tense','悲伤':'sad','大气':'grand','恢弘':'epic','神秘':'mysterious',
  '俏皮':'playful','深沉':'deep','热血':'passionate','激昂':'uplifting','宁静':'serene',
  '浪漫':'romantic','忧郁':'melancholic','兴奋':'excited','空灵':'ethereal','复古':'nostalgic'
};
const BAN_EN = {
  '人声':'vocals, singing','鼓':'drums and percussion','贝斯':'bass',
  '钢琴':'piano','弦乐':'strings','吵闹':'loud noisy mix'
};
const TONICS = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
/* 12 个示例标签（点击整句填入） */
const TAGS = [
  { label:'温暖治愈', full:'温暖治愈，适合产品发布片开头，不要人声' },
  { label:'科技感',   full:'科技感，紧张而克制，不要鼓' },
  { label:'轻快活力', full:'轻快活力，适合 vlog 片头，不要太吵' },
  { label:'大气恢弘', full:'大气恢弘，宣传片氛围，不要人声' },
  { label:'宁静安详',