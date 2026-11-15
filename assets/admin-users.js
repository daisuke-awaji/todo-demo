'use strict';
(function () {
  var A = window.App;
  var main = document.getElementById('main');
  var body = document.getElementById('users-body');
  var errEl = A.qs(document, 'users-error');

  function td(testid, text) {
    var c = document.createElement('td');
    c.setAttribute('data-testid', testid);
    c.textContent = text;
    return c;
  }

  // 一般利用者: 表の代わりに 403 の表示だけを出す（SPEC 3.4 節）
  function show403() {
    main.textContent = '';
    var h = document.createElement('h1');
    h.setAttribute('data-testid', 'error-title');
    h.textContent = 'この画面を開く権限がありません';
    var p = document.createElement('p');
    var a = document.createElement('a');
    a.setAttribute('data-testid', 'error-link');
    a.setAttribute('href', 'todos.html');
    a.textContent = 'ToDo 一覧へ';
    p.appendChild(a);
    main.appendChild(h);
    main.appendChild(p);
    document.title = '権限がありません | ToDo 管理';
  }

  function loadUsers() {
    return A.api('GET', '/api/admin/users').then(function (r) {
      if (r.status !== 200) {
        A.setError(errEl, A.errorOf(r).message);
        return;
      }
      A.setError(errEl, '');
      r.data.items.forEach(function (u) {
        var tr = document.createElement('tr');
        tr.setAttribute('data-testid', 'users-row');
        tr.setAttribute('data-user-id', String(u.id));
        tr.appendChild(td('user-username', u.username));
        tr.appendChild(td('user-displayname', u.displayName));
        tr.appendChild(td('user-role', u.role === 'admin' ? '管理者' : '一般'));
        tr.appendChild(td('user-count-all', String(u.todoCounts.all)));
        tr.appendChild(td('user-count-active', String(u.todoCounts.active)));
        tr.appendChild(td('user-count-done', String(u.todoCounts.done)));
        body.appendChild(tr);
      });
    });
  }

  A.api('GET', '/api/me').then(function (r) {
    if (r.status === 200) {
      if (r.data.user.role !== 'admin') {
        show403();
        A.showPage();
        return;
      }
      A.showPage();
      return loadUsers();
    }
    A.showPage();
    A.setError(errEl, A.errorOf(r).message);
  });
})();
