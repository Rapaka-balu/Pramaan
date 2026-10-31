// Domain pack (§8 M5): rule templates matched to the Living Spec by capability, plus deterministic DSL assertion
// templates. This is the offline fallback for both the rule proposer and the assertion proposer.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { RuleKind, type Evidence } from '../core/schemas.js';
import { sha1 } from '../core/stable-json.js';
import { isPrivileged } from '../authz/propose.js';
import type { AssertionT } from '../dsl/validate.js';
import type { Entity } from './entities.js';
import type { ApiModel } from './har-to-openapi.js';

export const PackTemplate = z.object({
  id: z.string(),
  title: z.string(),
  kind: RuleKind,
  criticality: z.number().int().min(1).max(5),
  requires: z.array(z.string()),
  assertion: z.string().optional(),
});
export const DomainPack = z.object({ schemaVersion: z.literal(1), pack: z.string(), templates: z.array(PackTemplate) });
export type PackTemplate = z.infer<typeof PackTemplate>;

export function loadDomainPack(root: string, pack: string): z.infer<typeof DomainPack> {
  return DomainPack.parse(parseYaml(readFileSync(join(root, 'domain-packs', pack, 'rules.yaml'), 'utf8')));
}

export const evidenceId = (kind: string, ref: string): string => `E-${sha1(`${kind}|${ref}`).slice(0, 8)}`;
export const ev = (kind: Evidence['kind'], ref: string, excerpt?: string): Evidence => ({
  id: evidenceId(kind, ref),
  kind,
  ref,
  ...(excerpt ? { excerpt: excerpt.slice(0, 600) } : {}),
});

export interface RoleInfo {
  role: string;
  tenant: string;
}

