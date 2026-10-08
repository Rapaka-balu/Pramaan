import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { repoRoot } from '../../src/core/config.js';

// exit 0 = ignored, 1 = not ignored
function ignored(path: string): boolean {
  const r = spawnSync('git', ['check-ignore', '-q', '--no-index', path], { cwd: repoRoot(), encoding: 'utf8' });
  if (r.status !== 0 && r.status !== 1) throw new Error(`git check-ignore failed: ${r.stderr}`);
  return r.status === 0;
}

describe('.gitignore (§6)', () => {
  it.each(['.pramaan-cache/llm/hrms/x.json', 'workspace/demo/a.json', '.env', '.pramaan-cache/other/x'])('ignores %s', (p) => {
    expect(ignored(p)).toBe(true);
  });

  it('keeps the demo LLM cache committable', () => {
    expect(ignored('.pramaan-cache/llm/demo/x.json')).toBe(false);
  });
});
