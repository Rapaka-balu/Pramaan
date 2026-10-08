// File cache for LLM responses (§2.4): <root>/.pramaan-cache/llm/<appId>/<key>.json
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { sha256, stableStringify } from '../core/stable-json.js';

export interface CacheKeyInput {
  appId: string;
  model: string;
  system: string;
  messages: ReadonlyArray<{ role: string; content: string }>;
  schemaHash: string;
  promptVersion: string;
}

export const CachedUsage = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative().optional(),
  cacheWriteTokens: z.number().int().nonnegative().optional(),
});

export const CacheEntry = z.object({
  key: z.string().regex(/^[a-f0-9]{64}$/),
  model: z.string(),
  purpose: z.string(),
  createdAt: z.string(),
  path: z.enum(['output_config', 'tool']).optional(),
  response: z.object({
    json: z.unknown(),
    usage: CachedUsage,
    stopReason: z.string().nullable(),
  }),
});
export type CacheEntry = z.infer<typeof CacheEntry>;

const KEY_RE = /^[a-f0-9]{64}$/;
const APP_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** sha256 of a stable serialization of every input that affects the answer. */
export function cacheKey(input: CacheKeyInput): string {
  return sha256(
    stableStringify({
      appId: input.appId,
      model: input.model,
      system: input.system,
      messages: input.messages.map((m) => ({ role: m.role, content: m.content })),
      schemaHash: input.schemaHash,
      promptVersion: input.promptVersion,
    }),
  );
}

export class LlmCache {
  readonly dir: string;

  constructor(root: string, appId: string) {
    if (!APP_RE.test(appId)) throw new Error(`invalid appId for LLM cache: ${appId}`);
    this.dir = path.join(root, '.pramaan-cache', 'llm', appId);
  }

  fileFor(key: string): string {
    if (!KEY_RE.test(key)) throw new Error(`invalid cache key: ${key}`);
    return path.join(this.dir, `${key}.json`);
  }

  async get(key: string): Promise<CacheEntry | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.fileFor(key), 'utf8');
    } catch (err) {
      if (isNotFound(err)) return undefined;
      throw err;
    }
    const parsed = CacheEntry.safeParse(JSON.parse(raw));
    if (!parsed.success) throw new Error(`corrupt LLM cache entry ${key}: ${parsed.error.message}`);
    if (parsed.data.key !== key) throw new Error(`LLM cache entry ${key} has mismatched key ${parsed.data.key}`);
    return parsed.data;
  }

  async put(entry: CacheEntry): Promise<void> {
    const file = this.fileFor(entry.key);
    await mkdir(this.dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, stableStringify(entry, 2) + '\n', 'utf8');
    await rename(tmp, file);
  }
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code: unknown }).code === 'ENOENT';
}
