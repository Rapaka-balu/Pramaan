import { describe, expect, it } from 'vitest';
import {
  buildAuthMaterial,
  deriveAuthScheme,
  type HarEntryLike,
  type StorageStateLike,
} from '../../src/onboarding/auth-material.js';

const ORIGIN = 'http://localhost:4600';
const entry = (method: string, path: string, headers: Record<string, string>, status = 200): HarEntryLike => ({
  request: { method, url: `${ORIGIN}${path}`, headers: Object.entries(headers).map(([name, value]) => ({ name, value })) },
  response: { status },
});
const common = { Accept: '*/*', 'User-Agent': 'x', 'sec-ch-ua': 'y', Referer: `${ORIGIN}/dashboard` };
const storage = (ls: Record<string, string>, cookies: StorageStateLike['cookies'] = []): StorageStateLike => ({
  cookies,
  origins: [{ origin: ORIGIN, localStorage: Object.entries(ls).map(([name, value]) => ({ name, value })) }],
});

describe('deriveAuthScheme', () => {
  const har = [
    entry('POST', '/api/auth/login', { ...common, 'Content-Type': 'application/json' }),
    entry('GET', '/api/me', { ...common, Authorization: 'Bearer tok123', 'X-Tenant-Code': 'TEST' }),
    entry('GET', '/api/leave-balance', { ...common, Authorization: 'Bearer tok123', 'X-Tenant-Code': 'TEST' }),
  ];

  it('should_find_bearer_in_localstorage_when_authorization_matches_a_stored_value', () => {
    const s = deriveAuthScheme(har, storage({ 'demo.token': 'tok123', other: 'z' }));
    expect(s.bearer).toEqual({ source: 'localStorage', key: 'demo.token', header: 'Authorization', prefix: 'Bearer ' });
  });

  it('should_detect_tenant_header_when_a_custom_header_is_on_every_api_call', () => {
    const s = deriveAuthScheme(har, storage({ 'demo.token': 'tok123' }));
    expect(s.tenantHeader).toEqual({ name: 'X-Tenant-Code', value: 'TEST' });
  });

  it('should_ignore_login_call_and_standard_headers_when_diffing', () => {
    const s = deriveAuthScheme(har, storage({ t: 'tok123' }));
    expect(s.tenantHeader?.name).not.toMatch(/^(accept|user-agent|referer|sec-)/i);
  });

  it('should_pick_first_successful_get_as_probe', () => {
    const s = deriveAuthScheme(har, storage({ t: 'tok123' }));
    expect(s.probe).toEqual({ method: 'GET', url: `${ORIGIN}/api/me` });
  });

  it('should_match_json_quoted_localstorage_tokens', () => {
    const s = deriveAuthScheme(har, storage({ auth: '"tok123"' }));
    expect(s.bearer).toMatchObject({ source: 'localStorage', key: 'auth' });
  });

  it('should_use_cookie_scheme_when_no_authorization_header_is_sent', () => {
    const cookieHar = [
      entry('GET', '/api/me', { ...common, Cookie: 'sid=abc; theme=dark' }),
      entry('GET', '/api/x', { ...common, Cookie: 'sid=abc' }),
    ];
    const s = deriveAuthScheme(cookieHar, storage({}));
    expect(s.bearer).toEqual({ source: 'cookie', names: ['sid', 'theme'] });
  });

  it('should_return_empty_scheme_when_no_authenticated_api_calls', () => {
    expect(deriveAuthScheme([entry('GET', '/assets/app.js', common)], storage({}))).toEqual({});
  });

  it('should_not_pick_a_header_whose_value_varies_between_calls', () => {
    const varying = [
      entry('GET', '/api/a', { Authorization: 'Bearer t', 'X-Request-Id': '1' }),
      entry('GET', '/api/b', { Authorization: 'Bearer t', 'X-Request-Id': '2' }),
    ];
    expect(deriveAuthScheme(varying, storage({ k: 't' })).tenantHeader).toBeUndefined();
  });
});

describe('buildAuthMaterial', () => {
  const scheme = {
    bearer: { source: 'localStorage' as const, key: 'demo.token', header: 'Authorization', prefix: 'Bearer ' },
    tenantHeader: { name: 'X-Tenant-Code', value: 'TEST' },
  };

  it('should_build_bearer_and_tenant_headers_from_stored_session', () => {
    const m = buildAuthMaterial(scheme, storage({ 'demo.token': 'tok9' }), ORIGIN);
    expect(m.headers).toEqual({ Authorization: 'Bearer tok9', 'X-Tenant-Code': 'TEST' });
  });

  it('should_omit_authorization_when_token_was_deleted_from_session', () => {
    const m = buildAuthMaterial(scheme, storage({}), ORIGIN);
    expect(m.headers['Authorization']).toBeUndefined();
    expect(m.headers['X-Tenant-Code']).toBe('TEST');
  });

  it('should_build_cookie_header_for_cookie_scheme', () => {
    const cookies = [
      { name: 'sid', value: 'abc', domain: 'localhost', path: '/' },
      { name: 'ga', value: 'zz', domain: 'localhost', path: '/' },
    ];
    const m = buildAuthMaterial({ bearer: { source: 'cookie', names: ['sid'] } }, storage({}, cookies), ORIGIN);
    expect(m.headers['Cookie']).toBe('sid=abc');
    expect(m.cookies).toHaveLength(1);
  });
});
