import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError, interpolateEnv, loadAppConfig, repoRoot } from '../../src/core/config.js';

const APP_YAML = `schemaVersion: 1
id: demo
name: Demo HRMS
baseUrl: http://localhost:\${DEMO_PORT:-4600}
tenants:
  - { id: primary, codeEnv: DEMO_TENANT_PRIMARY }
  - { id: secondary, codeEnv: DEMO_TENANT_SECONDARY }
roles:
  - { id: employee, tenant: primary, usernameEnv: DEMO_EMP_USER, passwordEnv: DEMO_PASSWORD }
  - { id: other, tenant: secondary, usernameEnv: DEMO_OTHER_USER, passwordEnv: DEMO_PASSWORD, optional: true }
login: { url: /login }
safety:
  allowedOrigins: [http://localhost:\${DEMO_PORT:-4600}]
  denyActionPatterns: [delete]
output: { repoPath: ../suite }
`;

let root: string;
const write = (rel: string, text: string): void => {
  const p = join(root, ...rel.split('/'));
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, text);
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pramaan-config-'));
  write('apps/demo/app.yaml', APP_YAML);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('loadAppConfig', () => {
  it('parses app.yaml with defaults and reports missing env with optionality', () => {
    const { config, missingEnv } = loadAppConfig('demo', { root, env: {} });
    expect(config.baseUrl).toBe('http://localhost:4600');
    expect(config.safety.maxRps).toBe(2);
    expect(missingEnv).toEqual([
      { tenant: 'primary', key: 'DEMO_TENANT_PRIMARY', optional: false },
      { tenant: 'secondary', key: 'DEMO_TENANT_SECONDARY', optional: true },
      { role: 'employee', key: 'DEMO_EMP_USER', optional: false },
      { role: 'employee', key: 'DEMO_PASSWORD', optional: false },
      { role: 'other', key: 'DEMO_OTHER_USER', optional: true },
      { role: 'other', key: 'DEMO_PASSWORD', optional: true },
    ]);
  });

  it('interpolates ${VAR} from env (target guard sees the same origin)', () => {
    const { config } = loadAppConfig('demo', { root, env: { DEMO_PORT: '5123' } });
    expect(config.baseUrl).toBe('http://localhost:5123');
    expect(config.safety.allowedOrigins).toEqual(['http://localhost:5123']);
  });

  it('fixture.env fills gaps but never overrides given env; empty counts as missing', () => {
    write('apps/demo/fixture.env', 'DEMO_TENANT_PRIMARY=TEST\nDEMO_PASSWORD=Demo@123\nDEMO_EMP_USER=fixture\nDEMO_PORT=4700\n');
    const { env, missingEnv, config } = loadAppConfig('demo', { root, env: { DEMO_EMP_USER: 'real', DEMO_PASSWORD: '' } });
    expect(env['DEMO_EMP_USER']).toBe('real');
    expect(env['DEMO_PASSWORD']).toBe('Demo@123');
    expect(config.baseUrl).toBe('http://localhost:4700');
    expect(missingEnv.map((m) => m.key)).toEqual(['DEMO_TENANT_SECONDARY', 'DEMO_OTHER_USER']);
  });

  it('loads <root>/.env only when no env is passed, without overriding real env', () => {
    write('.env', 'DEMO_TENANT_PRIMARY=FROM_DOTENV\nPRAMAAN_TEST_UNSET_KEY=x\n');
    const saved = process.env['DEMO_TENANT_PRIMARY'];
    process.env['DEMO_TENANT_PRIMARY'] = 'REAL';
    try {
      const { env } = loadAppConfig('demo', { root });
      expect(env['DEMO_TENANT_PRIMARY']).toBe('REAL');
      expect(env['PRAMAAN_TEST_UNSET_KEY']).toBe('x');
      expect(process.env['PRAMAAN_TEST_UNSET_KEY']).toBeUndefined();
      expect(loadAppConfig('demo', { root, env: {} }).env['PRAMAAN_TEST_UNSET_KEY']).toBeUndefined();
    } finally {
      if (saved === undefined) delete process.env['DEMO_TENANT_PRIMARY'];
      else process.env['DEMO_TENANT_PRIMARY'] = saved;
    }
  });

  it('marks a tenant optional only when every role on it is optional', () => {
    write('apps/demo/app.yaml', APP_YAML.replace('passwordEnv: DEMO_PASSWORD }\n  - { id: other', 'passwordEnv: DEMO_PASSWORD }\n  - { id: emp3, tenant: secondary, usernameEnv: X3, passwordEnv: Y3 }\n  - { id: other'));
    const { missingEnv } = loadAppConfig('demo', { root, env: {} });
    expect(missingEnv.find((m) => m.tenant === 'secondary')?.optional).toBe(false);
  });

  it('includes totpSeedEnv when declared', () => {
    write('apps/demo/app.yaml', APP_YAML.replace('usernameEnv: DEMO_EMP_USER,', 'usernameEnv: DEMO_EMP_USER, totpSeedEnv: DEMO_TOTP,'));
    const { missingEnv } = loadAppConfig('demo', { root, env: {} });
    expect(missingEnv).toContainEqual({ role: 'employee', key: 'DEMO_TOTP', optional: false });
  });

  it('throws ConfigError naming an unset variable without default', () => {
    write('apps/demo/app.yaml', APP_YAML.replace('name: Demo HRMS', 'name: ${DEMO_NAME}'));
    expect(() => loadAppConfig('demo', { root, env: {} })).toThrow(/DEMO_NAME/);
    expect(() => loadAppConfig('demo', { root, env: {} })).toThrow(ConfigError);
  });

  it('throws ConfigError on schema errors, unknown apps, bad ids and id mismatch', () => {
    write('apps/bad/app.yaml', 'schemaVersion: 2\n');
    expect(() => loadAppConfig('bad', { root, env: {} })).toThrow(ConfigError);
    expect(() => loadAppConfig('missing', { root, env: {} })).toThrow(/not found/);
    expect(() => loadAppConfig('../etc', { root, env: {} })).toThrow(/invalid app id/);
    write('apps/other/app.yaml', APP_YAML);
    expect(() => loadAppConfig('other', { root, env: {} })).toThrow(/does not match/);
  });
});

describe('interpolateEnv', () => {
  it('handles defaults, set values, empty values and leaves DSL refs alone', () => {
    expect(interpolateEnv('a=${A} b=${B:-dflt} c=${C:-} d=${data.days}', { A: '1', B: '' })).toBe('a=1 b=dflt c= d=${data.days}');
  });
});

describe('repoRoot', () => {
  it('finds the pramaan package root', () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot(), 'package.json'), 'utf8')) as { name: string };
    expect(pkg.name).toBe('pramaan');
  });
});
