# Needs Balu

Open asks that block or degrade work. Newest first. Tick when resolved.

## M0
- [x] ~~ANTHROPIC_API_KEY~~ — 2026-10-27: Balu chose keyless mode for now (D-010). Revisit when a key is bought.
- [ ] **HRMS `.env` values:** `HRMS_TENANT_PRIMARY` (TEST), `HRMS_EMPLOYEE_EMAIL/PASSWORD`, `HRMS_ADMIN_EMAIL/PASSWORD`. Copy `.env.example` → `.env` (gitignored). `npx tsx src/cli/index.ts doctor --app hrms` lists exactly what is still missing.
- [ ] **Approve the HRMS safety lists** in `apps/hrms/app.yaml` (`denyActionPatterns`, `requiresApprovalPatterns`, `forbiddenHostPatterns`, `allowedOrigins`). They are copied from spec §8 M0 item 6.

## LLM
- [ ] **ANTHROPIC_API_KEY** in `.env` once bought (D-012). Then I run `npm run llm:smoke` (a few cents) and, with your OK on the estimate, record the demo LLM fixtures.

## M8
- [ ] **30 seeded HRMS bugs** with the devs: 8 calculation, 8 authz/tenant, 7 validation, 7 UI/workflow, listed in `benchmark/hrms/bugs.yaml` with `activation: { manual: "<how to deploy it>" }` (or an env flag the devs add). `pramaan bench --app hrms --target staging` then pauses for each one.

## M5
- [ ] Your first real review session on HRMS (`pramaan review --app hrms --interactive`, or `--export` for a checklist) once staging has been crawled. Your minutes are the first measurement of lead workload.
- [ ] The 7 seed attendance rules (`apps/hrms/seed-rules.yaml`) get assertions only once attendance operations are observed on staging and the LLM key is in (no domain-pack template covers them).

## M3
- [ ] HRMS docs score needs the staging run: `pramaan infer --app hrms --target staging` after the crawl.

## M2
- [ ] Permission for the first staging crawl (`pramaan crawl --app hrms --target staging`), primary tenant, with a time cap. It submits only allow-listed forms and tags free text `PRM-<runId>-`.
- [ ] Spot-check 5 HRMS screenshots after that crawl (spec acceptance).

## Upcoming (M1)
- [ ] Ask the HRMS devs for an `employee2` login (same tenant, for IDOR) and one login in a second tenant (tenant isolation). Until then these roles report "cannot verify".
- [ ] Permission for the first staging run in M1 (`pramaan onboard --app hrms --target staging`).
