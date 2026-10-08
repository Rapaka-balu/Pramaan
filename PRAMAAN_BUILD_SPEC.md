# PRAMAAN — Build Specification (MVP → v1)

> **Who reads this:** Claude, the coding agent in VS Code, building Pramaan for Balu (sole QA engineer and owner of this repo).
> **What it is:** the single source of truth for building Pramaan from an empty folder to the v1 release gate.
> **How to use it:** work one milestone per session, in order. Never start a milestone before the previous one's acceptance checks pass. Start every session by reading `CLAUDE.md` and `docs/PROGRESS.md`, then only the section of this file for the current milestone.

---

## 0. Mission in one paragraph

Pramaan (Sanskrit: *proof*) is an autonomous multi-agent QA system. Given only a web app URL and one login per role, with no product docs, it discovers the app, infers its rules, and **writes** deterministic test suites: Playwright TypeScript, API, authorization-matrix and, in v1, accessibility, localization, visual, cross-browser and performance checks. Plain code runs those suites in CI with **zero LLM calls**. Agents come back only when a test fails or the app changes. One human QA lead approves only the decisions a machine cannot make safely, inside a fixed weekly minutes budget. Every finding carries the oracle that produced it and that oracle's measured precision.

**The core rule of this codebase: agents author, deterministic code judges.** An LLM may propose a rule, an assertion, form data or a triage summary. It may never pass a test, fail a test or file a bug on its own.

---

## 1. Ground truth about the first target (HRMS pilot)

| Fact | Value |
| --- | --- |
| App | BLG Technologies HRMS. B2B multi-tenant SaaS. React 18 + TypeScript + Vite SPA, Flask REST API, PostgreSQL |
| UI (staging) | `http://hrms-staging.blgtechnologies.in:82/` |
| API (staging) | `http://hrms-staging.blgtechnologies.in:5002/` |
| API docs (staging) | `http://hrms-staging.blgtechnologies.in:5002/apidocs/` (Flasgger/Swagger UI). **Used only to score Pramaan's inferred spec, never as an input to inference.** |
| Login | Tenant code + email + password. Primary tenant code: `TEST` |
| Roles available now | `employee` and `admin`. Credentials live in `.env` only (see §6). Never write them anywhere else |
| Roles to request from Balu | `employee2` (same tenant, for IDOR) and one login in a second tenant (for tenant isolation) |
| Reachability | Staging resolves only on Balu's network. Every milestone must also pass against the local demo app (§5) so work never blocks on staging |
| Domain | Attendance (punch-in/out, grace, LOP, regularization, payroll lock, cron status transitions), leave, approvals |

**Attendance rules Balu has already clarified.** These become `source: lead`, `status: confirmed` seed rules in `apps/hrms/seed-rules.yaml` at M5. They have no assertion yet; Pramaan proposes one and the lead confirms it.

1. Round-off boundary is exclusive: strictly less than 15 minutes triggers rounding; exactly 15 does not.
2. Grace-period deduction fires on the **fourth** late occurrence, not the third.
3. The elapsed timer is server-timestamp based, not client-side.
4. Regularization approval creates a new summary log record and never overwrites the original punch log.
5. Attendance deduction and leave-balance update are atomic.
6. Past records are never recalculated when shifts or policies change.
7. Policy resolution follows a strict five-level hierarchy: global → shift → department → employee type → employee-specific. Employee-specific overrides win.

**Known open ambiguities.** Never turn these into confirmed rules. They go to the lead queue as questions: the 60-minute presence boundary, the 30-minute grace threshold boundary, regularization's effect on rolling back the late count, weekend + holiday status priority, and admin override for reclassifying past days.

---

## 2. Non-negotiable engineering rules

### 2.1 For Pramaan's own code (`src/`)
- Node.js 20 LTS or later. TypeScript `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`. No `any`. Use `unknown` plus zod parsing at every boundary (files, network, LLM output, env).
- ESM modules. Run TypeScript with `tsx` in dev. Build with `tsc`.
- Every external input is parsed with the zod schemas in §4 before use. A schema change bumps `SCHEMA_VERSION` and adds a migration note to `docs/DECISIONS.md`.
- Pure logic (path normalization, schema merge, state keys, signatures, DSL evaluation, matrix comparison, redaction, budgets) gets unit tests in Vitest **before** it is wired into a command.
- No `eval`, `new Function`, `vm`, or libraries that use them (this rules out `jsonpath-plus`). Write the small JSONPath subset and the expression evaluator yourself (§4.6).
- Cross-platform: Balu may be on Windows. No bash-only scripts. Use Node scripts and `path.join`. No hard-coded `/`.
- Logging goes through `src/core/log.ts` (pino or a small wrapper). Secrets are never logged: the logger runs every message through `redact()`.
- Every command finishes with a one-screen summary: what ran, counts, cost in USD, where the outputs are, what needs the lead.

### 2.2 For the test code Pramaan generates (the "suite repo")
These are Balu's house conventions. Generated code must follow them exactly, and the suite repo's ESLint config enforces them (M6).
- Locator priority: `data-testid` first, then `getByRole`, then `getByLabel`, then `getByPlaceholder`, then CSS by `id` only. **Never XPath. Never CSS class selectors.**
- **Never hard-coded waits.** No `page.waitForTimeout`, no `sleep`. Wait on web-first assertions, `waitForResponse` or element state.
- Test names follow the BDD form `should_[action]_when_[condition]`.
- Every `expect` has a meaningful failure message: `expect(x, 'leave balance should drop by 2 days after approval').toBe(…)`.
- Every test has `// Arrange`, `// Act`, `// Assert` sections.
- Page Object Model. Layer layout: `pages/` (atomic UI actions), `flows/` (multi-page journeys), `specs/` (assertions only), `fixtures/` (auth, test data builders, implicit oracles), `helpers/` (reusable assertions and waits), `config/` (environments).
- TypeScript strict, no `any`, full type annotations.
- Test data uses the `en_IN` locale: ₹ with Indian digit grouping (₹1,00,000), DD/MM/YYYY, Asia/Kolkata time zone.
- Tags: `@smoke`, `@sanity`, `@regression`, `@api`, `@authz`, `@workflow`, `@a11y`, `@visual`, `@i18n`, `@perf`.
- Reporting: Allure (`allure-playwright`) plus Playwright's JSON reporter. Triage reads the JSON.

### 2.3 Safety rules (enforced in code, not only by convention)
1. **Target guard.** `src/core/target-guard.ts` refuses any origin not listed in `app.yaml → safety.allowedOrigins`. It also refuses any hostname matching `safety.forbiddenHostPatterns`. The schema default is empty, so each app lists its own production hosts. HRMS lists `^(www\.)?blgtechnologies\.in$` and `^(?!hrms-staging\.).*blgtechnologies\.in$`. Every browser context and every API request context is created through it.
2. **Action allowlist.** The crawler never clicks an element whose accessible name, `data-testid`, or nearest form action matches `safety.denyActionPatterns`. The single exception is the *owned-record rule*. Delete, cancel, approve, reject, edit and update are allowed only inside a row or dialog whose visible text contains this run's tag (`PRM-<runId>`). Even then, the network ownership guard (#9) must also allow the resulting request. Every block is written to the ledger as `safety.blocked`.
3. **Approval-gated actions.** Actions matching `safety.requiresApprovalPatterns` (punch in/out, payroll, lock, finalize, bulk import) are skipped and listed in the run summary until Balu adds them to `safety.approvedActions`.
4. **Rate limit.** A global limiter enforces `safety.maxRps` (default 2) across UI and API traffic. Authorization replay has its own limiter at `safety.maxReplayRps` (default 2).
5. **Data tagging.** Every **free-text** field Pramaan types into starts with `PRM-<runId>-`. Free-text means a `textarea` or an `input[type=text]` with no format hint (no email, phone, date, number or code pattern in its label or `pattern` attribute). Login fields are **never** tagged. Emails, phones, numbers and dates come from the data factory. The created record's ID is written to the ledger as `data.created`.
6. **Prompt-injection posture.** The LLM never receives credentials or tokens, never has browser or shell tools, and only produces structured output that zod validates. Page-derived text is wrapped in `<untrusted_page_content>` tags, and the system prompt says that content is data, not instructions. Generated code is linted and reviewed before it runs with credentials.
7. **PII redaction.** `redact()` runs before anything is sent to an LLM and before any evidence is written into the suite repo. It strips auth headers, cookies, JWTs, passwords, PAN (`[A-Z]{5}[0-9]{4}[A-Z]`), Aadhaar (12 digits, optionally grouped 4-4-4), IFSC, Indian phone numbers, bank-account-like digit runs inside keys named `account|acct|bank`, and any JSON value whose key matches `salary|ctc|basic|gross|net_?pay|pay(roll)?_amount`. Unit-test each pattern with positive and negative cases.
8. **No production.** There is no `--target production`. Do not add one. Apps with `requireTargetFlag: true` (HRMS) make **zero** network calls unless the command carries `--target staging`. This includes `doctor`, which skips reachability without the flag.
9. **Ownership guard at the network layer.** Button names are not enough, so `src/core/ownership-guard.ts` is installed via `context.route` on every crawler and replay context. It **aborts any non-GET request** unless one of these holds:
   - (a) it is a create: a POST to a path with no `{param}` segment, from a form that passed the safety checks;
   - (b) its path or body targets an ID present in this run's `data.created` ledger events;
   - (c) it is the login call.

   Each abort is logged as `safety.blocked`, with method, path and the reason. This rule protects real records on shared staging even when a deny pattern misses a button such as "Approve", "Save" on an edit form, or "Reject". Unit-test it, and include it in the M2 e2e.

### 2.4 LLM usage rules
- One client: `src/llm/client.ts`. Nothing else imports `@anthropic-ai/sdk`.
- Models come from env vars, with these defaults:
  - `PRAMAAN_MODEL_FRONTIER=claude-opus-5-5`: rule proposals, assertion authoring.
  - `PRAMAAN_MODEL_MID=claude-sonnet-5-5`: naming, triage summaries, charter planning.
  - `PRAMAAN_MODEL_SMALL=claude-haiku-4-5-20251001`: form data, frontier ranking.
- **Structured output.** Request JSON with `output_config: { format: { type: 'json_schema', schema } }`. Build the JSON Schema from the zod schema with `z.toJSONSchema()` (zod v4), then validate the reply with the same zod schema. The M0 smoke test confirms this works with the installed SDK. If the SDK types or the API reject it, fall back to forced tool use: one tool whose `input_schema` is the schema, plus `tool_choice: { type: 'tool', name }`. Record which path is live in `docs/DECISIONS.md`. Use `z.toJSONSchema(schema, { io: 'input' })`. If the API rejects a schema feature, define an LLM-facing variant in `src/llm/schemas/` and convert it to the §4 type in code. Typical rejected features are open `unknown` values such as `body` or `data`, regex-keyed records, and refinements. For example, the variant can carry `body` as a JSON string that you then parse. Check `stop_reason`: `refusal` or `max_tokens` is an error, never parsed.
- Modes come from `PRAMAAN_LLM_MODE`:
  - `live`: call the API.
  - `record`: call the API and write the response to the cache.
  - `replay`: read the cache only. A cache miss throws `LlmCacheMiss`.
  - `replay-or-off`: read the cache. On a miss, run the call site's deterministic fallback and log `llm.call` with `{ cached: false, fallback: true }`. **This is the default for `npm run verify` and CI**, so the build stays green before any cache has been recorded.
  - `off`: never call. Each call site's deterministic fallback runs instead.

  **Unit and e2e tests always run in `replay-or-off`, `replay` or `off`.** The cache key is `sha256(appId + model + systemPrompt + messages + schemaHash + promptVersion)`. The cache lives in `.pramaan-cache/llm/<appId>/` and is committed only for the demo app (see the `.gitignore` lines in §6).
- **Budgets.** Every call appends an `llm.call` event (input tokens, output tokens, estimated USD, cached, purpose) to the single ledger, `workspace/<app>/ledger/events.jsonl` (§4.7). Cost uses a price table in `src/llm/prices.ts`. Balu edits that table. An unknown model logs a warning and counts as $0. Each command has a USD cap, `budgets.perCommandUsd` (default 5). The compile pipeline has its own cap, `budgets.compileUsd` (default 40). Exceeding a cap stops the command cleanly and reports. Balu's AI budget needs CEO approval, so be frugal: cache, batch, truncate.
- Prompts live in `src/llm/prompts/<name>.md` with front-matter `version:`. Bumping a prompt changes its cache keys.
- **Evidence discipline.** Any LLM output that cites evidence may cite only evidence IDs that were in its input. The validator rejects any item citing an unknown ID, which is how hallucinated rules are dropped. Count and report rejections.

