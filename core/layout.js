// core/layout.js — 结构计算（纯逻辑，零 DOM 依赖）
// 职责：为每个节点计算深度方向的结构量（子树叶子宽度、默认展开集），供生成器写入 computed.json。
// 第 4 步实现（由 tools/generate.js 调用）；2026-11-20 起不再产出坐标：
// 排布必须随聚焦状态动态重算，坐标由渲染层按设计文档 5.1 的主干对齐规则实时计算。
//
// 默认展开口径（历史默认状态）：展开到第 2 层，即深度 < 2 的节点默认展开，
// 可见节点为深度 <= 2 的节点。

'use strict';

const DEFAULT_DEPTH = 2;

function computeLayout(model, ancestryInfo) {
  // 全树子树叶子宽度：叶子计 1，内部节点为其所有叶子后代之和。
  const subtreeLeafWidth = new Map();
  const width = (id) => {
    const kids = model.childrenOf(id);
    if (!kids.length) {
      subtreeLeafWidth.set(id, 1);
      return 1;
    }
    let sum = 0;
    for (const c of kids) sum += width(c);
    subtreeLeafWidth.set(id, sum);
    return sum;
  };
  width(model.rootId);

  const defaultExpanded = new Map();
  const defaultVisible = new Map();
  for (const id of model.order) {
    const info = ancestryInfo.get(id);
    defaultExpanded.set(id, info.depth < DEFAULT_DEPTH && model.childrenOf(id).length > 0);
    // 可见 <=> 全部祖先默认展开（根无祖先，恒可见）
    defaultVisible.set(id, info.ancestors.every((a) => defaultExpanded.get(a)));
  }

  const result = new Map();
  for (const id of model.order) {
    result.set(id, {
      subtreeLeafWidth: subtreeLeafWidth.get(id),
      defaultExpanded: defaultExpanded.get(id),
      defaultVisible: defaultVisible.get(id),
    });
  }
  return result;
}

module.exports = { computeLayout, DEFAULT_DEPTH };
