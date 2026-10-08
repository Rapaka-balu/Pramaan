// Prompt loader (§2.4): src/llm/prompts/<name>.md with YAML front-matter `version:`.
// Bumping the version changes every cache key built from it.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

export interface LoadedPrompt {
  version: string;
  body: string;
}

const DEFAULT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'prompts');
const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/i;
const FRONT_MATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

export function parsePrompt(text: string, source = '<prompt>'): LoadedPrompt {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const m = FRONT_MATTER_RE.exec(text);
  if (!m) throw new Error(`${source}: missing front-matter block with version:`);
  const meta: unknown = parseYaml(m[1] ?? '');
  const version =
    typeof meta === 'object' && meta !== null && 'version' in meta ? (meta as { version: unknown }).version : undefined;
  if (typeof version !== 'string' && typeof version !== 'number') {
    throw new Error(`${source}: front-matter must define version: (string or number)`);
  }
  return { version: String(version), body: text.slice(m[0].length).trim() };
}

export function loadPrompt(name: string, dir: string = DEFAULT_DIR): LoadedPrompt {
  if (!NAME_RE.test(name) || name.includes('..')) throw new Error(`invalid prompt name: ${name}`);
  const file = path.join(dir, `${name}.md`);
  return parsePrompt(readFileSync(file, 'utf8'), file);
}
