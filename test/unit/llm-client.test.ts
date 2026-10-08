import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  LlmBudgetError,
  LlmCacheMiss,
  LlmClient,
  LlmOutputError,
  LlmTransportError,
  UNTRUSTED_NOTICE,
  toLlmJsonSchema,
  untrusted,
  type LlmCallRecord,
  type LlmClientOptions,
  type LlmMode,
  type LlmRequest,
  type LlmResponse,
  type LlmTransport,
} from '../../src/llm/client.js';

const Out = z.object({ ok: z.boolean(), word: z.string() });
type Out = z.infer<typeof Out>;

class FakeTransport implements LlmTransport {
  readonly calls: LlmRequest[] = [];
  constructor(private readonly handler: (req: LlmRequest, n: number) => LlmResponse | Promise<LlmResponse>) {}
  async create(req: LlmRequest): Promise<LlmResponse> {
    this.calls.push(req);
    return this.handler(req, this.calls.length);
  }
}

const usage = { inputTokens: 100, outputTokens: 50 };
const jsonReply = (v: unknown, stop = 'end_turn'): LlmResponse => ({
  content: [{ type: 'text', text: JSON.stringify(v) }],
  stop_reason: stop,
  usage,
});
const toolReply = (name: string, v: unknown): LlmResponse => ({
  content: [{ type: 'tool_use', name, input: v }],
  stop_reason: 'tool_use',
  usage,
});

const FALLBACK: Out = { ok: false, word: 'fallback' };

