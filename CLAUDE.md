# Pramaan — standing rules

Pramaan is an autonomous multi-agent QA system. Agents author tests; deterministic code judges them.
Full spec: `PRAMAAN_BUILD_SPEC.md` (read only the section for the current milestone).
Status: `docs/PROGRESS.md` · Decisions: `docs/DECISIONS.md` · Open asks: `docs/NEEDS-BALU.md`

## Every session
1. Read docs/PROGRESS.md and docs/NEEDS-BALU.md; find the current milestone.
2. Read that milestone in the spec (§8 MVP, §9 v1). Make a short checklist.
3. Tests first for pure logic. Then commands. Then demo e2e.
4. `npm run verify` must be green (typecheck, lint, unit, demo e2e in replay mode).
5. Run the milestone's acceptance checks; paste measured numbers into PROGRESS.md.
6. Commit `feat(mN): …` in small steps. Stop and report in ≤5 lines. Wait for "continue".

## Never
- Never call an LLM to pass/fail a test or file a bug. LLM output is a proposal, validated by zod.
- Never run against a host not in app.yaml safety.allowedOrigins. There is no production target.
- Never click deny-pattern actions; approval-pattern actions only if listed in safety.approvedActions.
- Never mutate records Pramaan did not create (owned = in this run's data.created ledger). The network
  ownership guard (src/core/ownership-guard.ts) must wrap every crawler/replay context — never bypass it.
- Never make network calls to an app with requireTargetFlag unless the command has --target staging.
- Never send credentials, tokens or un-redacted payloads to the LLM. Run redact() first.
- Never log secrets. Never commit .env, workspace/, raw HAR.
- Never use eval/new Function/vm or libs that do (no jsonpath-plus).
- Never use `any`. Parse unknown input with the zod schemas in src/core/schemas.ts.
- Never weaken an assertion, add test.skip/fixme/only, or add waitForTimeout in generated code.
- Never change §4 contracts without a DECISIONS.md entry and Balu's OK.

## Generated suite conventions (enforced by the suite's ESLint)
- Locators: data-testid → getByRole → getByLabel → getByPlaceholder → CSS #id. No XPath, no class selectors.
- No hard-coded waits. Web-first assertions only.
- Test names: should_[action]_when_[condition]. Every expect has a message. Arrange/Act/Assert comments.
- POM layers: pages/ flows/ specs/ fixtures/ helpers/ config/. Strict TS, no any. en_IN data, Asia/Kolkata.

## LLM
- Anthropic key coming (D-012); keyless until it is in .env (D-010): every call site has a deterministic fallback.
- Only src/llm/client.ts talks to the API. Modes: live | record | replay | off (tests: replay/off).
- Models via env: PRAMAAN_MODEL_FRONTIER / _MID / _SMALL. Respect budgets in app.yaml.
- Cite-only-given-evidence: drop any output citing unknown evidence ids.

## Ask Balu before
First staging contact in a milestone · adding approvedActions · raising budgets · native/Python/>5MB deps ·
changing contracts · disabling any safety rule · recording LLM fixtures (show estimated cost).

## Commands
npm run verify · npm run demo · npx tsx src/cli/index.ts <command> --app demo|hrms [--target staging]
