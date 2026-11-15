'use strict';
// 操作層 window.TodoApi.request(method, path, body)。HTTP の通信はしない（SPEC 4.0 節）。
// 保存は localStorage（todo-demo:data / todo-demo:session / todo-demo:login-failures）。
(function () {
  var KEY_DATA = 'todo-demo:data';
  var KEY_SESSION = 'todo-demo:session';
  var KEY_FAILS = 'todo-demo:login-failures';
  var LOCK_NAME = 'todo-demo:lock';
  var SESSION_MS = 28800 * 1000;
  var LOCK_MS = 60 * 1000;
  var MAX_FAILS = 5;
  var FAILS_LIMIT = 10000;
  var TODO_LIMIT = 200;
  var PBKDF2_ITER = 100000;

  var MSG = {
    internal: 'サーバーでエラーが発生しました',
    notFound: '指定されたリソースが見つかりません',
    todoNotFound: 'ToDo が見つかりません',
    method: 'このメソッドは使えません',
    unauth: 'ログインしてください',
    forbidden: 'この操作を行う権限がありません',
    badBody: 'リクエストの形式が正しくありません',
    noChange: '変更する項目がありません',
    badCred: 'ユーザー名またはパスワードが違います',
    tooMany: 'ログイン試行が多すぎます。しばらくしてからやり直してください',
    limit: 'ToDo は 200 件までです。不要な ToDo を削除してから追加してください',
    titleMissing: 'タイトルを入力してください',
    titleType: 'タイトルの形式が正しくありません',
    titleNewline: 'タイトルに改行は使えません',
    titleLong: 'タイトルは 100 文字以内で入力してください',
    memoType: 'メモの形式が正しくありません',
    memoLong: 'メモは 500 文字以内で入力してください',
    due: '期限は 2000-01-01〜2099-12-31 の実在する日付で入力してください',
    priority: '優先度は high / medium / low のいずれかで指定してください',
    unknownKey: 'この項目は指定できません',
    usernameMissing: 'ユーザー名を入力してください',
    usernameType: 'ユーザー名の形式が正しくありません',
    usernameLong: 'ユーザー名は 64 文字以内で入力してください',
    passwordMissing: 'パスワードを入力してください',
    passwordType: 'パスワードの形式が正しくありません',
    passwordLong: 'パスワードは 128 文字以内で入力してください',
    qLong: 'キーワードは 100 文字以内で入力してください'
  };

  var hasOwn = function (o, k) { return Object.prototype.hasOwnProperty.call(o, k); };
  var cpLen = function (s) { return Array.from(s).length; };
  var pad2 = function (n) { return (n < 10 ? '0' : '') + n; };

  // ---------- 結果の組み立て ----------
  function result(status, body) { return { status: status, body: body }; }
  function errResult(status, code, message, fields) {
    var e = { code: code, message: message };
    if (fields) e.fields = fields;
    return result(status, { error: e });
  }
  function internalError() { return errResult(500, 'INTERNAL_ERROR', MSG.internal); }
  function notFoundRoute() { return errResult(404, 'NOT_FOUND', MSG.notFound); }
  function notFoundTodo() { return errResult(404, 'NOT_FOUND', MSG.todoNotFound); }
  function unauthenticated() { return errResult(401, 'UNAUTHENTICATED', MSG.unauth); }
  // list: [[キー, 文言], ...]（検証した順）。キーが __proto__ や整数に見える文字列でも、そのまま自身のキーにする
  function validationError(list) {
    var f = {};
    list.forEach(function (e) {
      Object.defineProperty(f, e[0], { value: e[1], enumerable: true, writable: true, configurable: true });
    });
    return errResult(400, 'VALIDATION_ERROR', list[0][1], f);
  }
  function badBody() { return errResult(400, 'VALIDATION_ERROR', MSG.badBody); }

  // ---------- 16 進数・乱数・PBKDF2 ----------
  function toHex(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
    return s;
  }
  function fromHex(hex) {
    var out = new Uint8Array(hex.length / 2);
    for (var i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
  }
  function randomHex(n) {
    var b = new Uint8Array(n);
    crypto.getRandomValues(b);
    return toHex(b);
  }
  function pbkdf2Hex(password, saltBytes) {
    var enc = new TextEncoder();
    return crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']).then(function (key) {
      return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes, iterations: PBKDF2_ITER }, key, 256);
    }).then(function (bits) { return toHex(new Uint8Array(bits)); });
  }
  // 全バイトを比べる（先に打ち切らない）
  function sameHex(a, b) {
    var diff = a.length ^ b.length;
    var n = Math.max(a.length, b.length);
    for (var i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
    return diff === 0;
  }

  // ---------- ルーティング（4.2） ----------
  function matchRoute(path) {
    if (typeof path !== 'string') return null;
    var qi = path.indexOf('?');
    var pathname = qi < 0 ? path : path.slice(0, qi);
    var search = qi < 0 ? '' : path.slice(qi + 1);
    var m;
    switch (pathname) {
      case '/api/login': return { name: 'login', allow: ['POST'], auth: false, search: search };
      case '/api/logout': return { name: 'logout', allow: ['POST'], auth: false, search: search };
      case '/api/me': return { name: 'me', allow: ['GET'], auth: true, search: search };
      case '/api/todos': return { name: 'todos', allow: ['GET', 'POST'], auth: true, search: search };
      case '/api/todos/clear-completed': return { name: 'clear', allow: ['POST'], auth: true, search: search };
      case '/api/admin/users': return { name: 'users', allow: ['GET'], auth: true, search: search };
    }
    m = /^\/api\/todos\/([^/]+)$/.exec(pathname);
    if (m) return { name: 'todo', allow: ['GET', 'PATCH', 'DELETE'], auth: true, id: m[1], search: search };
    m = /^\/api\/todos\/([^/]+)\/(complete|reopen)$/.exec(pathname);
    if (m) return { name: m[2], allow: ['POST'], auth: true, id: m[1], search: search };
    return null;
  }

  // ---------- 保存データ（6.1） ----------
  function dataProblem(reason) {
    try { console.error('todo-demo:data: ' + reason); } catch (e) { /* 何もしない */ }
    var err = new Error('todo-demo:data: ' + reason);
    err.dataProblem = true;
    return err;
  }

  function parseAndCheck(raw) {
    var d;
    try { d = JSON.parse(raw); } catch (e) { throw dataProblem('JSON として解釈できません'); }
    if (d === null || typeof d !== 'object' || Array.isArray(d)) throw dataProblem('トップレベルがオブジェクトではありません');
    if (d.version !== 1) throw dataProblem('version が 1 ではありません');
    if (!Array.isArray(d.users) || !Array.isArray(d.todos)) throw dataProblem('users または todos が配列ではありません');
    if (typeof d.nextTodoId !== 'number' || !Number.isInteger(d.nextTodoId) || d.nextTodoId < 1) throw dataProblem('nextTodoId が 1 以上の整数ではありません');
    var userIds = new Set();
    var names = new Set();
    d.users.forEach(function (u) {
      if (userIds.has(u.id)) throw dataProblem('users[].id が重複しています');
      userIds.add(u.id);
      if (names.has(u.username)) throw dataProblem('users[].username が重複しています');
      names.add(u.username);
      if (u.role !== 'user' && u.role !== 'admin') throw dataProblem('role が不正です');
    });
    var todoIds = new Set();
    var maxId = 0;
    d.todos.forEach(function (t) {
      if (todoIds.has(t.id)) throw dataProblem('todos[].id が重複しています');
      todoIds.add(t.id);
      if (!userIds.has(t.userId)) throw dataProblem('todos[].userId が実在しません');
      if (t.status !== 'active' && t.status !== 'done') throw dataProblem('status が不正です');
      if (t.status === 'done' && t.completedAt === null) throw dataProblem('done なのに completedAt が null です');
      if (t.status === 'active' && t.completedAt !== null && t.completedAt !== undefined) throw dataProblem('active なのに completedAt があります');
      if (t.priority !== 'high' && t.priority !== 'medium' && t.priority !== 'low') throw dataProblem('priority が不正です');
      if (typeof t.id === 'number' && t.id > maxId) maxId = t.id;
    });
    if (d.nextTodoId <= maxId) throw dataProblem('nextTodoId が ToDo の最大 id 以下です');
    return d;
  }

  function buildInitialData() {
    var specs = [
      { id: 1, username: 'alice', displayName: 'アリス', role: 'user', password: 'alice-pass-1' },
      { id: 2, username: 'bob', displayName: 'ボブ', role: 'user', password: 'bob-pass-1' },
      { id: 3, username: 'admin', displayName: '管理者', role: 'admin', password: 'admin-pass-1' }
    ];
    return Promise.all(specs.map(function (s) {
      var salt = randomHex(16);
      return pbkdf2Hex(s.password, fromHex(salt)).then(function (hash) {
        return { id: s.id, username: s.username, displayName: s.displayName, role: s.role, passwordSalt: salt, passwordHash: hash };
      });
    })).then(function (users) {
      function todo(id, userId, title, memo, priority, dueDate, status, createdAt, completedAt) {
        return {
          id: id, userId: userId, title: title, memo: memo, dueDate: dueDate, priority: priority, status: status,
          createdAt: createdAt, updatedAt: completedAt === null ? createdAt : completedAt, completedAt: completedAt
        };
      }
      return {
        version: 1,
        nextTodoId: 8,
        users: users,
        todos: [
          todo(1, 1, 'レポートを提出する', '第 3 章まで', 'high', '2000-01-01', 'active', '2026-11-01T09:00:00.000Z', null),
          todo(2, 1, '牛乳を買う', 'Costco で買う', 'medium', null, 'active', '2026-11-02T09:00:00.000Z', null),
          todo(3, 1, '部屋を掃除する', '', 'low', '2099-12-31', 'active', '2026-11-03T09:00:00.000Z', null),
          todo(4, 1, '本を返す', '', 'medium', '2000-01-01', 'done', '2026-11-04T09:00:00.000Z', '2026-11-05T09:00:00.000Z'),
          todo(5, 1, '歯医者の予約', '', 'high', '2099-01-01', 'done', '2026-11-05T09:00:00.000Z', '2026-11-06T09:00:00.000Z'),
          todo(6, 2, 'ボブの買い物', '', 'medium', null, 'active', '2026-11-06T09:00:00.000Z', null),
          todo(7, 2, 'ボブの宿題', '', 'low', null, 'done', '2026-11-07T09:00:00.000Z', '2026-11-08T09:00:00.000Z')
        ]
      };
    });
  }

  // 保存データを読む（なければ初期データを作って書く）。問題があれば例外（呼び出し側で 500）
  function loadData() {
    var raw = localStorage.getItem(KEY_DATA);
    if (raw === null) {
      return buildInitialData().then(function (d) {
        localStorage.setItem(KEY_DATA, JSON.stringify(d));
        return d;
      });
    }
    return Promise.resolve(parseAndCheck(raw));
  }
  function saveData(d) { localStorage.setItem(KEY_DATA, JSON.stringify(d)); }

  // ---------- セッション（6.2） ----------
  var ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
  function sessionIsValid(s, data, now) {
    if (s === null || typeof s !== 'object' || Array.isArray(s)) return false;
    var keys = Object.keys(s);
    if (keys.length !== 3 || !hasOwn(s, 'sid') || !hasOwn(s, 'userId') || !hasOwn(s, 'createdAt')) return false;
    if (typeof s.sid !== 'string' || !/^[0-9a-f]{64}$/.test(s.sid)) return false;
    if (typeof s.userId !== 'number' || !Number.isInteger(s.userId)) return false;
    if (typeof s.createdAt !== 'string' || !ISO_RE.test(s.createdAt)) return false;
    var t = Date.parse(s.createdAt);
    if (Number.isNaN(t) || new Date(t).toISOString() !== s.createdAt) return false;
    var age = now - t;
    if (age < 0 || age >= SESSION_MS) return false;
    return data.users.some(function (u) { return u.id === s.userId; });
  }
  function authenticate(data, now) {
    var raw = localStorage.getItem(KEY_SESSION);
    if (raw === null) return null;
    var s = null;
    var ok = false;
    try { s = JSON.parse(raw); ok = sessionIsValid(s, data, now); } catch (e) { ok = false; }
    if (!ok) {
      try { localStorage.removeItem(KEY_SESSION); } catch (e) { /* 401 は変えない */ }
      return null;
    }
    for (var i = 0; i < data.users.length; i++) if (data.users[i].id === s.userId) return data.users[i];
    return null;
  }

  // ---------- ログイン失敗の記録（6.2） ----------
  function loadFails() {
    var raw = localStorage.getItem(KEY_FAILS);
    var map = new Map();
    if (raw === null) return map;
    var arr;
    try { arr = JSON.parse(raw); } catch (e) { return map; }
    if (!Array.isArray(arr)) return map;
    var tmp = new Map();
    for (var i = 0; i < arr.length; i++) {
      var e = arr[i];
      if (!Array.isArray(e) || e.length !== 2 || typeof e[0] !== 'string' || e[1] === null || typeof e[1] !== 'object' || Array.isArray(e[1])) return map;
      var r = e[1];
      if (typeof r.failures !== 'number' || typeof r.lockedUntil !== 'number' || typeof r.updatedAt !== 'number') return map;
      tmp.set(e[0], { failures: r.failures, lockedUntil: r.lockedUntil, updatedAt: r.updatedAt });
    }
    return tmp;
  }
  function saveFails(map) { localStorage.setItem(KEY_FAILS, JSON.stringify(Array.from(map))); }

  // ---------- 本文（4.1 ⑤） ----------
  // 戻り値: オブジェクト、または null（形式が正しくない）
  function parseBody(body) {
    if (body === undefined) return null;
    var text;
    if (typeof body === 'string') text = body;
    else {
      try { text = JSON.stringify(body); } catch (e) { return null; }
      if (typeof text !== 'string') return null;
    }
    if (text === '') return null;
    var v;
    try { v = JSON.parse(text); } catch (e) { return null; }
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
    return v;
  }

  // ---------- 検証（8 節） ----------
  function checkDate(v) {
    if (typeof v !== 'string') return false;
    if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(v)) return false;
    var y = Number(v.slice(0, 4));
    var m = Number(v.slice(5, 7));
    var d = Number(v.slice(8, 10));
    var dt = new Date(Date.UTC(2000, 0, 1));
    dt.setUTCFullYear(y, m - 1, d);
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return false;
    return v >= '2000-01-01' && v <= '2099-12-31';
  }
  var KNOWN = ['title', 'memo', 'dueDate', 'priority'];
  // 戻り値: { errors: [[key, msg]...], values }
  function validateTodo(body, isCreate) {
    var errors = [];
    var values = {};
    if (hasOwn(body, 'title')) {
      var t = body.title;
      if (typeof t !== 'string') errors.push(['title', MSG.titleType]);
      else {
        var s = t.trim();
        if (s.length === 0) errors.push(['title', MSG.titleMissing]);
        else if (/[\r\n]/.test(s)) errors.push(['title', MSG.titleNewline]);
        else if (cpLen(s) > 100) errors.push(['title', MSG.titleLong]);
        else values.title = s;
      }
    } else if (isCreate) {
      errors.push(['title', MSG.titleMissing]);
    }
    if (hasOwn(body, 'memo')) {
      var m = body.memo;
      if (typeof m !== 'string') errors.push(['memo', MSG.memoType]);
      else if (cpLen(m) > 500) errors.push(['memo', MSG.memoLong]);
      else values.memo = m;
    }
    if (hasOwn(body, 'dueDate')) {
      var d = body.dueDate;
      if (d === null) values.dueDate = null;
      else if (!checkDate(d)) errors.push(['dueDate', MSG.due]);
      else values.dueDate = d;
    }
    if (hasOwn(body, 'priority')) {
      var p = body.priority;
      if (typeof p !== 'string' || (p !== 'high' && p !== 'medium' && p !== 'low')) errors.push(['priority', MSG.priority]);
      else values.priority = p;
    }
    Object.keys(body).forEach(function (k) {
      if (KNOWN.indexOf(k) < 0) errors.push([k, MSG.unknownKey]);
    });
    return { errors: errors, values: values };
  }
  function validateLogin(body) {
    var errors = [];
    if (!hasOwn(body, 'username')) errors.push(['username', MSG.usernameMissing]);
    else if (typeof body.username !== 'string') errors.push(['username', MSG.usernameType]);
    else if (body.username.length === 0) errors.push(['username', MSG.usernameMissing]);
    else if (cpLen(body.username) > 64) errors.push(['username', MSG.usernameLong]);
    if (!hasOwn(body, 'password')) errors.push(['password', MSG.passwordMissing]);
    else if (typeof body.password !== 'string') errors.push(['password', MSG.passwordType]);
    else if (body.password.length === 0) errors.push(['password', MSG.passwordMissing]);
    else if (cpLen(body.password) > 128) errors.push(['password', MSG.passwordLong]);
    return errors;
  }
  var ENUMS = {
    status: ['all', 'active', 'done'],
    priority: ['all', 'high', 'medium', 'low'],
    sort: ['created_desc', 'created_asc', 'due_asc', 'priority_desc']
  };
  function validateListQuery(search) {
    var sp = new URLSearchParams(search);
    var errors = [];
    var query = { status: 'all', priority: 'all', q: '', sort: 'created_desc' };
    function check(name) {
      var all = sp.getAll(name);
      if (all.length === 0) return;
      if (all.length > 1 || ENUMS[name].indexOf(all[0]) < 0) { errors.push([name, name + ' の値が正しくありません']); return; }
      query[name] = all[0];
    }
    check('status');
    check('priority');
    var qs = sp.getAll('q');
    if (qs.length > 1) errors.push(['q', 'q の値が正しくありません']);
    else if (qs.length === 1) {
      var q = qs[0].trim();
      if (cpLen(q) > 100) errors.push(['q', MSG.qLong]);
      else query.q = q;
    }
    check('sort');
    return { errors: errors, query: query };
  }

  // ---------- ID（8.5） ----------
  function parseId(s) {
    if (typeof s !== 'string' || !/^[1-9][0-9]*$/.test(s)) return null;
    var n = Number(s);
    return Number.isSafeInteger(n) ? n : null;
  }

  // ---------- JSON の形（4.3） ----------
  function todayString(now) {
    var d = new Date(now);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  function userJson(u) { return { id: u.id, username: u.username, displayName: u.displayName, role: u.role }; }
  function todoJson(t, today) {
    return {
      id: t.id, title: t.title, memo: t.memo, dueDate: t.dueDate, priority: t.priority, status: t.status,
      overdue: t.status === 'active' && t.dueDate !== null && t.dueDate !== undefined && t.dueDate < today,
      createdAt: t.createdAt, updatedAt: t.updatedAt, completedAt: t.completedAt === undefined ? null : t.completedAt
    };
  }
  function countsOf(data, userId) {
    var c = { all: 0, active: 0, done: 0 };
    data.todos.forEach(function (t) {
      if (t.userId !== userId) return;
      c.all++;
      if (t.status === 'done') c.done++; else c.active++;
    });
    return c;
  }
  function cmpCreatedDesc(a, b) {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
    return b.id - a.id;
  }
  var PRIO_RANK = { high: 0, medium: 1, low: 2 };
  function sorter(sort) {
    if (sort === 'created_asc') return function (a, b) {
      if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
      return a.id - b.id;
    };
    if (sort === 'due_asc') return function (a, b) {
      var an = a.dueDate === null || a.dueDate === undefined;
      var bn = b.dueDate === null || b.dueDate === undefined;
      if (an !== bn) return an ? 1 : -1;
      if (!an && a.dueDate !== b.dueDate) return a.dueDate < b.dueDate ? -1 : 1;
      return cmpCreatedDesc(a, b);
    };
    if (sort === 'priority_desc') return function (a, b) {
      if (a.priority !== b.priority) return PRIO_RANK[a.priority] - PRIO_RANK[b.priority];
      return cmpCreatedDesc(a, b);
    };
    return cmpCreatedDesc;
  }

  // ---------- 各 API ----------
  function findOwnTodo(data, user, idStr) {
    var id = parseId(idStr);
    if (id === null) return null;
    for (var i = 0; i < data.todos.length; i++) {
      if (data.todos[i].id === id && data.todos[i].userId === user.id) return data.todos[i];
    }
    return null;
  }

  function doLogin(data, body, now) {
    var obj = parseBody(body);
    if (obj === null) return Promise.resolve(badBody());
    var errors = validateLogin(obj);
    if (errors.length) return Promise.resolve(validationError(errors));
    var username = obj.username;
    var password = obj.password;
    var fails = loadFails();
    var rec = fails.get(username);
    var cur = rec ? { failures: rec.failures, lockedUntil: rec.lockedUntil, updatedAt: rec.updatedAt } : { failures: 0, lockedUntil: 0, updatedAt: now };
    if (cur.lockedUntil > 0 && cur.lockedUntil <= now) { cur.failures = 0; cur.lockedUntil = 0; }
    if (cur.lockedUntil > now) return Promise.resolve(errResult(429, 'TOO_MANY_ATTEMPTS', MSG.tooMany));
    var user = null;
    for (var i = 0; i < data.users.length; i++) if (data.users[i].username === username) { user = data.users[i]; break; }
    var salt = user ? fromHex(user.passwordSalt) : fromHex('00000000000000000000000000000000');
    return pbkdf2Hex(password, salt).then(function (hash) {
      var good = user ? sameHex(hash, user.passwordHash) : false;
      if (good) {
        var oldSession = localStorage.getItem(KEY_SESSION);
        var session = { sid: randomHex(32), userId: user.id, createdAt: new Date(now).toISOString() };
        localStorage.setItem(KEY_SESSION, JSON.stringify(session));
        if (rec) {
          fails.delete(username);
          try { saveFails(fails); } catch (e) {
            try {
              if (oldSession === null) localStorage.removeItem(KEY_SESSION); else localStorage.setItem(KEY_SESSION, oldSession);
            } catch (e2) { /* 何もできない */ }
            throw e;
          }
        }
        return result(200, { user: userJson(user) });
      }
      // 失敗
      if (!rec && fails.size >= FAILS_LIMIT) {
        // 上限: ロックの終わった記録を古いものから捨てる。捨てられないときは 429（OPEN_QUESTIONS Q10 の仮の扱い）
        var droppable = Array.from(fails).filter(function (e) { return e[1].lockedUntil <= now; })
          .sort(function (a, b) { return a[1].updatedAt - b[1].updatedAt; });
        var need = fails.size - FAILS_LIMIT + 1;
        if (droppable.length < need) return errResult(429, 'TOO_MANY_ATTEMPTS', MSG.tooMany);
        for (var k = 0; k < need; k++) fails.delete(droppable[k][0]);
      }
      cur.failures += 1;
      if (cur.failures >= MAX_FAILS) cur.lockedUntil = now + LOCK_MS;
      cur.updatedAt = now;
      fails.set(username, cur);
      saveFails(fails);
      return errResult(401, 'INVALID_CREDENTIALS', MSG.badCred);
    });
  }

  function doListTodos(data, user, route, now) {
    var v = validateListQuery(route.search);
    if (v.errors.length) return validationError(v.errors);
    var q = v.query;
    var needle = q.q.toLowerCase();
    var today = todayString(now);
    var items = data.todos.filter(function (t) {
      if (t.userId !== user.id) return false;
      if (q.status !== 'all' && t.status !== q.status) return false;
      if (q.priority !== 'all' && t.priority !== q.priority) return false;
      if (needle !== '' && String(t.title).toLowerCase().indexOf(needle) < 0 && String(t.memo).toLowerCase().indexOf(needle) < 0) return false;
      return true;
    }).sort(sorter(q.sort)).map(function (t) { return todoJson(t, today); });
    return result(200, { items: items, counts: countsOf(data, user.id) });
  }

  function doCreate(data, user, body, now) {
    var obj = parseBody(body);
    if (obj === null) return badBody();
    var v = validateTodo(obj, true);
    if (v.errors.length) return validationError(v.errors);
    if (countsOf(data, user.id).all >= TODO_LIMIT) return errResult(409, 'LIMIT_EXCEEDED', MSG.limit);
    var iso = new Date(now).toISOString();
    var t = {
      id: data.nextTodoId, userId: user.id, title: v.values.title,
      memo: hasOwn(v.values, 'memo') ? v.values.memo : '',
      dueDate: hasOwn(v.values, 'dueDate') ? v.values.dueDate : null,
      priority: hasOwn(v.values, 'priority') ? v.values.priority : 'medium',
      status: 'active', createdAt: iso, updatedAt: iso, completedAt: null
    };
    data.nextTodoId += 1;
    data.todos.push(t);
    saveData(data);
    return result(201, todoJson(t, todayString(now)));
  }

  function doPatch(data, user, route, body, now) {
    var t = findOwnTodo(data, user, route.id);
    if (!t) return notFoundTodo();
    var obj = parseBody(body);
    if (obj === null) return badBody();
    if (Object.keys(obj).length === 0) return errResult(400, 'VALIDATION_ERROR', MSG.noChange);
    var v = validateTodo(obj, false);
    if (v.errors.length) return validationError(v.errors);
    KNOWN.forEach(function (k) { if (hasOwn(v.values, k)) t[k] = v.values[k]; });
    t.updatedAt = new Date(now).toISOString();
    saveData(data);
    return result(200, todoJson(t, todayString(now)));
  }

  function doToggle(data, user, route, now, toDone) {
    var t = findOwnTodo(data, user, route.id);
    if (!t) return notFoundTodo();
    if (toDone && t.status === 'active') {
      var iso = new Date(now).toISOString();
      t.status = 'done'; t.completedAt = iso; t.updatedAt = iso;
      saveData(data);
    } else if (!toDone && t.status === 'done') {
      t.status = 'active'; t.completedAt = null; t.updatedAt = new Date(now).toISOString();
      saveData(data);
    }
    return result(200, todoJson(t, todayString(now)));
  }

  function doDelete(data, user, route) {
    var t = findOwnTodo(data, user, route.id);
    if (!t) return notFoundTodo();
    data.todos = data.todos.filter(function (x) { return x !== t; });
    saveData(data);
    return result(204, null);
  }

  function doClear(data, user) {
    var before = data.todos.length;
    data.todos = data.todos.filter(function (t) { return !(t.userId === user.id && t.status === 'done'); });
    var n = before - data.todos.length;
    if (n > 0) saveData(data);
    return result(200, { deleted: n });
  }

  function doAdminUsers(data) {
    var items = data.users.slice().sort(function (a, b) { return a.id - b.id; }).map(function (u) {
      var o = userJson(u);
      o.todoCounts = countsOf(data, u.id);
      return o;
    });
    return result(200, { items: items });
  }

  // ---------- 1 件の処理（4.1 の順序） ----------
  function handle(method, path, body) {
    var now = Date.now();
    var route = matchRoute(path);
    if (!route) return Promise.resolve(notFoundRoute());
    if (typeof method !== 'string' || route.allow.indexOf(method) < 0) {
      var r405 = errResult(405, 'METHOD_NOT_ALLOWED', MSG.method);
      r405.allow = route.allow.join(', ');
      return Promise.resolve(r405);
    }
    if (route.name === 'logout') {
      localStorage.removeItem(KEY_SESSION);
      return Promise.resolve(result(204, null));
    }
    return loadData().then(function (data) {
      var user = null;
      if (route.auth) {
        user = authenticate(data, now);
        if (!user) return unauthenticated();
      }
      switch (route.name) {
        case 'login': return doLogin(data, body, now);
        case 'me': return result(200, { user: userJson(user) });
        case 'users':
          if (user.role !== 'admin') return errResult(403, 'FORBIDDEN', MSG.forbidden);
          return doAdminUsers(data);
        case 'todos':
          return method === 'GET' ? doListTodos(data, user, route, now) : doCreate(data, user, body, now);
        case 'clear': return doClear(data, user);
        case 'todo':
          if (method === 'GET') {
            var t = findOwnTodo(data, user, route.id);
            return t ? result(200, todoJson(t, todayString(now))) : notFoundTodo();
          }
          if (method === 'PATCH') return doPatch(data, user, route, body, now);
          return doDelete(data, user, route);
        case 'complete': return doToggle(data, user, route, now, true);
        case 'reopen': return doToggle(data, user, route, now, false);
      }
      return notFoundRoute();
    });
  }

  function safeHandle(method, path, body) {
    var p;
    try { p = handle(method, path, body); } catch (e) { return Promise.resolve(internalError()); }
    return p.then(function (r) { return r; }, function () { return internalError(); });
  }

  // ---------- 順番に処理する（ページ内の連鎖 + タブをまたぐ Web Locks） ----------
  var chain = Promise.resolve();
  function runExclusive(method, path, body) {
    var locks = (typeof navigator !== 'undefined') ? navigator.locks : undefined;
    if (locks && typeof locks.request === 'function') {
      var ran = false;
      return locks.request(LOCK_NAME, function () {
        ran = true;
        return safeHandle(method, path, body);
      }).then(function (r) { return r; }, function () {
        return ran ? internalError() : safeHandle(method, path, body);
      });
    }
    return safeHandle(method, path, body);
  }
  function request(method, path, body) {
    var p = chain.then(function () { return runExclusive(method, path, body); });
    p = p.then(function (r) { return r; }, function () { return internalError(); });
    chain = p.then(function () {}, function () {});
    return p;
  }

  window.TodoApi = { request: request };
})();
