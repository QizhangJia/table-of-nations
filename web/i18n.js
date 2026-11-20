// web/i18n.js — 语言机制（第 5 步实现）
// 本期只启用 zh-Hans；zh-Hant / en 预留切换入口与字典结构，不实现内容。
(function (global) {
  'use strict';

  var DICTS = {
    'zh-Hans': {
      title: '旧约民族亲缘树',
      ancestor: '始祖',
      years: '生卒',
      faith: '信仰',
      region: '古代分布',
      modern: '现代对应',
      originVerse: '经文 · 民族的产生',
      faithVerse: '经文 · 民族的信仰',
      disputed: '存疑说明',
      archaeology: '考古发现',
      viewSource: '查看来源',
      readOnYouVersion: '在 YouVersion 阅读',
      linkPerson: '连接人物',
      line_shem: '闪系',
      line_ham: '含系',
      line_japheth: '雅弗系',
      rootLine: '共同祖先',
      loading: '加载中…',
      loadFailed: '数据加载失败，请刷新重试。',
      hashMismatch: '提示：数据指纹校验未通过，显示内容可能不是最新版本。',
      zoomIn: '放大',
      zoomOut: '缩小',
      close: '关闭',
    },
    'zh-Hant': {},
    en: {},
  };

  var current = 'zh-Hans';
  var dict = Object.assign({}, DICTS[current]);

  var I18N = {
    get locale() {
      return current;
    },
    t: function (key) {
      return dict[key] || key;
    },
    setLocale: function (loc) {
      if (DICTS[loc]) {
        current = loc;
        dict = Object.assign({}, DICTS[loc]);
      }
    },
    // 尝试用 locales/<locale>.json 覆盖/补充内置字典（如标题）；失败则用内置字典。
    load: function () {
      return fetch('locales/' + current + '.json')
        .then(function (r) {
          return r.ok ? r.json() : {};
        })
        .catch(function () {
          return {};
        })
        .then(function (remote) {
          Object.assign(dict, remote);
        });
    },
  };

  global.I18N = I18N;
})(window);
