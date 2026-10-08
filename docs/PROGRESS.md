# Progress

| Milestone | Status | Date |
| --- | --- | --- |
| M0 — Scaffold, demo app, LLM client, guards | **done** (llm:smoke pending Balu's key) | 2026-10-08 |
| M1 — Onboarding harness | **demo done**; HRMS staging run pending creds + OK | 2026-10-08 |
| M2 — Crawler with HAR capture | next — waiting for "continue" | |

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
