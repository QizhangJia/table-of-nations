// web/render.js — SVG 渲染与交互（第 5 步实现）
// 职责：只读数据与计算结果来画：展开/折叠、平移/缩放、高亮回溯、悬停提示、点击详情卡。
// 排布由本层按当前聚焦状态实时计算（设计文档 5.1 紧凑排布与主干对齐）；
// 预计算只提供结构（祖先链 / 子节点 / 深度）与呈现经文，不含坐标。
(function (global) {
  'use strict';

  var GAP_X = 24; // 兄弟子树轮廓之间的水平间隙（像素）
  var ROW_GAP = 34; // 行与行之间的垂直间隙（像素）
  var CARD_W = 172; // 民族卡宽度
  var LINK_W = 132; // 连接人物卡宽度
  var MAX_K = 2.5; // 缩放上限（最近）；下限动态计算 = 整树恰好入屏（设计文档 5.1）
  var PAN_MARGIN = 120; // 拖动边界：整树包围盒与视口的最小重叠（像素）
  var SMALL_W = 720; // 小视口阈值：宽或高低于阈值即用焦点近景
  var SMALL_H = 480;
  var SMALL_K = 0.85; // 小视口焦点近景的缩放

  // Okabe–Ito 色盲友好色板：三系各一色，根为中性灰（另有文字标签，不单靠颜色区分）
  var LINE_COLORS = { shem: '#0072B2', ham: '#D55E00', japheth: '#009E73', root: '#8E8E93' };

  function truncate(s, n) {
    s = String(s || '');
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function nameOf(node) {
    return (node.name && node.name['zh-Hans']) || node.id;
  }

  // 民族卡内容行：有才显示（设计文档 5.2）
  function nationLines(node, t) {
    var lines = [];
    var anc = node.ancestor && node.ancestor['zh-Hans'];
    if (anc) lines.push({ label: t('ancestor'), text: anc });
    if (node.ancestorYears) lines.push({ label: t('years'), text: node.ancestorYears });
    if (node.faith) lines.push({ label: t('faith'), text: node.faith });
    return lines;
  }
  function cardWidth(node) {
    return node.type === 'link' ? LINK_W : CARD_W;
  }
  function cardHeight(node, t) {
    if (node.type === 'link') return node.years ? 54 : 40;
    return 46 + nationLines(node, t).length * 17;
  }

  function buildModel(nations, computed) {
    var byId = new Map(
      nations.nodes.map(function (n) {
        return [n.id, n];
      })
    );
    var compById = new Map(
      computed.nodes.map(function (n) {
        return [n.id, n];
      })
    );
    return {
      rootId: computed.rootId,
      node: function (id) {
        return byId.get(id);
      },
      comp: function (id) {
        return compById.get(id);
      },
      childrenOf: function (id) {
        return compById.get(id).children;
      },
    };
  }

  function lineKeyOf(model, id) {
    var c = model.comp(id);
    if (c.depth === 0) return 'root';
    if (c.depth === 1) return id;
    return c.ancestors[1];
  }

  // 纯布局：给定展开集合与焦点链集合，算出每个可见节点的中心 x 与顶部 y（像素）。
  // 紧凑排布与主干对齐（设计文档 5.1）：
  // - 深度轮廓打包：子树占位按逐深度轮廓计算，兄弟子树逐个贴放、只在它实际
  //   有节点的深度上占宽（浅子树可嵌进深子树旁的空位，如以扫贴在雅各左侧），
  //   各深度轮廓之间留 GAP_X；
  // - 在焦点链上的子节点称「主干子节点」：父有 1 个主干子节点时父中心与之对齐
  //   （主干成竖线）；有 2 个时（双焦点在共同祖先处分叉）父中心取两者中点，
  //   两支线各成竖线并排而下；有 0 个时（焦点本身）父在子节点轮廓跨度上居中；
  // - 每行高度取该行最高卡片 + ROW_GAP。
  function computePositions(model, expanded, chainSet, t) {
    var tt =
      t ||
      function () {
        return '';
      };
    var chain = chainSet || new Set();
    // measure(id) 返回（坐标以本节点中心为原点）：
    //   profile: {相对深度: [左界, 右界]} —— 本子树在各深度的占位轮廓；
    //   kids: [{id, info, dx}] —— 子节点中心相对本节点中心的水平偏移。
    function measure(id) {
      var node = model.node(id);
      var w = cardWidth(node);
      var h = cardHeight(node, tt);
      var kids = model.childrenOf(id);
      var visibleKids = kids.length && expanded.has(id) ? kids : [];
      if (!visibleKids.length) {
        var p0 = {};
        p0[0] = [-w / 2, w / 2];
        return { w: w, h: h, profile: p0, kids: [] };
      }
      var infos = visibleKids.map(measure);
      // 逐个贴放子子树：acc 为已放子树在「子节点行坐标系」下的合并轮廓
      // （深度 0 = 子节点行）；每个新子树的偏移取所有共享深度上恰好让出
      // GAP_X 的最小值，无共享深度时不产生约束。
      var acc = null;
      var shifts = [];
      infos.forEach(function (ci) {
        var s = 0;
        if (acc) {
          s = null;
          Object.keys(ci.profile).forEach(function (d) {
            if (acc[d]) {
              var need = acc[d][1] + GAP_X - ci.profile[d][0];
              s = s === null ? need : Math.max(s, need);
            }
          });
          if (s === null) s = 0;
        }
        shifts.push(s);
        var merged = acc || {};
        Object.keys(ci.profile).forEach(function (d) {
          var l = s + ci.profile[d][0];
          var r = s + ci.profile[d][1];
          if (merged[d]) {
            merged[d][0] = Math.min(merged[d][0], l);
            merged[d][1] = Math.max(merged[d][1], r);
          } else {
            merged[d] = [l, r];
          }
        });
        acc = merged;
      });
      // 主干对齐：在子节点行坐标系下定本节点中心
      var spine = [];
      visibleKids.forEach(function (c, i) {
        if (chain.has(c)) spine.push(i);
      });
      var center;
      if (spine.length === 1) {
        center = shifts[spine[0]];
      } else if (spine.length >= 2) {
        center = (shifts[spine[0]] + shifts[spine[spine.length - 1]]) / 2;
      } else {
        var cMin = Infinity;
        var cMax = -Infinity;
        Object.keys(acc).forEach(function (d) {
          cMin = Math.min(cMin, acc[d][0]);
          cMax = Math.max(cMax, acc[d][1]);
        });
        center = (cMin + cMax) / 2;
      }
      var profile = {};
      profile[0] = [-w / 2, w / 2];
      Object.keys(acc).forEach(function (d) {
        profile[Number(d) + 1] = [acc[d][0] - center, acc[d][1] - center];
      });
      return {
        w: w,
        h: h,
        profile: profile,
        kids: visibleKids.map(function (c, i) {
          return { id: c, info: infos[i], dx: shifts[i] - center };
        }),
      };
    }
    var rootInfo = measure(model.rootId);
    var rowH = [];
    var pos = new Map();
    (function place(id, inf, cx, depth) {
      pos.set(id, { x: cx, y: 0, depth: depth, w: inf.w, h: inf.h });
      rowH[depth] = Math.max(rowH[depth] || 0, inf.h);
      inf.kids.forEach(function (k) {
        place(k.id, k.info, cx + k.dx, depth + 1);
      });
    })(model.rootId, rootInfo, 0, 0);
    var yOf = [0];
    for (var d = 1; d < rowH.length; d++) yOf[d] = yOf[d - 1] + rowH[d - 1] + ROW_GAP;
    pos.forEach(function (p) {
      p.y = yOf[p.depth];
    });
    var last = rowH.length - 1;
    var totalHeight = (yOf[last] || 0) + (rowH[last] || 0);
    var minX = Infinity;
    var maxX = -Infinity;
    pos.forEach(function (p) {
      minX = Math.min(minX, p.x - p.w / 2);
      maxX = Math.max(maxX, p.x + p.w / 2);
    });
    return {
      positions: pos,
      totalWidth: maxX - minX,
      totalHeight: totalHeight,
      bbox: { l: minX, r: maxX, t: 0, b: totalHeight },
    };
  }

  // 缩放下限（设计文档 5.1）：整棵可见树恰好完整放入视口的缩放，且不超过 1。
  function minZoomFor(bbox, vw, vh) {
    return Math.max(0.02, Math.min(1, (vw - 24) / (bbox.r - bbox.l), (vh - 24) / (bbox.b - bbox.t)));
  }

  function mount(opts) {
    var svg = opts.svg;
    var tooltip = opts.tooltip;
    var detail = opts.detail;
    var t = opts.t;
    var model = buildModel(opts.nations, opts.computed);
    var presentation = opts.computed.presentation || {};
    // 聚焦模型（设计文档 5.1）：当前焦点 + 记忆焦点，展开集合由焦点派生。
    var focusCurrent = 'israel';
    var focusRemembered = null;
    var detailNode = null;
    var view = { k: 1, tx: 0, ty: 0 };
    var lastLayout = null; // 最近一次排布：缩放下限与拖动边界据此计算
    var userMoved = false; // 用户已手动平移/缩放后，resize 不再自动重新取景
    var NS = 'http://www.w3.org/2000/svg';

    function el(tag, attrs, parent) {
      var e = document.createElementNS(NS, tag);
      for (var k in attrs) e.setAttribute(k, attrs[k]);
      if (parent) parent.appendChild(e);
      return e;
    }
    function text(parent, x, y, str, cls) {
      var e = el('text', { x: x, y: y, 'class': cls }, parent);
      e.textContent = str;
      return e;
    }

    var gRoot = el('g', {}, svg);
    var gLinks = el('g', {}, gRoot);
    var gNodes = el('g', {}, gRoot);

    function viewport() {
      return { w: svg.clientWidth || 800, h: svg.clientHeight || 600 };
    }
    function currentMinK() {
      if (!lastLayout) return 0.02;
      var vp = viewport();
      return minZoomFor(lastLayout.bbox, vp.w, vp.h);
    }
    // 视角钳制（设计文档 5.1）：缩放限制在 [整树入屏, 2.5]；拖动边界保证
    // 整树包围盒与视口至少重叠 PAN_MARGIN，任何方向都拖不丢。
    function clampView() {
      if (!lastLayout) return;
      var vp = viewport();
      var b = lastLayout.bbox;
      view.k = Math.min(MAX_K, Math.max(currentMinK(), view.k));
      var txLo = PAN_MARGIN - b.r * view.k;
      var txHi = vp.w - PAN_MARGIN - b.l * view.k;
      var tyLo = PAN_MARGIN - b.b * view.k;
      var tyHi = vp.h - PAN_MARGIN - b.t * view.k;
      view.tx = txLo > txHi ? (vp.w - (b.l + b.r) * view.k) / 2 : Math.min(txHi, Math.max(txLo, view.tx));
      view.ty = tyLo > tyHi ? (vp.h - (b.t + b.b) * view.k) / 2 : Math.min(tyHi, Math.max(tyLo, view.ty));
    }
    function applyView() {
      clampView();
      gRoot.setAttribute(
        'transform',
        'translate(' + view.tx + ',' + view.ty + ') scale(' + view.k + ')'
      );
    }

    function foci() {
      return focusRemembered && focusRemembered !== focusCurrent
        ? [focusRemembered, focusCurrent]
        : [focusCurrent];
    }
    // 两焦点「祖先链 + 自身」的并集：既是展开集合，也是高亮集合。
    function currentExpanded() {
      var s = new Set();
      foci().forEach(function (f) {
        model.comp(f).ancestors.forEach(function (a) {
          s.add(a);
        });
        s.add(f);
      });
      return s;
    }
    function sameChain(a, b) {
      return (
        a === b ||
        model.comp(a).ancestors.indexOf(b) >= 0 ||
        model.comp(b).ancestors.indexOf(a) >= 0
      );
    }
    function inSubtree(f, x) {
      return f === x || model.comp(f).ancestors.indexOf(x) >= 0;
    }
    function normalizeFoci() {
      if (focusRemembered === focusCurrent) focusRemembered = null;
    }
    // 节点点击的聚焦规则（设计文档 5.1）：同链移动 / 记忆支转正 / 异链新支（挤掉旧记忆）
    function applyFocusClick(x) {
      if (sameChain(x, focusCurrent)) {
        focusCurrent = x;
      } else if (focusRemembered && sameChain(x, focusRemembered)) {
        var old = focusCurrent;
        focusCurrent = x;
        focusRemembered = old;
      } else {
        focusRemembered = focusCurrent;
        focusCurrent = x;
      }
      normalizeFoci();
    }
    // +/− 钮：未展开 → 同聚焦手势（不开详情）；已展开 → 把其子树内的焦点上移到它，
    // 焦点若就是它本身则上移到其父节点（折叠一层）。
    function applyToggle(x) {
      if (!currentExpanded().has(x)) {
        applyFocusClick(x);
        return;
      }
      var which = null;
      if (inSubtree(focusCurrent, x)) which = 'current';
      else if (focusRemembered && inSubtree(focusRemembered, x)) which = 'remembered';
      if (!which) return;
      var f = which === 'current' ? focusCurrent : focusRemembered;
      var dest = x;
      if (f === x) {
        var anc = model.comp(x).ancestors;
        dest = anc[anc.length - 1];
        if (!dest) return; // 焦点即根，无可上移
      }
      if (which === 'current') focusCurrent = dest;
      else focusRemembered = dest;
      normalizeFoci();
    }

    function render() {
      var expanded = currentExpanded();
      var chain = expanded;
      var focusSet = new Set(foci());
      var layout = computePositions(model, expanded, chain, t);
      lastLayout = layout;
      while (gLinks.firstChild) gLinks.removeChild(gLinks.firstChild);
      while (gNodes.firstChild) gNodes.removeChild(gNodes.firstChild);

      layout.positions.forEach(function (p, id) {
        var comp = model.comp(id);
        var parent = comp.ancestors[comp.ancestors.length - 1];
        if (!parent || !layout.positions.has(parent)) return;
        var pp = layout.positions.get(parent);
        var x1 = pp.x;
        var y1 = pp.y + cardHeight(model.node(parent), t);
        var x2 = p.x;
        var y2 = p.y;
        var dy = Math.max(14, (y2 - y1) / 2);
        var d =
          'M ' + x1 + ' ' + y1 +
          ' C ' + x1 + ' ' + (y1 + dy) + ', ' + x2 + ' ' + (y2 - dy) + ', ' + x2 + ' ' + y2;
        var onChain = chain.has(id);
        var path = el('path', { d: d, 'class': 'link' + (onChain ? ' link-hl' : '') }, gLinks);
        path.style.stroke = LINE_COLORS[lineKeyOf(model, id)];
      });

      layout.positions.forEach(function (p, id) {
        var node = model.node(id);
        var w = cardWidth(node);
        var h = cardHeight(node, t);
        var x = p.x - w / 2;
        var y = p.y;
        var cls =
          'node' +
          (node.type === 'link' ? ' node-link' : '') +
          (focusSet.has(id) ? ' node-hl' : '');
        var g = el('g', { 'class': cls, 'data-id': id }, gNodes);
        var line = lineKeyOf(model, id);
        if (node.type === 'link') {
          el('rect', { x: x, y: y, width: w, height: h, rx: h / 2, 'class': 'card card-link' }, g);
          text(g, p.x, y + (node.years ? 23 : 25), nameOf(node), 'card-name-link').setAttribute(
            'text-anchor',
            'middle'
          );
          if (node.years) {
            text(g, p.x, y + 41, truncate(node.years, 16), 'card-sub').setAttribute(
              'text-anchor',
              'middle'
            );
          }
        } else {
          el('rect', { x: x, y: y, width: w, height: h, rx: 10, 'class': 'card' }, g);
          var bar = el('rect', { x: x + 6, y: y + 1, width: w - 12, height: 4, rx: 2, 'class': 'card-bar' }, g);
          bar.style.fill = LINE_COLORS[line];
          text(g, x + 12, y + 27, truncate(nameOf(node), 9), 'card-name');
          if (line !== 'root') {
            var lt = text(g, x + w - 10, y + 27, t('line_' + line), 'card-line');
            lt.setAttribute('text-anchor', 'end');
            lt.style.fill = LINE_COLORS[line];
          }
          nationLines(node, t).forEach(function (ln, i) {
            text(g, x + 12, y + 47 + i * 17, ln.label + '：' + truncate(ln.text, 13), 'card-sub');
          });
        }
        var kids = model.childrenOf(id);
        if (kids.length) {
          var tg = el('g', { 'class': 'toggle', 'data-toggle': id }, g);
          el('circle', { cx: x + w, cy: y, r: 17, 'class': 'toggle-circle' }, tg);
          var sign = text(tg, x + w, y + 7, expanded.has(id) ? '−' : '+', 'toggle-sign');
          sign.setAttribute('text-anchor', 'middle');
        }
      });

      if (detailNode && !layout.positions.has(detailNode)) closeDetail();
      applyView();
      return layout;
    }

    // 聚焦区域：两条焦点链 + 焦点的直接子节点（初始相机适配目标，设计文档 5.1）
    function focusRegion(layout) {
      var ids = new Set(currentExpanded());
      foci().forEach(function (f) {
        model.childrenOf(f).forEach(function (c) {
          ids.add(c);
        });
      });
      var r = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
      ids.forEach(function (id) {
        var p = layout.positions.get(id);
        if (!p) return;
        r.minX = Math.min(r.minX, p.x - p.w / 2);
        r.maxX = Math.max(r.maxX, p.x + p.w / 2);
        r.minY = Math.min(r.minY, p.y);
        r.maxY = Math.max(r.maxY, p.y + p.h);
      });
      return r;
    }
    // 初始相机按视口分档（设计文档 5.1）：大视口按聚焦区域适配；小视口
    // （手机等）用焦点近景——焦点居中、约 36% 高度、缩放 SMALL_K，不要求
    // 显示到根、也不要求焦点的子节点完整入屏。
    function fitView() {
      var layout = layoutNow();
      lastLayout = layout;
      var vp = viewport();
      var fp = layout.positions.get(focusCurrent);
      if ((vp.w < SMALL_W || vp.h < SMALL_H) && fp) {
        view.k = Math.min(MAX_K, Math.max(currentMinK(), SMALL_K));
        view.tx = vp.w / 2 - fp.x * view.k;
        view.ty = vp.h * 0.36 - (fp.y + fp.h / 2) * view.k;
      } else {
        var r = focusRegion(layout);
        var rw = r.maxX - r.minX;
        var rh = r.maxY - r.minY;
        var k = Math.min(1, (vp.w - 32) / rw, (vp.h - 32) / rh);
        view.k = Math.max(currentMinK(), k);
        view.tx = (vp.w - rw * view.k) / 2 - r.minX * view.k;
        view.ty = (vp.h - rh * view.k) / 2 - r.minY * view.k;
      }
      applyView();
    }
    // 点击锚定（设计文档 5.1）：重排前后让被点节点停留在同一屏幕位置
    function anchorOn(id, beforeLayout, afterLayout) {
      var b = beforeLayout.positions.get(id);
      var a = afterLayout.positions.get(id);
      if (!b || !a) return;
      view.tx += (b.x - a.x) * view.k;
      view.ty += (b.y + b.h / 2 - (a.y + a.h / 2)) * view.k;
      applyView();
    }
    function layoutNow() {
      return computePositions(model, currentExpanded(), currentExpanded(), t);
    }

    // ---------- 详情卡 ----------
    function scriptureBlock(title, s) {
      if (!s) return '';
      return (
        '<div class="d-section"><h3>' + esc(title) + '</h3>' +
        '<blockquote>「' + esc(s.text) + '」</blockquote>' +
        '<div class="d-ref">' + esc(s.ref) +
        ' · <a href="' + esc(s.link) + '" target="_blank" rel="noopener">' + esc(t('readOnYouVersion')) + '</a></div></div>'
      );
    }
    function rowHTML(label, value) {
      if (!value) return '';
      return '<div class="d-row"><span class="d-label">' + esc(label) + '</span><span>' + esc(value) + '</span></div>';
    }
    function openDetail(id) {
      detailNode = id;
      var node = model.node(id);
      var pres = presentation[id] || {};
      var line = lineKeyOf(model, id);
      var html = '';
      html += '<button type="button" class="d-close" data-close aria-label="' + esc(t('close')) + '">×</button>';
      html += '<h2>' + esc(nameOf(node)) + '</h2>';
      html +=
        '<div class="d-line" style="color:' + LINE_COLORS[line] + '">' +
        esc(line === 'root' ? t('rootLine') : t('line_' + line)) +
        (node.type === 'link' ? ' · ' + esc(t('linkPerson')) : '') +
        '</div>';
      if (node.type === 'link') {
        html += rowHTML(t('years'), node.years);
      } else {
        html += rowHTML(t('ancestor'), node.ancestor && node.ancestor['zh-Hans']);
        html += rowHTML(t('years'), node.ancestorYears);
        html += rowHTML(t('faith'), node.faith);
        html += rowHTML(t('region'), node.region);
        html += rowHTML(t('modern'), node.modernRef);
        html += scriptureBlock(t('originVerse'), pres.origin);
        html += scriptureBlock(t('faithVerse'), pres.faith);
        if (node.disputed && node.disputedNote) {
          html += '<div class="d-section"><h3>' + esc(t('disputed')) + '</h3><p>' + esc(node.disputedNote) + '</p></div>';
        }
        if (node.archaeology && node.archaeology.god) {
          var a = node.archaeology;
          html +=
            '<div class="d-section"><h3>' + esc(t('archaeology')) + '</h3>' +
            '<p><strong>' + esc(a.god) + '</strong> — ' + esc(a.note) + '</p>' +
            '<div class="d-ref"><a href="' + esc(a.link) + '" target="_blank" rel="noopener">' + esc(t('viewSource')) + '</a></div></div>';
        }
      }
      detail.innerHTML = html;
      detail.hidden = false;
    }
    function closeDetail() {
      detailNode = null;
      detail.hidden = true;
      detail.innerHTML = '';
    }
    detail.addEventListener('click', function (e) {
      // 只关详情卡，不改变聚焦与展开（设计文档 5.3）
      if (e.target.closest('[data-close]')) closeDetail();
    });

    // ---------- 悬停提示 ----------
    var tooltipFor = null;
    function tooltipHTML(id) {
      var node = model.node(id);
      var pres = presentation[id] || {};
      var parts = ['<div class="tt-name">' + esc(nameOf(node)) + '</div>'];
      if (pres.faith) {
        parts.push(
          '<div class="tt-row">「' + esc(pres.faith.text) + '」<span class="tt-ref">' + esc(pres.faith.ref) + '</span></div>'
        );
      }
      if (node.region) parts.push('<div class="tt-row"><span class="tt-label">' + esc(t('region')) + '</span>' + esc(node.region) + '</div>');
      if (node.modernRef) parts.push('<div class="tt-row"><span class="tt-label">' + esc(t('modern')) + '</span>' + esc(node.modernRef) + '</div>');
      return parts.join('');
    }
    function showTooltip(id, clientX, clientY) {
      if (tooltipFor !== id) {
        tooltip.innerHTML = tooltipHTML(id);
        tooltipFor = id;
      }
      var stage = svg.parentElement.getBoundingClientRect();
      var x = clientX - stage.left + 14;
      var y = clientY - stage.top + 14;
      tooltip.style.left = Math.min(x, stage.width - 316) + 'px';
      tooltip.style.top = y + 'px';
      tooltip.hidden = false;
    }
    function hideTooltip() {
      tooltip.hidden = true;
      tooltipFor = null;
    }

    // ---------- 平移 / 缩放 / 点击 ----------
    function zoomAt(clientX, clientY, k2) {
      userMoved = true;
      var rect = svg.getBoundingClientRect();
      var rx = clientX - rect.left;
      var ry = clientY - rect.top;
      k2 = Math.min(MAX_K, Math.max(currentMinK(), k2));
      var ratio = k2 / view.k;
      view.tx = rx - (rx - view.tx) * ratio;
      view.ty = ry - (ry - view.ty) * ratio;
      view.k = k2;
      applyView();
    }
    if (opts.zoomIn) opts.zoomIn.addEventListener('click', function () {
      var r = svg.getBoundingClientRect();
      zoomAt(r.left + r.width / 2, r.top + r.height / 2, view.k * 1.3);
    });
    if (opts.zoomOut) opts.zoomOut.addEventListener('click', function () {
      var r = svg.getBoundingClientRect();
      zoomAt(r.left + r.width / 2, r.top + r.height / 2, view.k / 1.3);
    });
    svg.addEventListener(
      'wheel',
      function (e) {
        e.preventDefault();
        hideTooltip();
        zoomAt(e.clientX, e.clientY, view.k * Math.exp(-e.deltaY * 0.0016));
      },
      { passive: false }
    );

    var pointers = new Map();
    var drag = null;
    var lastPinchDist = null;
    function nodeIdFromEvent(e) {
      var g = e.target.closest ? e.target.closest('[data-id]') : null;
      return g ? g.getAttribute('data-id') : null;
    }
    function toggleIdFromEvent(e) {
      var g = e.target.closest ? e.target.closest('[data-toggle]') : null;
      return g ? g.getAttribute('data-toggle') : null;
    }
    svg.addEventListener('pointerdown', function (e) {
      try {
        svg.setPointerCapture(e.pointerId);
      } catch (err) {}
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 1) {
        // 命中目标必须在按下瞬间记录：setPointerCapture 后，浏览器会把后续
        // pointerup 的 target 重定向到 svg 本身，抬起时再查 e.target 恒为空。
        drag = {
          x: e.clientX,
          y: e.clientY,
          moved: false,
          toggleId: toggleIdFromEvent(e),
          nodeId: nodeIdFromEvent(e),
        };
      } else if (pointers.size === 2) {
        drag = null;
        var ps = Array.from(pointers.values());
        lastPinchDist = Math.hypot(ps[0].x - ps[1].x, ps[0].y - ps[1].y);
      }
      hideTooltip();
    });
    svg.addEventListener('pointermove', function (e) {
      if (pointers.has(e.pointerId)) {
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      }
      if (lastPinchDist && pointers.size === 2) {
        var ps = Array.from(pointers.values());
        var d = Math.hypot(ps[0].x - ps[1].x, ps[0].y - ps[1].y);
        if (d > 0) {
          zoomAt((ps[0].x + ps[1].x) / 2, (ps[0].y + ps[1].y) / 2, view.k * (d / lastPinchDist));
          lastPinchDist = d;
        }
        return;
      }
      if (drag) {
        var dx = e.clientX - drag.x;
        var dy = e.clientY - drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
        if (drag.moved) {
          userMoved = true;
          view.tx += dx;
          view.ty += dy;
          drag.x = e.clientX;
          drag.y = e.clientY;
          applyView();
        }
        return;
      }
      if (e.pointerType === 'mouse' && pointers.size === 0) {
        var id = nodeIdFromEvent(e);
        if (id) showTooltip(id, e.clientX, e.clientY);
        else hideTooltip();
      }
    });
    function endPointer(e) {
      var wasDrag = drag;
      pointers.delete(e.pointerId);
      if (pointers.size < 2) lastPinchDist = null;
      if (wasDrag && pointers.size === 0) {
        drag = null;
        if (!wasDrag.moved) {
          var tg = wasDrag.toggleId;
          if (tg) {
            var beforeT = layoutNow();
            applyToggle(tg);
            anchorOn(tg, beforeT, render());
            return;
          }
          var id = wasDrag.nodeId;
          if (id) {
            var beforeN = layoutNow();
            applyFocusClick(id);
            anchorOn(id, beforeN, render());
            openDetail(id);
          } else {
            // 点空白处只关详情卡，不退出聚焦（设计文档 5.3）
            closeDetail();
          }
        }
      }
    }
    svg.addEventListener('pointerup', endPointer);
    svg.addEventListener('pointercancel', function (e) {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) lastPinchDist = null;
      drag = null;
    });
    svg.addEventListener('pointerleave', hideTooltip);

    // 视口尺寸变化：用户尚未手动平移/缩放时按新视口重新取景；已手动
    // 调整过则只重新钳制边界，不夺走用户的位置（设计文档 5.1）。
    window.addEventListener('resize', function () {
      if (!userMoved) fitView();
      else applyView();
    });

    render();
    fitView();

    return { render: render, fitView: fitView };
  }

  var api = {
    mount: mount,
    LINE_COLORS: LINE_COLORS,
    _buildModel: buildModel,
    _computePositions: computePositions,
    _minZoomFor: minZoomFor,
    _cardHeight: cardHeight,
  };
  global.NationsTree = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : this);
