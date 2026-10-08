# Needs Balu

Open asks that block or degrade work. Newest first. Tick when resolved.

## M0
- [ ] **ANTHROPIC_API_KEY + budget OK.** Needed only for `npm run llm:smoke` (one tiny call to each structured-output path, well under $0.05). Everything else runs keyless in `replay-or-off`.
- [ ] **HRMS `.env` values:** `HRMS_TENANT_PRIMARY` (TEST), `HRMS_EMPLOYEE_EMAIL/PASSWORD`, `HRMS_ADMIN_EMAIL/PASSWORD`. Copy `.env.example` → `.env` (gitignored). `npx tsx src/cli/index.ts doctor --app hrms` lists exactly what is still missing.
- [ ] **Approve the HRMS safety lists** in `apps/hrms/app.yaml` (`denyActionPatterns`, `requiresApprovalPatterns`, `forbiddenHostPatterns`, `allowedOrigins`). They are copied from spec §8 M0 item 6.

## Upcoming (M1)
- [ ] Ask the HRMS devs for an `employee2` login (same tenant, for IDOR) and one login in a second tenant (tenant isolation). Until then these roles report "cannot verify".
- [ ] Permission for the first staging run in M1 (`pramaan onboard --app hrms --target staging`).
