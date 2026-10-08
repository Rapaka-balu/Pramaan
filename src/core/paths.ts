// Where Pramaan keeps run state. PRAMAAN_STATE_ROOT lets tests use a temp dir; default is the repo root.
import { join } from 'node:path';
import { repoRoot } from './config.js';

export function stateRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env['PRAMAAN_STATE_ROOT'] || repoRoot();
}

export function workspaceDir(root: string, app: string, ...parts: string[]): string {
  return join(root, 'workspace', app, ...parts);
}
