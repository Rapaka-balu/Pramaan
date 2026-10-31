# Decisions (ADR log)

Newest last. Each entry: context → decision → consequence.

## D-001 · 2026-10-08 · Library versions (M0)
Installed latest stable: typescript 6.0.3, tsx 4.23.15, zod 4.6.5, yaml 2.9.1, commander 15.0.0,
@anthropic-ai/sdk 0.132.1, @playwright/test 1.64.0, @faker-js/faker 10.6.0, pino 10.4.0, p-limit 7.3.3,
ts-morph 28.0.0, @inquirer/prompts 8.7.3, dotenv 18.0.6, express 5.2.1, vitest 5.0.3, eslint 10.12.0,
typescript-eslint 8.71.1, @eslint/js 10.0.1, prettier 3.9.9. Node 24.16 locally, Node 22 in CI.

## D-002 · Structured-output path (§2.4)
SDK 0.132.1 types `output_config.format: { type: 'json_schema', schema }` as stable on `messages.create`;
the client tries it first. Fallback is tool use. **Deviation:** forced `tool_choice: {type:'tool'}` is rejected
(400) on claude-opus-5-5 and claude-sonnet-5-5, so on that 400 the client retries once with
`tool_choice: auto` + "respond only by calling <tool>" and remembers it per model; Haiku keeps forced tool use.
The JSON Schema sent to the API is `z.toJSONSchema(schema, {io:'input'})` with objects closed
(`additionalProperties:false`) and numeric/length limits stripped (unsupported); zod still enforces them on the
reply. **Live path is unconfirmed until `npm run llm:smoke` runs with Balu's key.**

## D-003 · LLM client details
Live mode does not read the cache (spec: "call the API"). Record writes only validated replies. `onCall` fires
whenever the API billed a call, even if the output then fails validation. Default maxTokens 8192.
Prices in `src/llm/prices.ts` (USD/MTok in/out): opus-5-5 4/20, sonnet-5-5 2/10, haiku-4-5 1/5. Balu: verify.

## D-004 · Schema addition: BugCatalog (§4, additive)
`BugCatalogEntry`/`BugCatalog` added to schemas.ts for `benchmark/*/bugs.yaml` (shape from §5 plus `mvp: boolean`
so `csv-export-mismatch` can be excluded from MVP bench). Additive only; SCHEMA_VERSION unchanged.

## D-005 · Demo fixture env + env interpolation in app.yaml
`apps/demo/fixture.env` (committed, fixture creds only) is a non-overriding fallback after `.env`, so
`doctor --app demo` and CI work on a clean clone. `app.yaml` supports `${VAR}` / `${VAR:-default}` interpolation
before parsing; the e2e harness runs the demo on a free port via `DEMO_PORT`, and the target guard sees the same
origin. A tenant's code env is optional when all its roles are optional.

## D-006 · Ownership guard is stricter than §2.3 #9's wording
If the path has an ID-like segment, only the path decides (an owned ID in the body cannot unlock a foreign path
ID). With no path ID, an owned `id`/`*_id`/`*Id` in body or query allows. A foreign top-level `id` in a create
body blocks. Note for M2: pass the rate limiter only for API traffic, or static assets crawl at 2 rps.

## D-007 · Budget.charge semantics
`charge()` records spend first, then throws `BudgetExceeded` (money already spent). Callers pre-check with
`wouldExceed()`; the LLM client does this before every live call.

## D-008 · Demo app choices (§5)
- `GET /api/leaves/:id` for a non-owner returns 404 (not 403) to avoid leaking existence.
- emp2 seeds with an approved 1-day leave, so its balance starts 19/20 (consistent; avoids invariant false alarms).
- Cancel is allowed from draft/submitted/approved (teardown needs it); 409 from rejected/cancelled.
- `ist-midnight`: §5's example ("23:30 IST stored on the next UTC day") is impossible — 23:30 IST is the *same*
  UTC date. Implemented as: with `fromTime`, the bug stores the UTC date instead of the IST date (00:30 IST on the
  10th → stored as the 9th). M10's Boundary Calculator must probe 00:30 IST to catch it.
