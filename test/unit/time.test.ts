import { describe, expect, it } from 'vitest';
import { istDate, istDatePlus, istParts, nowIso } from '../../src/core/time.js';
import { RUN_ID_RE, newRunId, runTag } from '../../src/core/run-id.js';
import { sha1, sha256, stableStringify } from '../../src/core/stable-json.js';

describe('time', () => {
  const t = new Date('2026-10-08T08:33:00.123Z'); // 14:03:00.123 IST

  it('nowIso uses +05:30', () => {
    expect(nowIso(t)).toBe('2026-10-08T14:03:00.123+05:30');
    expect(new Date(nowIso(t)).getTime()).toBe(t.getTime());
  });

  it('istDate crosses midnight before UTC does', () => {
    expect(istDate(new Date('2026-10-08T18:45:00Z'))).toBe('2026-10-09');
    expect(istDate(new Date('2026-10-08T18:29:59Z'))).toBe('2026-10-08');
    expect(nowIso(new Date('2026-10-08T18:45:00Z'))).toBe('2026-10-09T00:15:00.000+05:30');
  });

  it('istDatePlus handles month/year rollover and negatives', () => {
    expect(istDatePlus(7, t)).toBe('2026-10-15');
    expect(istDatePlus(0, new Date('2026-10-08T18:45:00Z'))).toBe('2026-10-09');
    expect(istDatePlus(1, new Date('2026-12-31T10:00:00Z'))).toBe('2027-01-01');
    expect(istDatePlus(-8, t)).toBe('2026-09-30');
  });

  it('istParts are zero-padded', () => {
    expect(istParts(new Date('2026-01-01T00:00:05.007Z'))).toEqual({
      year: '2026', month: '01', day: '01', hour: '05', minute: '30', second: '05', ms: '007',
    });
  });
});

describe('run-id', () => {
  it('formats YYYYMMDD-HHmm-hex in IST', () => {
    const id = newRunId(new Date('2026-10-08T18:45:00Z'), () => 'ab12');
    expect(id).toBe('20261009-0015-ab12');
    expect(RUN_ID_RE.test(id)).toBe(true);
  });

  it('defaults to random hex', () => {
    expect(newRunId()).toMatch(RUN_ID_RE);
  });

  it('rejects bad randHex', () => {
    expect(() => newRunId(new Date(), () => 'xyz')).toThrow(/4 hex/);
  });

  it('RUN_ID_RE rejects malformed ids', () => {
    expect(RUN_ID_RE.test('2026108-1430-ab12')).toBe(false);
    expect(RUN_ID_RE.test('20261008-1430-AB12')).toBe(false);
  });

  it('runTag', () => {
    expect(runTag('PRM', '20261008-1430-ab12')).toBe('PRM-20261008-1430-ab12');
  });
});

describe('stable-json', () => {
  it('sorts keys recursively and is order-independent', () => {
    const a = { b: 1, a: { d: [{ z: 1, y: 2 }], c: null } };
    const b = { a: { c: null, d: [{ y: 2, z: 1 }] }, b: 1 };
    expect(stableStringify(a)).toBe('{"a":{"c":null,"d":[{"y":2,"z":1}]},"b":1}');
    expect(stableStringify(a)).toBe(stableStringify(b));
  });

  it('keeps array order, omits undefined, honours indent', () => {
    expect(stableStringify([3, 1, 2])).toBe('[3,1,2]');
    expect(stableStringify({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(stableStringify({ b: 1, a: 2 }, 2)).toBe('{\n  "a": 2,\n  "b": 1\n}');
    expect(stableStringify(undefined)).toBe('null');
  });

  it('hashes', () => {
    expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha1('abc')).toBe('a9993e364706816aba3e25717850c26c9cd0d89d');
  });
});
