'use strict';
// 入口。ログイン済みなら todos.html、そうでなければ login.html へ移る（SPEC 3.5 節）。
(function () {
  var done = false;
  function go(url) {
    if (done) return;
    done = true;
    location.replace(url);
  }
  var p;
  try {
    p = Promise.resolve(window.TodoApi.request('GET', '/api/me'));
  } catch (e) {
    p = Promise.reject(e);
  }
  p.then(function (r) {
    go(r && r.status === 200 ? 'todos.html' : 'login.html');
  }, function () {
    go('login.html');
  });
})();