- UI-side bugs are driven by neutral `window.__DEMO__` flags so the page never names the active bug.
- `dashboard-console-error` lists `GET /dashboard` (a page route) in `operations`; M8's hit-matching must accept
  UI routes for implicit-oracle bugs.
- Unknown `DEMO_BUGS` / `DEMO_DRIFT` values make the demo refuse to start (fail loudly in bench).

## D-009 · Redaction trade-offs
Plain 12-digit numbers redact as Aadhaar and 10-digit 6–9 numbers as phones (safe side). Salary-key match is
unanchored, so e.g. `basicInfo` is over-redacted. Password/token keys only redact string values (so `inputTokens`
counts survive). Run tags, ISO dates, epoch ms and small IDs are not redacted.

## D-010 · `--target` has a single choice
commander restricts `--target` to `staging`; `--target production` is a parse error (§2.3 #8).

## D-011 · Onboarding (M1)
- Login success = the URL leaves the login path (or matches a `/path` successSignal, or a text signal is visible)
  AND no alert/error text is visible. After success the page waits for network idle so the HAR shows authed calls.
- The auth scheme is derived from the login HAR: the Authorization value is matched against localStorage (else a
  cookie scheme); the tenant header is a non-standard header with a constant value on every /api call, preferring
  names containing "tenant". Stored in `workspace/<app>/sessions/<role>.meta.json` — where the token lives, not the
  token itself.
- Session probe = first 2xx GET, preferring identity endpoints (/me, /profile…). 401/403 → re-login (`refreshed`).
- Optional roles that fail login are reported but never block; only required-role failures write cannot-proceed.md.
- `PRAMAAN_STATE_ROOT` (default: repo root) relocates `workspace/`, so e2e tests use temp dirs.
- Login contexts run behind the target guard, the global rate limiter and the ownership guard (login URL = a path
  matching login|signin|auth/token|session).

## D-010 · 2026-10-27 · Keyless mode until an LLM key is bought
Balu has no LLM API key yet (spec v2 moves to free tiers; he may buy a key later). Decision: **Pramaan runs keyless**
— `PRAMAAN_LLM_MODE=off` / `replay-or-off`, and every LLM call site uses its deterministic fallback. The existing
Anthropic client stays as it is (it already falls back cleanly); the free-tier provider migration of spec §2.4/§2.5
(`openai` package, Groq/Gemini/OpenRouter chains, quotas, privacy routing) is **deferred** until a key exists.
`PRAMAAN_BUILD_SPEC.md` is now spec v2 (free-tier LLM section); §2.4 is the target, not yet the code.
M2 consequence: no LLM form data and no frontier rerank — both use the deterministic path the spec defines.

## D-011 · 2026-10-27 · Crawler (M2) choices
- **Re-entry:** a state is reached again by opening its anchor URL and replaying a click chain. Any action that changes
  server state (form submit, owned-record action) starts a new anchor at the resulting URL, so a mutation is never
  replayed. A state that no longer exists after a later mutation is counted as `stale`, not as an error.
- **Ordering:** frontier priority is unvisited route → nav landmark → submit → rest → owned-record actions last
  (they change the state other candidates start from). Ties keep DOM order, so crawls are deterministic.
- **Repeated rows:** only the first row of a repeated group and rows showing this run's tag become candidates. Row
  candidates use a row-scoped descriptor (`getByTestId('leave-row').filter({hasText}).getByTestId(...)`), which adds an
  optional `scope` to the locator descriptor (additive). In-page `#anchor` links and zero-size elements are skipped;
  a bare `[data-testid]` is a candidate only if it is clickable and holds no other controls.
- **Owned-record container:** nearest row/listitem, else dialog, else the enclosing section/article/form (so a detail
  card showing the tag counts). The network ownership guard remains the backstop; an e2e test removes
  cancel/approve/reject from the deny list and proves the guard aborts `POST /api/leaves/1/cancel`.
- **Settling:** no fixed waits — an action is settled when no request is in flight across two animation frames
  (bounded at 10 s). Long-polling apps will hit the bound on every action; revisit on HRMS if needed.
- **Rate limit** applies to API traffic only (`limitWhen`, closes the D-006 note).
- **Teardown ops** are learned from the crawl: a 2xx `DELETE …/{id}` or `POST …/{id}/cancel|withdraw|delete|remove`
  on an owned record. A teardown call answered 409/410 means the record is already terminal → `retired`.
- **Demo app:** approval rows gained a "View" link (realistic, and lets second-tenant approvers reach `/leaves/{id}`).

## D-012 · 2026-10-31 · Anthropic API key (supersedes the free-tier plan)
Balu will buy an Anthropic API key. The LLM layer stays on the existing `@anthropic-ai/sdk` client (D-002/D-003,
models via `PRAMAAN_MODEL_*`, USD budgets in app.yaml). Spec v2's free-tier section (§2.4/§2.5: `openai` package,
Groq/Gemini/OpenRouter chains, quotas, privacy routing) is **not** implemented. Until the key is in `.env`, Pramaan
stays keyless (D-010); with the key, run `npm run llm:smoke`, then record demo fixtures (show estimated cost first).

