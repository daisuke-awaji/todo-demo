'use strict';
// 画面の共通の部品。入力された文字は textContent / value でだけ扱う。
(function () {
  var INTERNAL_MESSAGE = 'サーバーでエラーが発生しました';

  function qs(root, testid) {
    return root.querySelector('[data-testid="' + testid + '"]');
  }

  // エラー表示（role="alert"）。空なら hidden にして textContent を空にする
  function setError(el, message) {
    if (!el) return;
    if (message) {
      el.textContent = message;
      el.hidden = false;
    } else {
      el.textContent = '';
      el.hidden = true;
    }
  }

  // 操作層の呼び出し。戻り値: Promise<{status, data, ok}>。
  // 401 UNAUTHENTICATED は login.html へ移り、解決しない Promise を返す（opts.noRedirect が真のときを除く）。
  // request() が例外を投げた場合は 500 の結果として扱う。
  function api(method, path, body, opts) {
    var p;
    try {
      p = Promise.resolve(window.TodoApi.request(method, path, body));
    } catch (e) {
      p = Promise.reject(e);
    }
    return p.then(function (res) {
      if (!res || typeof res.status !== 'number') throw new Error('bad result');
      return { status: res.status, ok: res.status >= 200 && res.status < 300, data: res.body };
    }).catch(function () {
      return { status: 500, ok: false, data: { error: { code: 'INTERNAL_ERROR', message: INTERNAL_MESSAGE } } };
    }).then(function (r) {
      if (r.status === 401 && r.data && r.data.error && r.data.error.code === 'UNAUTHENTICATED' && !(opts && opts.noRedirect)) {
        location.replace('login.html');
        return new Promise(function () {});
      }
      return r;
    });
  }

  function errorOf(r) {
    var e = r && r.data && r.data.error;
    return {
      code: e && e.code ? e.code : '',
      message: e && e.message ? e.message : INTERNAL_MESSAGE,
      fields: e && e.fields ? e.fields : null
    };
  }

  function showPage() {
    document.body.setAttribute('data-auth', 'ok');
  }

  window.App = { qs: qs, setError: setError, api: api, errorOf: errorOf, showPage: showPage, INTERNAL_MESSAGE: INTERNAL_MESSAGE };
})();
