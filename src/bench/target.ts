// Bug activation for the bench (§8 M8): the demo app restarts in-process with the bug's env on a fixed port
// (so stored sessions stay valid); any other app (HRMS) is activated by hand and the runner waits.
import { createServer } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { repoRoot } from '../core/config.js';

export interface Target {
  stop(): Promise<void>;
}
export type Activation = { env: Record<string, string> } | { manual: string };

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      s.close(() => resolve(port));
    });
  });
}

interface DemoModule {
  startDemo(o: { port?: number; env?: Record<string, string | undefined> }): Promise<{ close(): Promise<void> }>;
}

export async function activate(
  appId: string,
  activation: Activation,
  opts: { port: number; ask?: (message: string) => Promise<void> },
): Promise<Target> {
  if ('env' in activation && appId === 'demo') {
    const mod = (await import(pathToFileURL(join(repoRoot(), 'fixtures', 'demo-hrms', 'server.mjs')).href)) as DemoModule;
    const demo = await mod.startDemo({ port: opts.port, env: { ...process.env, ...activation.env } });
    return { stop: () => demo.close() };
  }
  const message = 'manual' in activation ? activation.manual : `set ${Object.entries(activation.env).map(([k, v]) => `${k}=${v}`).join(' ')} on the target`;
  const ask =
    opts.ask ??
    (async (m: string): Promise<void> => {
      const { input } = await import('@inquirer/prompts');
      await input({ message: `${m} — press Enter when ready` });
    });
  await ask(message);
  return { stop: async () => undefined };
}
