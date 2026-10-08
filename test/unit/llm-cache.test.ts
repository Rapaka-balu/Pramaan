import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LlmCache, cacheKey, type CacheKeyInput } from '../../src/llm/cache.js';
import { loadPrompt, parsePrompt } from '../../src/llm/prompts.js';

const base: CacheKeyInput = {
  appId: 'demo',
  model: 'claude-opus-5-5',
  system: 'sys',
  messages: [{ role: 'user', content: 'hello' }],
  schemaHash: 'abc',
  promptVersion: '1',
};

describe('cacheKey', () => {
  it('is a stable sha256 hex', () => {
    const a = cacheKey(base);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
    expect(cacheKey({ ...base, messages: [{ content: 'hello', role: 'user' }] })).toBe(a);
  });

  it.each([
    ['appId', { appId: 'hrms' }],
    ['model', { model: 'claude-sonnet-5-5' }],
    ['system', { system: 'sys2' }],
    ['messages', { messages: [{ role: 'user', content: 'hello!' }] }],
    ['schemaHash', { schemaHash: 'abd' }],
    ['promptVersion', { promptVersion: '2' }],
  ] as const)('changes when %s changes', (_name, patch) => {
    expect(cacheKey({ ...base, ...patch })).not.toBe(cacheKey(base));
  });
});

describe('LlmCache', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'pramaan-llm-cache-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('round-trips an entry under .pramaan-cache/llm/<appId>/<key>.json', async () => {
    const cache = new LlmCache(root, 'demo');
    const key = cacheKey(base);
    expect(await cache.get(key)).toBeUndefined();
    await cache.put({
      key,
      model: base.model,
      purpose: 'test',
      createdAt: '2026-10-08T00:00:00.000Z',
      response: { json: { a: 1 }, usage: { inputTokens: 3, outputTokens: 4 }, stopReason: 'end_turn' },
    });
    const file = path.join(root, '.pramaan-cache', 'llm', 'demo', `${key}.json`);
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ key, purpose: 'test' });
    const got = await cache.get(key);
    expect(got?.response.json).toEqual({ a: 1 });
    expect(got?.response.usage.outputTokens).toBe(4);
  });

  it('rejects invalid keys and app ids (no path traversal)', () => {
    expect(() => new LlmCache(root, '../x')).toThrow();
    expect(() => new LlmCache(root, 'demo').fileFor('../../etc')).toThrow();
  });

  it('throws on a corrupt entry', async () => {
    const cache = new LlmCache(root, 'demo');
    const key = cacheKey(base);
    await mkdir(cache.dir, { recursive: true });
    await writeFile(cache.fileFor(key), JSON.stringify({ key }), 'utf8');
    await expect(cache.get(key)).rejects.toThrow(/corrupt/);
  });
});

describe('prompts', () => {
  it('parses front-matter version and body', () => {
    expect(parsePrompt('---\nversion: 3\n---\nHello\n')).toEqual({ version: '3', body: 'Hello' });
    expect(parsePrompt('---\r\nversion: "1.2"\r\ntitle: x\r\n---\r\nBody')).toEqual({ version: '1.2', body: 'Body' });
  });

  it('rejects missing front-matter or version', () => {
    expect(() => parsePrompt('no front matter')).toThrow(/front-matter/);
    expect(() => parsePrompt('---\ntitle: x\n---\nbody')).toThrow(/version/);
  });

  it('loads <dir>/<name>.md and rejects traversal', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'pramaan-prompts-'));
    try {
      await writeFile(path.join(dir, 'propose-rules.md'), '---\nversion: 7\n---\nDo it.\n', 'utf8');
      expect(loadPrompt('propose-rules', dir)).toEqual({ version: '7', body: 'Do it.' });
      expect(() => loadPrompt('../secret', dir)).toThrow(/invalid prompt name/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
