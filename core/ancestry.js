// core/ancestry.js — 祖先链计算（纯逻辑，零 DOM 依赖）
// 职责：给定节点 id，返回它回溯到根（挪亚）的祖先链，供高亮路径与 computed.json 使用。
// 第 4 步实现。

'use strict';

// 返回 Map：id -> { depth, ancestors }，ancestors 为从根到父节点的 id 数组（不含自身）。
function computeAncestry(model) {
  const info = new Map();
  const walk = (id, ancestors) => {
    info.set(id, { depth: ancestors.length, ancestors: ancestors.slice() });
    for (const c of model.childrenOf(id)) walk(c, ancestors.concat(id));
  };
  walk(model.rootId, []);
  return info;
}

// 含自身的高亮路径：[根, …, id]
function chainTo(info, id) {
  return info.get(id).ancestors.concat(id);
}

module.exports = { computeAncestry, chainTo };
