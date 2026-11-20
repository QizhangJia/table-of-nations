// tools/generate.js — 生成器（第 4 步实现）
// 职责：读 data/nations.json → 调用 core/ 计算 → 写 data/computed.json（内嵌源数据指纹）。
// 要求：确定性输出（不含时间戳、键序稳定），同一源数据永远产出同一结果。
//
// 用法：node tools/generate.js [--data <path>] [--out <path>]
// 默认：--data data/nations.json，--out data/computed.json（相对仓库根目录）。
// CI 在部署时运行本脚本现场生成 computed.json；该文件不入仓（见 .gitignore）。
//
// computed.json 内容（设计文档 4.1）：
// - sourceHash：nations.json 原始字节的 SHA-256，即数据指纹；
//   发布时另在 data/<sourceHash>/computed.json 存一份固化版。
// - nodes：每节点的 depth、ancestors（祖先链）、children、subtreeLeafWidth（全树子树叶子宽）、
//   defaultExpanded / defaultVisible。坐标不在预计算内（2026-11-20 定，version 2）：
//   排布由渲染层按当前聚焦状态实时计算（设计文档 5.1 主干对齐规则）。
// - presentation：每节点按权重入选的呈现经文 { origin, faith }（选取规则见设计文档 4.2：
//   weight 降序，同分按经卷 / 章 / 节的正典顺序取先者；无经文为 null）。

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { buildModel } = require('../core/model');
const { computeAncestry } = require('../core/ancestry');
const { computeLayout, DEFAULT_DEPTH } = require('../core/layout');

// 正典书卷顺序（用于同权重时的确定性 tie-break）
const BOOK_ORDER = {
  GEN: 1, EXO: 2, LEV: 3, NUM: 4, DEU: 5, JOS: 6, JDG: 7, RUT: 8,
  '1SA': 9, '2SA': 10, '1KI': 11, '2KI': 12, '1CH': 13, '2CH': 14,
  EZR: 15, NEH: 16, EST: 17, JOB: 18, PSA: 19, PRO: 20, ECC: 21, SNG: 22,
  ISA: 23, JER: 24, LAM: 25, EZK: 26, DAN: 27, HOS: 28, JOL: 29, AMO: 30,
  OBA: 31, JON: 32, MIC: 33, NAM: 34, HAB: 35, ZEP: 36, HAG: 37, ZEC: 38, MAL: 39,
};

// 从 YouVersion 链接解析 (书卷, 章, 节)：…/bible/48/GEN.10.13-14.CUNPSS-…
function parseRef(link) {
  const m = /\/([0-9]?[A-Z]+)\.(\d+)\.(\d+)/.exec(link || '');
  if (!m) return [999, 999, 999];
  return [BOOK_ORDER[m[1]] || 999, parseInt(m[2], 10), parseInt(m[3], 10)];
}

// 选取呈现经文：weight 降序；同分按正典顺序（书卷、章、节）取先者。
function pickPresentation(list) {
  if (!list || !list.length) return null;
  const sorted = list.slice().sort((a, b) => {
    if (b.weight !== a.weight) return b.weight - a.weight;
    const ra = parseRef(a.link);
    const rb = parseRef(b.link);
    for (let i = 0; i < 3; i++) if (ra[i] !== rb[i]) return ra[i] - rb[i];
    return 0;
  });
  const s = sorted[0];
  return { text: s.text, ref: s.ref, link: s.link, weight: s.weight };
}

function main() {
  const argv = process.argv.slice(2);
  const opt = (name, dflt) => {
    const i = argv.indexOf('--' + name);
    return i >= 0 ? argv[i + 1] : dflt;
  };
  const root = path.join(__dirname, '..');
  const dataPath = path.resolve(root, opt('data', 'data/nations.json'));
  const outPath = path.resolve(root, opt('out', 'data/computed.json'));

  const raw = fs.readFileSync(dataPath);
  const sourceHash = crypto.createHash('sha256').update(raw).digest('hex');
  const data = JSON.parse(raw.toString('utf8'));

  const model = buildModel(data);
  const ancestry = computeAncestry(model);
  const layout = computeLayout(model, ancestry);

  const nodes = model.order.map((id) => {
    const a = ancestry.get(id);
    const l = layout.get(id);
    return {
      id,
      depth: a.depth,
      ancestors: a.ancestors,
      children: model.childrenOf(id),
      subtreeLeafWidth: l.subtreeLeafWidth,
      defaultExpanded: l.defaultExpanded,
      defaultVisible: l.defaultVisible,
    };
  });

  const presentation = {};
  for (const id of model.order) {
    const n = model.byId.get(id);
    presentation[id] = {
      origin: pickPresentation(n.scripturesOrigin),
      faith: pickPresentation(n.scripturesFaith),
    };
  }

  const out = {
    version: 2,
    sourceHash,
    rootId: model.rootId,
    defaultDepth: DEFAULT_DEPTH,
    nodes,
    presentation,
  };

  fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n', 'utf8');
  const visible = nodes.filter((n) => n.defaultVisible).length;
  console.log(
    'computed.json 已生成：节点 ' + nodes.length + '，默认可见 ' + visible +
    '，sourceHash ' + sourceHash.slice(0, 12) + '…'
  );
}

main();
