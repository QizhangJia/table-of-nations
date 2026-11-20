// web/render.js — SVG 渲染与交互（第 5 步实现）
// 职责：只读数据与计算结果来画：展开/折叠、平移/缩放、高亮回溯、悬停提示、点击详情卡。
// 布局口径与生成器一致：展开集合由聚焦模型派生（设计文档 5.1），
// 排布用 computed 中每节点的 children 关系做叶子累加（折叠节点占 1 列）。
(function (global) {
  'use strict';

  var COL_PITCH = 196; // 叶子列距（像素）
  var ROW_PITCH = 124; // 深度行距（像素）
  var CARD_W = 172; // 民族卡宽度
  var LINK_W = 132; // 连接人物卡宽度
  var MIN_K = 0.12;
  var MAX_K = 2.5;

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

  // 纯布局：给定展开集合，算出每个可见节点的抽象列与像素坐标。
  function computePositions(model, expanded) {
    var widthMemo = {};
    function widthOf(id) {
      if (widthMemo[id] != null) return widthMemo[id];
      var kids = model.childrenOf(id);
      var w =
        !kids.length || !expanded.has(id)
          ? 1
          : kids.reduce(function (s, c) {
              return s + widthOf(c);
            }, 0);
      widthMemo[id] = w;
      return w;
    }
    var pos = new Map();
    (function assign(id, depth, startCol) {
      var kids = model.childrenOf(id);
      if (!kids.length || !expanded.has(id)) {
        pos.set(id, { col: startCol, depth: depth });
        return [startCol, startCol];
      }
      var first = null;
      var last = null;
      var cur = startCol;
      kids.forEach(function (c) {
        var span = assign(c, depth + 1, cur);
        if (first === null) first = span[0];
        last = span[1];
        cur += widthOf(c);
      });
      // 与生成器同一口径：父节点列 = 其可见叶子跨度的中点
      pos.set(id, { col: (first + last) / 2, depth: depth });
      return [first, last];
    })(model.rootId, 0, 0);
    pos.forEach(function (p) {
      p.x = p.col * COL_PITCH;
      p.y = p.depth * ROW_PITCH;
    });
    return { positions: pos, totalCols: widthOf(model.rootId) };
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

    function applyView() {
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
      var layout = computePositions(model, expanded);
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

    function fitView() {
      var layout = computePositions(model, currentExpanded());
      var w = svg.clientWidth || 800;
      var treeW = (layout.totalCols - 1) * COL_PITCH + CARD_W;
      var k = Math.min(1, Math.max(MIN_K, (w - 24) / treeW));
      view.k = k;
      view.tx = (w - treeW * k) / 2 + (CARD_W / 2) * k;
      view.ty = 14;
      applyView();
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
      var rect = svg.getBoundingClientRect();
      var rx = clientX - rect.left;
      var ry = clientY - rect.top;
      k2 = Math.min(MAX_K, Math.max(MIN_K, k2));
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
            applyToggle(tg);
            render();
            return;
          }
          var id = wasDrag.nodeId;
          if (id) {
            applyFocusClick(id);
            render();
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

    render();
    fitView();

    return { render: render, fitView: fitView };
  }

  var api = {
    mount: mount,
    LINE_COLORS: LINE_COLORS,
    _buildModel: buildModel,
    _computePositions: computePositions,
    _cardHeight: cardHeight,
  };
  global.NationsTree = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : this);
