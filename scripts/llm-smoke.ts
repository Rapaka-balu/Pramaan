// npm run llm:smoke — confirms which structured-output path works with the installed SDK (§8 M0 #4).
// Costs real money (two tiny frontier calls, well under $0.05). Skips cleanly without a key.
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';
import { LlmClient, type LlmCallRecord, type StructuredPath } from '../src/llm/client.js';

loadDotenv({ quiet: true });

const Smoke = z.object({ ok: z.boolean(), word: z.string() });

async function main(): Promise<number> {
  if (!process.env['ANTHROPIC_API_KEY']?.trim()) {
    console.log('llm:smoke skipped: no key (set ANTHROPIC_API_KEY in .env to run it)');
    return 0;
  }
  const calls: LlmCallRecord[] = [];
  const client = new LlmClient({
    appId: 'smoke',
    root: process.cwd(),
    mode: 'live',
    onCall: (r) => calls.push(r),
  });
  const model = client.modelFor('frontier');
  console.log(`llm:smoke model=${model}`);

  const worked: StructuredPath[] = [];
  let total = 0;
  for (const preferPath of ['output_config', 'tool'] as const) {
    const before = calls.length;
    try {
      const res = await client.structured({
        purpose: `smoke.${preferPath}`,
        tier: 'frontier',
        system: 'You are a connectivity check. Reply with the requested JSON object only.',
        user: 'Return ok=true and word="pramaan".',
        schema: Smoke,
        schemaName: 'smoke_result',
        promptVersion: 'smoke-1',
        maxTokens: 2048,
        fallback: () => ({ ok: false, word: '' }),
        preferPath,
      });
      const rec = calls[calls.length - 1];
      total += res.usd;
      const usedPath = res.path ?? 'unknown';
      if (usedPath === preferPath) worked.push(preferPath);
      console.log(
        `  ${preferPath}: ${usedPath === preferPath ? 'OK' : `fell back to ${usedPath}`} value=${JSON.stringify(res.value)} ` +
          `in=${rec?.inputTokens ?? 0} out=${rec?.outputTokens ?? 0} usd=$${res.usd.toFixed(6)}`,
      );
    } catch (err) {
      for (const r of calls.slice(before)) total += r.usd;
      console.log(`  ${preferPath}: FAILED ${(err as Error).name}: ${(err as Error).message}`);
    }
  }
  console.log(`llm:smoke working paths: ${worked.length ? worked.join(', ') : 'none'}; total usd=$${total.toFixed(6)}`);
  return worked.length > 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(`llm:smoke error: ${(err as Error).message}`);
    process.exit(1);
  },
);
