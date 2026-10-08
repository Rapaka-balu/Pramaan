// Core contracts — PRAMAAN_BUILD_SPEC.md §4. Copied exactly; additions only via DECISIONS.md.
import { z } from 'zod';

export const SCHEMA_VERSION = 1 as const;

// ---------------------------------------------------------------- §4.1 App config

export const RoleId = z.string().regex(/^[a-z][a-z0-9-]{1,30}$/);

export const AppConfig = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^[a-z][a-z0-9-]{1,30}$/),
  name: z.string(),
  baseUrl: z.url(),
  apiBaseUrl: z.url().optional(),
  apiDocsUrl: z.url().optional(), // scoring only, never an inference input
  tenants: z
    .array(
      z.object({
        id: z.string(), // 'primary' | 'secondary'
        codeEnv: z.string(), // env var holding the tenant code
      }),
    )
    .min(1),
  roles: z
    .array(
      z.object({
        id: RoleId, // 'employee' | 'employee2' | 'manager' | 'admin' | ...
        tenant: z.string(),
        usernameEnv: z.string(),
        passwordEnv: z.string(),
        totpSeedEnv: z.string().optional(), // v1 (M14)
        optional: z.boolean().default(false), // missing env → skip with a "cannot verify" note
      }),
    )
    .min(1),
  login: z.object({
    strategy: z.enum(['form', 'totp', 'email-otp']).default('form'),
    url: z.string().default('/'),
    fields: z
      .object({
        // optional overrides; auto-detected by label otherwise
        tenant: z.string().optional(),
        username: z.string().optional(),
        password: z.string().optional(),
        submit: z.string().optional(),
      })
      .default({}),
    successSignal: z.string().optional(), // URL glob or text proving login worked
  }),
  safety: z.object({
    allowedOrigins: z.array(z.url()).min(1),
    forbiddenHostPatterns: z.array(z.string()).default([]),
    requireTargetFlag: z.boolean().default(false), // true for HRMS: no network without --target staging
    denyActionPatterns: z.array(z.string()).min(1),
    requiresApprovalPatterns: z.array(z.string()).default([]),
    approvedActions: z.array(z.string()).default([]),
    maxRps: z.number().positive().default(2),
    maxReplayRps: z.number().positive().default(2),
    runTagPrefix: z.string().default('PRM'),
  }),
  crawl: z
    .object({
      maxStatesPerRole: z.number().int().positive().default(150),
      maxDepth: z.number().int().positive().default(8),
      maxMinutesPerRole: z.number().positive().default(20),
      submitForms: z.boolean().default(true), // only in the primary tenant, only allow-listed submits
    })
    .default({ maxStatesPerRole: 150, maxDepth: 8, maxMinutesPerRole: 20, submitForms: true }),
  budgets: z
    .object({
      perCommandUsd: z.number().nonnegative().default(5),
      compileUsd: z.number().nonnegative().default(40),
    })
    .default({ perCommandUsd: 5, compileUsd: 40 }),
  lead: z
    .object({
      minutesPerWeek: z.number().int().positive().default(90),
      autoFilePrecision: z.number().min(0).max(1).default(0.95),
      autoFileMinVerdicts: z.number().int().positive().default(20),
      shadowMode: z.boolean().default(false),
    })
    .default({ minutesPerWeek: 90, autoFilePrecision: 0.95, autoFileMinVerdicts: 20, shadowMode: false }),
  domainPack: z.string().optional(), // 'in-hrms'
  output: z.object({
    repoPath: z.string(),
    defectSink: z.enum(['markdown', 'github', 'jira']).default('markdown'),
  }),
  implicitOracle: z
    .object({
      ignoreConsolePatterns: z.array(z.string()).default([]),
      ignoreRequestPatterns: z.array(z.string()).default([]),
    })
    .default({ ignoreConsolePatterns: [], ignoreRequestPatterns: [] }),
});
export type AppConfig = z.infer<typeof AppConfig>;

// ---------------------------------------------------------------- §4.2 Evidence

export const EvidenceId = z.string().regex(/^E-[0-9a-f]{8}$/);
export const Evidence = z.object({
  id: EvidenceId,
  kind: z.enum([
    'request',
    'response',
    'screenshot',
    'aria-snapshot',
    'ui-text',
    'validation-message',
    'console',
    'domain-pack',
    'lead-note',
    'replay',
  ]),
  ref: z.string(), // workspace-relative path, or "METHOD /path" operation key
  excerpt: z.string().max(600).optional(), // redacted
});
export type Evidence = z.infer<typeof Evidence>;