/** What the Living Spec offers for one record entity: ops, fields, roles. Undefined parts are missing capabilities. */
export interface Binding {
  entity: Entity;
  createOp: string;
  createPath: string;
  createStatus: number;
  recipe: Record<string, unknown>;
  creator: string;
  approve?: { op: string; path: string; actor: string; status: number };
  cancel?: { op: string; path: string; status: number };
  read?: { op: string; path: string };
  daysField?: string;
  halfDayField?: string;
  fromField?: string;
  toField?: string;
  freeTextField?: string;
  balance?: { op: string; path: string; field: string };
  secondEmployee?: string;
  dateFields: string[];
  currencyFields: string[];
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const okStatus = (statuses: Record<string, number[]>): number => Object.values(statuses).flat().find((s) => s >= 200 && s < 300) ?? 200;

export function bindEntity(entity: Entity, model: ApiModel, roles: readonly RoleInfo[], tagPrefix: string): Binding | undefined {
  const primary = roles[0]?.tenant;
  const tenantOf = new Map(roles.map((r) => [r.role, r.tenant]));
  const create = model.operations.find((o) => o.key === entity.createOp);
  if (!create) return undefined;
  const recipeObs =
    create.observations.find((o) => o.status >= 200 && o.status < 300 && isObj(o.reqBody) && tenantOf.get(o.role) === primary && !isPrivileged(o.role)) ??
    create.observations.find((o) => o.status >= 200 && o.status < 300 && isObj(o.reqBody) && tenantOf.get(o.role) === primary);
  if (!recipeObs || !isObj(recipeObs.reqBody)) return undefined;
  const recipe = recipeObs.reqBody;
  const props = create.requestSchema?.properties ?? {};
  const field = (re: RegExp, type?: string): string | undefined =>
    Object.entries(props).find(([k, s]) => re.test(k) && (type === undefined || s.type === type || (Array.isArray(s.type) && s.type.includes(type))))?.[0];
  const numeric = (re: RegExp): string | undefined => field(re, 'integer') ?? field(re, 'number');
  const dateFields = Object.entries(props).filter(([, s]) => s.format === 'date' || s.format === 'date-time').map(([k]) => k);

  const sm = entity.stateMachine;
  const tr = (verb: string, from?: string) =>
    sm?.transitions.find((t) => t.observed && t.op.endsWith(`/{id}/${verb}`) && (from === undefined || t.from === from) && t.actors.some((a) => tenantOf.get(a) === primary));
  const approveT = tr('approve');
  const cancelT = tr('cancel', 'approved');
  const opInfo = (key: string): { path: string; status: number } => {
    const op = model.operations.find((o) => o.key === key);
    return { path: key.split(' ')[1] ?? '', status: op ? okStatus(op.statusByRole) : 200 };
  };
  const readKey = `GET ${entity.root}/{id}`;
  const balanceOp = model.operations.find((o) => {
    if (o.method !== 'GET' || o.path.includes('{')) return false;
    const s = o.responseSchemas['200']?.properties ?? {};
    return Object.entries(s).some(([k, x]) => /^(available|balance|remaining)$/i.test(k) && (x.type === 'number' || x.type === 'integer'));
  });
  const balanceField = balanceOp && Object.keys(balanceOp.responseSchemas['200']?.properties ?? {}).find((k) => /^(available|balance|remaining)$/i.test(k));
  const second = roles.find((r) => r.tenant === primary && r.role !== recipeObs.role && !isPrivileged(r.role))?.role;
  const freeText = Object.entries(recipe).find(([, v]) => typeof v === 'string' && v.startsWith(`${tagPrefix}-`))?.[0];

  const b: Binding = {
    entity,
    createOp: create.key,
    createPath: create.path,
    createStatus: okStatus(create.statusByRole),
    recipe,
    creator: recipeObs.role,
    dateFields,
    currencyFields: Object.keys(props).filter((k) => /salary|amount|ctc|price|pay/i.test(k)),
  };
  if (approveT) b.approve = { op: approveT.op, actor: approveT.actors.find((a) => tenantOf.get(a) === primary) ?? approveT.actors[0] ?? '', ...opInfo(approveT.op) };
  if (cancelT) b.cancel = { op: cancelT.op, ...opInfo(cancelT.op) };
  if (model.operations.some((o) => o.key === readKey)) b.read = { op: readKey, path: `${entity.root}/{id}` };
  const days = numeric(/^(days|no_?of_?days|leave_?days|duration|num_?days)$/i);
  if (days) b.daysField = days;
  const half = field(/half/i, 'boolean');
  if (half) b.halfDayField = half;
  const from = dateFields.find((k) => /^(from|start|startDate|start_date|fromDate|from_date)$/i.test(k));
  const to = dateFields.find((k) => /^(to|end|endDate|end_date|toDate|to_date|until)$/i.test(k));
  if (from) b.fromField = from;
  if (to) b.toField = to;
  if (freeText) b.freeTextField = freeText;
  if (balanceOp && balanceField) b.balance = { op: balanceOp.key, path: balanceOp.path, field: balanceField };
  if (second) b.secondEmployee = second;
  return b;
}

export interface UiFacts {
  /** Crawl state refs whose text shows a date / a balance. */
  dateStates: string[];
  balanceStates: string[];
}

function capabilities(b: Binding, ui: UiFacts): Map<string, Evidence[]> {
  const caps = new Map<string, Evidence[]>();
  const op = (key: string): Evidence => ev('response', key);
  if (b.approve) caps.set('approve-op', [op(b.approve.op)]);
  if (b.cancel) caps.set('cancel-after-approve', [op(b.cancel.op)]);
  if (b.read) caps.set('record-read', [op(b.read.op)]);
  if (b.entity.fields.some((f) => /^(employeeId|employee_id|userId|user_id|ownerId|owner_id)$/.test(f.name))) caps.set('personal-entity', [op(b.createOp)]);
  if (b.daysField) caps.set('days-field', [op(b.createOp)]);
  if (b.halfDayField) caps.set('half-day-field', [op(b.createOp)]);
  if (b.fromField && b.toField) caps.set('date-range', [op(b.createOp)]);
  if (b.dateFields.length > 0) caps.set('date-field', [op(b.createOp)]);
  if (b.currencyFields.length > 0) caps.set('currency-field', [op(b.createOp)]);
  if (b.balance) caps.set('balance-op', [op(b.balance.op)]);
  if (b.entity.stateMachine && b.entity.stateMachine.transitions.filter((t) => t.observed).length >= 2) {
    caps.set('state-machine', b.entity.stateMachine.transitions.filter((t) => t.observed).slice(0, 2).flatMap((t) => t.evidenceRefs.slice(0, 1).map((r) => ev('replay', r))));
  }
  if (ui.dateStates.length > 0) caps.set('ui-date', ui.dateStates.slice(0, 2).map((r) => ev('aria-snapshot', r)));
  if (ui.balanceStates.length > 0 && b.balance) caps.set('ui-balance', [...ui.balanceStates.slice(0, 1).map((r) => ev('aria-snapshot', r)), op(b.balance.op)]);
  return caps;
}

export interface PackMatch {
  template: PackTemplate;
  title: string;
  entity: string;
  operations: string[];
  evidence: Evidence[];
}

export function matchTemplates(pack: z.infer<typeof DomainPack>, bindings: readonly Binding[], ui: UiFacts): PackMatch[] {
  const out: PackMatch[] = [];
  const seenTitles = new Set<string>();
  for (const b of bindings) {
    const caps = capabilities(b, ui);
    for (const t of pack.templates) {
      if (!t.requires.every((r) => caps.has(r))) continue;
      const name = b.entity.name.replace(/-/g, ' ');
      const title = t.title.replace('{entity}', name).replace('{Entity}', name.charAt(0).toUpperCase() + name.slice(1));
      if (seenTitles.has(title)) continue; // entity-free templates (₹, DD/MM/YYYY) match once
      seenTitles.add(title);
      const evidence = [ev('domain-pack', `domain-packs/${pack.pack}/rules.yaml#${t.id}`), ...t.requires.flatMap((r) => caps.get(r) ?? [])];
      const unique = [...new Map(evidence.map((e) => [e.id, e])).values()];
      out.push({
        template: t,
        title,
        entity: b.entity.name,
        operations: [...new Set(unique.filter((e) => e.kind === 'response').map((e) => e.ref))],
        evidence: unique,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------- assertion templates

type Step = AssertionT['act'][number];
const apiStep = (id: string, actor: string, method: string, path: string, extra: Partial<Extract<Step, { kind: 'api' }>> = {}): Step => ({
  kind: 'api',
  id,
  actor,
  op: { method: method as 'GET', path },
  pathParams: path.includes('{id}') ? { id: '${cap.leaveId}' } : {},
  query: {},
  capture: {},
  ...extra,
});

/** Create body from the crawl recipe, with this assertion's dates, days and tagged free text. */
function body(b: Binding, ruleId: string, over: { fromOffset: number; toOffset?: number; days?: unknown; half?: boolean }): Record<string, unknown> {
  const out: Record<string, unknown> = { ...b.recipe };
  if (b.fromField) out[b.fromField] = `\${today+${over.fromOffset}}`;
  if (b.toField) out[b.toField] = `\${today+${over.toOffset ?? over.fromOffset}}`;
  if (b.daysField && over.days !== undefined) out[b.daysField] = over.days;
  if (b.halfDayField) out[b.halfDayField] = over.half === true;
  if (b.freeTextField) out[b.freeTextField] = `\${run.tag} ${ruleId}`;
  return out;
}

/**
 * A DSL assertion for a pack template, or undefined when the binding lacks what it needs. Each assertion uses its
 * own date window (offset) so assertions never collide with each other.
 */
export function assertionFromTemplate(name: string, b: Binding, ruleId: string, assertionId: string, offset: number): AssertionT | undefined {
  const base = { id: assertionId, ruleId, status: 'proposed' as const, cleanup: [] as Step[], arrange: [] as Step[] };
  const create = (id: string, actor: string, over: Parameters<typeof body>[2]): Step =>
    apiStep(id, actor, 'POST', b.createPath, { body: body(b, ruleId, over), capture: { leaveId: '$.id' } });
  const balanceGet = (id: string): Step | undefined => (b.balance ? apiStep(id, b.creator, 'GET', b.balance.path) : undefined);
  const cancel = (actor = b.creator): Step[] => (b.cancel ? [apiStep('cleanupCancel', actor, 'POST', b.cancel.path)] : []);
  const balPath = b.balance ? `$.${b.balance.field}` : '$';
  const refused = [400, 403, 404, 409, 422];

  switch (name) {
    case 'approval-deducts': {
      const before = balanceGet('balBefore');
      const after = balanceGet('balAfter');
      if (!b.approve || !before || !after || !b.daysField) return undefined;
      return {
        ...base, title: 'approval deducts the requested days', data: { days: 2 },
        arrange: [before, create('apply', b.creator, { fromOffset: offset, toOffset: offset + 1, days: '${data.days}' })],
        act: [apiStep('approve', b.approve.actor, 'POST', b.approve.path), after],
        assert: [
          { kind: 'status', step: 'approve', oneOf: [b.approve.status], message: `${b.approve.actor} should be able to approve a submitted ${b.entity.name}` },
          { kind: 'delta', before: 'balBefore', after: 'balAfter', path: balPath, expected: '-${data.days}', message: `${b.balance?.field} balance should drop by the approved days` },
        ],
        cleanup: cancel(),
      };
    }
    case 'cancel-refunds': {
      const before = balanceGet('balBefore');
      const after = balanceGet('balAfter');
      if (!b.approve || !b.cancel || !before || !after || !b.daysField) return undefined;
      return {
        ...base, title: 'cancelling an approved request refunds the days', data: { days: 2 },
        arrange: [create('apply', b.creator, { fromOffset: offset, toOffset: offset + 1, days: '${data.days}' }), apiStep('approve', b.approve.actor, 'POST', b.approve.path), before],
        act: [apiStep('cancel', b.creator, 'POST', b.cancel.path), after],
        assert: [
          { kind: 'status', step: 'cancel', oneOf: [b.cancel.status], message: `the owner should be able to cancel an approved ${b.entity.name}` },
          { kind: 'delta', before: 'balBefore', after: 'balAfter', path: balPath, expected: '${data.days}', message: `${b.balance?.field} balance should go back up by the cancelled days` },
        ],
      };
    }
    case 'half-day-deducts-half': {
      const before = balanceGet('balBefore');
      const after = balanceGet('balAfter');
      if (!b.approve || !before || !after || !b.halfDayField || !b.daysField) return undefined;
      return {
        ...base, title: 'a half day deducts 0.5', data: { days: 0.5 },
        arrange: [before, create('apply', b.creator, { fromOffset: offset, days: '${data.days}', half: true })],
        act: [apiStep('approve', b.approve.actor, 'POST', b.approve.path), after],
        assert: [
          { kind: 'status', step: 'approve', oneOf: [b.approve.status], message: `${b.approve.actor} should be able to approve a half-day ${b.entity.name}` },
          { kind: 'delta', before: 'balBefore', after: 'balAfter', path: balPath, expected: '-0.5', message: 'a half-day request should deduct exactly 0.5 days' },
        ],
        cleanup: cancel(),
      };
    }
    case 'end-before-start-rejected':
      if (!b.fromField || !b.toField) return undefined;
      return {
        ...base, title: 'end date before start date is rejected', data: { days: 1 },
        act: [create('apply', b.creator, { fromOffset: offset + 1, toOffset: offset, days: b.daysField ? '${data.days}' : undefined })],
        assert: [{ kind: 'status', step: 'apply', oneOf: [400, 422], message: `a ${b.entity.name} ending before it starts should be rejected` }],
        cleanup: cancel(),
      };
    case 'non-positive-days-rejected':
      if (!b.daysField) return undefined;
      return {
        ...base, title: 'zero or negative days are rejected', data: { days: -2 },
        act: [create('apply', b.creator, { fromOffset: offset, days: '${data.days}' })],
        assert: [{ kind: 'status', step: 'apply', oneOf: [400, 422], message: `a ${b.entity.name} for -2 days should be rejected` }],
        cleanup: cancel(),
      };
    case 'cross-employee-read-denied':
      if (!b.read || !b.secondEmployee) return undefined;
      return {
        ...base, title: "another employee cannot read the record", data: { days: 1 },
        arrange: [create('apply', b.creator, { fromOffset: offset, days: b.daysField ? '${data.days}' : undefined })],
        act: [apiStep('peek', b.secondEmployee, 'GET', b.read.path)],
        assert: [{ kind: 'status', step: 'peek', oneOf: [403, 404], message: `${b.secondEmployee} should not be able to read ${b.creator}'s ${b.entity.name}` }],
        cleanup: cancel(),
      };
    case 'self-approval-denied':
      if (!b.approve) return undefined;
      return {
        ...base, title: 'an approver cannot approve their own request', data: { days: 1 },
        arrange: [create('apply', b.approve.actor, { fromOffset: offset, days: b.daysField ? '${data.days}' : undefined })],
        act: [apiStep('selfApprove', b.approve.actor, 'POST', b.approve.path)],
        assert: [{ kind: 'status', step: 'selfApprove', oneOf: refused, message: `${b.approve.actor} should not be able to approve their own ${b.entity.name}` }],
        cleanup: cancel(b.approve.actor),
      };
    case 'double-approve-rejected':
      if (!b.approve) return undefined;
      return {
        ...base, title: 'approving twice is rejected', data: { days: 1 },
        arrange: [create('apply', b.creator, { fromOffset: offset, days: b.daysField ? '${data.days}' : undefined }), apiStep('approve', b.approve.actor, 'POST', b.approve.path)],
        act: [apiStep('approveAgain', b.approve.actor, 'POST', b.approve.path)],
        assert: [{ kind: 'status', step: 'approveAgain', oneOf: [400, 409, 422], message: `approving an already approved ${b.entity.name} should be rejected` }],
        cleanup: cancel(),
      };
    default:
      return undefined;
  }
}
