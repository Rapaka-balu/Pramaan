# Needs Balu

Open asks that block or degrade work. Newest first. Tick when resolved.

## M0
- [x] ~~ANTHROPIC_API_KEY~~ — 2026-10-27: Balu chose keyless mode for now (D-010). Revisit when a key is bought.
- [ ] **HRMS `.env` values:** `HRMS_TENANT_PRIMARY` (TEST), `HRMS_EMPLOYEE_EMAIL/PASSWORD`, `HRMS_ADMIN_EMAIL/PASSWORD`. Copy `.env.example` → `.env` (gitignored). `npx tsx src/cli/index.ts doctor --app hrms` lists exactly what is still missing.
- [ ] **Approve the HRMS safety lists** in `apps/hrms/app.yaml` (`denyActionPatterns`, `requiresApprovalPatterns`, `forbiddenHostPatterns`, `allowedOrigins`). They are copied from spec §8 M0 item 6.

## M2
- [ ] Permission for the first staging crawl (`pramaan crawl --app hrms --target staging`), primary tenant, with a time cap. It submits only allow-listed forms and tags free text `PRM-<runId>-`.
- [ ] Spot-check 5 HRMS screenshots after that crawl (spec acceptance).

## Upcoming (M1)
- [ ] Ask the HRMS devs for an `employee2` login (same tenant, for IDOR) and one login in a second tenant (tenant isolation). Until then these roles report "cannot verify".
- [ ] Permission for the first staging run in M1 (`pramaan onboard --app hrms --target staging`).
