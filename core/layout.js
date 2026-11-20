// core/layout.js — 布局计算（纯逻辑，零 DOM 依赖）
// 职责：为每个节点计算抽象坐标（列序 / 深度）与子树叶子宽度，供生成器写入 computed.json。
// 第 4 步实现（由 tools/generate.js 调用）。