// ---------------------------------------------------------------- §4.3 Rules

export const RuleId = z.string().regex(/^R-\d{3,}$/);
export const RuleKind = z.enum([
  'authz',
  'tenant-isolation',
  'validation',
  'calculation',
  'workflow',
  'invariant',
  'consistency',
  'format',
  'ui-behaviour',
]);
export const DecisionStatus = z.enum(['proposed', 'confirmed', 'rejected', 'retired']);
export const Decision = z.object({
  by: z.string(), // 'lead:balu' | 'pramaan'
  at: z.iso.datetime({ offset: true }),
  note: z.string().optional(),
});

export const Rule = z
  .object({
    id: RuleId,
    title: z.string().min(10).max(200), // one plain sentence
    kind: RuleKind,
    status: DecisionStatus,
    confidence: z.number().min(0).max(1),
    source: z.enum(['inferred', 'domain-pack', 'charter', 'lead', 'mined']),
    entities: z.array(z.string()).default([]),
    operations: z.array(z.string()).default([]), // "POST /api/leave"
    evidence: z.array(Evidence).min(1),
    criticality: z.number().int().min(1).max(5),
    assertionIds: z.array(z.string()).default([]),
    openQuestion: z.string().optional(), // for ambiguities: what the lead must answer
    decision: Decision.optional(),
    version: z.number().int().min(1).default(1),
  })
  .superRefine((r, ctx) => {
    if ((r.status === 'confirmed' || r.status === 'rejected') && !r.decision) {
      ctx.addIssue({ code: 'custom', message: `${r.id}: ${r.status} rules need a decision` });
    }
  });
export type Rule = z.infer<typeof Rule>;
export const RulesFile = z.object({ schemaVersion: z.literal(1), rules: z.array(Rule) });

// ---------------------------------------------------------------- §4.4 Role matrix

// Actor keys: a role id, 'anonymous', or 'other-tenant:<roleId>'.
export const ActorKey = z.string().regex(/^(anonymous|other-tenant:[a-z][a-z0-9-]*|[a-z][a-z0-9-]*)$/);
export const Expectation = z.enum(['allow', 'deny', 'own-only', 'filtered', 'unknown']);
export const ObservedOutcome = z.enum(['same-data', 'different-data', 'denied', 'error', 'skipped']);
export const MatrixRow = z.object({
  operation: z.string(), // "GET /api/leave/{id}"
  ownerRole: RoleId, // whose session produced the baseline response
  expected: z.record(ActorKey, Expectation),
  observed: z.record(
    ActorKey,
    z.object({
      status: z.number().int(),
      outcome: ObservedOutcome,
      similarity: z.number().min(0).max(1).optional(),
      evidenceRef: z.string().optional(),
    }),
  ),
  status: DecisionStatus,
  decision: Decision.optional(),
});
export const RoleMatrixFile = z.object({ schemaVersion: z.literal(1), rows: z.array(MatrixRow) });

// ---------------------------------------------------------------- §4.5 Assertion DSL

export const OperationRef = z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  path: z.string().startsWith('/'), // template from openapi.observed, e.g. /api/leave/{id}
});
// Type rule: a string that is EXACTLY one reference ("${data.days}") takes the referenced value's type
// (number stays number). A string mixing a reference with other text ("${run.tag} R-012") is always a string.
// String leaves anywhere in pathParams/query/body/value/expected may contain ${name} references:
// ${data.x} → assertion.data, ${cap.x} → an earlier capture, ${run.tag} → PRM-<runId>,
// ${today}, ${today+N} → Asia/Kolkata dates as YYYY-MM-DD.
export const ApiStep = z.object({
  kind: z.literal('api'),
  id: z.string().regex(/^[a-z][a-zA-Z0-9]*$/),
  actor: ActorKey,
  op: OperationRef,
  pathParams: z.record(z.string(), z.string()).default({}),
  query: z.record(z.string(), z.string()).default({}),
  body: z.unknown().optional(),
  capture: z.record(z.string(), z.string()).default({}), // name → JSONPath into the response body
});
export const UiStep = z.object({
  kind: z.literal('ui'),
  id: z.string().regex(/^[a-z][a-zA-Z0-9]*$/),
  actor: ActorKey,
  flow: z.string(), // a flow id from the suite's flows/ registry
  args: z.record(z.string(), z.string()).default({}),
});
export const Step = z.discriminatedUnion('kind', [ApiStep, UiStep]);

