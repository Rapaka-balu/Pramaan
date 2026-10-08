// Demo HRMS: a tiny local HRMS that imitates the real pilot app (PRAMAAN_BUILD_SPEC.md §5).
// Express + static SPA + in-memory store. Every toggle is read per instance from the `env` argument.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(HERE, 'public');
const PASSWORD = 'Demo@123';
const DEFAULT_SECRET = 'pramaan-demo-hrms-fixture-secret';
const TOKEN_TTL_SECONDS = 8 * 60 * 60;
const IST_OFFSET_MS = 330 * 60 * 1000;
const MAX_REASON = 200;

export const KNOWN_BUGS = Object.freeze([
  'idor-leave-read',
  'employee-admin-endpoint',
  'cross-tenant-list',
  'self-approve',
  'double-approve',
  'cancel-no-refund',
  'balance-off-by-one',
  'half-day-rounding',
  'negative-days',
  'end-before-start',
  'ist-midnight',
  'long-reason-500',
  'dashboard-console-error',
  'stale-ui-balance',
  'csv-export-mismatch',
]);
const KNOWN_DRIFTS = Object.freeze(['apply-testid']);

const SPA_ROUTES = [
  '/',
  '/login',
  '/dashboard',
  '/leaves',
  '/leaves/apply',
  '/leaves/:id',
  '/approvals',
  '/employees',
  '/attendance',
];

// ------------------------------------------------------------------ options

function parseList(value, known, name) {
  const items = String(value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '' && s !== 'none');
  for (const item of items) {
    if (!known.includes(item)) throw new Error(`Unknown ${name} value: ${item}`);
  }
  return new Set(items);
}

function parseOptions(env) {
  const flaky = env.DEMO_FLAKY === undefined || env.DEMO_FLAKY === '' ? 0 : Number(env.DEMO_FLAKY);
  if (!Number.isFinite(flaky) || flaky < 0 || flaky > 1) throw new Error('DEMO_FLAKY must be a number in [0, 1]');
  const seed = env.DEMO_SEED === undefined || env.DEMO_SEED === '' ? 42 : Number(env.DEMO_SEED);
  if (!Number.isInteger(seed)) throw new Error('DEMO_SEED must be an integer');
  return {
    bugs: parseList(env.DEMO_BUGS, KNOWN_BUGS, 'DEMO_BUGS'),
    drift: parseList(env.DEMO_DRIFT, KNOWN_DRIFTS, 'DEMO_DRIFT'),
    apiV2: env.DEMO_API_V2 === '1' || env.DEMO_API_V2 === 'true',
    flaky,
    seed,
    secret: env.DEMO_TOKEN_SECRET || DEFAULT_SECRET,
  };
}

/** mulberry32: tiny deterministic PRNG returning floats in [0, 1). */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------------ seed data