---

## 3. Architecture and repository layout

### 3.1 Pipeline

```
onboard → crawl → infer → review(lead) → compile → mutate-check → review(lead PR) → run (CI, $0 LLM)
                                                                                   ↓ on failure / change
                                              triage → heal (locator-only) / finding → digest(lead) → report
weekly: charter agents (Workflow Breaker, Boundary Calculator; v1: personas) → candidates → replay ×3 → review(lead)
v1: drift sentinel diffs every CI run's traffic against the Living Spec → impacted tests, new rule proposals
```

### 3.2 Pramaan repo (this repo)

```
pramaan/
  CLAUDE.md                     # short standing rules (generated in M0 from §11)
  PRAMAAN_BUILD_SPEC.md         # this file
  docs/PROGRESS.md              # milestone status + measured metrics (agent updates)
  docs/DECISIONS.md             # ADR-style log: library versions, SDK path, deviations
  docs/NEEDS-BALU.md            # open asks that block or degrade work
  .env.example                  # every env var, no values
  package.json  tsconfig.json  eslint.config.js  vitest.config.ts  .prettierrc
  src/
    cli/index.ts                # commander; one subcommand per pipeline stage
    core/                       # config loading, schemas.ts, log, ids, runId, redact, target-guard,
                                # rate-limit, ledger, budget, stable-json, time (Asia/Kolkata helpers)
    llm/                        # client, cache, prices, prompts/*.md
    onboarding/                 # contract check, login strategies, session store
    crawler/                    # bfs, state-key, candidates, safety, form-fill, capture
    spec/                       # har→openapi, path-normalize, schema-infer, role-matrix, entities,
                                # state-machines, rule-proposer, living-spec io
    authz/                      # replay, compare, matrix-update
    dsl/                        # jsonpath subset, expression evaluator, assertion runner
    oracles/                    # implicit, differential, consistency
    data/                       # steward (seed/teardown ledger), factories/en_IN
    codegen/                    # pom, flows, specs (ui/api/authz/workflow), fixtures, templates, writer
    mutation/                   # fault catalog, mutant runner, kill-rate
    triage/                     # results parser, signature, classifier, defect writer
    maintain/                   # heal (locator-only), expect-count lint, quarantine
    charters/                   # workflow-breaker, boundary-calculator (v1: personas)
    lead/                       # queue, interactive review, digest, PR helper, minutes tracking
    report/                     # coverage, precision ledger, closure report (HTML + MD)
    bench/                      # seeded-bug benchmark runner
    nfr/                        # v1: a11y, pseudo-locale, visual, browsers, lighthouse, k6
    drift/                      # v1: sentinel, change-impact, crystallization
  domain-packs/in-hrms/         # rule templates, entity hints, en_IN formats (YAML)
  apps/
    demo/app.yaml               # the local demo app (§5)
    hrms/app.yaml               # the real pilot
    hrms/seed-rules.yaml        # Balu's 7 confirmed attendance rules (§1)
  fixtures/demo-hrms/           # tiny local HRMS with toggleable seeded bugs (§5)
  benchmark/demo/bugs.yaml      # seeded bug catalog for the demo app
  benchmark/hrms/bugs.yaml      # seeded bug catalog for HRMS (Balu + devs fill it)
  test/unit/**  test/e2e/**     # Pramaan's own tests
  workspace/<appId>/            # GITIGNORED: HAR, snapshots, screenshots, sessions, raw runs
  .pramaan-cache/               # GITIGNORED except llm cache for the demo app
```

### 3.3 Suite repo (generated, owned by the client)

`app.yaml → output.repoPath` points at a **separate git repo**. The default is `../pramaan-<appId>-suite`. That repo is the product the client keeps. It must run with `npm ci && npx playwright test` and have no dependency on Pramaan.

```
pramaan-hrms-suite/
  package.json  playwright.config.ts  tsconfig.json  eslint.config.js  .env.example
  spec/                         # the Living Spec (reviewable, versioned)
    openapi.observed.yaml
    role-matrix.yaml
    entities.yaml               # entities, fields, CRUD ops, state machines
    rules.yaml                  # Rule[] (§4.3)
    assertions/*.json           # Assertion DSL (§4.5), one file per assertion
    test-index.json             # test id → operations/rules it covers (drift + coverage)
  config/  fixtures/  helpers/  pages/  flows/
  specs/ui/  specs/api/  specs/authz/  specs/workflow/   (v1: specs/a11y, specs/i18n, specs/visual, perf/)
  scripts/lint-expect-count.ts  # heal lint (M9), also runs in the suite's CI
  .github/workflows/qa.yml      # smoke on push, full regression nightly
  PRAMAAN.md                    # human-readable: what this suite covers, how it was generated
```

### 3.4 CLI surface (all commands take `--app <id>`; staging requires an explicit `--target staging`)

| Command | Milestone | Does |
| --- | --- | --- |
| `pramaan doctor` | M0 | Checks env, Node, browsers, LLM smoke, target reachability |
| `pramaan onboard` | M1 | Contract check, per-role login, saves sessions, writes `cannot-proceed.md` on failure |
| `pramaan crawl [--role r] [--max-states n]` | M2 | BFS per role, HAR plus snapshots |
| `pramaan infer` | M3, M5 | Observed OpenAPI, entities, state machines, role matrix proposal, rule proposals |
| `pramaan authz` | M4 | Differential replay, updates the role matrix's observed side |
| `pramaan review [--interactive]` | M5, M10 | Lead queue: rules, matrix, assertions, findings. Tracks minutes |
| `pramaan compile` | M6 | Writes the suite repo on branch `pramaan/compile-<runId>`, runs its lint and typecheck |
| `pramaan seed` / `pramaan teardown` | M7 | Data steward |
| `pramaan run [--suite smoke\|regression\|authz]` | M6 | Runs the suite repo, collects JSON results into the workspace |
| `pramaan mutate` | M8 | Fault-injection kill rate |
| `pramaan bench [--bugs all\|<id,...>]` | M8 | Seeded-bug recall and precision |
| `pramaan triage --results <path>` | M9 | Signatures, rerun, classify, heal or finding |
| `pramaan charter --agent workflow-breaker\|boundary-calculator` | M10 | Weekly charter run, produces candidates |
| `pramaan digest` | M10 | Weekly markdown digest for the lead |
| `pramaan report` | M10 | Closure report: coverage, precision ledger, residual risk, GO/NO-GO evidence |
| `pramaan nfr` | M12 | v1 NFR suites |
| `pramaan drift` | M15 | v1 drift sentinel and change impact |
| `pramaan all` | M10 | onboard → crawl → infer → authz → (stop for review) |

---

## 4. Core contracts (`src/core/schemas.ts`)

Implement these **exactly** (zod v4). Every file Pramaan reads or writes goes through them. You may add fields. Do not rename or remove fields without a DECISIONS.md entry.

### 4.1 App config (`apps/<id>/app.yaml`)

```ts
import { z } from 'zod';

export const SCHEMA_VERSION = 1 as const;

export const RoleId = z.string().regex(/^[a-z][a-z0-9-]{1,30}$/);

export const AppConfig = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^[a-z][a-z0-9-]{1,30}$/),
  name: z.string(),
  baseUrl: z.url(),
  apiBaseUrl: z.url().optional(),
  apiDocsUrl: z.url().optional(),            // scoring only, never an inference input
  tenants: z.array(z.object({
    id: z.string(),                           // 'primary' | 'secondary'
    codeEnv: z.string(),                      // env var holding the tenant code
  })).min(1),
  roles: z.array(z.object({
    id: RoleId,                               // 'employee' | 'employee2' | 'manager' | 'admin' | ...
    tenant: z.string(),
    usernameEnv: z.string(),
    passwordEnv: z.string(),
    totpSeedEnv: z.string().optional(),       // v1 (M14)
    optional: z.boolean().default(false),     // missing env → skip with a "cannot verify" note
  })).min(1),
  login: z.object({
    strategy: z.enum(['form', 'totp', 'email-otp']).default('form'),
    url: z.string().default('/'),
    fields: z.object({                        // optional overrides; auto-detected by label otherwise
      tenant: z.string().optional(),
      username: z.string().optional(),
      password: z.string().optional(),
      submit: z.string().optional(),
    }).default({}),
    successSignal: z.string().optional(),     // URL glob or text proving login worked
  }),
  safety: z.object({
    allowedOrigins: z.array(z.url()).min(1),
    forbiddenHostPatterns: z.array(z.string()).default([]),
    requireTargetFlag: z.boolean().default(false),   // true for HRMS: no network without --target staging
    denyActionPatterns: z.array(z.string()).min(1),
    requiresApprovalPatterns: z.array(z.string()).default([]),
    approvedActions: z.array(z.string()).default([]),
    maxRps: z.number().positive().default(2),
    maxReplayRps: z.number().positive().default(2),
    runTagPrefix: z.string().default('PRM'),
  }),
  crawl: z.object({
    maxStatesPerRole: z.number().int().positive().default(150),
    maxDepth: z.number().int().positive().default(8),
    maxMinutesPerRole: z.number().positive().default(20),
    submitForms: z.boolean().default(true),   // only in the primary tenant, only allow-listed submits
  }).default({ maxStatesPerRole: 150, maxDepth: 8, maxMinutesPerRole: 20, submitForms: true }),
  budgets: z.object({
    perCommandUsd: z.number().nonnegative().default(5),
    compileUsd: z.number().nonnegative().default(40),
  }).default({ perCommandUsd: 5, compileUsd: 40 }),
  lead: z.object({
    minutesPerWeek: z.number().int().positive().default(90),
    autoFilePrecision: z.number().min(0).max(1).default(0.95),
    autoFileMinVerdicts: z.number().int().positive().default(20),
    shadowMode: z.boolean().default(false),
  }).default({ minutesPerWeek: 90, autoFilePrecision: 0.95, autoFileMinVerdicts: 20, shadowMode: false }),
  domainPack: z.string().optional(),          // 'in-hrms'
  output: z.object({
    repoPath: z.string(),
    defectSink: z.enum(['markdown', 'github', 'jira']).default('markdown'),
  }),
  implicitOracle: z.object({
    ignoreConsolePatterns: z.array(z.string()).default([]),
    ignoreRequestPatterns: z.array(z.string()).default([]),
  }).default({ ignoreConsolePatterns: [], ignoreRequestPatterns: [] }),
});
export type AppConfig = z.infer<typeof AppConfig>;
```

### 4.2 Evidence

```ts
export const EvidenceId = z.string().regex(/^E-[0-9a-f]{8}$/);
export const Evidence = z.object({
  id: EvidenceId,
  kind: z.enum(['request', 'response', 'screenshot', 'aria-snapshot', 'ui-text',
    'validation-message', 'console', 'domain-pack', 'lead-note', 'replay']),
  ref: z.string(),                 // workspace-relative path, or "METHOD /path" operation key
  excerpt: z.string().max(600).optional(),   // redacted
});
export type Evidence = z.infer<typeof Evidence>;
```

### 4.3 Rules (`spec/rules.yaml`)

```ts
export const RuleId = z.string().regex(/^R-\d{3,}$/);
export const RuleKind = z.enum(['authz', 'tenant-isolation', 'validation', 'calculation',
  'workflow', 'invariant', 'consistency', 'format', 'ui-behaviour']);
export const DecisionStatus = z.enum(['proposed', 'confirmed', 'rejected', 'retired']);
export const Decision = z.object({
  by: z.string(),                  // 'lead:balu' | 'pramaan'
  at: z.iso.datetime({ offset: true }),
  note: z.string().optional(),
});

export const Rule = z.object({
  id: RuleId,
  title: z.string().min(10).max(200),        // one plain sentence
  kind: RuleKind,
  status: DecisionStatus,
  confidence: z.number().min(0).max(1),
  source: z.enum(['inferred', 'domain-pack', 'charter', 'lead', 'mined']),
  entities: z.array(z.string()).default([]),
  operations: z.array(z.string()).default([]),   // "POST /api/leave"
  evidence: z.array(Evidence).min(1),
  criticality: z.number().int().min(1).max(5),
  assertionIds: z.array(z.string()).default([]),
  openQuestion: z.string().optional(),       // for ambiguities: what the lead must answer
  decision: Decision.optional(),
  version: z.number().int().min(1).default(1),
}).superRefine((r, ctx) => {
  if ((r.status === 'confirmed' || r.status === 'rejected') && !r.decision) {
    ctx.addIssue({ code: 'custom', message: `${r.id}: ${r.status} rules need a decision` });
  }
});
export type Rule = z.infer<typeof Rule>;
export const RulesFile = z.object({ schemaVersion: z.literal(1), rules: z.array(Rule) });
```