## D-013 · 2026-10-31 · Living Spec inference (M3) choices
- **Where:** drafts go to `workspace/<app>/spec/` (openapi.observed.yaml, entities.yaml, docs-score.json, replay/).
  M6 `compile` copies the reviewed versions into the suite repo's `spec/`. The OpenAPI holds schemas only — no
  sample values — so nothing personal reaches the suite repo; raw samples stay in the gitignored workspace.
- **Slug params:** ≥ 3 distinct values at a position *and* the parent path observed as a collection *and* identifier-like
  values (a digit, or ≥ 5 values), never file names. Without these, `/api/leaves|employees|attendance` collapsed to
  `/api/{id}`. Several params: the last is `{id}`, earlier ones `{<entity>Id}`.
- **Entities:** path root after the API prefix; a group whose record fields match another's at Jaccard ≥ 0.8 merges
  into the larger (e.g. `/api/approvals` → leave). Names are singular roots (keyless; the LLM may rename later).
- **State machines:** status-like string field with ≤ 8 values. Observed transitions come from per-record sequences
  ordered by timestamp across roles. UI hints (a crawl state showing exactly one status + its record buttons) add
  `observed:false` hypotheses, including conventional `POST <root>/{id}/<verb>` ops the crawler was denied.
  `initial` (states right after create) is an additive field.
- **Lifecycle probe:** tries every known record op from every reachable state (not only UI hints), creating a fresh
  record per attempt from a crawl recipe (free text re-tagged), driving it along observed transitions, trying actors
  (UI roles → creator → others, max 4). 404/405 for the owner = the op does not exist. Every write passes
  `decideOwnership` first; all records are torn down. Replay evidence: `spec/replay/lifecycle-<runId>.json`.
- **Login:** session reuse means crawl HARs rarely contain the login call; it is excluded from entities anyway.