function seedState() {
  const users = [
    { id: 1, tenant: 'TEST', email: 'emp1@demo.local', name: 'Asha Rao', role: 'employee', managerId: 3 },
    { id: 2, tenant: 'TEST', email: 'emp2@demo.local', name: 'Vikram Iyer', role: 'employee', managerId: 3 },
    { id: 3, tenant: 'TEST', email: 'mgr1@demo.local', name: 'Meera Nair', role: 'manager', managerId: 4 },
    { id: 4, tenant: 'TEST', email: 'admin1@demo.local', name: 'Rohan Kapoor', role: 'admin', managerId: null },
    { id: 5, tenant: 'TEST2', email: 'admin2@demo.local', name: 'Kavita Menon', role: 'admin', managerId: null },
    { id: 6, tenant: 'TEST2', email: 'emp3@demo.local', name: 'Arjun Das', role: 'employee', managerId: 5 },
  ];
  const balances = new Map(users.map((u) => [u.id, { total: 20, used: 0 }]));
  // emp2's seeded approved leave (1 day) is reflected in the balance so seed data is self-consistent.
  balances.get(2).used = 1;

  const ts = '2026-10-01T04:30:00.000Z';
  const leave = (fields) => ({
    halfDay: false,
    fromTime: null,
    decidedBy: null,
    deducted: 0,
    createdAt: ts,
    updatedAt: ts,
    ...fields,
  });
  const leaves = [
    leave({ id: 1, tenant: 'TEST', employeeId: 1, from: '2026-11-02', to: '2026-11-03', days: 2, reason: 'Family function in Mysuru', status: 'submitted' }),
    leave({ id: 2, tenant: 'TEST', employeeId: 2, from: '2026-10-20', to: '2026-10-20', days: 1, reason: 'Medical appointment', status: 'approved', decidedBy: 3, deducted: 1 }),
    leave({ id: 3, tenant: 'TEST2', employeeId: 6, from: '2026-11-10', to: '2026-11-10', days: 1, reason: 'Personal work', status: 'submitted' }),
  ];
  const attendance = [
    { id: 1, tenant: 'TEST', employeeId: 1, date: '2026-10-07', punchIn: '2026-10-07T03:45:00.000Z', punchOut: '2026-10-07T12:40:00.000Z' },
  ];
  return { users, balances, leaves, attendance, nextLeaveId: 4, nextAttendanceId: 2 };
}

// ------------------------------------------------------------------ tokens

