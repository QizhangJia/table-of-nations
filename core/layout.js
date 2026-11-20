// core/layout.js — 布局计算（纯逻辑，零 DOM 依赖）
// 职责：为每个节点计算抽象坐标（列序 / 深度）与子树叶子宽度，供生成器写入 computed.json。
// 第 4 步实现（由 tools/generate.js 调用）。
//
// 抽象坐标约定（设计文档第 4、6 节）：
// - 只存「叶子列序 × 深度」的抽象量，不存像素；渲染层绘制时按节点尺寸换算。
// - 只预计算默认展开状态的布局；其余展开状态由渲染层用 subtreeLeafWidth 做累加排布。
// - 默认展开口径（设计文档 5.1）：展开到第 2 层，即深度 < 2 的节点默认展开，
//   可见节点为深度 <= 2 的节点。

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

  // 默认视图布局：按同辈顺序深度优先，为可见叶子依次分配列号，
  // 内部节点的列 = 其可见叶子跨度的中点。
  const defaultCol = new Map();
  let nextLeaf = 0;
  const layoutVisible = (id) => {
    const kids = model.childrenOf(id).filter((c) => defaultVisible.get(c));
    if (!kids.length) {
      const c = nextLeaf++;
      defaultCol.set(id, c);
      return [c, c];
    }
    let first = null;
    let last = null;
    for (const k of kids) {
      const span = layoutVisible(k);
      if (first === null) first = span[0];
      last = span[1];
    }
    defaultCol.set(id, (first + last) / 2);
    return [first, last];
  };
  layoutVisible(model.rootId);

  const result = new Map();
  for (const id of model.order) {
    result.set(id, {
      subtreeLeafWidth: subtreeLeafWidth.get(id),
      defaultExpanded: defaultExpanded.get(id),
      defaultVisible: defaultVisible.get(id),
      defaultCol: defaultVisible.get(id) ? defaultCol.get(id) : null,
    });
  }
  return result;
}

module.exports = { computeLayout, DEFAULT_DEPTH };
