// Idempotent suite writer (§8 M6): a file is (re)written only when its content changed; a file a human edited
// (or created) is never overwritten. Ownership is tracked in .pramaan/manifest.json (path → sha1 of what we wrote).
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const MANIFEST = '.pramaan/manifest.json';
const sha1 = (s: string): string => createHash('sha1').update(s).digest('hex');

export interface WriteResult {
  written: string[];
  unchanged: string[];
  handEdited: string[]; // left alone
  removed: string[];
}

function readManifest(repo: string): Record<string, string> {
  const p = join(repo, MANIFEST);
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as Record<string, string>;
  } catch {
    return {};
  }
}

export function writeSuite(repo: string, files: ReadonlyMap<string, string>): WriteResult {
  const manifest = readManifest(repo);
  const next: Record<string, string> = {};
  const res: WriteResult = { written: [], unchanged: [], handEdited: [], removed: [] };
  for (const [rel, content] of [...files.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const abs = join(repo, rel);
    if (existsSync(abs)) {
      const current = readFileSync(abs, 'utf8');
      if (current === content) {
        res.unchanged.push(rel);
        next[rel] = sha1(content);
        continue;
      }
      const ours = manifest[rel] !== undefined && manifest[rel] === sha1(current);
      if (!ours) {
        res.handEdited.push(rel);
        if (manifest[rel] !== undefined) next[rel] = manifest[rel];
        continue;
      }
    }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    res.written.push(rel);
    next[rel] = sha1(content);
  }
  // Files we generated before and no longer produce: removed, unless a human changed them since.
  for (const [rel, hash] of Object.entries(manifest)) {
    if (files.has(rel)) continue;
    const abs = join(repo, rel);
    if (existsSync(abs) && sha1(readFileSync(abs, 'utf8')) === hash) {
      rmSync(abs);
      res.removed.push(rel);
    }
  }
  const sorted = Object.fromEntries(Object.entries(next).sort(([a], [b]) => a.localeCompare(b)));
  mkdirSync(join(repo, '.pramaan'), { recursive: true });
  const text = `${JSON.stringify(sorted, null, 2)}\n`;
  if (!existsSync(join(repo, MANIFEST)) || readFileSync(join(repo, MANIFEST), 'utf8') !== text) writeFileSync(join(repo, MANIFEST), text);
  return res;
}

export interface Cmd {
  status: number;
  out: string;
}
/** Runs a command; on Windows npm/npx are .cmd shims that need a shell, so the line is built with quoted args. */
export function run(cmd: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): Cmd {
  const opts = { cwd, env: env ?? process.env, encoding: 'utf8' as const, maxBuffer: 64 * 1024 * 1024 };
  const quote = (a: string): string => (/^[\w@./:=,-]+$/.test(a) ? a : `"${a.replace(/"/g, '\\"')}"`);
  const r = process.platform === 'win32' ? spawnSync([cmd, ...args].map(quote).join(' '), { ...opts, shell: true }) : spawnSync(cmd, args, opts);
  return { status: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const GIT_ID = ['-c', 'user.name=Pramaan', '-c', 'user.email=pramaan@localhost', '-c', 'commit.gpgsign=false'];

/** git init on first use; commits a change set on branch pramaan/compile-<runId>. No changes → no branch, no commit. */
export function commitSuite(repo: string, runId: string, message: string): { branch?: string; commit?: string; changed: boolean } {
  if (!existsSync(join(repo, '.git'))) {
    run('git', ['init', '-q', '-b', 'main'], repo);
    run('git', [...GIT_ID, 'commit', '-q', '--allow-empty', '-m', 'chore: initialise Pramaan suite repo'], repo);
  }
  if (run('git', ['status', '--porcelain'], repo).out.trim() === '') return { changed: false };
  const branch = `pramaan/compile-${runId}`;
  run('git', ['checkout', '-q', '-b', branch], repo);
  run('git', ['add', '-A'], repo);
  run('git', [...GIT_ID, 'commit', '-q', '-m', message], repo);
  return { branch, commit: run('git', ['rev-parse', '--short', 'HEAD'], repo).out.trim(), changed: true };
}

/** Async variant: keeps the event loop free (an in-process server, e.g. the demo app in tests, keeps answering). */
export function runAsync(cmd: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): Promise<Cmd> {
  const quote = (a: string): string => (/^[\w@./:=,-]+$/.test(a) ? a : `"${a.replace(/"/g, '\\"')}"`);
  return new Promise((resolvePromise) => {
    const opts = { cwd, env: env ?? process.env };
    const child = process.platform === 'win32' ? spawn([cmd, ...args].map(quote).join(' '), { ...opts, shell: true }) : spawn(cmd, args, opts);
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (out += d.toString('utf8')));
    child.on('close', (code) => resolvePromise({ status: code ?? 1, out }));
    child.on('error', (e) => resolvePromise({ status: 1, out: `${out}${e.message}` }));
  });
}
