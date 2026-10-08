// Demo HRMS single-page app. Vanilla JS, no build step.
// Views are <template> elements in index.html; this file clones and fills them.
'use strict';

(function demoApp() {
  // Server-injected runtime config (see renderIndex in server.mjs).
  const config = Object.assign(
    { balanceEndpoint: '/api/leave-balance', cacheBalance: false, announcementsWidget: false },
    window.__DEMO__ || {},
  );

  const TOKEN_KEY = 'demo.token';
  const USER_KEY = 'demo.user';
  const BALANCE_CACHE_KEY = 'demo.balanceCache';

  const main = document.getElementById('main');

  // ------------------------------------------------------------------ session

  const session = {
    get token() {
      return localStorage.getItem(TOKEN_KEY);
    },
    get user() {
      const raw = localStorage.getItem(USER_KEY);
      if (!raw) return null;
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    },
    save(token, user) {
      localStorage.setItem(TOKEN_KEY, token);
      localStorage.setItem(USER_KEY, JSON.stringify(user));
    },
    clear() {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
    },
  };

  const isApprover = (user) => user && (user.role === 'manager' || user.role === 'admin');

  // ------------------------------------------------------------------ API

  function authHeaders() {
    const user = session.user;
    const headers = {};
    if (session.token) headers['Authorization'] = `Bearer ${session.token}`;
    if (user) headers['X-Tenant-Code'] = user.tenant;
    return headers;
  }

  /** Calls the JSON API. Resolves to { status, ok, data }; never throws on HTTP errors. */
  async function api(path, { method = 'GET', body } = {}) {
    const headers = authHeaders();
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data = null;
    const type = res.headers.get('content-type') || '';
    if (type.includes('application/json')) data = await res.json();
    if (res.status === 401 && path !== '/api/auth/login') {
      session.clear();
      navigate('/login', { replace: true });
    }
    return { status: res.status, ok: res.ok, data };
  }

  const errorText = (result) =>
    (result.data && result.data.error) || `Request failed (HTTP ${result.status})`;

  // ------------------------------------------------------------------ DOM helpers

  function cloneTemplate(id) {
    return document.getElementById(id).content.cloneNode(true);
  }

  function fillFields(root, record) {
    for (const el of root.querySelectorAll('[data-field]')) {
      const key = el.getAttribute('data-field');
      if (key in record && el.tagName !== 'A') el.textContent = String(record[key] ?? '');
    }
  }

  function mount(fragment, title) {
    main.replaceChildren(fragment);
    document.title = `${title} · Demo HRMS`;
    main.focus();
  }

  function showFlash(text) {
    const flash = document.getElementById('flash') || document.getElementById('detail-flash');
    if (flash) flash.textContent = text;
  }

  function showMessage(title, text) {
    const view = cloneTemplate('tpl-message');
    fillFields(view, { title, text });
    mount(view, title);
  }

  const formatDays = (days) => String(days);

  // ------------------------------------------------------------------ chrome (header + nav)

  function renderChrome() {
    const header = document.getElementById('site-header');
    const user = session.user;
    header.hidden = !user;
    if (!user) return;
    document.getElementById('current-user').textContent = `${user.name} (${user.role}, ${user.tenant})`;
    for (const li of header.querySelectorAll('[data-requires-role]')) {
      const roles = li.getAttribute('data-requires-role').split(' ');
      li.hidden = !roles.includes(user.role);
    }
  }

  // ------------------------------------------------------------------ views

  function renderLogin() {
    const view = cloneTemplate('tpl-login');
    const form = view.querySelector('#login-form');
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const error = document.getElementById('login-error');
      error.hidden = true;
      const result = await api('/api/auth/login', {
        method: 'POST',
        body: {
          tenant: document.getElementById('login-tenant').value.trim(),
          email: document.getElementById('login-email').value.trim(),
          password: document.getElementById('login-password').value,
        },
      });
      if (!result.ok) {
        error.textContent = errorText(result);
        error.hidden = false;
        return;
      }
      session.save(result.data.token, result.data.user);
      navigate('/dashboard');
    });
    mount(view, 'Sign in');
  }

  function readBalanceCache() {
    try {
      return JSON.parse(localStorage.getItem(BALANCE_CACHE_KEY) || '{}');
    } catch {
      return {};
    }
  }

  const readCachedBalance = (userId) => readBalanceCache()[userId] || null;

  function writeCachedBalance(userId, balance) {
    const cache = readBalanceCache();
    cache[userId] = balance;
    localStorage.setItem(BALANCE_CACHE_KEY, JSON.stringify(cache));
  }

  async function loadBalance(user) {
    // Seeded bug `stale-ui-balance`: the first balance ever fetched is cached and reused forever.
    if (config.cacheBalance) {
      const cached = readCachedBalance(user.id);
      if (cached) return { ok: true, data: cached };
    }
    const result = await api(config.balanceEndpoint);
    if (result.ok && config.cacheBalance) writeCachedBalance(user.id, result.data);
    return result;
  }

  // Seeded bug `dashboard-console-error`: a widget reads a field the config never provides.
  function renderAnnouncements(widgetConfig) {
    return widgetConfig.items.map((item) => item.title);
  }

  async function renderDashboard(user) {
    const view = cloneTemplate('tpl-dashboard');
    mount(view, 'Dashboard');

    const show = async () => {
      const result = await loadBalance(user);
      const errorBox = document.getElementById('balance-error');
      if (!errorBox) return; // navigated away
      if (!result.ok) {
        errorBox.hidden = false;
        return;
      }
      errorBox.hidden = true;
      const { total, used, available } = result.data;
      document.getElementById('balance-days').textContent = formatDays(available);
      document.getElementById('balance-detail').textContent = `Used ${formatDays(used)} of ${formatDays(total)} days`;
    };
    document.getElementById('balance-retry').addEventListener('click', show);
    await show();

    if (config.announcementsWidget) {
      setTimeout(() => renderAnnouncements(config.announcements), 0);
    }
  }

  async function renderLeaves(user, flashText) {
    const view = cloneTemplate('tpl-leaves');
    mount(view, 'My leaves');
    if (flashText) showFlash(flashText);

    document.getElementById('export-csv').addEventListener('click', exportCsv);

    const result = await api('/api/leaves');
    if (!result.ok) {
      showFlash(errorText(result));
      return;
    }
    const body = document.getElementById('leaves-body');
    if (!body) return;
    document.getElementById('leaves-empty').hidden = result.data.length > 0;
    for (const leave of result.data) {
      const row = cloneTemplate('tpl-leave-row');
      const tr = row.querySelector('tr');
      tr.setAttribute('data-leave-id', String(leave.id));
      fillFields(row, { ...leave, days: formatDays(leave.days) });
      row.querySelector('[data-field="view"]').setAttribute('href', `/leaves/${leave.id}`);
      const cancel = row.querySelector('[data-action="cancel"]');
      const cancellable = leave.employeeId === user.id && (leave.status === 'submitted' || leave.status === 'approved');
      if (cancellable) {
        cancel.addEventListener('click', async () => {
          const res = await api(`/api/leaves/${leave.id}/cancel`, { method: 'POST' });
          renderLeaves(user, res.ok ? 'Leave cancelled.' : errorText(res));
        });
      } else {
        cancel.remove();
      }
      body.appendChild(row);
    }
  }

  async function exportCsv() {
    const res = await fetch('/api/leaves/export.csv', { headers: authHeaders() });
    if (!res.ok) {
      showFlash(`Export failed (HTTP ${res.status})`);
      return;
    }
    const blob = await res.blob();
    const href = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = href;
    link.download = 'leaves.csv';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(href), 1000);
  }

  function renderApply() {
    const view = cloneTemplate('tpl-apply');
    const form = view.querySelector('#apply-form');
    const halfDay = view.querySelector('#leave-half-day');
    const daysInput = view.querySelector('#leave-days');

    halfDay.addEventListener('change', () => {
      daysInput.readOnly = halfDay.checked;
      if (halfDay.checked) daysInput.value = '0.5';
    });

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const draft = event.submitter && event.submitter.value === 'draft';
      for (const el of form.querySelectorAll('[data-error-for]')) el.textContent = '';
      for (const el of form.querySelectorAll('[aria-invalid]')) el.removeAttribute('aria-invalid');
      const alertBox = document.getElementById('apply-error');
      alertBox.hidden = true;

      const daysRaw = daysInput.value.trim();
      const payload = {
        from: document.getElementById('leave-from').value,
        to: document.getElementById('leave-to').value,
        days: daysRaw === '' ? null : Number(daysRaw),
        reason: document.getElementById('leave-reason').value,
        halfDay: halfDay.checked,
        draft,
      };
      const result = await api('/api/leaves', { method: 'POST', body: payload });
      if (!result.ok) {
        const message = errorText(result);
        const field = result.data && result.data.field;
        const fieldError = field && form.querySelector(`[data-error-for="${field}"]`);
        if (fieldError) {
          fieldError.textContent = message;
          const input = form.querySelector(`[name="${field}"]`);
          if (input) input.setAttribute('aria-invalid', 'true');
        }
        alertBox.textContent = message;
        alertBox.hidden = false;
        return;
      }
      navigate('/leaves', { flash: draft ? 'Leave saved as draft.' : 'Leave request submitted.' });
    });
    mount(view, 'Apply leave');
  }

  async function renderLeaveDetail(user, id, flashText) {
    const result = await api(`/api/leaves/${encodeURIComponent(id)}`);
    if (!result.ok) {
      showMessage('Leave not found', errorText(result));
      return;
    }
    const leave = result.data;
    const view = cloneTemplate('tpl-leave-detail');
    fillFields(view, { ...leave, days: formatDays(leave.days) });

    const own = leave.employeeId === user.id;
    const visible = {
      submit: own && leave.status === 'draft',
      cancel: own && ['draft', 'submitted', 'approved'].includes(leave.status),
      approve: !own && isApprover(user) && leave.status === 'submitted',
      reject: !own && isApprover(user) && leave.status === 'submitted',
    };
    for (const button of view.querySelectorAll('button[data-action]')) {
      const action = button.getAttribute('data-action');
      button.hidden = !visible[action];
      button.addEventListener('click', async () => {
        const res = await api(`/api/leaves/${leave.id}/${action}`, { method: 'POST' });
        if (!res.ok) {
          const error = document.getElementById('detail-error');
          error.textContent = errorText(res);
          error.hidden = false;
          return;
        }
        renderLeaveDetail(user, id, `Leave ${res.data.status}.`);
      });
    }
    mount(view, 'Leave request');
    if (flashText) showFlash(flashText);
  }

  async function renderApprovals(user, flashText) {
    const view = cloneTemplate('tpl-approvals');
    mount(view, 'Approvals');
    if (flashText) showFlash(flashText);
    const result = await api('/api/approvals');
    if (!result.ok) {
      showFlash(errorText(result));
      return;
    }
    const body = document.getElementById('approvals-body');
    if (!body) return;
    document.getElementById('approvals-empty').hidden = result.data.length > 0;
    for (const leave of result.data) {
      const row = cloneTemplate('tpl-approval-row');
      row.querySelector('tr').setAttribute('data-leave-id', String(leave.id));
      fillFields(row, { ...leave, days: formatDays(leave.days) });
      for (const button of row.querySelectorAll('button[data-action]')) {
        const action = button.getAttribute('data-action');
        button.setAttribute('aria-label', `${button.textContent} leave of ${leave.employeeName}: ${leave.reason}`);
        button.addEventListener('click', async () => {
          const res = await api(`/api/leaves/${leave.id}/${action}`, { method: 'POST' });
          const done = action === 'approve' ? 'approved' : 'rejected';
          renderApprovals(user, res.ok ? `Leave ${done}.` : errorText(res));
        });
      }
      body.appendChild(row);
    }
  }

  async function renderEmployees() {
    const view = cloneTemplate('tpl-employees');
    mount(view, 'Employees');
    const result = await api('/api/employees');
    const body = document.getElementById('employees-body');
    if (!body) return;
    if (!result.ok) {
      showMessage('Access denied', errorText(result));
      return;
    }
    for (const employee of result.data) {
      const row = cloneTemplate('tpl-employee-row');
      fillFields(row, employee);
      body.appendChild(row);
    }
  }

  const formatTime = (iso) =>
    iso ? new Date(iso).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' }) : '—';

  async function renderAttendance(user, flashText) {
    const view = cloneTemplate('tpl-attendance');
    mount(view, 'Attendance');
    if (flashText) showFlash(flashText);

    for (const [id, path, done] of [
      ['punch-in', '/api/attendance/punch-in', 'Punched in.'],
      ['punch-out', '/api/attendance/punch-out', 'Punched out.'],
    ]) {
      document.getElementById(id).addEventListener('click', async () => {
        const res = await api(path, { method: 'POST' });
        renderAttendance(user, res.ok ? done : errorText(res));
      });
    }

    const result = await api('/api/attendance');
    const body = document.getElementById('attendance-body');
    if (!body || !result.ok) return;
    for (const record of result.data) {
      const row = cloneTemplate('tpl-attendance-row');
      fillFields(row, { date: record.date, punchIn: formatTime(record.punchIn), punchOut: formatTime(record.punchOut) });
      body.appendChild(row);
    }
  }

  // ------------------------------------------------------------------ router

  const routes = [
    { pattern: /^\/login$/, public: true, render: () => renderLogin() },
    { pattern: /^\/dashboard$/, render: (user) => renderDashboard(user) },
    { pattern: /^\/leaves$/, render: (user, _m, state) => renderLeaves(user, state.flash) },
    { pattern: /^\/leaves\/apply$/, render: () => renderApply() },
    { pattern: /^\/leaves\/(\d+)$/, render: (user, m) => renderLeaveDetail(user, m[1]) },
    { pattern: /^\/approvals$/, roles: ['manager', 'admin'], render: (user) => renderApprovals(user) },
    { pattern: /^\/employees$/, roles: ['admin'], render: (user) => renderEmployees(user) },
    { pattern: /^\/attendance$/, render: (user) => renderAttendance(user) },
  ];

  function navigate(path, state = {}) {
    if (state.replace) history.replaceState(state, '', path);
    else history.pushState(state, '', path);
    route();
  }

  function route() {
    const path = location.pathname.replace(/\/+$/, '') || '/';
    const user = session.user;
    renderChrome();

    if (path === '/') {
      navigate(user ? '/dashboard' : '/login', { replace: true });
      return;
    }
    if (path === '/login' && user) {
      navigate('/dashboard', { replace: true });
      return;
    }
    for (const r of routes) {
      const match = path.match(r.pattern);
      if (!match) continue;
      if (!r.public && !user) {
        navigate('/login', { replace: true });
        return;
      }
      if (r.roles && !r.roles.includes(user.role)) {
        showMessage('Access denied', 'You do not have permission to view this page.');
        return;
      }
      r.render(user, match, history.state || {});
      return;
    }
    showMessage('Page not found', `There is no page at ${path}.`);
  }

  // Intercept same-origin link clicks so navigation stays inside the SPA.
  document.addEventListener('click', (event) => {
    const link = event.target.closest('a[href]');
    if (!link || link.target || link.hasAttribute('download')) return;
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
    const url = new URL(link.href, location.href);
    if (url.origin !== location.origin) return;
    if (url.hash && url.pathname === location.pathname) return; // in-page anchor (skip link)
    event.preventDefault();
    navigate(url.pathname);
  });

  document.getElementById('logout').addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST' });
    session.clear();
    navigate('/login', { replace: true });
  });

  window.addEventListener('popstate', route);
  route();
})();
