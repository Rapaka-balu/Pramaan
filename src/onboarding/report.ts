// onboarding.md and cannot-proceed.md writers (§8 M1).
import type { OriginCheck } from './contract.js';

export type OnboardStatus = 'ok' | 'reused' | 'refreshed' | 'failed' | 'skipped';
export interface OnboardRow {
  role: string;
  tenant: string;
  optional: boolean;
  status: OnboardStatus;
  reason: string;
  ms: number;
}

const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

export function renderOnboardingMd(app: string, runId: string, rows: OnboardRow[], origins: OriginCheck[]): string {
  const lines = [
    `# Onboarding — ${app}`,
    '',
    `Run \`${runId}\``,
    '',
    '| Role | Tenant | Status | Reason | Time |',
    '| --- | --- | --- | --- | --- |',
    ...rows.map(
      (r) =>
        `| ${r.role}${r.optional ? ' (optional)' : ''} | ${r.tenant} | ${r.status} | ${cell(r.reason) || '—'} | ${(r.ms / 1000).toFixed(1)}s |`,
    ),
    '',
    '## Origins',
    '',
    ...origins.map((o) => `- ${o.url} — ${o.status} (${cell(o.detail)})`),
    '',
  ];
  return lines.join('\n');
}

/** Failures of required roles only; optional roles are "cannot verify", never blockers. */
export function blockingFailures(rows: OnboardRow[]): OnboardRow[] {
  return rows.filter((r) => !r.optional && r.status === 'failed');
}

export function renderCannotProceed(app: string, failures: OnboardRow[], origins: OriginCheck[]): string {
  const badOrigins = origins.filter((o) => o.status === 'unreachable');
  return [
    `# Cannot proceed — ${app}`,
    '',
    'Pramaan stopped before crawling because a required precondition failed.',
    '',
    ...failures.map((f) => `- **Role \`${f.role}\`** (tenant ${f.tenant}): ${cell(f.reason)}`),
    ...badOrigins.map((o) => `- **Origin ${o.url}** unreachable: ${cell(o.detail)}`),
    '',
    'Fix the credentials in `.env` (or the app.yaml login settings) and run `pramaan onboard` again.',
    '',
  ].join('\n');
}
