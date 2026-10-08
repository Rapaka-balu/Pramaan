import { describe, expect, it } from 'vitest';
import { createLogger } from '../../src/core/log.js';

function capture(): { dest: { write(s: string): void }; lines: string[] } {
  const lines: string[] = [];
  return { dest: { write: (s: string) => void lines.push(s) }, lines };
}

describe('createLogger', () => {
  it('redacts messages, objects and errors before writing', () => {
    const { dest, lines } = capture();
    const log = createLogger('t', dest);
    log.info({ headers: { authorization: 'Bearer abcdefghijk' }, salary: 90000 }, 'user PAN ABCDE1234F');
    log.error(new Error('phone 9876543210 failed'));
    log.warn({ err: new Error('aadhaar 234567890123') }, 'x');
    const out = lines.join('');
    expect(out).not.toMatch(/abcdefghijk|90000|ABCDE1234F|9876543210|234567890123/);
    expect(out).toMatch(/\[REDACTED:pan\]/);
    expect(out).toMatch(/\[REDACTED:phone\]/);
    expect(out).toMatch(/"name":"t"/);
  });
});
