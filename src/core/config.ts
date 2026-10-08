// Loads apps/<id>/app.yaml and resolves env. Never logs env values.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { parse as parseYaml } from 'yaml';
import { AppConfig } from './schemas.js';

export class ConfigError extends Error {
  override name = 'ConfigError';
}

export interface MissingEnv {
  role?: string;
  tenant?: string;
  key: string;
  optional: boolean;
}

export interface LoadedConfig {
  config: AppConfig;
  env: Record<string, string>;
  missingEnv: MissingEnv[];
}

let cachedRoot: string | undefined;

/** Walks up from this file to the package.json named "pramaan". */
export function repoRoot(): string {
  if (cachedRoot) return cachedRoot;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg)) {
      try {
        const name = (JSON.parse(readFileSync(pkg, 'utf8')) as { name?: unknown }).name;
        if (name === 'pramaan') return (cachedRoot = dir);
      } catch {
        // unreadable package.json: keep walking
      }
    }
    const up = dirname(dir);
    if (up === dir) throw new ConfigError('could not find the pramaan repo root (package.json name "pramaan")');
    dir = up;
  }
}

const isSet = (v: string | undefined): v is string => v !== undefined && v !== '';

/** Fills keys that are missing or empty in `env` from a dotenv file, if it exists. */
function fillFrom(env: Record<string, string>, file: string): void {
  if (!existsSync(file)) return;
  const parsed = dotenv.parse(readFileSync(file));
  for (const [k, v] of Object.entries(parsed)) if (!isSet(env[k])) env[k] = v;
}

const VAR_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

/** ${VAR} and ${VAR:-default}; an unset VAR without a default is a ConfigError. */
export function interpolateEnv(text: string, env: Readonly<Record<string, string>>, source = 'config'): string {
  return text.replace(VAR_RE, (_m, name: string, def: string | undefined) => {
    const v = env[name];
    if (isSet(v)) return v;
    if (def !== undefined) return def;
    throw new ConfigError(`${source}: environment variable ${name} is not set and has no default`);
  });
}

export function loadAppConfig(appId: string, opts: { root?: string; env?: NodeJS.ProcessEnv } = {}): LoadedConfig {
  if (!/^[a-z][a-z0-9-]{1,30}$/.test(appId)) throw new ConfigError(`invalid app id: ${appId}`);
  const root = opts.root ?? repoRoot();
  const file = join(root, 'apps', appId, 'app.yaml');
  if (!existsSync(file)) throw new ConfigError(`app config not found: ${file}`);

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.env ?? process.env)) if (v !== undefined) env[k] = v;
  if (!opts.env) fillFrom(env, join(root, '.env'));
  fillFrom(env, join(root, 'apps', appId, 'fixture.env'));

  const text = interpolateEnv(readFileSync(file, 'utf8'), env, file);
  let raw: unknown;
  try {
    raw = parseYaml(text) as unknown;
  } catch (e) {
    throw new ConfigError(`${file}: YAML parse error: ${e instanceof Error ? e.message : String(e)}`);
  }
  const parsed = AppConfig.safeParse(raw);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new ConfigError(`${file}: invalid app config: ${msg}`);
  }
  const config = parsed.data;
  if (config.id !== appId) throw new ConfigError(`${file}: id "${config.id}" does not match app "${appId}"`);

  const missingEnv: MissingEnv[] = [];
  for (const t of config.tenants) {
    if (isSet(env[t.codeEnv])) continue;
    const roles = config.roles.filter((r) => r.tenant === t.id);
    missingEnv.push({ tenant: t.id, key: t.codeEnv, optional: roles.every((r) => r.optional) });
  }
  for (const r of config.roles) {
    const keys = [r.usernameEnv, r.passwordEnv, ...(r.totpSeedEnv ? [r.totpSeedEnv] : [])];
    for (const key of keys) if (!isSet(env[key])) missingEnv.push({ role: r.id, key, optional: r.optional });
  }

  return { config, env, missingEnv };
}
