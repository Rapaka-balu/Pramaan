import { describe, expect, it } from 'vitest';
import { TargetGuardError, createTargetGuard } from '../../src/core/target-guard.js';

const hrms = createTargetGuard({
  allowedOrigins: ['http://hrms-staging.blgtechnologies.in:82', 'http://hrms-staging.blgtechnologies.in:5002'],
  forbiddenHostPatterns: ['^(www\\.)?blgtechnologies\\.in$', '^(?!hrms-staging\\.).*blgtechnologies\\.in$'],
});

describe('target guard', () => {
  it('allows an allow-listed origin', () => {
    expect(hrms.check('http://hrms-staging.blgtechnologies.in:82/api/leaves?x=1')).toEqual({ ok: true });
    expect(() => hrms.assertAllowed('http://hrms-staging.blgtechnologies.in:5002/')).not.toThrow();
  });

  it('refuses a non-allowed origin (wrong port or host)', () => {
    expect(() => hrms.assertAllowed('http://hrms-staging.blgtechnologies.in:8080/')).toThrow(TargetGuardError);
    expect(() => hrms.assertAllowed('https://example.com/')).toThrow(/not in safety.allowedOrigins/);
  });

  it.each(['http://blgtechnologies.in/', 'https://www.blgtechnologies.in/', 'http://hrms.blgtechnologies.in:82/'])(
    'refuses production host %s via forbidden pattern',
    (url) => {
      expect(() => hrms.assertAllowed(url)).toThrow(/forbidden pattern/);
    },
  );

  it('forbidden pattern wins even when allow-listed', () => {
    const g = createTargetGuard({
      allowedOrigins: ['http://hrms.blgtechnologies.in'],
      forbiddenHostPatterns: ['^(?!hrms-staging\\.).*blgtechnologies\\.in$'],
    });
    const r = g.check('http://hrms.blgtechnologies.in/');
    expect(r.ok).toBe(false);
    expect(() => g.assertAllowed('http://hrms.blgtechnologies.in/')).toThrow(/forbidden pattern/);
  });

  it('treats default ports as equal origins', () => {
    const g = createTargetGuard({ allowedOrigins: ['https://app.test:443/'], forbiddenHostPatterns: [] });
    expect(g.check('https://app.test/x').ok).toBe(true);
    const h = createTargetGuard({ allowedOrigins: ['http://localhost:80'], forbiddenHostPatterns: [] });
    expect(h.check('http://localhost/').ok).toBe(true);
  });

  it('refuses non-http(s) and malformed URLs', () => {
    const g = createTargetGuard({ allowedOrigins: ['http://localhost:4600'], forbiddenHostPatterns: [] });
    expect(g.check('file:///etc/passwd').ok).toBe(false);
    expect(g.check('ws://localhost:4600/').ok).toBe(false);
    expect(g.check('not a url').ok).toBe(false);
  });

  it('rejects invalid configuration', () => {
    expect(() => createTargetGuard({ allowedOrigins: ['nope'], forbiddenHostPatterns: [] })).toThrow(TargetGuardError);
    expect(() => createTargetGuard({ allowedOrigins: ['http://a.test'], forbiddenHostPatterns: ['('] })).toThrow(TargetGuardError);
  });
});
