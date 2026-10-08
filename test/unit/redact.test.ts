import { describe, expect, it } from 'vitest';
import { redact, redactText } from '../../src/core/redact.js';

describe('redactText', () => {
  it.each([
    ['PAN', 'PAN is ABCDE1234F.', 'PAN is [REDACTED:pan].'],
    ['Aadhaar plain', 'aadhaar 234567890123 ok', 'aadhaar [REDACTED:aadhaar] ok'],
    ['Aadhaar spaced', 'id: 2345 6789 0123', 'id: [REDACTED:aadhaar]'],
    ['Aadhaar hyphen', '2345-6789-0123', '[REDACTED:aadhaar]'],
    ['IFSC', 'IFSC HDFC0001234 branch', 'IFSC [REDACTED:ifsc] branch'],
    ['phone bare', 'call 9876543210 now', 'call [REDACTED:phone] now'],
    ['phone +91 spaced', 'call +91 98765 43210', 'call [REDACTED:phone]'],
    ['phone +91 compact', 'm:+919876543210', 'm:[REDACTED:phone]'],
    ['phone 0-prefix', 'tel 09876543210', 'tel [REDACTED:phone]'],
    ['phone 3-3-4', 'tel 987-654-3210', 'tel [REDACTED:phone]'],
    ['Bearer', 'Authorization: Bearer abc.def.ghi123', 'Authorization: [REDACTED:auth]'],
    ['Bearer inline', 'sent Bearer sk_live_abcdefgh123', 'sent Bearer [REDACTED:token]'],
    ['cookie header line', 'Cookie: sid=abc123; x=1', 'Cookie: [REDACTED:auth]'],
    [
      'JWT',
      'tok eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig_nature-x end',
      'tok [REDACTED:jwt] end',
    ],
    ['password in raw body', 'user=a&password=hunter2&x=1', 'user=a&password=[REDACTED:secret]&x=1'],
    ['password in JSON text', '{"password":"hunter2"}', '{"password":"[REDACTED:secret]"}'],
  ])('redacts %s', (_name, input, expected) => {
    expect(redactText(input)).toBe(expected);
  });

  it.each([
    ['ISO date', '2026-10-08'],
    ['ISO timestamp', '2026-10-08T14:03:00.123+05:30'],
    ['run tag', 'PRM-20261008-1430-ab12 leave reason'],
    ['small id', 'leave 4211 for user 17'],
    ['lowercase pan-like', 'abcde1234f'],
    ['phone starting with 5', '5876543210'],
    ['13-digit epoch ms', 'at 1791234567890'],
    ['16-digit card-like run is not aadhaar', '1234-5678-9012-3456'.replace(/-/g, '')],
    ['ifsc without 0 at 5th', 'HDFCX001234'],
    ['token counts', '{"inputTokens":120,"outputTokens":30}'],
    ['plain prose', 'Approving a submitted leave deducts the requested days'],
  ])('leaves %s alone', (_name, input) => {
    expect(redactText(input)).toBe(input);
  });

  it('is idempotent', () => {
    const once = redactText('PAN ABCDE1234F phone 9876543210');
    expect(redactText(once)).toBe(once);
  });
});

describe('redact (deep)', () => {
  it('redacts header-named keys regardless of value', () => {
    expect(redact({ Authorization: 'Bearer x', cookie: 'sid=1', 'X-Api-Key': 'k', accept: 'json' })).toEqual({
      Authorization: '[REDACTED:auth]',
      cookie: '[REDACTED:auth]',
      'X-Api-Key': '[REDACTED:auth]',
      accept: 'json',
    });
  });

  it('redacts HAR-style name/value header pairs', () => {
    const har = { headers: [{ name: 'Set-Cookie', value: 'a=b' }, { name: 'Accept', value: 'text/html' }] };
    expect(redact(har)).toEqual({
      headers: [{ name: 'Set-Cookie', value: '[REDACTED:auth]' }, { name: 'Accept', value: 'text/html' }],
    });
  });

  it('redacts password/secret/token string values but keeps numeric token counts', () => {
    expect(redact({ password: 'p', clientSecret: 's', accessToken: 't', inputTokens: 120 })).toEqual({
      password: '[REDACTED:secret]',
      clientSecret: '[REDACTED:secret]',
      accessToken: '[REDACTED:secret]',
      inputTokens: 120,
    });
  });

  it('redacts any value under salary-like keys', () => {
    expect(
      redact({ salary: 50000, ctc: '12 LPA', basic_salary: 1, grossPay: 2, net_pay: 3, netpay: 4, payroll_amount: 5, pay_amount: 6, breakup: { gross: { a: 1 } } }),
    ).toEqual({
      salary: '[REDACTED:salary]',
      ctc: '[REDACTED:salary]',
      basic_salary: '[REDACTED:salary]',
      grossPay: '[REDACTED:salary]',
      net_pay: '[REDACTED:salary]',
      netpay: '[REDACTED:salary]',
      payroll_amount: '[REDACTED:salary]',
      pay_amount: '[REDACTED:salary]',
      breakup: { gross: '[REDACTED:salary]' },
    });
  });

  it('does not redact non-salary amounts', () => {
    expect(redact({ days: 2, amount: 1500, leaveType: 'casual' })).toEqual({ days: 2, amount: 1500, leaveType: 'casual' });
  });

  it('redacts account-like digit runs under account/bank keys, including nested', () => {
    expect(
      redact({ accountNumber: '123456789012', acct_no: 987654321, bank: { number: '00112233445566' }, bankName: 'HDFC Bank' }),
    ).toEqual({
      accountNumber: '[REDACTED:account]',
      acct_no: '[REDACTED:account]',
      bank: { number: '[REDACTED:account]' },
      bankName: 'HDFC Bank',
    });
  });

  it('keeps short ids under account keys', () => {
    expect(redact({ accountId: 42, bankBranchCode: '1234' })).toEqual({ accountId: 42, bankBranchCode: '1234' });
  });

  it('does not treat digit runs outside account keys as accounts', () => {
    expect(redact({ requestId: '123456789' })).toEqual({ requestId: '123456789' });
  });

  it('redacts PII-shaped numbers', () => {
    expect(redact({ aadhaarNo: 234567890123, mobile: 9876543210, id: 1791234567 })).toEqual({
      aadhaarNo: '[REDACTED:aadhaar]',
      mobile: '[REDACTED:phone]',
      id: 1791234567,
    });
  });

  it('walks arrays and strings, and does not mutate input', () => {
    const input = { rows: [{ note: 'PAN ABCDE1234F', at: '2026-10-08T14:03:00+05:30' }], tag: 'PRM-20261008-1430-ab12' };
    const copy = structuredClone(input);
    const out = redact(input);
    expect(out).toEqual({ rows: [{ note: 'PAN [REDACTED:pan]', at: '2026-10-08T14:03:00+05:30' }], tag: 'PRM-20261008-1430-ab12' });
    expect(input).toEqual(copy);
    expect(out).not.toBe(input);
  });

  it('passes through primitives, null and non-plain objects', () => {
    const d = new Date(0);
    expect(redact(null)).toBeNull();
    expect(redact(true)).toBe(true);
    expect(redact(d)).toBe(d);
    expect(redact('ABCDE1234F')).toBe('[REDACTED:pan]');
  });
});
