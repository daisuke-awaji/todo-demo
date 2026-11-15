'use strict';
(function () {
  var A = window.App;
  var qs = A.qs;

  // ---- 要素 ----
  var el = {
    userName: qs(document, 'header-user-name'),
    headerLinks: document.getElementById('header-links'),
    logout: qs(document, 'logout-button'),
    addForm: qs(document, 'add-form'),
    title: qs(document, 'title-input'),
    memo: qs(document, 'memo-input'),
    due: qs(document, 'due-input'),
    priority: qs(document, 'priority-select'),
    addSubmit: qs(document, 'add-submit'),
    titleError: qs(document, 'title-error'),
    memoError: qs(document, 'memo-error'),
    dueError: qs(document, 'due-error'),
    priorityError: qs(document, 'priority-error'),
    addFormError: qs(document, 'add-form-error'),
    statusBtns: {
      all: qs(document, 'filter-status-all'),
      active: qs(document, 'filter-status-active'),
      done: qs(document, 'filter-status-done'),
    },
    fPriority: qs(document, 'filter-priority'),
    fQ: qs(document, 'filter-q'),
    fQError: qs(document, 'filter-q-error'),
    fSort: qs(document, 'filter-sort'),
    fClear: qs(document, 'filter-clear'),
    counts: qs(document, 'todo-counts'),
    summary: document.getElementById('summary'),
    clearBtn: qs(document, 'clear-completed-button'),
    listError: qs(document, 'list-error'),
    list: qs(document, 'todo-list'),
  };

  // ---- 状態 ----
  var DEFAULTS = { status: 'all', priority: 'all', q: '', sort: 'created_desc' };
  var ENUMS = {
    status: ['all', 'active', 'done'],
    priority: ['all', 'high', 'medium', 'low'],
    sort: ['created_desc', 'created_asc', 'due_asc', 'priority_desc'],
  };
  var filters = { status: 'all', priority: 'all', q: '', sort: 'created_desc' };
  var data = null; // { items, counts }
  var editing = null; // { id, title, memo, due, priority, errors, busy }
  var deleteConfirmId = null;
  var deleteBusy = false;
  var clearConfirmOpen = false;
  var clearBusy = false;
  var toggleBusy = {}; // id -> 望ましい checked
  var loadSeq = 0;
  var addBusy = false;

  function cpLen(s) { return Array.from(s).length; }

  // ---- URL と条件 ----
  function restoreFromUrl() {
    var sp = new URL(location.href).searchParams;
    ['status', 'priority', 'sort'].forEach(function (k) {
      var all = sp.getAll(k);
      filters[k] = (all.length === 1 && ENUMS[k].indexOf(all[0]) >= 0) ? all[0] : DEFAULTS[k];
    });
    var qs2 = sp.getAll('q');
    filters.q = '';
    if (qs2.length === 1) {
      var q = qs2[0].trim();
      if (cpLen(q) <= 100) filters.q = q;
    }
    syncFilterControls();
  }

  function syncFilterControls() {
    Object.keys(el.statusBtns).forEach(function (k) {
      el.statusBtns[k].setAttribute('aria-pressed', filters.status === k ? 'true' : 'false');
    });
    el.fPriority.value = filters.priority;
    el.fSort.value = filters.sort;
    el.fQ.value = filters.q;
  }

  function queryString() {
    var p = new URLSearchParams();
    if (filters.status !== 'all') p.append('status', filters.status);
    if (filters.priority !== 'all') p.append('priority', filters.priority);
    var q = filters.q.trim();
    if (q !== '') p.append('q', q);
    if (filters.sort !== 'created_desc') p.append('sort', filters.sort);
    return p.toString();
  }

  function updateUrl() {
    var s = queryString();
    history.replaceState(null, '', s ? 'todos.html?' + s : 'todos.html');
  }

  // ---- 描画 ----
  function mk(tag, attrs, text) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function tid(tag, testid, attrs, text) {
    var a = attrs || {};
    a['data-testid'] = testid;
    return mk(tag, a, text);
  }

  var PRIO_LABEL = { high: '高', medium: '中', low: '低' };

  function renderCounts() {
    el.counts.textContent = '';
    if (!data) {
      el.clearBtn.disabled = true;
      return;
    }
    var c = data.counts;
    el.counts.appendChild(document.createTextNode('全 '));
    el.counts.appendChild(tid('span', 'count-all', null, String(c.all)));
    el.counts.appendChild(document.createTextNode(' 件 / 未完了 '));
    el.counts.appendChild(tid('span', 'count-active', null, String(c.active)));
    el.counts.appendChild(document.createTextNode(' 件 / 完了 '));
    el.counts.appendChild(tid('span', 'count-done', null, String(c.done)));
    el.counts.appendChild(document.createTextNode(' 件'));
    el.clearBtn.disabled = c.done === 0;
  }

  function renderClearConfirm() {
    var old = qs(document, 'clear-confirm');
    if (old) old.remove();
    if (!clearConfirmOpen || !data) return;
    var box = tid('div', 'clear-confirm', { id: 'clear-confirm' });
    box.appendChild(tid('p', 'clear-confirm-message', null, '完了済みの ToDo ' + data.counts.done + ' 件を削除しますか？'));
    var yes = tid('button', 'clear-confirm-yes', { type: 'button' }, '削除する');
    var no = tid('button', 'clear-confirm-no', { type: 'button' }, 'キャンセル');
    if (clearBusy) { yes.disabled = true; no.disabled = true; }
    yes.addEventListener('click', onClearYes);
    no.addEventListener('click', function () { clearConfirmOpen = false; renderClearConfirm(); });
    box.appendChild(yes);
    box.appendChild(no);
    el.summary.appendChild(box);
  }

  function fieldBlock(idBase, labelText, control, errTestid, errText) {
    var wrap = mk('div', { class: 'field' });
    var label = mk('label', { for: idBase }, labelText);
    control.id = idBase;
    wrap.appendChild(label);
    wrap.appendChild(control);
    var err = tid('div', errTestid, { role: 'alert' });
    A.setError(err, errText || '');
    wrap.appendChild(err);
    return wrap;
  }

  function renderEditRow(li, t) {
    var ed = editing;
    var form = tid('form', 'edit-form', { novalidate: '', class: 'edit-form' });
    var fe = tid('div', 'edit-form-error', { role: 'alert', class: 'form-error' });
    A.setError(fe, ed.errors.form || '');
    form.appendChild(fe);

    var ti = tid('input', 'edit-title-input', { type: 'text' });
    ti.value = ed.title;
    form.appendChild(fieldBlock('edit-title-' + t.id, 'タイトル', ti, 'edit-title-error', ed.errors.title));

    var mi = tid('textarea', 'edit-memo-input', { rows: '3' });
    mi.value = ed.memo;
    form.appendChild(fieldBlock('edit-memo-' + t.id, 'メモ', mi, 'edit-memo-error', ed.errors.memo));

    var di = tid('input', 'edit-due-input', { type: 'date' });
    di.value = ed.due;
    form.appendChild(fieldBlock('edit-due-' + t.id, '期限', di, 'edit-due-error', ed.errors.due));

    var ps = tid('select', 'edit-priority-select');
    [['high', '高'], ['medium', '中'], ['low', '低']].forEach(function (o) {
      ps.appendChild(mk('option', { value: o[0] }, o[1]));
    });
    ps.value = ed.priority;
    form.appendChild(fieldBlock('edit-priority-' + t.id, '優先度', ps, 'edit-priority-error', ed.errors.priority));

    var actions = mk('div', { class: 'edit-actions' });
    var save = tid('button', 'edit-save', { type: 'submit' }, '保存');
    var cancel = tid('button', 'edit-cancel', { type: 'button' }, 'キャンセル');
    if (ed.busy) save.disabled = true;
    actions.appendChild(save);
    actions.appendChild(cancel);
    form.appendChild(actions);

    form.addEventListener('submit', function (ev) { ev.preventDefault(); onEditSave(t.id, form); });
    cancel.addEventListener('click', function () { editing = null; render(); });
    li.appendChild(form);
  }

  function renderViewRow(li, t) {
    var row = mk('div', { class: 'todo-row' });
    var busy = Object.prototype.hasOwnProperty.call(toggleBusy, t.id);
    var cb = tid('input', 'todo-toggle', {
      type: 'checkbox',
      'aria-label': (t.status === 'done' ? '未完了に戻す: ' : '完了にする: ') + t.title,
    });
    cb.checked = busy ? toggleBusy[t.id] : t.status === 'done';
    if (busy) cb.disabled = true;
    cb.addEventListener('change', function () { onToggle(t.id, cb.checked); });
    row.appendChild(cb);
    row.appendChild(tid('span', 'todo-title', { class: 'todo-title' }, t.title));
    row.appendChild(tid('span', 'todo-priority', { class: 'todo-priority', 'data-priority': t.priority }, PRIO_LABEL[t.priority]));
    if (t.dueDate !== null) row.appendChild(tid('span', 'todo-due', { class: 'todo-due' }, '期限: ' + t.dueDate));
    if (t.overdue) row.appendChild(tid('span', 'todo-overdue', { class: 'todo-overdue' }, '期限切れ'));
    var actions = mk('div', { class: 'todo-actions' });
    var eb = tid('button', 'todo-edit-button', { type: 'button' }, '編集');
    var db = tid('button', 'todo-delete-button', { type: 'button' }, '削除');
    eb.addEventListener('click', function () { onEditOpen(t); });
    db.addEventListener('click', function () { onDeleteOpen(t.id); });
    actions.appendChild(eb);
    actions.appendChild(db);
    row.appendChild(actions);
    li.appendChild(row);
    if (t.memo !== '') li.appendChild(tid('p', 'todo-memo', { class: 'todo-memo' }, t.memo));
    if (deleteConfirmId === t.id) {
      var box = tid('div', 'delete-confirm', { class: 'delete-confirm' });
      box.appendChild(tid('p', 'delete-confirm-message', null, '「' + t.title + '」を削除しますか？'));
      var yes = tid('button', 'delete-confirm-yes', { type: 'button' }, '削除する');
      var no = tid('button', 'delete-confirm-no', { type: 'button' }, 'キャンセル');
      if (deleteBusy) { yes.disabled = true; no.disabled = true; }
      yes.addEventListener('click', function () { onDeleteYes(t.id); });
      no.addEventListener('click', function () { deleteConfirmId = null; render(); });
      box.appendChild(yes);
      box.appendChild(no);
      li.appendChild(box);
    }
  }

  function captureEdit() {
    if (!editing) return;
    // 編集中の行（editing.id）のフォームだけを読む。別の行のフォームが DOM に残っていても読まない
    var row = el.list.querySelector('[data-todo-id="' + String(editing.id).replace(/[^0-9A-Za-z_-]/g, '') + '"]');
    var form = row ? qs(row, 'edit-form') : null;
    if (!form) return;
    editing.title = qs(form, 'edit-title-input').value;
    editing.memo = qs(form, 'edit-memo-input').value;
    editing.due = qs(form, 'edit-due-input').value;
    editing.priority = qs(form, 'edit-priority-select').value;
  }

  function render() {
    captureEdit();
    var active = document.activeElement;
    var focusKey = null;
    if (active && el.list.contains(active)) {
      var row = active.closest('[data-todo-id]');
      focusKey = { id: row ? row.getAttribute('data-todo-id') : null, testid: active.getAttribute('data-testid') };
    }
    renderCounts();
    renderClearConfirm();
    // 空の表示
    var emptyEl = qs(document, 'list-empty');
    if (emptyEl) emptyEl.remove();
    var noMatchEl = qs(document, 'list-no-match');
    if (noMatchEl) noMatchEl.remove();
    el.list.textContent = '';
    if (!data) return;
    if (data.counts.all === 0) {
      el.list.after(tid('p', 'list-empty', { class: 'empty-message' }, 'ToDo はまだありません。上のフォームから追加してください'));
    } else if (data.items.length === 0) {
      el.list.after(tid('p', 'list-no-match', { class: 'empty-message' }, '条件に合う ToDo はありません'));
    }
    data.items.forEach(function (t) {
      var li = tid('li', 'todo-item', {
        class: 'todo-item',
        'data-todo-id': String(t.id),
        'data-status': t.status,
        'data-mode': editing && editing.id === t.id ? 'edit' : 'view',
      });
      if (editing && editing.id === t.id) renderEditRow(li, t);
      else renderViewRow(li, t);
      el.list.appendChild(li);
    });
    if (focusKey && focusKey.id !== null) {
      var target = el.list.querySelector('[data-todo-id="' + focusKey.id + '"] [data-testid="' + focusKey.testid + '"]');
      if (target && !target.disabled) target.focus();
    }
  }

  // ---- 一覧の取得 ----
  function load(keepListError) {
    var seq = ++loadSeq;
    var s = queryString();
    return A.api('GET', '/api/todos' + (s ? '?' + s : '')).then(function (r) {
      if (seq !== loadSeq) return;
      if (r.status === 200) {
        data = r.data;
        if (!keepListError) A.setError(el.listError, '');
        A.setError(el.fQError, '');
        // 残っていない行の編集・確認は捨てる
        var ids = {};
        data.items.forEach(function (t) { ids[t.id] = true; });
        if (editing && !ids[editing.id]) editing = null;
        if (deleteConfirmId !== null && !ids[deleteConfirmId]) deleteConfirmId = null;
        if (clearConfirmOpen && data.counts.done === 0) clearConfirmOpen = false;
        render();
        return;
      }
      var e = A.errorOf(r);
      if (r.status === 400 && e.fields) {
        // fields.q のときだけ filter-q-error に出す（q 以外の 400 は画面からは起きない。OPEN_QUESTIONS Q8）
        if (e.fields.q) A.setError(el.fQError, e.fields.q);
      } else {
        A.setError(el.listError, e.message);
      }
    });
  }

  function onFiltersChanged() {
    A.setError(el.listError, '');
    updateUrl();
    load(false);
  }

  // ---- ヘッダー ----
  function loadMe() {
    return A.api('GET', '/api/me').then(function (r) {
      A.showPage();
      if (r.status !== 200) return;
      el.userName.textContent = r.data.user.displayName;
      var old = qs(document, 'admin-users-link');
      if (old) old.remove();
      if (r.data.user.role === 'admin') {
        el.headerLinks.appendChild(tid('a', 'admin-users-link', { href: 'admin-users.html' }, '利用者一覧'));
      }
    });
  }

  // ---- 操作 ----
  function openExclusive(which) {
    if (which !== 'edit') editing = null;
    if (which !== 'delete') deleteConfirmId = null;
    if (which !== 'clear') clearConfirmOpen = false;
  }

  function onToggle(id, checked) {
    A.setError(el.listError, '');
    toggleBusy[id] = checked;
    render();
    A.api('POST', '/api/todos/' + id + (checked ? '/complete' : '/reopen')).then(function (r) {
      delete toggleBusy[id];
      var failed = !r.ok;
      if (failed) A.setError(el.listError, A.errorOf(r).message);
      render();
      load(failed);
    });
  }

  function onEditOpen(t) {
    captureEdit();
    openExclusive('edit');
    editing = { id: t.id, title: t.title, memo: t.memo, due: t.dueDate === null ? '' : t.dueDate, priority: t.priority, errors: {}, busy: false };
    render();
    var f = el.list.querySelector('[data-todo-id="' + t.id + '"] [data-testid="edit-title-input"]');
    if (f) f.focus();
  }

  function onEditSave(id, form) {
    if (!editing || editing.id !== id || editing.busy) return;
    captureEdit();
    editing.errors = {};
    editing.busy = true;
    A.setError(el.listError, '');
    render();
    var body = {
      title: editing.title,
      memo: editing.memo,
      dueDate: editing.due === '' ? null : editing.due,
      priority: editing.priority,
    };
    A.api('PATCH', '/api/todos/' + id, body).then(function (r) {
      if (!editing || editing.id !== id) { load(false); return; }
      editing.busy = false;
      if (r.status === 200) {
        editing = null;
        // 表示に戻した直後に古い値が見えないよう、応答の ToDo で行を置き換えてから、一覧を取り直す
        if (data && r.data && r.data.id === id) {
          data.items = data.items.map(function (x) { return x.id === id ? r.data : x; });
        }
        render();
        load(false);
        return;
      }
      var e = A.errorOf(r);
      if (r.status === 404) {
        editing = null;
        A.setError(el.listError, e.message);
        render();
        load(true);
        return;
      }
      if (r.status === 400 && e.fields) {
        editing.errors = {
          title: e.fields.title || '',
          memo: e.fields.memo || '',
          due: e.fields.dueDate || '',
          priority: e.fields.priority || '',
          form: '',
        };
        var known = ['title', 'memo', 'dueDate', 'priority'];
        var other = Object.keys(e.fields).filter(function (k) { return known.indexOf(k) < 0; })[0];
        if (other) editing.errors.form = e.fields[other];
      } else {
        editing.errors = { form: e.message };
      }
      render();
    });
  }

  function onDeleteOpen(id) {
    captureEdit();
    openExclusive('delete');
    deleteConfirmId = id;
    render();
  }

  function onDeleteYes(id) {
    if (deleteBusy) return;
    A.setError(el.listError, '');
    deleteBusy = true;
    render();
    A.api('DELETE', '/api/todos/' + id).then(function (r) {
      deleteBusy = false;
      deleteConfirmId = null;
      var failed = !r.ok;
      if (failed) A.setError(el.listError, A.errorOf(r).message);
      render();
      load(failed);
    });
  }

  function onClearOpen() {
    if (!data || data.counts.done === 0) return;
    captureEdit();
    openExclusive('clear');
    clearConfirmOpen = true;
    render();
  }

  function onClearYes() {
    if (clearBusy) return;
    A.setError(el.listError, '');
    clearBusy = true;
    renderClearConfirm();
    A.api('POST', '/api/todos/clear-completed').then(function (r) {
      clearBusy = false;
      clearConfirmOpen = false;
      var failed = !r.ok;
      if (failed) A.setError(el.listError, A.errorOf(r).message);
      render();
      load(failed);
    });
  }

  function clearAddErrors() {
    A.setError(el.titleError, '');
    A.setError(el.memoError, '');
    A.setError(el.dueError, '');
    A.setError(el.priorityError, '');
    A.setError(el.addFormError, '');
  }

  el.addForm.addEventListener('submit', function (ev) {
    ev.preventDefault();
    if (addBusy) return;
    addBusy = true;
    el.addSubmit.disabled = true;
    clearAddErrors();
    A.setError(el.listError, '');
    var body = {
      title: el.title.value,
      memo: el.memo.value,
      dueDate: el.due.value === '' ? null : el.due.value,
      priority: el.priority.value,
    };
    A.api('POST', '/api/todos', body).then(function (r) {
      addBusy = false;
      el.addSubmit.disabled = false;
      if (r.status === 201) {
        el.title.value = '';
        el.memo.value = '';
        el.due.value = '';
        el.priority.value = 'medium';
        clearAddErrors();
        el.title.focus();
        load(false);
        return;
      }
      var e = A.errorOf(r);
      if (r.status === 400 && e.fields) {
        A.setError(el.titleError, e.fields.title || '');
        A.setError(el.memoError, e.fields.memo || '');
        A.setError(el.dueError, e.fields.dueDate || '');
        A.setError(el.priorityError, e.fields.priority || '');
        var known = ['title', 'memo', 'dueDate', 'priority'];
        var other = Object.keys(e.fields).filter(function (k) { return known.indexOf(k) < 0; })[0];
        if (other) A.setError(el.addFormError, e.fields[other]);
      } else {
        A.setError(el.addFormError, e.message);
      }
    });
  });

  Object.keys(el.statusBtns).forEach(function (k) {
    el.statusBtns[k].addEventListener('click', function () {
      filters.status = k;
      syncFilterControls();
      onFiltersChanged();
    });
  });
  el.fPriority.addEventListener('change', function () { filters.priority = el.fPriority.value; onFiltersChanged(); });
  el.fSort.addEventListener('change', function () { filters.sort = el.fSort.value; onFiltersChanged(); });
  el.fQ.addEventListener('input', function () { filters.q = el.fQ.value; onFiltersChanged(); });
  el.fClear.addEventListener('click', function () {
    filters = { status: 'all', priority: 'all', q: '', sort: 'created_desc' };
    syncFilterControls();
    A.setError(el.fQError, '');
    onFiltersChanged();
  });
  el.clearBtn.addEventListener('click', onClearOpen);

  el.logout.addEventListener('click', function () {
    el.logout.disabled = true;
    A.api('POST', '/api/logout', undefined, { noRedirect: true }).then(function () {
      location.replace('login.html');
    });
  });

  window.addEventListener('pageshow', function (ev) {
    if (ev.persisted) loadMe();
  });

  // ---- 開始 ----
  restoreFromUrl();
  render();
  // まず GET /api/me（401 なら login.html へ移り、ToDo の行は作らない）。そのあと一覧を取得する
  loadMe().then(function () { load(false); });
})();
