# Demo HRMS (local fixture)

A tiny HRMS that imitates the pilot app (spec §5). Express + static SPA (vanilla JS, no build) + in-memory store.
It is the target for Pramaan's e2e tests and the offline benchmark.

```sh
npm run demo                 # http://127.0.0.1:4600 (PORT=… to change)
DEMO_BUGS=idor-leave-read npm run demo
```

Programmatic: `startDemo({ port = 4600, host = '127.0.0.1', env = process.env })` →
`{ url, port, close(), requestLog }`. Port 0 picks a free port. All toggles are read from `env` per instance.

## Users (password `Demo@123` for all)

| Tenant | Email | Role | Name |
| --- | --- | --- | --- |
| TEST | emp1@demo.local | employee | Asha Rao (manager: mgr1) |
| TEST | emp2@demo.local | employee | Vikram Iyer (manager: mgr1) |
| TEST | mgr1@demo.local | manager | Meera Nair |
| TEST | admin1@demo.local | admin | Rohan Kapoor |
| TEST2 | admin2@demo.local | admin | Kavita Menon |
| TEST2 | emp3@demo.local | employee | Arjun Das |

Every user has `{ total: 20, used: 0, available: 20 }` except emp2 (`used: 1`), whose seeded approved leave is
reflected so the seed is self-consistent. Seed leaves: #1 emp1 submitted (2 days), #2 emp2 approved (1 day),
#3 emp3 (TEST2) submitted. None are PRM-tagged.

## SPA routes

`/login`, `/dashboard`, `/leaves`, `/leaves/apply`, `/leaves/:id`, `/approvals` (manager/admin), `/employees`
(admin), `/attendance`. `/` redirects client-side. Unknown pages get the SPA shell with HTTP 404 and a
"Page not found" view. Views are `<template>`s in `public/index.html`; `app.js` clones them.

## API

Every route except login needs `Authorization: Bearer <token>` (else 401) and `X-Tenant-Code` equal to the
token's tenant (else 403). Validation errors are `400 { error, field }`. IDs are numeric and incrementing.

| Method & path | Who | Notes |
| --- | --- | --- |
| POST /api/auth/login | anyone | `{tenant,email,password}` → 200 `{token,user}` / 401 `Invalid credentials` |
| POST /api/auth/logout | any | 204 (tokens are stateless) |
| GET /api/me | any | current user |
| GET /api/leave-balance | any | own `{total,used,available}`; 503 under `DEMO_FLAKY` |
| GET /api/leaves | any | own leaves; `?all=1` whole tenant for manager/admin, 403 for employee |
| POST /api/leaves | any | `{from,to,days,reason,halfDay?,fromTime?,draft?}` → 201; 400 on invalid / insufficient balance |
| GET /api/leaves/export.csv | any | own leaves: `id,from,to,days,status,reason` |
| GET /api/leaves/:id | owner, manager/admin of tenant | others get **404, not 403**, so ids do not leak existence |
| POST /api/leaves/:id/submit | owner | draft → submitted, else 409 |
| POST /api/leaves/:id/approve | manager/admin, not own | submitted → approved (deducts), else 409; own → 403 |
| POST /api/leaves/:id/reject | manager/admin, not own | submitted → rejected, else 409 |
| POST /api/leaves/:id/cancel | owner | draft/submitted/approved → cancelled (approved refunds), else 409 |
| GET /api/approvals | manager/admin | submitted leaves in tenant, excluding own |
| GET /api/employees, /api/employees/:id | admin | 403 otherwise |
| GET /api/attendance | any | own records |
| POST /api/attendance/punch-in, /punch-out | any | 201 / 200; 409 when already in / not in |

Rules: `days > 0`, multiple of 0.5; `to >= from`; reason 1–200 chars; `halfDay: true` ⇒ days 0.5 (defaulted).
If `fromTime` (ISO with offset) is given, `from` is its Asia/Kolkata calendar date and `to` defaults to `from`.
Leaves from other tenants are always 404. Owner-only actions return 403 to approvers who can see the leave,
404 to everyone else.

Dev-only, loopback only: `POST /__reset` (restore seed, reset the PRNG), `GET /__requests` (request log),
`DELETE /__requests` (clear it). Every `/api` request is logged after it finishes as
`{ ts, method, path, status, userId, tenant }`.

## Toggles

| Env | Effect |
| --- | --- |
| `DEMO_BUGS=a,b` | Seeded bugs below. `none` or empty = fully correct. Unknown ids fail at start. |
| `DEMO_FLAKY=0.3` | `GET /api/leave-balance(s)` returns 503 with that probability (mulberry32, one draw per call). |
| `DEMO_SEED=42` | PRNG seed (default 42), per instance. |
| `DEMO_DRIFT=apply-testid` | The apply form's submit button testid changes `apply-leave-btn` → `apply-leave-submit`. |
| `DEMO_API_V2=1` | Leave responses gain `leaveType: 'casual'`; `GET /api/leave-balance` → `GET /api/leave-balances` (old route 404). The SPA follows the new route. |
| `DEMO_TOKEN_SECRET` | HMAC secret (a fixed default, so sessions survive restarts). |

The server injects `window.__DEMO__` (balance endpoint, two neutral UI flags) into `index.html`; it never names bugs.

## Seeded bugs (`benchmark/demo/bugs.yaml`)

| Id | When on |
| --- | --- |
| idor-leave-read | `GET /api/leaves/:id` returns another employee's leave (same tenant) |
| employee-admin-endpoint | `/api/employees` and `/api/employees/:id` allowed for non-admins |
| cross-tenant-list | `/api/leaves?all=1` returns every tenant's leaves |
| self-approve | manager/admin can approve or reject their own leave |
| double-approve | approving an approved leave returns 200 and deducts again |
| cancel-no-refund | cancelling an approved leave does not refund |
| balance-off-by-one | approval deducts `days + 1` |
| half-day-rounding | deduction is `ceil(days)` (0.5 → 1) |
| negative-days | `days <= 0` (e.g. -2) accepted |
| end-before-start | `to < from` accepted |
| ist-midnight | with `fromTime`, `from` is the UTC date (00:30 IST on the 10th → stored on the 9th) |
| long-reason-500 | reason > 200 chars → 500 instead of 400 |
| dashboard-console-error | dashboard throws an uncaught `TypeError` (announcements widget) |
| stale-ui-balance | SPA caches the first balance per user in `localStorage` (`demo.balanceCache`) and never refetches |
| csv-export-mismatch | CSV rounds `days` (0.5 → 1); the API keeps 0.5 |
