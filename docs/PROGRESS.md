# Progress

| Milestone | Status | Date |
| --- | --- | --- |
| M0 — Scaffold, demo app, LLM client, guards | **done** (llm:smoke pending Balu's key) | 2026-10-08 |
| M1 — Onboarding harness | **demo done**; HRMS staging run pending creds + OK | 2026-10-08 |
| M2 — Crawler with HAR capture | **demo done**; HRMS staging crawl pending creds + OK | 2026-10-27 |
| M3 — Living Spec inference | **demo done**; HRMS docs score pending staging | 2026-10-31 |
| M4 — Authorization differential matrix | **demo done**; HRMS matrix pending staging | 2026-10-31 |
| M5 — Rule proposer, seed rules, review queue v0 | **demo done**; HRMS first review session pending | 2026-10-31 |
| M6 — Compiler: the suite repo | **demo done**; first HRMS suite + Balu review pending | 2026-10-31 |
| M7 — Data Steward hardening | **demo done**; HRMS orphan/irreversible-op counts pending staging | 2026-10-31 |
| M8 — Benchmark and mutation self-check | **demo done**; HRMS bench needs 30 seeded bugs from Balu + devs | 2026-10-31 |
| M9 — Triage, locator-only heal, expect-count lint | next | |

## M0 — measured (2026-10-08)

| Acceptance check | Result |
| --- | --- |
| `npm run verify` (typecheck, lint, unit, demo e2e; replay-or-off, no API key) | green: 17 unit files / 237 tests, 3 e2e tests |
| Demo starts with `DEMO_BUGS=none` and `idor-leave-read`; IDOR toggle proven | emp2 → emp1's leave: 404 (none) vs 200 (bug); 34 demo tests incl. one per seeded bug |
| `doctor --app demo` | PASS (e2e, demo on a free port) |
| `doctor --app hrms` without `--target` | lists 5 missing required + 5 optional keys; **0 network calls** (unit test with stubbed fetch) |
| Ownership guard unit tests | 26 pass (non-owned non-GET aborted; create and owned-ID allowed) |
| Target guard unit tests | 9 pass (forbidden HRMS pattern wins over allow-list) |
| `redact()` unit cases | 39 (PAN, Aadhaar, IFSC, phone, JWT, auth, salary keys, negatives) |
| `.gitignore` check-ignore test | pass (demo LLM cache committed, HRMS cache ignored) |
| `npm run llm:smoke` | skipped — no `ANTHROPIC_API_KEY` yet |

## M1 — measured (2026-10-08)

| Acceptance check | Result |
| --- | --- |
| All six demo users log in; API calls succeed with derived AuthMaterial | 6/6 ok in ~8.4 s; GET /api/me → 200 as the right user for each role (e2e) |
| Derived auth scheme (demo) | bearer from localStorage `demo.token` + tenant header `X-Tenant-Code`; probe GET /api/me |
| Wrong password → cannot-proceed.md naming role + visible error | `admin`: "Invalid credentials"; exit 2; password never written (e2e) |
| Token deleted from stored session → automatic refresh | next run `refreshed`, then `reused` (e2e) |
| safety.blocked events during login | 0 |
| HRMS without `--target` | all roles skipped, 0 network calls, exit 2 |
| HRMS staging (employee + admin log in; employee2 / other-tenant "cannot verify") | **not run** — needs `.env` values and Balu's OK |
| `npm run verify` | green: 19 unit files / 256 tests, 6 e2e tests |

## M2 — measured (2026-10-27, demo, `DEMO_BUGS=none`, keyless)

| Acceptance check | Result |
| --- | --- |
| ≥ 90% of demo routes discovered per role | **100% for all 6 roles**: employee/employee2/t2-employee 5/5, manager 6/6, admin/t2-admin 7/7 |
| Crawl under 5 min per role | 2–5 s per role (8–10 states, 14–19 transitions each); whole 6-role crawl ≈ 40 s incl. login |
| No mutating request reaches a non-owned leave (server log vs ledger) | **0** foreign mutations; seeded leave 1 stays `submitted` |
| Owned-record cancel exercised | yes — crawl-created leaves cancelled in the UI (teardown then finds them `retired`) |
| Network ownership guard in e2e (deny list with cancel/approve/reject removed) | guard aborted `POST /api/leaves/1/cancel`; 0 foreign mutations |
| Teardown restores seed except terminal records | 8 created → 4 torn down + 4 retired, **0 orphaned**; all balances back to seed |
| Punch in/out skipped and listed | never called; every role lists "Punch in, Punch out" as needing approval |
| Determinism (two crawls of a reset demo) | identical state-key sets (employee, manager) |
| HRMS crawl without `--target` | refused, 0 network calls, exit 2 |
| HRMS staging crawl (state counts, 5 screenshot spot-checks) | **not run** — needs `.env` values and Balu's OK |
| LLM requests | 0 (keyless mode, D-010) |
| `npm run verify` | green: 23 unit files / 305 tests, 9 e2e tests |

## M3 — measured (2026-10-31, demo, keyless)

| Acceptance check | Result |
| --- | --- |
| Every leave/employee op the crawl exercised, correctly templated | 11 ops from 134 API calls: `GET/POST /api/leaves`, `GET /api/leaves/{id}`, `POST /api/leaves/{id}/approve|reject|cancel`, `GET /api/leaves/export.csv`, `GET /api/approvals`, `GET /api/employees`, `/api/leave-balance`, `/api/attendance`; no concrete ids left |
| Leave state machine after lifecycle probe | field `status`, states approved/cancelled/draft/rejected/submitted; **submitted→approved** (admin), **approved→cancelled** (employee), submitted→rejected, submitted→cancelled all `observed: true` |
| Probe safety | only its own records mutated (server log vs ledger); 0 orphans; balances back to seed |
| Unit tests: path normalization, slug detection, schema merge with conflicting types, required fields | 25 cases (spec-infer, spec-model) |
| HRMS route precision ≥ 90% vs /apidocs | **not run** — needs staging (`score-vs-docs` is built and unit-tested) |
| LLM requests | 0 (entity names from path roots) |
| `npm run verify` | green: 25 unit files / 330 tests, 10 e2e tests |

## M4 — measured (2026-10-31, demo, keyless)

| Acceptance check | Result |
| --- | --- |
| `DEMO_BUGS=none`, matrix confirmed by scripted review → authz findings | **0** (12 rows, 72 cells: denied 37 · same-data 6 · different-data 23 · error 0 · skipped 6) |
| `DEMO_BUGS=idor-leave-read,employee-admin-endpoint,cross-tenant-list` | **3 of 3 found**, 5 findings, 0 false: employee2 → `GET /api/leaves/{id}` (own-only); employee, employee2, manager → `GET /api/employees` (deny); other-tenant:t2-admin → `GET /api/leaves?all` (filtered, S1) |
| Replay never mutates a record outside the teardown ledger | 0 foreign mutations (server log vs ledger); 18 replay records → 17 torn down + 1 retired, 0 orphans |
| Clean demo raises no lead questions | 0 contradictions on proposed rows |
| Skipped cells | 6 (create operation `POST /api/leaves`, not replayed by design) |
| HRMS matrix rows / skipped cells | **not run** — needs staging |
| `npm run verify` | green: 26 unit files / 345 tests, 12 e2e tests |

## M5 — measured (2026-10-31, demo, keyless — LLM proposals fall back to the domain pack)

| Acceptance check | Result |
| --- | --- |
| ≥ 10 sensible proposed rules with valid evidence | **11** (domain pack): own-approval, cross-employee read, approval deducts, cancel refunds, half day = 0.5, end-before-start, days > 0, IST dates, DD/MM/YYYY, state machine, UI balance = API |
| Rules citing unknown evidence | **0** accepted; rejection count reported per run (0 this run — no LLM output yet). Unit tests prove an invented id is dropped and logged |
| ≥ 6 assertions dry-run successfully on `DEMO_BUGS=none` | **8 of 8** (A-001…A-007, A-010); 2 rules wait for an LLM (no template); records torn down, 0 orphans |
| Review CLI decides 20 items (scripted) + ledger `lead.session` minutes | 20 decided (rules + matrix rows), 20 `*.decided` events, `lead.session` with measured minutes |
| DSL runtime unit cases (§10.1 invalid + corrected A-012, JSONPath, expressions, refs, runner) | 73 cases; invalid A-012 → "assert[1]: expected a Check, got a Step — move balAfter to act" |
| HRMS: Balu's first real review session (minutes, confirm/reject counts) | **not run** — needs the HRMS crawl/infer on staging first |
| `npm run verify` | green: 28 unit files / 429 tests, 13 e2e tests |

## M6 — measured (2026-10-31, demo, keyless)

| Acceptance check | Result |
| --- | --- |
| `pramaan compile` then `npm ci && npx playwright test` on `DEMO_BUGS=none` | **70 / 70 pass** (6 smoke, 8 rule assertions, 52 authz-matrix cells, 4 UI↔API consistency); suite typecheck + lint clean |
| LLM-free: package.json + lockfile | no `openai` / `@anthropic-ai/sdk` |
| LLM-free: code search `openai|anthropic|generativelanguage|groq|openrouter|11434` | 0 files |
| LLM-free: `llm.call` during compile | 0 uncached calls |
| `DEMO_BUGS=stale-ui-balance` | consistency tests fail, **only** consistency tests fail; pass on `none` |
| Custom lint rules reject a bad file each | 8 unit cases (wait, 4 fragile locators, missing message, 2 bad titles) |
| Regenerating twice without input changes | 0 files written, no branch, clean `git status` |
| Authz matrix spec on the 3 authz bugs | fails for employee2 → leave by id, employee → /api/employees, other-tenant t2-admin → leaves?all; passes on `none` |
| HRMS: first compiled suite as a PR + Balu's review minutes | **not run** — needs staging |

## M7 — measured (2026-10-31, demo)

| Acceptance check | Result |
| --- | --- |
| After a full compile, run and teardown: `orphans()` | **0** live tagged records (checked in the M6 e2e after the suite run) |
| Kill the run halfway, then `pramaan teardown --run <id>` | crawl process killed right after its first `data.created`; teardown left **0** pending records and **0** live records for that run |
| Seed → orphans → teardown | 3 seeded leaves found live by tag, then 0 live / 3 retired after teardown |
| en_IN factories | PAN format-valid with a never-issued holder type (50/50), Aadhaar Verhoeff-invalid (50/50), +91 mobiles |
| HRMS: orphan counts, irreversible operations, Balu's policy per operation | **not run** — needs staging |

## M8 — measured (2026-10-31, demo, keyless)

| Acceptance check | Result |
| --- | --- |
| Demo bench recall (14 MVP bugs) | **86 % (12/14)** — target ≥ 60 %. authz 2/2, tenant-isolation 1/1, workflow 2/2, calculation 3/4, validation 2/2, consistency 1/1, implicit 1/2 |
| Missed | `ist-midnight` (needs a 00:30 IST probe → Boundary Calculator, M10), `long-reason-500` (needs a > 200-char reason → Boundary Calculator, M10) |
| False alarms on `DEMO_BUGS=none` | **0** (precision 100 % on the clean run) |
| Precision of failures across all runs | 96 % — the one "false alarm" is `idor-leave-read` also failing the confirmed cross-employee-read rule (same bug, second oracle) |
| Mutation kill rate (demo) | **96 % (143/149)** — target ≥ 70 %; 19 equivalent mutants excluded; 0 weak tests; 0 fragile under `delay-2s` |
| Surviving mutants | 6, all on `POST /api/leaves` in tests that expect the create to be refused |
| Time | bench 2.8 min (15 suite runs), mutate 8.3 min (40 suite runs); 0 LLM requests |
| HRMS bench in manual activation mode with ≥ 1 real seeded bug | harness built + unit-tested (manual prompt); **needs a bug deployed on staging** |
