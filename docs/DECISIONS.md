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