describe('LlmClient', () => {
  let root: string;
  let records: LlmCallRecord[];

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'pramaan-llm-client-'));
    records = [];
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const mk = (mode: LlmMode, transport?: LlmTransport, extra: Partial<LlmClientOptions> = {}): LlmClient =>
    new LlmClient({
      appId: 'demo',
      root,
      mode,
      env: {},
      onCall: (r) => records.push(r),
      warn: () => undefined,
      ...(transport ? { transport } : {}),
      ...extra,
    });

  const req = (over: Partial<{ user: string; promptVersion: string; maxTokens: number }> = {}) => ({
    purpose: 'test.purpose',
    tier: 'frontier' as const,
    system: 'You are a test.',
    user: over.user ?? 'Say hi.',
    schema: Out,
    schemaName: 'test_out',
    promptVersion: over.promptVersion ?? '1',
    fallback: () => FALLBACK,
    ...(over.maxTokens !== undefined ? { maxTokens: over.maxTokens } : {}),
  });

  it('modelFor uses env overrides and spec defaults', () => {
    const c = new LlmClient({ appId: 'demo', root, mode: 'off', env: { PRAMAAN_MODEL_MID: 'm-x' } });
    expect(c.modelFor('frontier')).toBe('claude-opus-5-5');
    expect(c.modelFor('mid')).toBe('m-x');
    expect(c.modelFor('small')).toBe('claude-haiku-4-5-20251001');
  });

  it('mode defaults to PRAMAAN_LLM_MODE, else replay-or-off; invalid value throws', () => {
    expect(new LlmClient({ appId: 'demo', root, env: {} }).mode).toBe('replay-or-off');
    expect(new LlmClient({ appId: 'demo', root, env: { PRAMAAN_LLM_MODE: 'replay' } }).mode).toBe('replay');
    expect(() => new LlmClient({ appId: 'demo', root, env: { PRAMAAN_LLM_MODE: 'prod' } })).toThrow(/invalid/);
  });

  it('off: never touches the transport, runs fallback, logs fallback call', async () => {
    const t = new FakeTransport(() => jsonReply({ ok: true, word: 'x' }));
    const res = await mk('off', t).structured(req());
    expect(res).toMatchObject({ value: FALLBACK, source: 'fallback', usd: 0 });
    expect(t.calls).toHaveLength(0);
    expect(records).toEqual([
      expect.objectContaining({ cached: false, fallback: true, usd: 0, inputTokens: 0, outputTokens: 0 }),
    ]);
  });

  it('replay: cache miss throws LlmCacheMiss', async () => {
    const t = new FakeTransport(() => jsonReply({ ok: true, word: 'x' }));
    await expect(mk('replay', t).structured(req())).rejects.toBeInstanceOf(LlmCacheMiss);
    expect(t.calls).toHaveLength(0);
  });

  it('replay-or-off: miss → fallback and onCall fallback:true', async () => {
    const t = new FakeTransport(() => jsonReply({ ok: true, word: 'x' }));
    const res = await mk('replay-or-off', t).structured(req());
    expect(res.source).toBe('fallback');
    expect(res.value).toEqual(FALLBACK);
    expect(t.calls).toHaveLength(0);
    expect(records[0]).toMatchObject({ cached: false, fallback: true, usd: 0, purpose: 'test.purpose' });
  });

  it('record writes the cache; a second client in replay reads it (cached:true, usd 0)', async () => {
    const t = new FakeTransport(() => jsonReply({ ok: true, word: 'hi' }));
    const live = await mk('record', t).structured(req());
    expect(live).toMatchObject({ value: { ok: true, word: 'hi' }, source: 'live', path: 'output_config' });
    expect(live.usd).toBeCloseTo((100 * 4 + 50 * 20) / 1e6, 10);
    expect(records[0]).toMatchObject({ cached: false, inputTokens: 100, outputTokens: 50, path: 'output_config' });
    expect(await readdir(path.join(root, '.pramaan-cache', 'llm', 'demo'))).toHaveLength(1);

    const t2 = new FakeTransport(() => {
      throw new Error('must not be called');
    });
    const replayed = await mk('replay', t2).structured(req());
    expect(replayed).toMatchObject({ value: { ok: true, word: 'hi' }, source: 'cache', usd: 0 });
    expect(records[1]).toMatchObject({ cached: true, usd: 0 });
    expect(t2.calls).toHaveLength(0);

    // promptVersion is part of the key
    await expect(mk('replay', t2).structured(req({ promptVersion: '2' }))).rejects.toBeInstanceOf(LlmCacheMiss);
  });

  it('live: calls the API but does not write the cache', async () => {
    const t = new FakeTransport(() => jsonReply({ ok: true, word: 'hi' }));
    await mk('live', t).structured(req());
    await expect(readdir(path.join(root, '.pramaan-cache'))).rejects.toThrow();
  });

  it('sends output_config json_schema with additionalProperties:false and the untrusted notice', async () => {
    const t = new FakeTransport(() => jsonReply({ ok: true, word: 'hi' }));
    await mk('live', t).structured(req());
    const sent = t.calls[0];
    expect(sent?.output_config?.format.type).toBe('json_schema');
    expect(sent?.output_config?.format.schema).toMatchObject({ type: 'object', additionalProperties: false });
    expect(sent?.system).toContain(UNTRUSTED_NOTICE);
    expect(sent?.tools).toBeUndefined();
  });

  it.each([['refusal'], ['max_tokens']])('stop_reason %s → LlmOutputError', async (stop) => {
    const t = new FakeTransport(() => jsonReply({ ok: true, word: 'hi' }, stop));
    await expect(mk('record', t).structured(req())).rejects.toBeInstanceOf(LlmOutputError);
    // never cached
    await expect(readdir(path.join(root, '.pramaan-cache'))).rejects.toThrow();
  });

  it('zod-invalid output → LlmOutputError with issues', async () => {
    const t = new FakeTransport(() => jsonReply({ ok: 'yes' }));
    const err = await mk('live', t)
      .structured(req())
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmOutputError);
    expect((err as LlmOutputError).issues?.length).toBeGreaterThan(0);
  });

  it('non-JSON text → LlmOutputError', async () => {
    const t = new FakeTransport(() => ({ content: [{ type: 'text', text: 'sure!' }], stop_reason: 'end_turn', usage }));
    await expect(mk('live', t).structured(req())).rejects.toBeInstanceOf(LlmOutputError);
  });

  it('output_config rejection falls back to forced tool use and memoizes the path', async () => {
    const t = new FakeTransport((r) => {
      if (r.output_config) throw new LlmTransportError(400, 'output_config: Extra inputs are not permitted');
      return toolReply('test_out', { ok: true, word: 'tool' });
    });
    const c = mk('live', t);
    const res = await c.structured(req());
    expect(res).toMatchObject({ value: { ok: true, word: 'tool' }, path: 'tool' });
    expect(t.calls).toHaveLength(2);
    expect(t.calls[1]?.tool_choice).toEqual({ type: 'tool', name: 'test_out' });
    expect(t.calls[1]?.tools?.[0]?.input_schema).toMatchObject({ type: 'object' });
    expect(records.at(-1)).toMatchObject({ path: 'tool' });

    await c.structured(req({ user: 'again' }));
    expect(t.calls).toHaveLength(3); // memoized: straight to tool path
    expect(t.calls[2]?.output_config).toBeUndefined();
  });

  it('forced tool_choice rejection retries tool path with tool_choice auto', async () => {
    const t = new FakeTransport((r) => {
      if (r.tool_choice?.type === 'tool') {
        throw new LlmTransportError(400, 'tool_choice: type "tool" and "any" are not supported for this model.');
      }
      return toolReply('test_out', { ok: true, word: 'auto' });
    });
    const res = await mk('live', t).structured({ ...req(), preferPath: 'tool' });
    expect(res.value.word).toBe('auto');
    expect(t.calls.map((c) => c.tool_choice?.type)).toEqual(['tool', 'auto']);
  });

  it('other API errors propagate (no silent fallback)', async () => {
    const t = new FakeTransport(() => {
      throw new LlmTransportError(529, 'overloaded');
    });
    await expect(mk('live', t).structured(req())).rejects.toBeInstanceOf(LlmTransportError);
  });

  it('budget: throws LlmBudgetError before calling the transport; charges actual usd after', async () => {
    const t = new FakeTransport(() => jsonReply({ ok: true, word: 'hi' }));
    const charged: number[] = [];
    const tight = mk('live', t, { budget: { charge: (u) => charged.push(u), wouldExceed: () => true } });
    await expect(tight.structured(req())).rejects.toBeInstanceOf(LlmBudgetError);
    expect(t.calls).toHaveLength(0);

    const seen: number[] = [];
    const roomy = mk('live', t, {
      budget: {
        charge: (u) => charged.push(u),
        wouldExceed: (u) => {
          seen.push(u);
          return false;
        },
      },
    });
    await roomy.structured(req({ maxTokens: 1000 }));
    expect(seen[0]).toBeGreaterThanOrEqual((1000 * 20) / 1e6); // upper bound includes maxTokens output
    expect(charged).toEqual([expect.closeTo((100 * 4 + 50 * 20) / 1e6, 10)]);
  });

  it('redaction: a PAN in user/system text never reaches the transport', async () => {
    const t = new FakeTransport(() => jsonReply({ ok: true, word: 'hi' }));
    await mk('live', t).structured({
      ...req({ user: `Employee PAN is ABCDE1234F, see ${untrusted('page shows PQRSX9876Z')}` }),
      system: 'Context PAN ZZZZZ0000Z',
    });
    const wire = JSON.stringify(t.calls[0]);
    expect(wire).not.toMatch(/ABCDE1234F|PQRSX9876Z|ZZZZZ0000Z/);
    expect(wire).toContain('<untrusted_page_content>');
  });

  it('cache key uses redacted text (same PAN-free key for different PANs)', async () => {
    const t = new FakeTransport(() => jsonReply({ ok: true, word: 'hi' }));
    await mk('record', t).structured(req({ user: 'PAN ABCDE1234F' }));
    const res = await mk('replay', t).structured(req({ user: 'PAN QWERT5678Y' }));
    expect(res.source).toBe('cache');
  });

  it('live without transport and without ANTHROPIC_API_KEY → clear error', async () => {
    await expect(mk('live').structured(req())).rejects.toThrow(/ANTHROPIC_API_KEY is not set/);
  });

  it('toLlmJsonSchema strips unsupported constraints and closes objects', () => {
    const s = toLlmJsonSchema(z.object({ n: z.number().min(1).max(5), s: z.string().min(2), inner: z.object({ a: z.string() }) }));
    const txt = JSON.stringify(s);
    expect(txt).not.toMatch(/minimum|maximum|minLength|\$schema/);
    expect(s).toMatchObject({ additionalProperties: false, properties: { inner: { additionalProperties: false } } });
  });
});