### 4.4 Role matrix (`spec/role-matrix.yaml`)

```ts
// Actor keys: a role id, 'anonymous', or 'other-tenant:<roleId>'.
export const ActorKey = z.string().regex(/^(anonymous|other-tenant:[a-z][a-z0-9-]*|[a-z][a-z0-9-]*)$/);
export const Expectation = z.enum(['allow', 'deny', 'own-only', 'filtered', 'unknown']);
export const ObservedOutcome = z.enum(['same-data', 'different-data', 'denied', 'error', 'skipped']);
export const MatrixRow = z.object({
  operation: z.string(),                       // "GET /api/leave/{id}"
  ownerRole: RoleId,                           // whose session produced the baseline response
  expected: z.record(ActorKey, Expectation),
  observed: z.record(ActorKey, z.object({
    status: z.number().int(),
    outcome: ObservedOutcome,
    similarity: z.number().min(0).max(1).optional(),
    evidenceRef: z.string().optional(),
  })),
  status: DecisionStatus,
  decision: Decision.optional(),
});
export const RoleMatrixFile = z.object({ schemaVersion: z.literal(1), rows: z.array(MatrixRow) });
```

### 4.5 Assertion DSL (`spec/assertions/A-xxx.json`)

The DSL is how an LLM expresses an expectation without being the judge. The evaluator in `src/dsl/` runs it deterministically (charter replay, bench). Codegen turns it into readable Playwright code (M6).

```ts
export const OperationRef = z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  path: z.string().startsWith('/'),            // template from openapi.observed, e.g. /api/leave/{id}
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
  capture: z.record(z.string(), z.string()).default({}),   // name → JSONPath into the response body
});
export const UiStep = z.object({
  kind: z.literal('ui'),
  id: z.string().regex(/^[a-z][a-zA-Z0-9]*$/),
  actor: ActorKey,
  flow: z.string(),                            // a flow id from the suite's flows/ registry
  args: z.record(z.string(), z.string()).default({}),
});
export const Step = z.discriminatedUnion('kind', [ApiStep, UiStep]);

export const Comparator = z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte',
  'exists', 'absent', 'matches', 'contains', 'in']);
export const Normalizer = z.enum(['none', 'number', 'inr', 'date-in', 'trim-lower']);
export const Check = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('status'), step: z.string(),
    oneOf: z.array(z.number().int()).min(1), message: z.string().min(8) }),
  z.object({ kind: z.literal('field'), step: z.string(), path: z.string(),
    cmp: Comparator, value: z.unknown().optional(), normalize: Normalizer.default('none'),
    message: z.string().min(8) }),
  z.object({ kind: z.literal('delta'), before: z.string(), after: z.string(), path: z.string(),
    expected: z.string(),                      // expression, e.g. "-${data.days}"
    message: z.string().min(8) }),
  z.object({ kind: z.literal('equalAcross'),
    refs: z.array(z.object({ step: z.string(), path: z.string() })).min(2),
    normalize: Normalizer.default('none'), message: z.string().min(8) }),
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
```

### 4.6 DSL runtime requirements (`src/dsl/`)
- **JSONPath subset:** `$`, `.key`, `['key']`, `[n]`, `[-1]`, `[*]` (returns an array), and `length()` as a final segment. Anything else is a parse error with a clear message.
- **Expressions:** number literals, `${refs}`, `+ - * /`, unary minus, parentheses, and the functions `round(x, n)`, `floor`, `ceil`, `abs`, `min`, `max`, `days(dateA, dateB)` (inclusive day count in Asia/Kolkata). Use a hand-written recursive-descent parser. Division by zero is an evaluation error, never `Infinity`.
- **Runner:**
  1. Resolve every actor's auth material (§M4).
  2. Run `arrange`, then `act`, through the rate limiter and target guard.
  3. Evaluate the checks.
  4. Always run `cleanup`, even when an earlier step failed.
  5. Return `{ passed, checks: [{ ok, message, actual, expected }], evidence }`.
- **Determinism:** the same inputs against the same server state give the same result. Before any check runs, the runner enforces a readiness rule: a response must be complete. There are no timing-based waits.

### 4.7 Findings and ledger

```ts
export const OracleClass = z.enum(['implicit', 'differential', 'consistency', 'authz-matrix',
  'confirmed-rule', 'invariant', 'metamorphic', 'charter-candidate']);
export const Finding = z.object({
  id: z.string().regex(/^F-\d{4,}$/),
  title: z.string(),
  severity: z.enum(['S1', 'S2', 'S3', 'S4']),
  oracle: OracleClass,
  ruleId: RuleId.optional(),
  testId: z.string().optional(),
  signature: z.string(),                       // failure signature hash (§M9)
  evidence: z.array(Evidence).min(1),
  reproSteps: z.array(z.string()).min(1),
  status: z.enum(['candidate', 'queued', 'auto-filed', 'confirmed', 'rejected', 'duplicate']),
  firstSeenRunId: z.string(),
  lastSeenRunId: z.string(),
});

export const LedgerEventType = z.enum([
  'run.started', 'run.completed', 'safety.blocked', 'llm.call', 'llm.rejected-output',
  'rule.proposed', 'rule.decided', 'matrix.decided', 'assertion.decided',
  'data.created', 'data.deleted', 'data.orphaned',
  'heal.applied', 'heal.rejected', 'test.quarantined', 'test.promoted', 'test.demoted',
  'finding.created', 'finding.queued', 'finding.autofiled', 'finding.verdict',
  'lead.session', 'bench.result', 'mutation.result',
]);
export const LedgerEvent = z.object({
  ts: z.iso.datetime({ offset: true }),
  app: z.string(),
  runId: z.string(),
  type: LedgerEventType,
  actor: z.string(),                           // 'pramaan:<module>' | 'lead:<name>'
  data: z.record(z.string(), z.unknown()),
});
// Required data keys by type (validated in ledger.append):
//   finding.verdict  → { findingId, oracle: OracleClass, verdict: 'true-positive'|'false-positive'|'duplicate' }
//   lead.session     → { minutes: number, itemsDecided: number }
//   llm.call         → { model, inputTokens, outputTokens, usd, cached: boolean, purpose }
//   data.created     → { entity, id, operation, teardownOp?: string }
```

There is **one** ledger: append-only JSONL at `workspace/<app>/ledger/events.jsonl`. Because `workspace/` is gitignored, durable history is mirrored into the suite repo at `spec/decisions.jsonl`. The mirrored types are `rule.decided`, `matrix.decided`, `assertion.decided`, `finding.verdict`, `lead.session`, `test.quarantined`, `test.promoted`, `test.demoted`, `bench.result`, `mutation.result` and `run.completed`. Gate history therefore survives a clean clone and travels with the code. The suite's CI does not have Pramaan installed, so it uploads `results.json` as a build artifact. `pramaan triage --results <path|dir>` imports those artifacts, and flake statistics are computed from the imported runs. **Precision per oracle class** is the true positives divided by all verdicts for that class, over the last 50 verdicts. A class can auto-file only when it has at least `lead.autoFileMinVerdicts` verdicts and precision of at least `lead.autoFilePrecision`. A single false positive recomputes the class immediately.

---
## 5. The demo app (`fixtures/demo-hrms/`) — build this in M0

Staging is reachable only on Balu's network, and you must never experiment on it. Build a **tiny local HRMS** that imitates the real one. It is the target for all Pramaan e2e tests and for the offline benchmark.

- **Stack:** Express plus static HTML and vanilla JS, with no build step and an in-memory store. Start it with `npm run demo` on `http://localhost:4600`.
- **Shape:**
  - The SPA uses `fetch` to call a JSON API under `/api`.
  - The login form has three fields: tenant code, email and password.
  - After login, the app keeps an HMAC-signed token in `localStorage` and sends it as `Authorization: Bearer`, plus an `X-Tenant-Code` header.
- **Tenants:** `TEST` and `TEST2`. Users in `TEST`: `emp1` and `emp2` (employees), `mgr1` (manager) and `admin1` (admin). `TEST2` has one admin and one employee. All passwords are `Demo@123`, and these are fixture credentials only.
- **Pages:**
  - Login.
  - Dashboard, showing the leave balance.
  - My leaves: a list, an apply form and a cancel action.
  - Approvals, for manager and admin: approve and reject actions.
  - Employees, for admin only.
  - Attendance: punch in and punch out, matched by an approval-gated pattern.
  - A CSV export of leaves.
- **`data-testid` coverage:** put it on about 60% of interactive elements, so the locator ladder gets exercised.
- **Leave state machine:** `draft → submitted → approved | rejected → cancelled`. Only a submitted request can be approved or rejected. Approving deducts `days` from the balance, a half day counts as 0.5, and cancelling an approved leave refunds the days.
- **Reset:** `POST /__reset` restores the seed data. It is only reachable from localhost.
- **Visible tags:** list rows (leaves, employees) show the reason and name text, so the owned-record rule can see `PRM-` tags in the UI.
- **Flaky toggle:** `DEMO_FLAKY=<p>`, for example `0.3`, makes `GET /api/leave-balance` return 503 with probability p. It uses a seeded PRNG (`DEMO_SEED`, default 42), so runs are reproducible.
- **Drift toggles** (used in M9 and M16): `DEMO_DRIFT=apply-testid` renames the `data-testid` of "Apply leave". `DEMO_API_V2=1` adds a field and renames one route.
- **Seeded bugs:** each is toggled by `DEMO_BUGS=<comma list>`. `DEMO_BUGS=none` must be fully correct.

| Bug id | Category | Behaviour when on | Should be caught by |
| --- | --- | --- | --- |
| `idor-leave-read` | authz | `GET /api/leaves/:id` returns another employee's leave | authz matrix (own-only) |
| `employee-admin-endpoint` | authz | `GET /api/employees` allowed for the employee role | authz matrix |
| `cross-tenant-list` | tenant-isolation | `/api/leaves?all=1` ignores the tenant | authz matrix (other-tenant) |
| `self-approve` | workflow | Manager can approve their own leave | workflow rule / Workflow Breaker |
| `double-approve` | workflow | Approving an already approved leave deducts again | Workflow Breaker |
| `cancel-no-refund` | calculation | Cancelling an approved leave does not refund the balance | confirmed calculation rule |
| `balance-off-by-one` | calculation | Approval deducts `days + 1` | confirmed calculation rule (delta) |
| `half-day-rounding` | calculation | 0.5 days is deducted as 1 | Boundary Calculator |
| `negative-days` | validation | `days: -2` is accepted | Boundary Calculator |
| `end-before-start` | validation | An end date before the start date is accepted | Boundary Calculator |
| `ist-midnight` | calculation | A leave applied for 23:30 IST is stored on the next UTC day | Boundary Calculator |
| `long-reason-500` | implicit | A reason longer than 200 characters returns 500 | implicit oracle |
| `dashboard-console-error` | implicit | Dashboard throws an uncaught JS error | implicit oracle |
| `stale-ui-balance` | consistency | Dashboard balance is not refreshed after approval, so the UI differs from the API | consistency oracle |
| `csv-export-mismatch` | consistency (v1) | CSV shows `days` rounded differently from the API | export consistency oracle (M13) |

`benchmark/demo/bugs.yaml` lists these bugs as `{ id, category, activation: { env: { DEMO_BUGS: '<id>' } }, expectedOracle: OracleClass, operations: string[] }`. `expectedOracle` is a §4.7 `OracleClass` value, and the table's "Should be caught by" column is just a human hint. The mapping:
- authz rows → `authz-matrix`;
- tenant-isolation → `authz-matrix`;
- calculation or validation rows caught by a confirmed rule → `confirmed-rule`;
- rows caught by Workflow Breaker or Boundary Calculator → `charter-candidate` at first, then `confirmed-rule` once the lead confirms the candidate;
- implicit → `implicit`;
- consistency → `consistency`.

`operations` lists the `METHOD /template` keys the bug lives on.

---

## 6. Environment (`.env.example`)

