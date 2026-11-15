'use strict';
(function () {
  var A = window.App;
  var form = A.qs(document, 'login-form');
  var userInput = A.qs(document, 'username-input');
  var passInput = A.qs(document, 'password-input');
  var userError = A.qs(document, 'username-error');
  var passError = A.qs(document, 'password-error');
  var loginError = A.qs(document, 'login-error');
  var submit = A.qs(document, 'login-submit');

  function clearErrors() {
    A.setError(userError, '');
    A.setError(passError, '');
    A.setError(loginError, '');
  }

  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    if (submit.disabled) return;
    clearErrors();
    submit.disabled = true;
    A.api('POST', '/api/login', { username: userInput.value, password: passInput.value }, { noRedirect: true })
      .then(function (r) {
        if (r.status === 200) {
          location.replace('todos.html');
          return;
        }
        var e = A.errorOf(r);
        if (r.status === 400 && e.fields) {
          A.setError(userError, e.fields.username || '');
          A.setError(passError, e.fields.password || '');
        } else {
          A.setError(loginError, e.message);
          if (r.status === 401) passInput.value = '';
        }
        submit.disabled = false;
      });
  });

  // 開いたとき: ログイン済みなら todos.html へ。401・500 ならフォームを表示する
  A.api('GET', '/api/me', undefined, { noRedirect: true }).then(function (r) {
    if (r.status === 200) {
      location.replace('todos.html');
      return;
    }
    A.showPage();
  });
})();