function signToken(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyToken(token, secret) {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const expected = crypto.createHmac('sha256', secret).update(body).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ helpers

class HttpError extends Error {
  constructor(status, message, field) {
    super(message);
    this.status = status;
    this.field = field;
  }
}

const badRequest = (message, field) => new HttpError(400, message, field);
const isApprover = (user) => user.role === 'manager' || user.role === 'admin';
const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

function isIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

const ISO_DATETIME_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const utcDateOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const istDateOf = (ms) => utcDateOf(ms + IST_OFFSET_MS);

function isLoopback(req) {
  const addr = req.socket.remoteAddress ?? '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function csvCell(value) {
  const s = String(value ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Validates a POST /api/leaves body. Returns normalized fields or throws a 400 HttpError. */
function validateLeaveInput(body, bugs) {
  if (!isPlainObject(body)) throw badRequest('Request body must be a JSON object', 'body');
  for (const flag of ['halfDay', 'draft']) {
    if (body[flag] !== undefined && typeof body[flag] !== 'boolean') throw badRequest(`${flag} must be a boolean`, flag);
  }
  const halfDay = body.halfDay === true;

  let from = body.from;
  let fromTime = null;
  if (body.fromTime !== undefined) {
    const ms = typeof body.fromTime === 'string' ? Date.parse(body.fromTime) : NaN;
    if (!ISO_DATETIME_WITH_OFFSET.test(String(body.fromTime)) || Number.isNaN(ms)) {
      throw badRequest('fromTime must be an ISO date-time with an offset', 'fromTime');
    }
    fromTime = body.fromTime;
    // Correct: the leave date is the Asia/Kolkata calendar date. Bug `ist-midnight` uses the UTC date.
    from = bugs.has('ist-midnight') ? utcDateOf(ms) : istDateOf(ms);
  }
  if (!isIsoDate(from)) throw badRequest('from must be a date in YYYY-MM-DD format', 'from');
  const to = body.to === undefined && fromTime !== null ? from : body.to;
  if (!isIsoDate(to)) throw badRequest('to must be a date in YYYY-MM-DD format', 'to');

  let days = body.days;
  if (halfDay && (days === undefined || days === null)) days = 0.5;
  if (typeof days !== 'number' || !Number.isFinite(days)) throw badRequest('days must be a number', 'days');
  if (days <= 0 && !bugs.has('negative-days')) throw badRequest('days must be greater than 0', 'days');
  if (!Number.isInteger(days * 2)) throw badRequest('days must be a multiple of 0.5', 'days');
  if (halfDay && days !== 0.5) throw badRequest('A half-day leave must be 0.5 days', 'days');
  if (to < from && !bugs.has('end-before-start')) throw badRequest('to must be on or after from', 'to');

  const reason = body.reason;
  if (typeof reason !== 'string' || reason.trim() === '') throw badRequest('reason is required', 'reason');
  if (reason.length > MAX_REASON) {
    // Bug `long-reason-500`: the length check is missing and the "database" blows up.
    if (bugs.has('long-reason-500')) throw new Error('value too long for column "reason" (varchar 200)');
    throw badRequest(`reason must be at most ${MAX_REASON} characters`, 'reason');
  }
  return { from, to, days, halfDay, reason, fromTime, draft: body.draft === true };
}

/** Days deducted from the balance when a leave is approved. */
function deductionFor(days, bugs) {
  let amount = days;
  if (bugs.has('half-day-rounding')) amount = Math.ceil(amount);
  if (bugs.has('balance-off-by-one')) amount += 1;
  return amount;
}

// ------------------------------------------------------------------ app

function renderIndex(template, opts) {
  // Neutral flag names on purpose: the page must not advertise which bug is active.
  const pageConfig = {
    balanceEndpoint: opts.apiV2 ? '/api/leave-balances' : '/api/leave-balance',
    cacheBalance: opts.bugs.has('stale-ui-balance'),
    announcementsWidget: opts.bugs.has('dashboard-console-error'),
  };
  const json = JSON.stringify(pageConfig).replace(/</g, '\\u003c');
  let html = template.replace('<!-- demo-config -->', `<script>window.__DEMO__ = ${json};</script>`);
  if (opts.drift.has('apply-testid')) {
    html = html.replace('data-testid="apply-leave-btn"', 'data-testid="apply-leave-submit"');
  }
  return html;
}

function createApp(opts, requestLog) {
  let state = seedState();
  let random = mulberry32(opts.seed);
  const { bugs } = opts;
  const indexHtml = renderIndex(fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8'), opts);

  const userById = (id) => state.users.find((u) => u.id === id);
  const balanceOf = (userId) => {
    const b = state.balances.get(userId);
    return { total: b.total, used: b.used, available: b.total - b.used };
  };
  const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, tenant: u.tenant });
  const employeeView = (u) => ({ ...publicUser(u), managerId: u.managerId });
  const leaveView = (l) => ({
    id: l.id,
    employeeId: l.employeeId,
    employeeName: userById(l.employeeId)?.name ?? null,
    tenant: l.tenant,
    from: l.from,
    to: l.to,
    days: l.days,
    halfDay: l.halfDay,
    reason: l.reason,
    status: l.status,
    ...(opts.apiV2 ? { leaveType: 'casual' } : {}),
    fromTime: l.fromTime,
    decidedBy: l.decidedBy,
    createdAt: l.createdAt,
    updatedAt: l.updatedAt,
  });

  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);

  // ---------------------------------------------------------------- dev-only endpoints (loopback only)
  app.post('/__reset', (req, res) => {
    if (!isLoopback(req)) return res.status(403).json({ error: 'Forbidden' });
    state = seedState();
    random = mulberry32(opts.seed);
    res.json({ ok: true });
  });
  app.get('/__requests', (req, res) => {
    if (!isLoopback(req)) return res.status(403).json({ error: 'Forbidden' });
    res.json(requestLog);
  });
  app.delete('/__requests', (req, res) => {
    if (!isLoopback(req)) return res.status(403).json({ error: 'Forbidden' });
    requestLog.length = 0;
    res.status(204).end();
  });

  // ---------------------------------------------------------------- API
  const api = express.Router();

  api.use((req, res, next) => {
    res.on('finish', () => {
      requestLog.push({
        ts: new Date().toISOString(),
        method: req.method,
        path: req.originalUrl.split('?')[0],
        status: res.statusCode,
        userId: res.locals.user?.id ?? null,
        tenant: res.locals.user?.tenant ?? null,
      });
    });
    next();
  });
  api.use(express.json({ limit: '100kb' }));

  api.post('/auth/login', (req, res) => {
    const { tenant, email, password } = isPlainObject(req.body) ? req.body : {};
    const user = state.users.find(
      (u) => u.tenant === tenant && typeof email === 'string' && u.email === email.trim().toLowerCase(),
    );
    if (!user || password !== PASSWORD) return res.status(401).json({ error: 'Invalid credentials' });
    const token = signToken(
      { uid: user.id, tenant: user.tenant, role: user.role, exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS },
      opts.secret,
    );
    res.locals.user = user;
    res.json({ token, user: publicUser(user) });
  });

  // Everything below requires a valid bearer token and a matching X-Tenant-Code header.
  api.use((req, res, next) => {
    const header = req.get('authorization') ?? '';
    const match = /^Bearer (\S+)$/.exec(header);
    const payload = match ? verifyToken(match[1], opts.secret) : null;
    const user = payload ? userById(payload.uid) : undefined;
    if (!user || user.tenant !== payload.tenant) return res.status(401).json({ error: 'Unauthorized' });
    res.locals.user = user;
    if (req.get('x-tenant-code') !== user.tenant) return res.status(403).json({ error: 'Tenant mismatch' });
    next();
  });

  api.post('/auth/logout', (_req, res) => res.status(204).end());
  api.get('/me', (_req, res) => res.json(publicUser(res.locals.user)));

  api.get(opts.apiV2 ? '/leave-balances' : '/leave-balance', (_req, res) => {
    const roll = random(); // advanced exactly once per call
    if (roll < opts.flaky) return res.status(503).json({ error: 'Service temporarily unavailable' });
    res.json(balanceOf(res.locals.user.id));
  });

  api.get('/leaves', (req, res) => {
    const user = res.locals.user;
    if (req.query.all === '1') {
      if (!isApprover(user)) throw new HttpError(403, 'Only managers and admins can list all leaves');
      // Bug `cross-tenant-list`: the tenant filter is forgotten.
      const list = bugs.has('cross-tenant-list') ? state.leaves : state.leaves.filter((l) => l.tenant === user.tenant);
      return res.json(list.map(leaveView));
    }
    res.json(state.leaves.filter((l) => l.employeeId === user.id).map(leaveView));
  });

  api.post('/leaves', (req, res) => {
    const user = res.locals.user;
    const input = validateLeaveInput(req.body, bugs);
    if (!input.draft && input.days > balanceOf(user.id).available) {
      throw badRequest('Insufficient leave balance', 'days');
    }
    const now = new Date().toISOString();
    const leave = {
      id: state.nextLeaveId++,
      tenant: user.tenant,
      employeeId: user.id,
      from: input.from,
      to: input.to,
      days: input.days,
      halfDay: input.halfDay,
      reason: input.reason,
      fromTime: input.fromTime,
      status: input.draft ? 'draft' : 'submitted',
      decidedBy: null,
      deducted: 0,
      createdAt: now,
      updatedAt: now,
    };
    state.leaves.push(leave);
    res.status(201).location(`/api/leaves/${leave.id}`).json(leaveView(leave));
  });

  api.get('/leaves/export.csv', (_req, res) => {
    const user = res.locals.user;
    const rows = state.leaves
      .filter((l) => l.employeeId === user.id)
      .map((l) => {
        // Bug `csv-export-mismatch`: days are rounded in the export only.
        const days = bugs.has('csv-export-mismatch') ? Math.round(l.days) : l.days;
        return [l.id, l.from, l.to, days, l.status, l.reason].map(csvCell).join(',');
      });
    res
      .type('text/csv')
      .attachment('leaves.csv')
      .send(['id,from,to,days,status,reason', ...rows].join('\r\n') + '\r\n');
  });

  /** Finds a leave in the caller's tenant. Unknown ids and other tenants both give 404. */
  function leaveInTenant(req, res) {
    const id = Number(req.params.id);
    const leave = Number.isInteger(id) ? state.leaves.find((l) => l.id === id && l.tenant === res.locals.user.tenant) : undefined;
    if (!leave) throw new HttpError(404, 'Leave not found');
    return leave;
  }

  /** Owner-only actions: approvers who can see the leave get 403; everyone else gets 404. */
  function requireOwner(leave, user) {
    if (leave.employeeId === user.id) return;
    if (isApprover(user)) throw new HttpError(403, 'Only the owner can do this');
    throw new HttpError(404, 'Leave not found');
  }

  api.get('/leaves/:id', (req, res) => {
    const user = res.locals.user;
    const leave = leaveInTenant(req, res);
    // Employees see only their own leaves. Others get 404 (not 403) so ids do not leak existence.
    // Bug `idor-leave-read`: the ownership check is skipped.
    const visible = leave.employeeId === user.id || isApprover(user) || bugs.has('idor-leave-read');
    if (!visible) throw new HttpError(404, 'Leave not found');
    res.json(leaveView(leave));
  });

  api.post('/leaves/:id/submit', (req, res) => {
    const user = res.locals.user;
    const leave = leaveInTenant(req, res);
    requireOwner(leave, user);
    if (leave.status !== 'draft') throw new HttpError(409, `Cannot submit a leave in status ${leave.status}`);
    if (leave.days > balanceOf(user.id).available) throw badRequest('Insufficient leave balance', 'days');
    leave.status = 'submitted';
    leave.updatedAt = new Date().toISOString();
    res.json(leaveView(leave));
  });

  function decide(action) {
    return (req, res) => {
      const user = res.locals.user;
      if (!isApprover(user)) throw new HttpError(403, `Only managers and admins can ${action} leaves`);
      const leave = leaveInTenant(req, res);
      // Bug `self-approve`: approvers may decide their own leave.
      if (leave.employeeId === user.id && !bugs.has('self-approve')) {
        throw new HttpError(403, `You cannot ${action} your own leave`);
      }
      // Bug `double-approve`: approving an already approved leave succeeds and deducts again.
      const doubleApprove = action === 'approve' && leave.status === 'approved' && bugs.has('double-approve');
      if (leave.status !== 'submitted' && !doubleApprove) {
        throw new HttpError(409, `Cannot ${action} a leave in status ${leave.status}`);
      }
      if (action === 'approve') {
        const amount = deductionFor(leave.days, bugs);
        state.balances.get(leave.employeeId).used += amount;
        leave.deducted += amount;
        leave.status = 'approved';
      } else {
        leave.status = 'rejected';
      }
      leave.decidedBy = user.id;
      leave.updatedAt = new Date().toISOString();
      res.json(leaveView(leave));
    };
  }
  api.post('/leaves/:id/approve', decide('approve'));
  api.post('/leaves/:id/reject', decide('reject'));

  api.post('/leaves/:id/cancel', (req, res) => {
    const user = res.locals.user;
    const leave = leaveInTenant(req, res);
    requireOwner(leave, user);
    if (!['draft', 'submitted', 'approved'].includes(leave.status)) {
      throw new HttpError(409, `Cannot cancel a leave in status ${leave.status}`);
    }
    // Bug `cancel-no-refund`: the refund on cancelling an approved leave is skipped.
    if (leave.status === 'approved' && !bugs.has('cancel-no-refund')) {
      state.balances.get(leave.employeeId).used -= leave.deducted;
      leave.deducted = 0;
    }
    leave.status = 'cancelled';
    leave.updatedAt = new Date().toISOString();
    res.json(leaveView(leave));
  });

  api.get('/approvals', (_req, res) => {
    const user = res.locals.user;
    if (!isApprover(user)) throw new HttpError(403, 'Only managers and admins can view approvals');
    const pending = state.leaves.filter(
      (l) => l.tenant === user.tenant && l.status === 'submitted' && l.employeeId !== user.id,
    );
    res.json(pending.map(leaveView));
  });

  // Bug `employee-admin-endpoint`: the admin-role check is skipped.
  function requireAdmin(user) {
    if (user.role !== 'admin' && !bugs.has('employee-admin-endpoint')) throw new HttpError(403, 'Admins only');
  }
  api.get('/employees', (_req, res) => {
    const user = res.locals.user;
    requireAdmin(user);
    res.json(state.users.filter((u) => u.tenant === user.tenant).map(employeeView));
  });
  api.get('/employees/:id', (req, res) => {
    const user = res.locals.user;
    requireAdmin(user);
    const id = Number(req.params.id);
    const employee = state.users.find((u) => u.id === id && u.tenant === user.tenant);
    if (!employee) throw new HttpError(404, 'Employee not found');
    res.json(employeeView(employee));
  });

  api.get('/attendance', (_req, res) => {
    const user = res.locals.user;
    res.json(state.attendance.filter((a) => a.employeeId === user.id));
  });
  api.post('/attendance/punch-in', (_req, res) => {
    const user = res.locals.user;
    if (state.attendance.some((a) => a.employeeId === user.id && a.punchOut === null)) {
      throw new HttpError(409, 'Already punched in');
    }
    const now = Date.now();
    const record = {
      id: state.nextAttendanceId++,
      tenant: user.tenant,
      employeeId: user.id,
      date: istDateOf(now),
      punchIn: new Date(now).toISOString(),
      punchOut: null,
    };
    state.attendance.push(record);
    res.status(201).json(record);
  });
  api.post('/attendance/punch-out', (_req, res) => {
    const user = res.locals.user;
    const open = state.attendance.find((a) => a.employeeId === user.id && a.punchOut === null);
    if (!open) throw new HttpError(409, 'Not punched in');
    open.punchOut = new Date().toISOString();
    res.json(open);
  });

  api.use((_req, res) => res.status(404).json({ error: 'Not found' }));
  app.use('/api', api);

  // ---------------------------------------------------------------- SPA
  const sendIndex = (_req, res) => res.type('html').send(indexHtml);
  app.get(SPA_ROUTES, sendIndex);
  app.get('/index.html', sendIndex);
  app.use(express.static(PUBLIC_DIR, { index: false }));
  // Unknown pages: the SPA renders its not-found view, with an honest 404 status.
  app.use((req, res) => {
    if (req.method === 'GET' && req.accepts('html')) return res.status(404).type('html').send(indexHtml);
    res.status(404).json({ error: 'Not found' });
  });

  // ---------------------------------------------------------------- errors
  // Express recognises error handlers by their four parameters.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: err.message, ...(err.field ? { field: err.field } : {}) });
    }
    if (err && typeof err.status === 'number' && err.status >= 400 && err.status < 500) {
      return res.status(err.status).json({ error: err.type === 'entity.parse.failed' ? 'Invalid JSON body' : err.message });
    }
    res.status(500).json({ error: 'Internal Server Error' });
  });

  return app;
}

// ------------------------------------------------------------------ public API

/**
 * Starts one demo HRMS instance. Toggles come from `env` (not process.env), so several
 * instances with different bugs can run in one process. Port 0 picks a free port.
 */
export async function startDemo({ port = 4600, host = '127.0.0.1', env = process.env } = {}) {
  const opts = parseOptions(env);
  const requestLog = [];
  const server = http.createServer(createApp(opts, requestLog));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const actualPort = server.address().port;
  const urlHost = host.includes(':') ? `[${host}]` : host;
  return {
    url: `http://${urlHost}:${actualPort}`,
    port: actualPort,
    requestLog,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        server.closeAllConnections();
      }),
  };
}

function isMainModule() {
  if (!process.argv[1]) return false;
  const self = fileURLToPath(import.meta.url);
  const entry = path.resolve(process.argv[1]);
  return process.platform === 'win32' ? self.toLowerCase() === entry.toLowerCase() : self === entry;
}

if (isMainModule()) {
  const port = process.env.PORT ? Number(process.env.PORT) : 4600;
  const demo = await startDemo({ port, env: process.env });
  console.log(`Demo HRMS listening on ${demo.url} (also http://localhost:${demo.port})`);
  const stop = () => demo.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