```dotenv
# --- LLM ---
ANTHROPIC_API_KEY=
PRAMAAN_LLM_MODE=replay            # live | record | replay | off
PRAMAAN_MODEL_FRONTIER=claude-opus-5-5
PRAMAAN_MODEL_MID=claude-sonnet-5-5
PRAMAAN_MODEL_SMALL=claude-haiku-4-5-20251001

# --- HRMS staging (Balu fills; never commit .env) ---
HRMS_TENANT_PRIMARY=TEST
HRMS_TENANT_SECONDARY=
HRMS_EMPLOYEE_EMAIL=
HRMS_EMPLOYEE_PASSWORD=
HRMS_EMPLOYEE2_EMAIL=
HRMS_EMPLOYEE2_PASSWORD=
HRMS_ADMIN_EMAIL=
HRMS_ADMIN_PASSWORD=
HRMS_OTHER_TENANT_EMPLOYEE_EMAIL=
HRMS_OTHER_TENANT_EMPLOYEE_PASSWORD=

# --- Demo app (fixture creds, safe to keep) ---
DEMO_TENANT_PRIMARY=TEST
DEMO_TENANT_SECONDARY=TEST2
DEMO_PASSWORD=Demo@123

# --- Optional sinks ---
GITHUB_TOKEN=                      # gh CLI is preferred; used for PRs/issues if set
JIRA_BASE_URL=
JIRA_EMAIL=
JIRA_API_TOKEN=
```

`.gitignore` must contain exactly these lines for the cache. Git cannot re-include a file inside an ignored directory, so the pattern must be built this way:

```gitignore
.env
workspace/
playwright-report/
test-results/
allure-results/
.pramaan-cache/*
!.pramaan-cache/llm/
.pramaan-cache/llm/*
!.pramaan-cache/llm/demo/
```

Add a unit test that runs `git check-ignore` on a demo cache file and a HRMS cache file.

---

## 7. Working protocol for the agent (every session)

1. Read `CLAUDE.md`, `docs/PROGRESS.md` and `docs/NEEDS-BALU.md`. Find the current milestone.
2. Read **only** that milestone's section below, plus any § it references.
3. Write a checklist for the milestone with the TaskCreate/todo tool. Keep it short.
4. Pure logic first, with tests. Then wire it into commands. Then run the e2e test against the demo app.
5. Run `npm run verify`, which is typecheck, lint, unit tests and e2e against the demo app with `PRAMAAN_LLM_MODE=replay`. It must be green.
6. Run the milestone's acceptance checks. Paste the measured numbers into `docs/PROGRESS.md`.
7. Commit with `feat(mN): <summary>`. Use one commit per coherent step, never one giant commit.
8. **Stop.** Report to Balu in five lines or fewer: what works, the measured numbers, what needs him, and the next milestone. Do not start the next milestone until he says "continue".

**Ask Balu before you:**
- touch staging for the first time in a milestone;
- add any action to `approvedActions`;
- raise a budget;
- add a dependency that is native, Python, or larger than 5 MB;
- change any contract in §4;
- disable a safety rule.

For anything else, make the reasonable call and log it in `docs/DECISIONS.md`.

**Recording LLM fixtures:** when a milestone adds an LLM call, run the demo e2e once with `PRAMAAN_LLM_MODE=record`. That needs Balu's API key and his OK on cost. Show him the estimated USD first. Commit the demo cache so CI and future sessions replay it for free.

---

## 8. MVP milestones (M0–M10) — target 10 weeks, pilot on HRMS

Each milestone lists: **Goal · Build · Contracts/notes · Acceptance (all must pass) · Needs Balu**.

### M0 — Scaffold, demo app, LLM client, guards (week 1)

**Goal:** an empty repo becomes a working skeleton with every guardrail in place before any feature exists.

**Build:**
1. `package.json` (type: module). Scripts:
   - `dev`, `build`, `typecheck`, `lint`, `test`, `e2e:demo`
   - `verify` = `typecheck && lint && test && e2e:demo` (never `dev`, which is long-running). `e2e:demo` starts the demo app itself on a free port, through Playwright's `webServer` or a programmatic start/stop in global setup and teardown, and sets `PRAMAAN_LLM_MODE=replay-or-off`.
   - `demo`, `doctor`, `llm:smoke`

   Dependencies (install the latest stable versions and record them in DECISIONS.md): `typescript`, `tsx`, `zod@^4`, `yaml`, `commander`, `@anthropic-ai/sdk`, `@playwright/test`, `@faker-js/faker`, `pino`, `p-limit`, `ts-morph`, `@inquirer/prompts`, `dotenv`, `express`, `vitest`, `eslint`, `typescript-eslint`, `prettier`. Install Playwright browsers with `npx playwright install chromium firefox webkit`.
