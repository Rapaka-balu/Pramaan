# Progress

| Milestone | Status | Date |
| --- | --- | --- |
| M0 — Scaffold, demo app, LLM client, guards | **done** (llm:smoke pending Balu's key) | 2026-10-08 |
| M1 — Onboarding harness | next — waiting for "continue" | |

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