export const Comparator = z.enum([
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'exists',
  'absent',
  'matches',
  'contains',
  'in',
]);
export const Normalizer = z.enum(['none', 'number', 'inr', 'date-in', 'trim-lower']);
export const Check = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('status'),
    step: z.string(),
    oneOf: z.array(z.number().int()).min(1),
    message: z.string().min(8),
  }),
  z.object({
    kind: z.literal('field'),
    step: z.string(),
    path: z.string(),
    cmp: Comparator,
    value: z.unknown().optional(),
    normalize: Normalizer.default('none'),
    message: z.string().min(8),
  }),
  z.object({
    kind: z.literal('delta'),
    before: z.string(),
    after: z.string(),
    path: z.string(),
    expected: z.string(), // expression, e.g. "-${data.days}"
    message: z.string().min(8),
  }),
  z.object({
    kind: z.literal('equalAcross'),
    refs: z.array(z.object({ step: z.string(), path: z.string() })).min(2),
    normalize: Normalizer.default('none'),
    message: z.string().min(8),
  }),
]);
export const AssertionId = z.string().regex(/^A-\d{3,}$/);
export const Assertion = z.object({
  id: AssertionId,
  ruleId: RuleId,
  title: z.string(),
  data: z.record(z.string(), z.unknown()).default({}),
  arrange: z.array(Step).default([]),
  act: z.array(Step).min(1),
  assert: z.array(Check).min(1),
  cleanup: z.array(Step).default([]),
  status: DecisionStatus,
  decision: Decision.optional(),
});
export type Assertion = z.infer<typeof Assertion>;

// ---------------------------------------------------------------- §4.7 Findings and ledger

export const OracleClass = z.enum([
  'implicit',
  'differential',
  'consistency',
  'authz-matrix',
  'confirmed-rule',
  'invariant',
  'metamorphic',
  'charter-candidate',
]);
export const Finding = z.object({
  id: z.string().regex(/^F-\d{4,}$/),
  title: z.string(),
  severity: z.enum(['S1', 'S2', 'S3', 'S4']),
  oracle: OracleClass,
  ruleId: RuleId.optional(),
  testId: z.string().optional(),
  signature: z.string(), // failure signature hash (§M9)
  evidence: z.array(Evidence).min(1),
  reproSteps: z.array(z.string()).min(1),
  status: z.enum(['candidate', 'queued', 'auto-filed', 'confirmed', 'rejected', 'duplicate']),
  firstSeenRunId: z.string(),
  lastSeenRunId: z.string(),
});

export const LedgerEventType = z.enum([
  'run.started',
  'run.completed',
  'safety.blocked',
  'llm.call',
  'llm.rejected-output',
  'rule.proposed',
  'rule.decided',
  'matrix.decided',
  'assertion.decided',
  'data.created',
  'data.deleted',
  'data.orphaned',
  'heal.applied',
  'heal.rejected',
  'test.quarantined',
  'test.promoted',
  'test.demoted',
  'finding.created',
  'finding.queued',
  'finding.autofiled',
  'finding.verdict',
  'lead.session',
  'bench.result',
  'mutation.result',
]);
export const LedgerEvent = z.object({
  ts: z.iso.datetime({ offset: true }),
  app: z.string(),
  runId: z.string(),
  type: LedgerEventType,
  actor: z.string(), // 'pramaan:<module>' | 'lead:<name>'
  data: z.record(z.string(), z.unknown()),
});
export type LedgerEvent = z.infer<typeof LedgerEvent>;
// Required data keys by type (validated in ledger.append):
//   finding.verdict  → { findingId, oracle: OracleClass, verdict: 'true-positive'|'false-positive'|'duplicate' }
//   lead.session     → { minutes: number, itemsDecided: number }
//   llm.call         → { model, inputTokens, outputTokens, usd, cached: boolean, purpose }
//   data.created     → { entity, id, operation, teardownOp?: string }

// ---------------------------------------------------------------- §5 Bench catalog (addition, see DECISIONS)

export const BugCatalogEntry = z.object({
  id: z.string(),
  category: z.string(),
  activation: z.union([
    z.object({ env: z.record(z.string(), z.string()) }),
    z.object({ manual: z.string() }),
  ]),
  expectedOracle: OracleClass,
  operations: z.array(z.string()),
  mvp: z.boolean().default(true),
});
export const BugCatalog = z.object({ schemaVersion: z.literal(1), bugs: z.array(BugCatalogEntry) });