2. `src/core/schemas.ts`: copy §4 exactly, then add `test/unit/schemas.test.ts` with one valid and one invalid fixture per schema.
3. `src/core/`: `config.ts` (loads `app.yaml` and resolves env), `target-guard.ts`, `rate-limit.ts`, `redact.ts`, `ledger.ts`, `budget.ts`, `run-id.ts` (`YYYYMMDD-HHmm-<4 hex>`, Asia/Kolkata), `stable-json.ts`, `time.ts`.
4. `src/llm/`: `client.ts`, `cache.ts`, `prices.ts`, and `prompts/` (empty). Add `scripts/llm-smoke.ts`. It asks the frontier model for a tiny schema-validated object using `output_config.format`, falls back to forced tool use, and prints which path worked and what it cost.
5. `fixtures/demo-hrms/` as described in §5, plus `benchmark/demo/bugs.yaml`.
6. `apps/demo/app.yaml` and `apps/hrms/app.yaml`. Use the values in §1 and §6. HRMS safety starts with:
   - `denyActionPatterns: [delete, remove, terminate, deactivate, archive, "run payroll", "process payroll", "lock", "finalize", "approve all", "reject all", approve, reject, edit, update, "bulk", "import", "reset password", "change password", logout, "sign out"]`. `approve`, `reject`, `edit` and `update` remain usable on owned records through the owned-record exception, and the network ownership guard (§2.3 #9) is the backstop.
   - `forbiddenHostPatterns` as in §2.3 #1, with `requireTargetFlag: true`
   - `requiresApprovalPatterns: ["punch in", "punch out", "check in", "check out", "clock in", "clock out", "regulariz", "payroll", "arrear"]`
   - `allowedOrigins: [http://hrms-staging.blgtechnologies.in:82, http://hrms-staging.blgtechnologies.in:5002]`
7. `src/cli/index.ts` with `doctor`, which checks:
   - Node version;
   - the browsers are installed;
   - the `.env` keys for the chosen app;
   - target reachability: an HTTP 200 on `baseUrl`, run through the guard;
   - the LLM mode, plus key presence when the mode is live.
8. Create `CLAUDE.md` from §11 verbatim, plus `docs/PROGRESS.md`, `docs/DECISIONS.md` and `docs/NEEDS-BALU.md`.
9. A `.github/workflows/ci.yml` that runs `npm run verify` on push, in replay mode.

**Acceptance:**
- `npm run verify` is green on a clean clone.
- `npm run demo` serves the app. `DEMO_BUGS=none` and `DEMO_BUGS=idor-leave-read` both start, and a unit test hits `/api/leaves/:id` across users to prove the toggle works.
- `pramaan doctor --app demo` passes. `pramaan doctor --app hrms` (no `--target`) reports exactly which env keys are missing and makes zero network calls. Prove it with a unit test that stubs the network layer and asserts no calls.
- The ownership guard unit tests pass: a non-GET request on a non-owned ID is aborted, create and owned-ID requests are allowed.
- The target guard has unit tests: an allowed origin passes, a non-allowed origin throws, a forbidden host pattern throws even if allow-listed.
- `redact()` has at least 20 unit cases, including the PAN, Aadhaar and salary-key patterns.
- `npm run llm:smoke` (only if Balu gave a key) prints the working structured-output path and its cost.

**Needs Balu:** `ANTHROPIC_API_KEY` with a budget OK, HRMS `.env` values, and approval of the HRMS safety lists.

### M1 — Onboarding harness (week 1–2)

**Goal:** log in as every role, keep the sessions, and fail fast with a readable report.

**Build:**
- `src/onboarding/contract.ts` checks:
  - every non-optional role has credentials;
  - the tenants resolve;
  - the origins are reachable.

  Missing optional roles (`employee2`, other-tenant roles) produce **"cannot verify"** notes instead of failures.
- `src/onboarding/login-form.ts` finds the fields by `getByLabel`, then `getByPlaceholder`, then `getByRole('textbox')` ordering, unless `login.fields` overrides them. It types the tenant, username and password, submits, and checks success: the URL left the login page, or `successSignal` is visible, and no error text is shown.
- `src/onboarding/sessions.ts` saves `storageState` to `workspace/<app>/sessions/<role>.json`. It refreshes automatically when a stored session gets a 401 on its first API call.
- `src/onboarding/auth-material.ts` works out how the API is authenticated, using HAR from the login run:
  - the bearer-header source (a `localStorage` key, or a cookie);
  - the tenant header name. Detect it by diffing the headers present on every `/api` call.

  It produces `AuthMaterial { headers: Record<string,string>; cookies: Cookie[] }` per role, for API replay. **Never write raw tokens outside `workspace/`.**
- `pramaan onboard` writes `workspace/<app>/onboarding.md`, a table with one row per role: ok / failed / skipped, the reason, and the time taken. On any failure of a required role it also writes `cannot-proceed.md` and exits with code 2.

**Acceptance:**
- Against the demo app, all six demo users log in, and API calls succeed with the derived `AuthMaterial`.
- A wrong password produces `cannot-proceed.md` naming the role and the visible error text.
- With a token deleted from the stored session, the next command refreshes it automatically.
- Against HRMS, after Balu's OK: employee and admin log in, and the report shows `employee2` and other-tenant as "cannot verify" if missing.

**Needs Balu:** the first staging run, and asking the devs for `employee2` plus a second-tenant login.

### M2 — Crawler with HAR capture (week 3)

**Goal:** a deterministic, safe BFS crawl of every role that records what the app shows and calls.

**Build:**
- **Context:** `src/crawler/bfs.ts` opens one browser context per role, with that role's `storageState` and `recordHar: { path, mode: 'full', content: 'embed' }`. Every request also passes through the target guard, the rate limiter and the **ownership guard** (§2.3 #9), all via one `context.route` handler.
- **Minimal Data Steward (moved forward from M7; M4–M6 depend on it):** `src/data/steward.ts` v0 provides:
  - `recordCreated({ entity, id, operation, teardownOp? })`, which appends `data.created`;
  - `teardown(runId)`, which walks `data.created` in reverse and calls each known `teardownOp` through the API with the creating role's `AuthMaterial`;
  - `orphans(runId)`.

  The crawler calls `recordCreated` after every successful form submission. It parses the ID from the response body (`id`, `<entity>_id`, or the last path segment of a `Location` header). M7 adds the en_IN factories, `create()` helpers for tests, interrupted-run recovery and the orphan policy.
- **State key:** `src/crawler/state-key.ts` computes `sha1(normalizedRoute + '|' + structuralSignature)`.
  - `normalizedRoute`: the pathname with numeric, UUID and ULID segments replaced by `{id}`, and query keys sorted with their values dropped.
  - `structuralSignature`: taken from `page.locator('body').ariaSnapshot()`. Keep only role and name for headings, buttons, links, tabs, textboxes, comboboxes, checkboxes and dialogs. Replace every digit with `#`. Collapse a repeated sibling structure, such as table rows or list items, into one entry with a count bucket (`1`, `2-10`, `>10`). Drop any text over 40 characters.

  Unit-test it: two pages with different rows but the same structure must give the same key.
- **Candidates:** `src/crawler/candidates.ts` enumerates clickable candidates: `getByRole` for link, button, tab and menuitem, plus `[data-testid]` elements that are visible and enabled. Each candidate gets a **locator descriptor** following the §2.2 ladder (`{ strategy: 'testid'|'role'|'label'|'placeholder'|'css-id', value, name? }`). A descriptor is kept only if it resolves to exactly one element.
- **Safety:** `src/crawler/safety.ts` matches deny, approval and owned-record rules (§2.3) against the accessible name, the testid and the surrounding dialog title. It has unit tests.
- **Form fill:** `src/crawler/form-fill.ts` detects forms and fills them. It uses `fakerEN_IN` by default and chooses each value by field label and type. Only free-text fields get the `PRM-<runId>-` prefix (§2.3 #5). The LLM path is the small model: given the form's labels, placeholders and validation messages seen so far, it proposes plausible values. A form is submitted only when `crawl.submitForms` is set, the tenant is primary, and the submit button does not match a deny or approval pattern. Each submission is recorded through `steward.recordCreated`.
- **Frontier:** BFS ordered by a heuristic score: unvisited route first, then navigation landmarks, then forms, then the rest. With an LLM available and more than 15 candidates queued, the small model reranks the top 30 by "likely to reveal new features". It may only reorder, never add.
- **Capture:** each new state writes `workspace/<app>/crawl/<role>/states/<key>/` containing `aria.yml`, `screenshot.png`, `url.txt`, `candidates.json` (descriptors), `forms.json` (labels, types, validation messages seen) and `console.json`.
- **Limits:** stop at `maxStatesPerRole`, `maxDepth` or `maxMinutesPerRole`. Write `crawl-summary.json`: states, transitions (`fromKey → candidate → toKey`), skipped-by-safety counts, and errors.

**Acceptance:**
- **Demo app:** at least 90% of the routes defined in the demo app are discovered for each role. The crawl takes under 5 minutes per role.
- No mutating request ever reaches a non-owned leave. Prove it from a server-side request log in the demo app, compared with the ledger. The owned-record cancel *is* exercised, and the ledger shows it.
- After the crawl, `steward.teardown(runId)` runs and the demo's server state matches the seed, except for terminal-state records (see M7).
- Every punch in/out is skipped, and listed as needing approval.
- Two crawls of an unchanged demo app produce the same set of state keys (determinism test).
- **HRMS (after Balu's OK):** the crawl summary is committed to PROGRESS.md (state counts per role). There are zero `safety.blocked` events for actions outside the patterns. Spot-check five screenshots.

### M3 — Living Spec inference: observed OpenAPI, entities, state machines (week 4)

**Goal:** turn the captured traffic and UI into a reviewable model of the API and its entities.

**Build:**
- `src/spec/har-to-openapi.ts` is deterministic.
  - **Filter:** keep only same-origin API calls (`apiBaseUrl`, or paths under `/api`). Drop static assets.
  - **Group:** by method plus normalized path, using the same normalizer as the state key, plus a slug heuristic. A segment is `{param}` when at least 3 distinct values appear in that position for otherwise equal paths.
  - **Infer JSON Schema** from the samples. Merge types into unions. A field is `required` when it is present in every sample. Formats are detected for date, date-time, email and uuid.
  - **Record per operation:** status codes per role, query params, and the request body schema.
  - **Emit** OpenAPI 3.1 at `spec/openapi.observed.yaml` with `x-pramaan` extensions: `rolesSeen`, `sampleCount` and `evidenceRefs`.
- `src/spec/entities.ts` groups operations into entities by their shared path root and body field overlap. The mid LLM may name an entity; it never invents operations. Offline, the fallback name is the path root in singular form.
- `src/spec/state-machines.ts`:
  - finds status-like fields: an enum-ish string, at most 8 distinct values, with a name matching `status|state|stage`;
  - derives transitions from observed sequences (value before → operation → value after) and from button names per status seen in the UI;
  - emits `entities.yaml` with each `stateMachine: { field, states, transitions: [{ from, op, to, observed: boolean }] }`. Transitions that were inferred but not observed are marked `observed: false`.
- `src/spec/lifecycle-probe.ts` is deterministic and multi-role. A per-role BFS never moves one record through several roles, so this probe does. It runs only on records Pramaan created in this run.
  1. For each entity with a state machine, it creates a record as the role that the crawl saw creating it.
  2. It then tries each candidate transition with the role whose UI showed that button or operation, for example the manager or admin "approve" seen in the crawl.
  3. It reads the record back after each step.

  Successful transitions become `observed: true`, with replay evidence. The ownership guard still applies, and the probe's records are torn down afterwards.
- `src/spec/score-vs-docs.ts` (HRMS only, scoring only):
  - fetches the Swagger JSON from `apiDocsUrl` (Flasgger usually serves `/apispec_1.json`; detect it from the UI page);
  - reports route recall and precision of `openapi.observed.yaml` against the docs, into PROGRESS.md;
  - **never** feeds the docs into inference.

**Acceptance:**
- Demo app: every leave and employee operation exercised by the crawl appears with the correct template (`/api/leaves/{id}`), and, after the lifecycle probe, the leave state machine has `submitted → approved` and `approved → cancelled` as `observed: true`.
- Unit tests cover path normalization, slug detection, schema merge with conflicting types, and required-field inference.
- HRMS: route precision is at least 90% against `/apidocs`, and recall is reported (recall is limited by crawl reach, which is fine to be honest about).

### M4 — Authorization differential matrix (week 4)

**Goal:** find authorization and tenant-isolation bugs from credentials alone, and turn the confirmed matrix into a permanent regression.

**Build:**
- `src/authz/replay.ts`: for every operation in `openapi.observed.yaml` except login and logout:
  - **Baseline:** the response the owner role got during the crawl. The owner is the role that first produced a 2xx. If there is no 2xx, the operation is `unknown`.
  - **Actors:** every other role, `anonymous` (no auth headers), and `other-tenant:<role>` when available.
  - **GET:** replay with each actor's `AuthMaterial`, through `request.newContext`.
  - **POST/PUT/PATCH/DELETE:** replay only against records the Data Steward created in this run (owned by another actor), and only bodies built from the recorded schema. Never mutate pre-existing data. If no owned record exists, mark the cell `skipped` with the reason.
  - **Same-role IDOR:** when `employee2` exists, swap path IDs between `employee` and `employee2` records.
- `src/authz/compare.ts` classifies each replay:
  - `denied`: 401, 403, or 404 with a body unlike the baseline;
  - `error`: 5xx;
  - `same-data`: 2xx with structural JSON similarity of at least 0.9 to the baseline. Similarity is the Jaccard index over the set of `path=valueHash` pairs, ignoring timestamps and the run tag;
  - `different-data`: any other 2xx. This is a filtered list and is normal for list endpoints.

  Unit-test it with crafted response pairs.
- `src/authz/propose.ts` proposes the `expected` side:
  - Heuristics first:
    - a path containing `admin|employees|settings|tenant|payroll` → deny for the employee role;
    - `/{id}` reads of personal entities → own-only;
    - anonymous → deny everywhere except public auth endpoints;
    - other-tenant → deny everywhere.
  - Then the mid LLM, given operation names and roles, may adjust and add a one-line reason. Each row stays `status: proposed`.
- **Violations.** A cell where the observed outcome contradicts a **confirmed** expectation becomes a Finding with `oracle: 'authz-matrix'`. Until the row is confirmed, the contradiction is a queued question for the lead ("employee got same-data on GET /api/employees — expected?").

**Acceptance:**
- Demo app with `DEMO_BUGS=idor-leave-read,employee-admin-endpoint,cross-tenant-list`, after the matrix rows are confirmed through a scripted review: all three bugs are found. With `DEMO_BUGS=none`: zero authz findings.
- The replay never sends a mutating request against a record not in the teardown ledger. Assert this from the ledger in the e2e test.
- HRMS: the matrix proposal is generated and the lead review happens in M5. Report the count of rows and of `skipped` cells.

### M5 — Rule proposer, seed rules, review queue v0 (week 5)

**Goal:** proposed business rules that carry evidence, and a fast way for the lead to confirm or reject them.

**Build:**
- **Domain pack.** `domain-packs/in-hrms/rules.yaml` holds rule templates with placeholders, matched to entities by name or field hints. At least these:
  - an employee cannot approve their own request;
  - an employee cannot read another employee's leave, attendance or payslip;
  - approval deducts the requested days from the balance;
  - cancelling an approved request refunds it;
  - half day = 0.5;
  - an end date before the start date is rejected;
  - days > 0;
  - dates are evaluated in Asia/Kolkata;
  - currency renders as ₹ with Indian grouping;
  - dates render as DD/MM/YYYY;
  - a status only moves along the state machine;
  - balance shown in the UI equals the balance in the API.
- **Seed rules.** `apps/hrms/seed-rules.yaml` holds Balu's 7 rules from §1 as `source: lead, status: confirmed`, with decision `by: lead:balu`. The five ambiguities are `status: proposed` with `openQuestion` set.
- **LLM proposals.** `src/spec/rule-proposer.ts` uses the frontier model. Its input is a compact, redacted digest:
  - operations with schemas;
  - entities and state machines;
  - the UI texts per state: headings, labels, validation messages, empty states;
  - the domain-pack templates that matched;
  - every item carrying an `E-xxxxxxxx` evidence ID.

  Its output is `Rule[]` with `status: proposed`. Validate it: drop any rule that cites an unknown evidence ID, de-duplicate against existing rules (normalized title similarity of at least 0.85), and cap at 40 new proposals per run. Rejected items are logged as `llm.rejected-output` with the reason. **Offline fallback:** domain-pack matches only.
- **DSL runtime.** Build `src/dsl/` exactly per §4.6, test-first: the JSONPath subset, the expression parser, the `${}` resolver with its type rule, and the assertion runner. Use the §10.1 invalid and corrected A-012 fixtures plus at least 40 unit cases. The dry-runs below and the charters in M10 depend on it.
- **Assertion proposals.** `src/spec/assertion-proposer.ts`, for each rule that is confirmed (or seed-confirmed) and has no assertion, uses the frontier model to propose a DSL `Assertion` (§4.5) that uses only operations present in `openapi.observed.yaml`. Validate it with zod and by a static check that every referenced op, step ID and capture exists. Then **dry-run it on the demo app or staging in the primary tenant**. An assertion that cannot run (as opposed to failing a check) is discarded with its reason.
- **Review queue.** `src/lead/queue.ts` builds `ReviewItem { kind: 'rule'|'matrix-row'|'assertion'|'finding'|'question', id, risk, uncertainty, estMinutes, summary, evidence[] }`.
  - **Rank** by `risk × uncertainty`. Risk is criticality × (1 + recent change) × (1 + oracle weakness). Uncertainty is `1 - confidence`, or 1 for questions.
  - **Estimated minutes:** rule 0.5, matrix row 0.25, assertion 1.5, finding 2, question 2.
  - **Cap** the queue at the remaining weekly minutes budget. Overflow waits for next week, and the digest says so.
- **Interactive review.** `pramaan review --interactive` (`@inquirer/prompts`) shows one item at a time: the one-line summary, the evidence excerpts with screenshot paths, and the proposed assertion rendered as plain English. The choices are confirm, reject, edit (opens `$EDITOR` on the YAML/JSON), skip and quit. It writes the decision with `by: lead:<name>` and appends `lead.session` with the wall-clock minutes **measured** from start to quit. There is also a non-interactive mode: `pramaan review --export` writes `review/REVIEW-<date>.md` with checkboxes, and `pramaan review --import` reads the ticked file back.

**Acceptance:**
- Demo app in replay mode: at least 10 sensible proposed rules, each with valid evidence. Zero rules cite unknown evidence: show the count of rejections.
- At least 6 assertions dry-run successfully on `DEMO_BUGS=none`.
- The review CLI decides 20 items in a scripted test, and the ledger records `lead.session` minutes.
- HRMS: Balu runs his first real review session. Record his minutes and his confirm/reject counts in PROGRESS.md. **This is the first real measurement of lead workload.**

### M6 — Compiler: the suite repo (week 6)

**Goal:** plain, portable Playwright code that follows Balu's conventions and runs with zero LLM calls.

**Build:**
- **Repo.** `src/codegen/writer.ts` creates or updates `output.repoPath`:
  - with `git init` if it is new;
  - on branch `pramaan/compile-<runId>`;
  - using an idempotent write: files are regenerated only when their inputs changed, each generated file carries a header `// generated by pramaan <version> from <inputs hash> — edit via spec/ or regenerate`, and hand-edited files without that header are never overwritten.
- **Page objects.** `src/codegen/pom.ts` emits one page class per stable route template, with locators from crawl descriptors following the §2.2 ladder only. Method names are verbs from accessible names (`clickApplyLeave()`, `fillReason(text: string)`).
- **Flows.** `src/codegen/flows.ts` emits `flows/` for the journeys the assertions reference: login per role, apply leave, approve leave and the like. It also writes a `flows/registry.ts` that maps flow IDs to functions, so UI steps in the DSL resolve.
- **Fixtures.** `src/codegen/fixtures.ts` emits:
  - `auth.fixture.ts`: per-role `storageState` produced by a global setup that logs in, using credentials from env;
  - `api.fixture.ts`: per-role `APIRequestContext` built with the derived auth header and tenant-header names;
  - `implicit-oracle.fixture.ts`: listens for `console` errors, `pageerror`, responses with status ≥ 500 and `requestfailed` (ignoring `net::ERR_ABORTED` and the configured ignore patterns), then fails the test at teardown with the list, and attaches it to Allure;
  - `data.fixture.ts`: the Data Steward client. Use steward v0 from M2 now: `steward.create(entity, { actor, body })` calls the observed create operation, records it and registers teardown. M7 adds the factories and orphan policy;
  - `consistency.fixture.ts` + `helpers/consistency.ts`: `expectUiMatchesApi(page, locator, apiValue, normalizer, message)`. For every entity field that is both shown in a crawled UI state and returned by a GET (matched by label ↔ field name, plus value equality during the crawl), codegen emits one `@regression` consistency test per role. It does the UI action, reloads the view **without** a hard wait, then compares the UI text with the API value. This produces the `consistency` oracle class (demo bug `stale-ui-balance`).
- **Specs.** `src/codegen/specs.ts` emits:
  - `specs/ui/smoke.spec.ts` (`@smoke`): each role logs in and its landing page shows its top-level navigation;
  - `specs/api/<entity>.spec.ts` (`@api`): one test per confirmed assertion that has only API steps;
  - `specs/workflow/<entity>.spec.ts` (`@workflow`): multi-role assertions using two or more `browser.newContext()` sessions;
  - `specs/authz/authz-matrix.spec.ts` (`@authz`): data-driven over confirmed matrix rows, where each cell becomes one test;
  - `spec/test-index.json`: test ID → operations, rule IDs and assertion IDs.
- **DSL to code.** Each check becomes an `expect` carrying its `message`. Each step becomes a `request.<method>` call or a flow call. The `// Arrange` / `// Act` / `// Assert` comments come from the DSL sections. Test names come from the rule title, converted to `should_<action>_when_<condition>` by a deterministic converter. The LLM may suggest a better name at compile time, and that name is cached.
- **Quality gates.** The suite repo's `eslint.config.js` includes custom rules, written as a local plugin:
  - no `waitForTimeout`;
  - no locator strings that start with `xpath=` or `//`, or that contain a `.class` selector;
  - every `expect(` has a second argument;
  - test titles match `^should_[a-z0-9_]+_when_[a-z0-9_]+$`. Titles therefore never contain tags: tags go in Playwright's details object, `test('should_…', { tag: ['@api', '@regression'] }, async (…) => …)` (Playwright ≥ 1.42). `--grep @api` still matches tags. Title parts derived from data replace every non `[a-z0-9]` character with `_`.

  `pramaan compile` runs the suite's `tsc --noEmit` and ESLint and **fails the compile** if either fails.
- **Config.** `playwright.config.ts` in the suite: `projects` with Chromium only in the MVP (v1 adds more), the reporters `['json', { outputFile: 'results.json' }]`, `['allure-playwright']` and `['list']`, `retries: 0` (flakiness is triaged, not retried away), and `trace: 'retain-on-failure'`.
- **Dependencies.** The suite's `package.json` pins exact versions (`@playwright/test`, `allure-playwright`, `zod`, `typescript`, `eslint`, `typescript-eslint`, `@faker-js/faker`, `dotenv`). On first creation, and whenever dependencies change, `pramaan compile` runs `npm install` in the suite to produce `package-lock.json` and commits it, so `npm ci` works everywhere. The suite must **not** depend on `@anthropic-ai/sdk` or on Pramaan.
- **Docs and CI.** `PRAMAAN.md` describes the coverage table and how to run the suite. `.github/workflows/qa.yml` runs smoke on push and regression on a nightly cron, and uploads `results.json` as an artifact for `pramaan triage` to import.
- **Run.** `pramaan run` executes `npx playwright test --grep @<suite>` inside the suite repo, with `PRAMAAN_RUN_ID` set, and copies `results.json` into the workspace.

**Acceptance:**
- Demo app: `pramaan compile` followed by `cd suite && npm ci && npx playwright test` passes on `DEMO_BUGS=none`. Prove the suite is LLM-free three ways:
  1. The suite's `package.json` and `package-lock.json` contain no `@anthropic-ai/sdk`.
  2. `grep -ri anthropic` over the suite's code returns nothing.
  3. `pramaan compile` run in `replay` mode logs only `llm.call` events with `cached: true`.
- With `DEMO_BUGS=stale-ui-balance`, a consistency test fails; on `none` it passes.
- The lint fails on a deliberately bad generated file in a unit test, for each custom rule.
- Regenerating twice without input changes produces zero diff.
- The authz matrix spec fails on the three authz demo bugs and passes on `none`.
- HRMS: the first compiled suite opens as a PR (or a branch with a diff summary). Balu reviews it, and his minutes are recorded.

### M7 — Data Steward hardening: factories, recovery, orphan policy (week 7)

**Goal:** every record Pramaan creates is tagged, tracked and cleaned up, so no orphaned test data stays behind on shared staging. Steward v0 already exists from M2. This milestone completes it.

**Build:**
- `src/data/steward.ts` v1:
  - `create(entity, overrides)` uses the observed create operation and the factory, then records `data.created` with the ID and its `teardownOp`;
  - `teardown(runId)` walks the ledger in reverse creation order and calls each `teardownOp`. Valid teardown ops are DELETE, or a cancel or reject transition from the state machine. If no teardown op is known, the record is logged as `data.orphaned` with an explanation;
  - `orphans()` lists tagged records still **live**, by searching list endpoints for the `PRM-` tag. A record whose state equals the terminal state its teardown op produces is **retired**, not orphaned. For example, a cancelled leave is retired when no DELETE exists. Retired counts are reported separately.
- `src/data/factories/en_IN.ts` provides typed builders per entity, generated from schemas: Indian names, `+91` mobile numbers, PAN and Aadhaar **format-valid but checksum-invalid fakes** (never real), and dates relative to today in Asia/Kolkata.
- The suite-repo `data.fixture.ts` exposes `steward` to tests. Its global teardown calls `teardown(runId)` and **fails the run** if any orphans remain. Records that are `data.orphaned` with a known reason (no delete operation exists) are listed but do not fail the run. They go to `NEEDS-BALU.md` as an ask to the devs for a cleanup endpoint.

**Acceptance:**
- Demo app: after a full compile, run and teardown, `orphans()` returns 0.
- Kill the run halfway (SIGINT): the next `pramaan teardown --run <id>` cleans up.
- HRMS: report the counts of orphans and of irreversible operations. Balu decides the policy for each irreversible operation.

### M8 — Benchmark and mutation self-check (week 7–8)

**Goal:** Pramaan measures its own effectiveness with numbers a buyer can trust.

**Build:**
- **Bench.** `src/bench/run.ts` takes `pramaan bench --app demo --bugs all`. For each bug:
  1. Restart the demo with that bug's activation env.
  2. Run `pramaan run --suite regression` and the authz suite.
  3. Collect the failures.
  4. Map each failure to the bug. A **hit** is a failing test whose oracle class in `test-index.json` equals the bug's `expectedOracle`, **and** whose covered operations intersect the bug's `operations`. The bug counts as detected if it has at least one hit. A failure that is not a hit for the active bug is a **false alarm**.
  5. Run once with `DEMO_BUGS=none` and count every failure as a **false alarm**.

  Output `bench/report-<runId>.md` and `.json` with:
  - recall overall and per category;
  - precision of the failures, true failures ÷ all failures across runs;
  - per-oracle precision;
  - time and cost.

  It appends `bench.result` to the ledger.
- **HRMS bench mode.** `benchmark/hrms/bugs.yaml` has the same schema plus `activation: { manual: '<instructions>' }`. The runner pauses with a prompt such as "deploy bug B07 to staging, press Enter", or reads an env flag if the devs add one. Balu and the devs seed **30 bugs**: 8 calculation, 8 authz/tenant, 7 validation and 7 UI/workflow. Track progress in `NEEDS-BALU.md`.
- **Fault catalog.** `src/mutation/faults.ts` defines faults applied by response interception. When `PRAMAAN_FAULT=<id>:<operation>` is set, the suite applies the fault in **two places**:
- a `context.route` handler, for browser traffic;
- a wrapper in `api.fixture.ts` around every `APIResponse`, overriding `status()`, `json()`, `text()` and `body()` for matching operations. This is required because `page.route` and `context.route` do **not** intercept `APIRequestContext` traffic, so `@api` and `@authz` tests would otherwise never see faults.

The faults:
  - `drop-field`
  - `null-field`
  - `number-plus-one`
  - `number-times-ten`
  - `flip-boolean`
  - `empty-list`
  - `truncate-list`
  - `swap-tenant-id`: replaces the tenant/owner IDs in the body with another known ID
  - `status-500`
  - `status-403-to-200`: replays the owner's body for a denied call
  - `stale-copy`: returns the response captured before the last mutation

  `delay-2s` is a robustness probe: tests should survive it, and a failure here is reported as fragility, not a kill.
- **Mutant runner.** `src/mutation/runner.ts`: for each test in `test-index.json` and each applicable fault on its operations, run the test once under the fault.
  - **Killed:** the test fails.
  - **Survived:** the test passes.

  Kill rate = killed ÷ (killed + survived). It excludes equivalent mutants, for example `drop-field` on a field the test never reads, which is detected from the test's referenced JSONPaths. Tests that kill no mutants are flagged **weak** in the review queue.

**Acceptance:**
- Demo bench (MVP categories, excluding `csv-export-mismatch`): recall is reported, and precision on `DEMO_BUGS=none` is 100% (zero false alarms). Recall at this stage must be **at least 60%**. Charter agents in M10 raise it further.
- Mutation kill rate is reported on the demo, at **least 70%**.
- The HRMS bench harness works in manual activation mode with at least one real seeded bug.

### M9 — Triage, locator-only heal, expect-count lint, decision ledger (week 9)

**Goal:** failures sort themselves into bug, flaky, drift and environment, and healing can never hide a regression.

**Build:**
- **Results parser.** `src/triage/parse.ts` reads Playwright `results.json` and produces failures with test ID, error message, stack, step titles and attachment paths (trace, screenshot).
- **Signature.** `src/triage/signature.ts` computes `sha1(testId + errorClass + normalizedMessage + topUserFrame + failingStepTitle)`. Normalization replaces numbers, IDs, ISO dates, the run tag and quoted dynamic values with placeholders. Unit-test it.
- **Classifier.** `src/triage/classify.ts`, deterministic first:
  1. A known signature in the quarantine list → `flaky-known`.
  2. Rerun the failing test 3 times in isolation (`--repeat-each=3 --workers=1`). **The original failure counts as one failure**, so original failure plus at least 1 rerun pass → `flaky`. Quarantine it by adding the test ID to `quarantine.json`, and never with `test.fixme` or `test.skip`. The suite config greps quarantined tests out of the gating run, and a separate quarantine job still runs them. Ledger `test.quarantined`.
  3. A locator error (`strict mode violation`, `locator resolved to 0 elements`, or a timeout waiting for a locator) on all reruns → `locator-drift`.
  4. Login failures, DNS errors, 502/503/504, or more than 50% of tests failing at once → `environment`. Alert; never file bugs.
  5. A 404 or 405 on an operation that exists in `openapi.observed.yaml`, or a zod parse failure in the suite's `helpers/schemas.ts` (the response shape changed) → `spec-change`, which goes to the review queue. The HAR-based drift diff comes later, in M16.
  6. Otherwise, an assertion failing consistently → `product-bug-candidate`. Build a Finding with the oracle class taken from the test index.
- **Mid LLM.** It writes only a 3-line human summary of the evidence for each finding. It cannot change the class.
- **Auto-filing.** A `product-bug-candidate` auto-files when its oracle class precision meets the gate (§4.7) and `shadowMode` is off. Otherwise it is queued. `src/triage/defect-writer.ts` writes `defects/F-xxxx.md`: repro steps, the expected value from the assertion message, the actual value, the trace path, the oracle and its precision. Sinks: markdown is the default; `github` opens an issue via `gh issue create` when configured; Jira is optional in v1.
- **Heal.** `src/maintain/heal.ts` handles `locator-drift`. It re-crawls only the route of the failing page object for the drifted element. It looks for a unique element with the same role and accessible name (or a same-testid prefix, or the same label), following the §2.2 ladder. When exactly one candidate exists, it patches **only that locator expression** in the page object with ts-morph, reruns the test, and if it passes opens a heal PR, writing the ledger event `heal.applied`. If there are zero or several candidates, it writes `heal.rejected` and queues the item for the lead.
- **Heal lint.** `scripts/lint-expect-count.ts` in the suite repo, also run by `pramaan`, compares the base branch to the head with the TypeScript AST and fails when any of these happen:
  - the count of `expect(` calls per test drops;
  - `test.skip`, `test.fixme` or `.only` are added;
  - `waitForTimeout` is added;
  - an assertion's matcher is weakened, for example from `toBe` or `toEqual` to `toBeTruthy` or `toBeDefined`;
  - a file in `specs/` changes in a heal PR.

  Heal PRs may touch only `pages/`.

**Acceptance:**
- Demo e2e: change the demo's `data-testid` for "Apply leave" through `DEMO_DRIFT=apply-testid`. Triage classifies the failure as `locator-drift`, the heal patches only the POM, the test passes, and the lint passes.
- A crafted heal that weakens an assertion is blocked by the lint (unit test).
- With `DEMO_FLAKY=0.3` and `DEMO_SEED=42`, the tests that read `/api/leave-balance` are classified `flaky` and quarantined, never filed. Pick the seed so the scenario is reproducible, and assert the exact classification.
- With `DEMO_BUGS=balance-off-by-one`: a finding with oracle `confirmed-rule` and correct evidence. Auto-filing respects the precision gate. In a fresh ledger it is queued, not auto-filed.

### M10 — Charter agents, lead console, digest, closure report, MVP gate (week 10)

**Goal:** ongoing discovery, so the product never goes quiet, plus the lead's weekly experience, and the MVP gate.

**Build:**
- **Workflow Breaker.** `src/charters/workflow-breaker.ts` enumerates deterministically from each state machine:
  - every transition from every state, including illegal ones;
  - double transitions (approve twice);
  - transitions after terminal states (edit after approved);
  - transitions by the wrong actor (self-approval, an employee approving).

  For each case it builds a DSL assertion candidate. The expected outcome is the state machine's legality: an illegal transition should give 4xx and an unchanged state. The mid LLM only maps the case to concrete operations and bodies when the mapping is ambiguous. Each candidate is **replayed 3 times on fresh steward data**. Only consistent unexpected outcomes survive, and they become Rules with `source: charter`, `status: proposed`, plus the replay evidence. **Never a filed bug.**
- **Boundary Calculator.** `src/charters/boundary-calculator.ts`: for each numeric or date field in create and update operations, it generates boundaries from the schema and the domain pack:
  - numbers: `0`, `-1`, `0.5`, the max seen + 1, `Number.MAX_SAFE_INTEGER`;
  - dates: today; month end; `2028-02-29`; end before start; `23:30` and `00:30` Asia/Kolkata;
  - strings: the observed max length + 1, plus 201 characters as a probe.

  It replays each 3 times and compares the observed acceptance (2xx versus 4xx) with the domain-pack rule or validation messages seen in the UI. Divergences become proposed rules with evidence.
- **Weekly runs.** `pramaan charter` runs both charters under a budget (`perCommandUsd`) and a time cap (30 minutes).
- **Digest.** `src/lead/digest.ts` writes `digest/DIGEST-<ISO week>.md`:
  - the minutes used against the budget;
  - the queue, top items first;
  - auto-filed findings and their precision;
  - new candidates from the charters;
  - heals applied;
  - quarantine debt;
  - orphans;
  - cost this week;
  - "deferred to next week" overflow.
- **Shadow mode.** When `lead.shadowMode` is true, or no `lead.session` has happened for 10 days, everything except auto-fileable findings is held, and the digest says so.
- **Closure report.** `src/report/closure.ts` writes `report/CLOSURE-<runId>.md`, plus a single-file HTML version with inline CSS and no external assets. It contains:
  - **coverage:**
    - operations exercised ÷ observed;
    - status codes covered;
    - role × operation cells with confirmed expectations;
    - confirmed rules with passing assertions;
    - state-machine transitions covered;
  - defects by severity and oracle;
  - the precision ledger table;
  - mutation kill rate;
  - bench results;
  - residual risk, meaning which rules and areas have only weak or no oracles;
  - a GO / NO-GO **evidence** section. The lead decides; Pramaan never decides.
- **Orchestrator.** `pramaan all` chains onboard → crawl → infer → authz, then stops with "run `pramaan review`".

**MVP gate (record each in PROGRESS.md, measured, with date).** The gate has two parts. **Part A** is the agent's alone and is closed in this session. **Part B** depends on staging, the devs and calendar time, and Balu owns it. The agent prepares the tooling and the report for Part B but cannot close it alone.

*Part A — demo sub-gate (agent closes):*

| Metric | Target | Where measured |
| --- | --- | --- |
| Seeded-bug recall, demo (14 MVP bugs) | ≥ 60% (aim ≥ 80% with charters) | `pramaan bench --app demo` |
| Seeded authz/tenant bugs caught, demo | 100% (3 of 3) | bench, category filter |
| False alarms on `DEMO_BUGS=none` | 0 | bench clean run |
| Mutation kill rate, demo | ≥ 70% | `pramaan mutate --app demo` |
| Flake rate, demo | < 2% over 50 runs | `npx playwright test --repeat-each=50` in the suite, imported by triage |
| Orphaned (live) records after teardown, demo | 0 | `orphans()` |
| Mutating requests to non-owned records | 0 | demo server request log vs. ledger |
| `npm run verify` on a clean clone, with no API key | green | CI |

*Part B — HRMS pilot gate (Balu owns; two different weeks):*

| Metric | Target | Where measured |
| --- | --- | --- |
| Seeded-bug recall, HRMS (up to 30 seeded bugs) | ≥ 60% | `pramaan bench --app hrms --target staging` |
| Seeded authz/tenant bugs caught, HRMS | 100% | bench, category filter |
| Precision of auto-filed findings | ≥ 90% | `finding.verdict` events |
| Lead minutes per week (from week 3) | ≤ 90 | `lead.session` events |
| Compile cost | ≤ $40 | `llm.call` events |
| LLM cost per regression run | ≤ $0.50 (target $0) | `llm.call` events during `run` |
| Flake rate on nightly CI | < 2% over 50 runs | imported CI `results.json` |
| Orphaned (live) records after teardown | 0 | `orphans()` |
| `safety.blocked` events that were wrong blocks or misses | 0 | Balu reviews the audit list |

**Do not start M11 until Part A passes, and Balu has either confirmed Part B or explicitly waived the rows still waiting on staging.** Record which rows were waived and why. If a row fails, open the smallest fix as a new sub-milestone `M10.x` and record why.

---
## 9. v1 milestones (M11–M17): second app, all test types, drift

v1 has three aims:
- prove that Pramaan generalizes beyond an app that has `data-testid` and whose builder knows its code;
- complete the test-type matrix;
- make sure the product keeps finding things after month one.

### M11 — Second app without `data-testid`

**Goal:** remove the dogfooding bias.

**Build:**
1. Pick an open-source HRMS that runs locally in Docker. Candidates are OrangeHRM 5.x and Frappe HR. First verify that the official image or compose file exists and starts; note the image and version in DECISIONS.md. **Ask Balu to confirm the choice** before investing in it.
2. Add `fixtures/second-app/docker-compose.yml` and `apps/second/app.yaml`, with its own seed users and a safety list.
3. Run the whole MVP pipeline on it. Fix whatever the generality gaps turn out to be. Typical ones:
   - the login form layout;
   - cookie sessions instead of bearer tokens;
   - server-rendered pages;
   - CSRF tokens. Correlate them by reading the hidden input or meta tag and replaying it.
4. Create `benchmark/second/bugs.yaml`. You cannot change its source easily, so use **response-level seeded bugs**: the M8 fault-injection mechanism, run as "bugs". Add at least 15, across the four categories.

**Acceptance:**
- Onboarding to the first compiled suite takes **≤ 1 working day** of Balu's time, measured in `lead.session` plus the setup minutes he logs.
- The locator ladder falls back to role, label and placeholder with zero XPath or class selectors (the lint proves it).
- Bench recall on the second app is reported.

### M12 — NFR compiler: accessibility, i18n, visual, cross-browser, responsive, web vitals

**Accessibility** (`src/nfr/a11y.ts`):
- Generate `specs/a11y/*.spec.ts` using `@axe-core/playwright` on every stable route per role, with WCAG 2.2 A/AA tags and one test per route. Known violations go to a reviewed baseline file, so only new violations fail.
- Add a **keyboard pass**:
  - Tab through the page and assert that focus is visible: the focused element has a non-zero outline or box-shadow difference from its unfocused computed style.
  - Assert that dialogs trap focus and close on Escape.
  - Assert that every interactive element is reachable.
- At compile time only, the frontier LLM reviews screenshots plus the aria snapshot per route against the judgement-based criteria: meaningful alt text, link purpose, label-in-name, and error identification. It emits proposed **checkable** assertions (e.g. "error text is associated with the field via aria-describedby"). These go to review, and only confirmed ones are compiled.

**Localization / i18n** (`src/nfr/i18n.ts`):
- Generate a `pseudo-locale` Playwright project. Its `addInitScript` walks text nodes and wraps them with accented expansion, +35% length (e.g. `[Àpplý lëàvé ~~~]`), and uses a MutationObserver for SPA updates.
- Assertions per route:
  - no element's `scrollWidth > clientWidth + 1` where `overflow` is hidden (truncation);
  - no overlapping bounding boxes among sibling interactive elements;
  - no text node missing the pseudo markers. Missing markers mean a hard-coded string drawn on canvas or in an image, and are reported as a finding candidate.
- **en_IN format checks:**
  - currency matches `₹\s?\d{1,2}(,\d{2})*(,\d{3})(\.\d{2})?` or plain `₹\d{1,3}` for small values;
  - dates match `DD/MM/YYYY` or the app's confirmed format rule;
  - times are IST.
- Hindi input probe: type Devanagari into free-text fields (`PRM-<run>-परीक्षण`), then read it back through the API. It must be byte-equal (consistency oracle).

**Visual** (`src/nfr/visual.ts`): `toHaveScreenshot` per route with masks. Detect masks automatically by capturing each route twice, 10 seconds apart and once after reload, then masking the regions that differ (clocks, avatars, charts with live data). Generate baselines only on Chromium Linux in CI, so OS font rendering does not cause flake.

**Cross-browser and responsive:** add `firefox` and `webkit` projects, plus `Pixel 7` and `iPhone 14` device projects. Smoke, workflow and visual run on all of them. API and authz run once, because they do not depend on the browser.

**Web vitals:** use `lighthouse` (Node API) against the top 10 routes by risk, on Chromium via a remote-debugging port. Check budgets: LCP ≤ 2.5 s, CLS ≤ 0.1, TBT ≤ 300 ms. TBT is the lab proxy for INP. Balu can edit the budgets in `app.yaml → nfr.budgets` (add this to the schema with a DECISIONS entry).

**Acceptance:**
- Demo app: the new projects run green on `DEMO_BUGS=none`.
- An injected demo a11y bug is caught by axe: `DEMO_BUGS=missing-label`.
- An injected truncation bug is caught by the pseudo-locale project: `DEMO_BUGS=fixed-width-button`. Add both bugs to the demo and the bench.
- HRMS: the a11y and i18n baselines are reviewed by Balu.

### M13 — Export consistency oracle

**Goal:** catch the bugs where the UI, the API and the exported file disagree. These are the best oracles an HRMS has.

**Build:**
- **Discover** download actions during the crawl: buttons whose accessible name matches `export|download|csv|excel|pdf|payslip|report`. Use them only on owned or seeded data scopes where possible.
- **Capture** files through Playwright's `download` event. Parse them with `papaparse` (CSV), `exceljs` (XLSX) and `pdfjs-dist` (PDF text by page). PDF tables are parsed heuristically by line and column alignment; flag low-confidence parses.
- **Join** rows to API records by the best key: an ID column, else the run tag plus date.
- **Compare** with normalizers (`inr`, `number`, `date-in`, `trim-lower`). Each mismatch becomes a finding with oracle `consistency`.
- **Compile** confirmed export checks into `specs/workflow/export-consistency.spec.ts`.

**Acceptance:** demo `csv-export-mismatch` is caught; `none` gives no false alarm. HRMS: report which export endpoints were found (payslip, attendance report), and run the checks on the attendance export.

### M14 — Hard logins: TOTP and email OTP

**Build:**
- **TOTP:** `login.strategy: 'totp'` uses `otplib` with the seed from `totpSeedEnv`. Generate the code just before submit. If fewer than 5 seconds remain in the current window, wait for the next window. Do not use a fixed sleep: compute the remaining seconds and use `page.clock` or a poll on the time source.
- **Email OTP and magic link:** `login.strategy: 'email-otp'` uses a Mailpit instance (`fixtures/mailpit/docker-compose.yml`) through its REST API. Poll the newest message to the user with a bounded timeout, then extract the code or link with configurable regexes.
- Add **demo app support**: `DEMO_MFA=totp|email` toggles MFA for `admin1`.
- **CAPTCHA:** never attempt to solve one. If a CAPTCHA is detected (an iframe from `recaptcha|hcaptcha|turnstile`, or a canvas plus "verify you are human"), stop with `cannot-proceed.md` asking for a staging bypass key.

**Acceptance:** both MFA modes log in on the demo; the CAPTCHA detection test stops cleanly.

### M15 — Persona charter agents

**Goal:** the bug-finding power of the persona swarm, without its false positives. Personas create candidates only, and every candidate must pass 3× deterministic replay before it reaches the queue.

**Personas:**
- **Accessibility persona:**
  - keyboard-only completion of each confirmed flow;
  - screen-reader name/role sanity from the aria snapshot;
  - zoom 200% (viewport scaling) with no loss of content or function.
- **Locale persona:** Hindi and Telugu names, Indian addresses, 10-digit mobiles with and without `+91`, long surnames, apostrophes and dots in names, ₹ amounts with lakh/crore grouping, DD/MM vs MM/DD ambiguity (`03/04/2027`).
- **Access-boundary persona:**
  - UI actions hidden from a role but reachable by direct URL (navigate to admin routes with an employee session);
  - parameter tampering **on owned records only**: change `employee_id` and `status` in bodies, change `tenant` fields;
  - re-submitting a stale form after a state change.

**Implementation:**
- `src/charters/personas/*.ts` share one runner.
- The mid LLM plans up to 20 probes per persona per week from the Living Spec, under a budget.
- The deterministic engine executes the probes, through the DSL where possible and through Playwright where needed.
- Survivors become `source: charter` proposed rules with evidence.
- Track the **charter confirmation rate** = confirmed ÷ (confirmed + rejected) over the lead's verdicts on charter candidates.

**Acceptance:** each persona produces at least 1 surviving candidate on a demo build with a related seeded bug, and 0 surviving candidates on `none`.

### M16 — Drift sentinel, change impact, progressive crystallization

**Drift** (`src/drift/sentinel.ts`):
- The suite repo records HAR in CI when `PRAMAAN_RECORD=1`. That is the nightly run.
- `pramaan drift` compares the new traffic with `openapi.observed.yaml` and reports:
  - new and removed operations;
  - status-code shifts;
  - response-schema changes (added, removed or type-changed fields);
  - new routes and states, via a light re-crawl of changed routes only.
- Output `drift/DRIFT-<runId>.md`:
  - new operations become new rule proposals plus a matrix row;
  - removed or changed ones are flagged against tests through `test-index.json`.

**Change impact:** `pramaan run --impacted` selects tests whose operations or routes changed since the last green run, plus all `@smoke` tests. Unit-test the selection on a crafted diff.

**Crystallization:**
1. Charter candidates that the lead confirmed start as `trial` tests: tag `@trial`, non-gating.
2. They are promoted to `@regression` after 10 consecutive runs at ≥ 90% consistent outcome, then hardened after 50 runs at ≥ 99%.
3. Any unexplained failure demotes them back to trial.
4. Promotions and demotions are written to the ledger. The digest lists them.

**Acceptance:**
- Demo: toggling `DEMO_API_V2=1` (adds a field, renames one route) produces a correct drift report and impacted-test selection.
- The crystallization state machine has unit tests.

### M17 — v1 hardening and gate

**Build:**
- **Cost:**
  - trim prompts;
  - add prompt caching (cache the long system and evidence prefix where the API supports it);
  - batch small-model calls;
  - report the cost per command in every summary.
- **Performance smoke:** `src/nfr/k6.ts` generates a k6 script from the HAR of confirmed flows.
  - Correlate dynamic values by diffing two recordings of the same flow: values that differ and come back in later requests become extracted variables.
  - The script runs **at ≤ 5 RPS** with `thresholds` for p95 latency and error rate.
  - It runs only when Balu adds `perf-smoke` to `approvedActions`.
  - It requires the `k6` binary; `doctor` checks for it.
- **Release report:** the closure report gains trend charts (inline SVG) for recall, precision, lead minutes and cost per run across weeks.
- **Docs:** the `PRAMAAN.md` template is polished for a client handover. Add `docs/RUNBOOK.md` on onboarding a new client app in one day, with the contract checklist: test tenant, second tenant, role logins, TOTP seed or mailbox, CAPTCHA bypass, WAF allowlist, signed rules of engagement, DPA.

**v1 gate (two consecutive weeks):**

| Metric | Target |
| --- | --- |
| Seeded-bug recall on HRMS and the second app | ≥ 75% each |
| Precision of auto-filed findings | ≥ 90% |
| New app onboarded to first compiled suite | ≤ 1 day |
| Lead minutes per week per app | ≤ 60 |
| Full run cost (regression + NFR, excluding weekly charters) | ≤ $5 |
| Charter candidate confirmation rate | ≥ 60% |
| Mutation kill rate | ≥ 70% |
| Test-type coverage | All of: smoke, sanity, functional, regression, E2E multi-role, API, integration, data integrity, authz, exploratory (charters), a11y, i18n, visual, cross-browser, responsive, web vitals, perf smoke |

After the v1 gate, write `docs/V1-RELEASE.md`: measured numbers, known limits, and what v2 needs (passive ZAP, signed active scans, full load testing, usability heuristics, DPDP pack, opt-in pattern library, multi-client onboarding).

---

## 10. Reference examples (copy these shapes)

### 10.1 A confirmed rule and its assertion

```yaml
# spec/rules.yaml (excerpt)
schemaVersion: 1
rules:
  - id: R-012
    title: Approving a submitted leave deducts exactly the requested days from the employee's balance
    kind: calculation
    status: confirmed
    confidence: 0.86
    source: domain-pack
    entities: [leave, leave-balance]
    operations: ["POST /api/leaves", "POST /api/leaves/{id}/approve", "GET /api/leave-balance"]
    evidence:
      - { id: E-3fa1c2d9, kind: response, ref: "GET /api/leave-balance", excerpt: '{"available": 12, "used": 3}' }
      - { id: E-91b0e4aa, kind: ui-text, ref: crawl/employee/states/7c1e.../aria.yml, excerpt: 'heading "Leave balance: 12 days"' }
    criticality: 5
    assertionIds: [A-012]
    decision: { by: "lead:balu", at: "2026-11-03T10:12:00+05:30" }
    version: 1
```

```json
{
  "id": "A-012",
  "ruleId": "R-012",
  "title": "approval deducts requested days",
  "data": { "days": 2 },
  "arrange": [
    { "kind": "api", "id": "balBefore", "actor": "employee", "op": { "method": "GET", "path": "/api/leave-balance" }, "capture": { "available": "$.available" } },
    { "kind": "api", "id": "apply", "actor": "employee", "op": { "method": "POST", "path": "/api/leaves" },
      "body": { "from": "${today+7}", "to": "${today+8}", "days": "${data.days}", "reason": "${run.tag} R-012" },
      "capture": { "leaveId": "$.id" } }
  ],
  "act": [
    { "kind": "api", "id": "approve", "actor": "admin", "op": { "method": "POST", "path": "/api/leaves/{id}/approve" }, "pathParams": { "id": "${cap.leaveId}" } }
  ],
  "assert": [
    { "kind": "status", "step": "approve", "oneOf": [200], "message": "admin should be able to approve a submitted leave" },
    { "kind": "api", "id": "balAfter", "actor": "employee", "op": { "method": "GET", "path": "/api/leave-balance" } }
  ],
  "cleanup": [
    { "kind": "api", "id": "cancel", "actor": "employee", "op": { "method": "POST", "path": "/api/leaves/{id}/cancel" }, "pathParams": { "id": "${cap.leaveId}" } }
  ],
  "status": "confirmed",
  "decision": { "by": "lead:balu", "at": "2026-11-03T10:14:00+05:30" }
}
```

> ⚠ The example above is **deliberately invalid**: `assert` contains a step. Your validator must reject it with a clear message ("assert[1]: expected a Check, got a Step — move balAfter to act"). The correct version moves `balAfter` to the end of `act` and adds `{ "kind": "delta", "before": "balBefore", "after": "balAfter", "path": "$.available", "expected": "-${data.days}", "message": "available balance should drop by the approved days" }` to `assert`. Use both versions as unit-test fixtures.

### 10.2 What codegen must emit for A-012 (corrected version)

```ts
// generated by pramaan 0.1.0 from 4be1c09a — edit via spec/ or regenerate
import { test, expect } from '../../fixtures';

test.describe('leave balance', () => {
  test('should_deduct_requested_days_from_balance_when_admin_approves_submitted_leave', { tag: ['@api', '@regression'] }, async ({ api, steward, runTag }) => {
    // Arrange
    const days = 2;
    const balBefore = await api.employee.get('/api/leave-balance');
    expect(balBefore.status(), 'employee should be able to read own leave balance').toBe(200);
    const availableBefore = (await balBefore.json() as { available: number }).available;
    const leave = await steward.create('leave', {
      actor: 'employee',
      body: { from: steward.dates.todayPlus(7), to: steward.dates.todayPlus(8), days, reason: `${runTag} R-012` },
    });

    // Act
    const approve = await api.admin.post(`/api/leaves/${leave.id}/approve`);
    const balAfter = await api.employee.get('/api/leave-balance');

    // Assert
    expect(approve.status(), 'admin should be able to approve a submitted leave').toBe(200);
    const availableAfter = (await balAfter.json() as { available: number }).available;
    expect(availableAfter - availableBefore, 'available balance should drop by the approved days').toBe(-days);
  });
});
```

Notes: the `steward` registers the cancel teardown automatically, so the DSL `cleanup` maps to the steward and not to inline code. Parse responses with zod schemas generated from `openapi.observed.yaml` (`helpers/schemas.ts`) instead of `as` casts when the schema is known. The cast above is acceptable only for the fallback path.

### 10.3 Authz matrix test shape

```ts
// generated by pramaan — data-driven from spec/role-matrix.yaml (confirmed rows only)
import { test, expect } from '../../fixtures';
import { matrix } from './authz-matrix.data';

// Only confirmed rows; cells with expectation 'unknown' are never emitted.
// What each expectation requires, when another actor calls an operation on the OWNER's record:
//   deny → 'denied' · own-only → 'denied' (it is someone else's record) · filtered → 'different-data' · allow → 'same-data'
const required = { deny: 'denied', 'own-only': 'denied', filtered: 'different-data', allow: 'same-data' } as const;
const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

for (const row of matrix) {
  for (const cell of row.cells) {
    test(`should_return_${slug(required[cell.expect])}_for_${slug(cell.actor)}_when_calling_${row.slug}`, { tag: ['@authz', '@regression'] }, async ({ api, steward }) => {
      // Arrange
      const target = await steward.targetFor(row, cell.actor);   // owned record of another actor, if needed
      // Act
      const res = await api.as(cell.actor).fetch(row.method, target.path, target.init);
      // Assert
      const outcome = await api.classify(res, target.baseline);  // denied | same-data | different-data | error
      expect(outcome, `${cell.actor} calling ${row.method} ${row.path} on ${row.ownerRole}'s record should be ${required[cell.expect]} (matrix: ${cell.expect})`)
        .toBe(required[cell.expect]);
    });
  }
}
```

---

## 11. `CLAUDE.md` to create in M0 (keep it under 120 lines)

Write this file verbatim at the repo root in M0. Claude Code loads `CLAUDE.md` into every session, and shorter files are followed more reliably. The long spec therefore stays in `PRAMAAN_BUILD_SPEC.md` and is read on demand. **Do not** add an `@`-import of the spec to `CLAUDE.md`: an import would load the whole spec into every session.

(The verbatim content is the repo's `CLAUDE.md`, created in M0.)

---

## 12. Kick-off prompts for Balu (paste into Claude in VS Code)

- **First session:** `Read PRAMAAN_BUILD_SPEC.md sections 0–7 and M0 in §8. Build M0 exactly. Ask me for anything listed under "Needs Balu" before you need it.`
- **Every later session:** `Continue with the next milestone per CLAUDE.md.`
- **When a gate fails:** `The MVP gate row "<metric>" failed at <value>. Diagnose from the ledger and bench report, propose the smallest M10.x fix, and wait for my OK.`
- **Before touching staging:** `You may run <command> against hrms staging now, max <N> minutes, primary tenant only.`

---

## 13. Definition of done for v1

Pramaan v1 is done when all of the following hold:
1. Every row of the v1 gate (§9, M17) passes on two consecutive weeks, and the numbers are in PROGRESS.md.
2. A fresh clone of the suite repo for HRMS runs green with `npm ci && npx playwright test`, with no Pramaan installed and no LLM key.
3. Balu can onboard a new web app from `app.yaml` to a reviewed, compiled suite in one working day by following `docs/RUNBOOK.md`.
4. `docs/V1-RELEASE.md` exists, with honest limits.
