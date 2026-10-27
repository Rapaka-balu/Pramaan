import { describe, expect, it } from 'vitest';
import { countBucket, normalizeRoute, parseAriaSnapshot, stateKey, structuralSignature } from '../../src/crawler/state-key.js';

const page = (rows: string[]): string =>
  [
    '- navigation "Main":',
    '  - link "Dashboard":',
    '    - /url: /dashboard',
    '- main:',
    '  - heading "My leaves" [level=1]',
    '  - table:',
    '    - rowgroup:',
    ...rows.flatMap((r) => [
      `      - row "${r}":`,
      `        - cell "${r}"`,
      '        - cell "View Cancel":',
      '          - link "View":',
      '            - /url: /leaves/7',
      '          - button "Cancel"',
    ]),
  ].join('\n');

describe('normalizeRoute', () => {
  it('replaces numeric, uuid and ulid segments with {id}', () => {
    expect(normalizeRoute('http://h/leaves/42')).toBe('/leaves/{id}');
    expect(normalizeRoute('http://h/a/3f2504e0-4f89-11d3-9a0c-0305e82c3301/b')).toBe('/a/{id}/b');
    expect(normalizeRoute('http://h/a/01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBe('/a/{id}');
  });
  it('sorts query keys and drops values', () => {
    expect(normalizeRoute('http://h/leaves?z=1&all=1&z=2')).toBe('/leaves?all&z');
  });
  it('drops a trailing slash but keeps the root', () => {
    expect(normalizeRoute('http://h/leaves/')).toBe('/leaves');
    expect(normalizeRoute('http://h/')).toBe('/');
  });
  it('keeps word segments', () => {
    expect(normalizeRoute('http://h/leaves/apply')).toBe('/leaves/apply');
  });
});

describe('parseAriaSnapshot', () => {
  it('builds a tree by indentation and skips text and property lines', () => {
    const tree = parseAriaSnapshot('- main:\n  - text: From\n  - textbox "From": 2026-01-01\n  - dialog:\n    - heading "Hi" [level=2]');
    expect(tree).toHaveLength(1);
    expect(tree[0]?.children.map((c) => c.role)).toEqual(['textbox', 'dialog']);
    expect(tree[0]?.children[1]?.children[0]?.name).toBe('Hi');
  });
  it('unescapes quoted names', () => {
    expect(parseAriaSnapshot('- button "Say \\"hi\\""')[0]?.name).toBe('Say "hi"');
  });
});

describe('structuralSignature', () => {
  it('gives the same key for different rows with the same structure', () => {
    const a = page(['2026-11-02 Family function', '2026-12-01 Trip']);
    const b = page(['2027-01-05 Medical', '2027-02-01 Wedding', '2027-03-01 Exam']);
    expect(stateKey('http://h/leaves', a), 'row data must not change the key').toBe(stateKey('http://h/leaves', b));
  });
  it('separates count buckets 1, 2-10 and >10', () => {
    const one = structuralSignature(page(['a']));
    const few = structuralSignature(page(['a', 'b']));
    const many = structuralSignature(page(Array.from({ length: 11 }, (_, i) => `r${i}`)));
    expect(new Set([one, few, many]).size).toBe(3);
    expect(few).toContain('*2-10');
    expect(many).toContain('*>10');
  });
  it('replaces digits with # and drops names over 40 chars', () => {
    expect(structuralSignature('- heading "Leaves 12" [level=1]')).toBe('heading"Leaves ##"');
    expect(structuralSignature(`- button "${'x'.repeat(41)}"`)).toBe('button');
  });
  it('keeps only structural roles', () => {
    expect(structuralSignature('- paragraph: hello\n- img "logo"\n- button "Go"')).toBe('button"Go"');
  });
  it('differs when a button appears', () => {
    expect(structuralSignature('- main:\n  - button "Approve"')).not.toBe(structuralSignature('- main:\n  - button "Reject"'));
  });
});

describe('stateKey', () => {
  it('differs by route even with the same structure', () => {
    expect(stateKey('http://h/a', '- button "x"')).not.toBe(stateKey('http://h/b', '- button "x"'));
  });
  it('is a 40-hex sha1', () => {
    expect(stateKey('http://h/a', '')).toMatch(/^[0-9a-f]{40}$/);
  });
  it('treats ids in the route as equal', () => {
    expect(stateKey('http://h/leaves/1', '- heading "L"')).toBe(stateKey('http://h/leaves/99', '- heading "L"'));
  });
});

describe('countBucket', () => {
  it('buckets', () => {
    expect([0, 1, 2, 10, 11].map(countBucket)).toEqual(['1', '1', '2-10', '2-10', '>10']);
  });
});