## D-014 · 2026-10-31 · Authorization matrix (M4) choices
- **Similarity = containment, not Jaccard.** The share of the owner's (path=valueHash) pairs the actor also gets.
  Jaccard scores a superset leak (cross-tenant list = owner's rows + own rows) ≈ 0.8 and misses it; containment
  scores 1.0. Array indices, timestamp keys/values and run-tagged strings are ignored. For collections only
  identifying fields (id, *Id, email, tenant, name, reason…) count, so look-alike numbers (two people with 20 days
  of leave) are not a leak. `same-data` ≥ 0.9.
- **Mutations** classify by status: 2xx = same-data (the action worked as for the owner), 401/403/404 = denied,
  other 4xx/5xx = error. Each actor gets a fresh record created by this run and driven along observed transitions
  to the state where the owner's call was legal; creates are not replayed (cells `skipped`).
- **Expectation semantics:** `filtered` is satisfied by `different-data` *or* `denied` (no owner data leaks either
  way); `deny`/`own-only` need `denied`; `allow` needs `same-data`. §10.3's codegen must use these sets (M6).
- **Heuristic proposals (keyless):** anonymous → deny (except public auth paths); other-tenant → deny on records and
  writes, filtered on collections; admin|employees|settings|tenant|payroll paths → deny for non-admin roles; record
  reads → own-only for plain roles, allow for privileged ones (role id ~ admin|manager|hr|lead|approver|owner);
  writes → deny for plain roles; anything else `unknown` (never judged).
- **Query variants are separate rows:** `GET /api/leaves` and `GET /api/leaves?all` (keys only; the baseline URL keeps
  values). M8 hit-matching strips the `?…` part when comparing with bug catalog operations.
- **Findings** are written to `workspace/<app>/findings/F-xxxx.json`, signature = sha1(oracle|operation|actor|
  expected|outcome), re-seen findings only update `lastSeenRunId`. Status `queued` until the class has a precision
  record (§4.7). S1 for other-tenant/anonymous leaks, S2 otherwise.
- **Demo app:** approvers get an "All leave requests" view (`/leaves?scope=all` → `GET /api/leaves?all=1`), the realistic
  screen through which `cross-tenant-list` becomes reachable; before it, no UI called that endpoint.

## D-015 · 2026-10-31 · Rules, DSL and lead review (M5) choices
- **Domain pack = deterministic fallback.** `domain-packs/in-hrms/rules.yaml` holds 12 templates with `requires`
  capabilities; `src/spec/domain-pack.ts` binds them to the Living Spec (create/approve/cancel ops, days/half-day/date
  fields, balance endpoint, second plain employee, UI facts) and builds 8 deterministic DSL assertion templates.
  Assertions prefer the template over the LLM (no cost, reproducible); the frontier LLM writes assertions only for
  rules without a template (IST dates, ₹/date formats, seed attendance rules) — keyless they wait (`need an LLM`).
- **Rule proposals:** pack matches (confidence 0.7, `source: domain-pack`) + frontier LLM (`source: inferred`). LLM
  output is an LLM-facing shape with evidence *ids*; ids are resolved against the digest, unknown ids drop the rule
  (`llm.rejected-output`). Dedupe = Dice bigram similarity ≥ 0.85 against all existing rules (so rejected rules are
  never re-proposed); max 40 new per run. Template provenance = the rule's `domain-pack` evidence ref (`…#<template>`).
- **Assertion LLM shape:** bodies travel as JSON strings (`bodyJson`) and checks as loose objects; converted, then
  validated by the full zod schema + static checks; an assertion that cannot run (aborted) is discarded.
- **DSL runner:** API steps only (UI steps run in the compiled suite's flows, M6). `aborted` (could not run) is distinct
  from `passed: false` (a check failed). Every write passes `decideOwnership` with the assertion's own creations as the
  owned set; cleanup always runs; created records are also reported to the steward (dry-run teardown is the backstop).
- **Seed rules:** `apps/hrms/seed-rules.yaml` — 7 confirmed (`source: lead`, `by: lead:balu`, evidence `lead-note`
  → spec §1), 5 open questions (`proposed` + `openQuestion`). A seed whose id is taken is renumbered.
- **Queue:** risk = criticality × (1 + recent change [0 until M16]) × (1 + oracle weakness [no assertion = 1]);
  matrix rows criticality 4 (×1.25 for writes), findings S1..S4 → 5..2. Weekly budget from `lead.minutesPerWeek`
  minus this ISO week's (Mon 00:00 IST) `lead.session` minutes. Checklist imports record *estimated* minutes and say so.
- **Review ids:** rules/questions `R-xxx`, matrix rows `M:<operation>`, assertions `A-xxx`, findings `F-xxxx`.

## D-016 · 2026-10-31 · Compiler / suite repo (M6) choices
- **Suite module setup:** CommonJS package (no `"type": "module"`), `tsconfig` `module: preserve` + `moduleResolution:
  bundler` (extensionless imports, TS 6 safe), ESLint config as `eslint.config.mjs` with a local plugin
  `eslint-rules/pramaan.mjs` (rules: no-wait-for-timeout, no-fragile-locators, expect-message, test-title). Exact pinned
  versions; `compile` runs `npm install` when package.json changed (writes the lockfile), then the suite's `tsc` and
  ESLint, and fails the compile on either.
- **Ownership of files:** `.pramaan/manifest.json` (path → sha1 of what Pramaan wrote). A file whose content differs from
  the manifest hash was edited by a human and is never overwritten; TS files also carry the `generated by pramaan
  <version> from <sha8 of the body>` header (hash of the content, so regeneration is byte-stable). Commits go to
  `pramaan/compile-<runId>`; no changes → no branch.
- **`spec/decisions.jsonl`** mirrors durable ledger events (incl. `run.completed` of suite runs, excluding compile's own),
  so a suite run between two compiles is a genuine input change; two compiles in a row give zero diff.
- **Runtime contracts in the suite:** `api.as(actor)` (role / `other-tenant:<role>` / `anonymous`) builds request
  contexts from the stored session exactly as the app authenticates (observed AuthScheme: localStorage token or cookies
  + tenant header from env); `steward.create` + automatic teardown (409/410 = retired); `pageAs(role)` carries the
  implicit oracle (console errors, page errors, ≥ 500, failed requests except ERR_ABORTED). `workers: 1` because tests
  share account balances.
- **DSL → TS:** creates become `steward.create`, other steps `call(await api.as(…))`, delta expressions are folded at
  compile time (captures in an expression → not compiled, listed in PRAMAAN.md), unused bindings are dropped.
  1 actor → `specs/api/`, ≥ 2 actors → `specs/workflow/`; both tagged `@regression`.
- **Authz spec** prepares the owner's record per test (create + drive along observed transitions) and compares live
  owner vs actor responses with the suite's copy of the containment classifier (`helpers/authz.ts`, mirrors
  `src/authz/compare.ts` — keep in sync); assertion uses the D-014 satisfaction sets (`toContain`, not `toBe`).
- **Consistency tests:** the crawler now records `texts.json` (visible non-interactive `[data-testid]` text per state).
  A UI element ↔ GET field pair needs value equality for every primary-tenant role that saw both, and exactly one field
  per element (employee2's 19 vs 20 disambiguates `available` from `total`). The test opens the page, changes the
  data through the API (own request approved by another role), reopens and compares with a web-first poll.
- **Crawler fix:** a candidate inside a repeated row uses a plain locator when that is already unique (nav list items)
  and is row-scoped only when it repeats (a "View" link per row) — page objects now get the navigation.
- **`pramaan run`** is async (`spawn`), so an in-process demo server keeps answering; it passes the suite only URLs,
  `PRAMAAN_RUN_ID` and the role logins from the app's env.

## D-017 · 2026-10-31 · Data Steward hardening (M7) choices
- **Fake identities that can never be real:** PAN keeps the `AAAAA9999A` format but uses a 4th (holder-type) letter
  that is never issued (D E I K M N O Q R S U V W X Y Z); Aadhaar is 12 digits starting 2–9 that *fail* the Verhoeff
  check digit. Mobiles `+91 [6-9]XXXXXXXXX`, IFSC `PRMQ0…`, dates in Asia/Kolkata.
- **Create bodies** start from an observed, known-valid body (crawl recipe) and refresh what reuse would get wrong:
  tagged free text, an IST date window (start = end, one day), names/phones/IDs from the factory. Unknown fields keep
  their observed value — safer than inventing values for fields Pramaan has never seen filled.
- **Teardown plan:** DELETE on the record → observed cancel/withdraw transition → reject (called by the role allowed to
  reject) → learned op. 2xx = deleted, 409/410 = retired (already terminal). No plan → `data.orphaned` with reason and a
  one-time ask in NEEDS-BALU.md ("Cleanup endpoints"); not a run failure.
- **Live orphans** are found from the app itself: every list endpoint, as every role, records carrying a `PRM-<runId>`
  tag; a tagged record in a terminal state (no observed way out) is *retired*, not orphaned.
- **Interrupted runs:** `pramaan teardown --run <id>` needs only the ledger (`data.created` minus `data.deleted` /
  `data.orphaned`) plus the Living Spec's teardown plans; teardown events are appended under the killed run's id.
  Without a Living Spec (a first-ever crawl killed) there are no plans yet — run `infer` first.
- **Suite side:** the steward appends every create/teardown to `.pramaan-run/<runTag>.jsonl`; global setup fixes one run
  tag for all workers (`PRAMAAN_RUN_ID`); the global teardown tears down anything a crashed test left and fails the run
  only for records whose known teardown failed (no-teardown entities are listed in `<tag>.no-teardown.txt`).
