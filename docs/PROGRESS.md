# Progress

| Milestone | Status | Date |
| --- | --- | --- |
| M0 — Scaffold, demo app, LLM client, guards | **done** (llm:smoke pending Balu's key) | 2026-10-08 |
| M1 — Onboarding harness | **demo done**; HRMS staging run pending creds + OK | 2026-10-08 |
| M2 — Crawler with HAR capture | **demo done**; HRMS staging crawl pending creds + OK | 2026-10-27 |
| M3 — Living Spec inference | **demo done**; HRMS docs score pending staging | 2026-10-31 |
| M4 — Authorization differential matrix | **demo done**; HRMS matrix pending staging | 2026-10-31 |
| M5 — Rule proposer, seed rules, review queue v0 | next | |

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
