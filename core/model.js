// core/model.js — 谱系模型（纯逻辑，零 DOM 依赖）
// 职责：读取 nations.json 的节点数组，构建 id 索引与父子关系映射，供 layout / ancestry 使用。
// 第 4 步实现。生成器在 Node 环境调用本模块；浏览器端只读 computed.json，不加载 core/。

'use strict';

function buildModel(data) {
  if (!data || !Array.isArray(data.nodes)) {
    throw new Error('nations.json 结构错误：缺少 nodes 数组');
  }
  const byId = new Map();
  for (const n of data.nodes) {
    if (byId.has(n.id)) throw new Error('节点 id 重复：' + n.id);
    byId.set(n.id, n);
  }
  const children = new Map(); // parentId -> 子节点 id 数组（保持数据文件中的顺序，即同辈顺序）
  let rootId = null;
  for (const n of data.nodes) {
    if (n.parentId === null) {
      if (rootId !== null) throw new Error('存在多个根节点');
      rootId = n.id;
    } else {
      if (!byId.has(n.parentId)) throw new Error('父节点不存在：' + n.id + ' -> ' + n.parentId);
      if (!children.has(n.parentId)) children.set(n.parentId, []);
      children.get(n.parentId).push(n.id);
    }
  }
  if (rootId === null) throw new Error('没有根节点（parentId 为 null 的节点）');
  if (data.rootId && data.rootId !== rootId) throw new Error('rootId 与根节点不一致：' + data.rootId);
  // 可达性与环检测：从根出发遍历，访问到的节点数必须等于总数
  const seen = new Set();
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) throw new Error('谱系存在环：' + id);
    seen.add(id);
    for (const c of children.get(id) || []) stack.push(c);
  }
  if (seen.size !== data.nodes.length) {
    throw new Error('有节点不在根的可达范围内（' + seen.size + ' / ' + data.nodes.length + '）');
  }
  return {
    rootId,
    byId,
    order: data.nodes.map((n) => n.id),
    childrenOf: (id) => children.get(id) || [],
    parentOf: (id) => byId.get(id).parentId,
  };
}

module.exports = { buildModel };
