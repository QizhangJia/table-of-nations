// web/app.js — 入口（第 5 步实现）
// 职责：加载 data/nations.json 与 data/computed.json（校验指纹）、加载 locales，初始化渲染。
(function () {
  'use strict';

  function $(id) {
    return document.getElementById(id);
  }
  function setStatus(msg) {
    var s = $('status');
    if (!s) return;
    s.textContent = msg || '';
    s.hidden = !msg;
  }
  function sha256Hex(buf) {
    return crypto.subtle.digest('SHA-256', buf).then(function (h) {
      return Array.from(new Uint8Array(h))
        .map(function (b) {
          return b.toString(16).padStart(2, '0');
        })
        .join('');
    });
  }

  async function main() {
    var t = function (k) {
      return window.I18N.t(k);
    };
    setStatus(t('loading'));
    try {
      await window.I18N.load();
      document.title = t('title');
      $('app-title').textContent = t('title');
      $('search-input').placeholder = t('searchPlaceholder');
    } catch (e) {
      /* 用内置字典继续 */
    }

    var nationsBuf;
    var computed;
    try {
      var rs = await Promise.all([fetch('data/nations.json'), fetch('data/computed.json')]);
      if (!rs[0].ok || !rs[1].ok) throw new Error('fetch failed');
      nationsBuf = await rs[0].arrayBuffer();
      computed = await rs[1].json();
    } catch (e) {
      setStatus(t('loadFailed'));
      return;
    }
    var nations = JSON.parse(new TextDecoder('utf-8').decode(nationsBuf));

    // 指纹校验：computed 内嵌的 sourceHash 应等于 nations.json 原始字节的 SHA-256。
    // 不一致只提示、不阻断（分发机制已保证同源同版，此为兜底）。
    try {
      var hex = await sha256Hex(nationsBuf);
      setStatus(hex === computed.sourceHash ? '' : t('hashMismatch'));
    } catch (e) {
      setStatus('');
    }

    var legend = $('legend');
    legend.innerHTML =
      ['shem', 'ham', 'japheth']
        .map(function (k) {
          return (
            '<span class="legend-item"><span class="legend-dot" style="background:' +
            window.NationsTree.LINE_COLORS[k] +
            '"></span>' +
            t('line_' + k) +
            '</span>'
          );
        })
        .join('') +
      '<span class="legend-item"><span class="legend-dot" style="background:' +
      window.NationsTree.LINE_COLORS.root +
      '"></span>' +
      t('rootLine') +
      '</span>';

    window.NationsTree.mount({
      svg: $('tree'),
      tooltip: $('tooltip'),
      detail: $('detail'),
      zoomIn: $('zoom-in'),
      zoomOut: $('zoom-out'),
      searchInput: $('search-input'),
      searchList: $('search-list'),
      nations: nations,
      computed: computed,
      t: t,
    });
  }

  document.addEventListener('DOMContentLoaded', main);
})();
