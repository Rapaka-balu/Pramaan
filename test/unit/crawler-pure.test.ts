import { describe, expect, it } from 'vitest';
import { isFreeText, runFaker, valueFor, type FieldFacts } from '../../src/crawler/form-fill.js';
import { Frontier, priority, type FrontierItem } from '../../src/crawler/frontier.js';
import { describeLocator, ladder } from '../../src/crawler/locator.js';

describe('locator ladder', () => {
  it('orders testid → role → label → placeholder → css id', () => {
    const d = ladder({ testid: 't', role: 'button', name: 'Go', label: 'L', placeholder: 'P', id: 'go' });
    expect(d.map((x) => x.strategy)).toEqual(['testid', 'role', 'label', 'placeholder', 'css-id']);
  });
  it('skips rungs without data and never offers xpath or class selectors', () => {
    expect(ladder({ role: 'link', name: '  My   leaves ' })).toEqual([{ strategy: 'role', value: 'link', name: 'My leaves' }]);
    expect(ladder({ role: 'button' })).toEqual([]);
  });
  it('rejects generated-looking ids', () => {
    expect(ladder({ id: 'react-select-3-input' })).toEqual([]);
    expect(ladder({ id: ':r1:' })).toEqual([]);
    expect(ladder({ id: 'field123456' })).toEqual([]);
    expect(ladder({ id: 'export-csv' })).toEqual([{ strategy: 'css-id', value: 'export-csv' }]);
  });
  it('describes descriptors stably, including row scope', () => {
    expect(describeLocator({ strategy: 'role', value: 'button', name: 'Cancel' })).toBe('role:button[Cancel]');
    expect(
      describeLocator({ strategy: 'testid', value: 'cancel-btn', scope: { strategy: 'testid', value: 'leave-row', hasText: 'PRM-x' } }),
    ).toBe('testid:leave-row{PRM-x} >> testid:cancel-btn');
  });
});

describe('form fill', () => {
  const ctx = { runTag: 'PRM-20261027-2010-ab12', faker: runFaker('20261027-2010-ab12'), now: new Date('2026-10-27T10:00:00Z') };
  const f = (x: Partial<FieldFacts>): FieldFacts => ({ tag: 'input', type: 'text', ...x });

  it('tags only free text: textarea or plain text input without a format hint', () => {
    expect(isFreeText(f({ tag: 'textarea', type: 'textarea', label: 'Reason' }))).toBe(true);
    expect(isFreeText(f({ label: 'Remarks' }))).toBe(true);
    expect(isFreeText(f({ label: 'Mobile number' }))).toBe(false);
    expect(isFreeText(f({ label: 'Employee code' }))).toBe(false);
    expect(isFreeText(f({ label: 'Remarks', pattern: '[A-Z]+' }))).toBe(false);
    expect(isFreeText(f({ type: 'email', label: 'Email' }))).toBe(false);
  });
  it('prefixes free text with the run tag and respects maxlength', () => {
    const v = valueFor(f({ tag: 'textarea', type: 'textarea', label: 'Reason', maxLength: 30 }), ctx);
    expect(v.kind === 'fill' && v.value.startsWith(`${ctx.runTag}-`)).toBe(true);
    expect(v.kind === 'fill' && v.value.length <= 30 && v.tagged).toBe(true);
  });
  it('fills dates in IST with the end date after the start date', () => {
    expect(valueFor(f({ type: 'date', label: 'From' }), ctx)).toEqual({ kind: 'fill', value: '2026-11-03', tagged: false });
    expect(valueFor(f({ type: 'date', label: 'To' }), ctx)).toEqual({ kind: 'fill', value: '2026-11-04', tagged: false });
  });
  it('keeps numbers inside min/max', () => {
    expect(valueFor(f({ type: 'number', min: '0.5' }), ctx)).toMatchObject({ value: '1' });
    expect(valueFor(f({ type: 'number', min: '5' }), ctx)).toMatchObject({ value: '5' });
    expect(valueFor(f({ type: 'number', max: '0.5' }), ctx)).toMatchObject({ value: '0.5' });
  });
  it('never fills passwords, checkboxes or files', () => {
    for (const type of ['password', 'checkbox', 'file', 'hidden']) expect(valueFor(f({ type }), ctx).kind).toBe('skip');
  });
  it('uses formatted, untagged factory values for hinted text', () => {
    const phone = valueFor(f({ label: 'Mobile' }), ctx);
    expect(phone.kind === 'fill' && /^9\d{9}$/.test(phone.value) && !phone.tagged).toBe(true);
    const tel = valueFor(f({ type: 'tel' }), ctx);
    expect(tel.kind === 'fill' && tel.value.startsWith('+91 ')).toBe(true);
    const aadhaar = valueFor(f({ label: 'Aadhaar' }), ctx);
    expect(aadhaar.kind === 'fill' && aadhaar.value.startsWith('0')).toBe(true);
  });
  it('picks the first non-empty select option', () => {
    expect(valueFor({ tag: 'select', type: 'select', options: ['', 'casual', 'sick'] }, ctx)).toEqual({ kind: 'select', value: 'casual' });
  });
  it('is reproducible for the same run id', () => {
    const a = valueFor(f({ tag: 'textarea', type: 'textarea' }), { ...ctx, faker: runFaker('r1') });
    const b = valueFor(f({ tag: 'textarea', type: 'textarea' }), { ...ctx, faker: runFaker('r1') });
    expect(a).toEqual(b);
  });
});

describe('frontier', () => {
  const item = (x: Partial<FrontierItem>): FrontierItem => ({ stateKey: 's', candidateKey: 'c', kind: 'button', landmark: false, depth: 0, ...x });

  it('ranks unvisited routes, then landmarks, then submits, then the rest', () => {
    const visited = new Set(['/dashboard']);
    expect(priority(item({ kind: 'link', targetRoute: '/leaves' }), visited)).toBe(0);
    expect(priority(item({ kind: 'link', targetRoute: '/dashboard', landmark: true }), visited)).toBe(1);
    expect(priority(item({ kind: 'submit' }), visited)).toBe(2);
    expect(priority(item({}), visited)).toBe(3);
  });
  it('pops by priority, then insertion order, and dedupes (state, candidate)', () => {
    const fr = new Frontier();
    fr.push(item({ candidateKey: 'a' }));
    fr.push(item({ candidateKey: 'b', kind: 'submit' }));
    fr.push(item({ candidateKey: 'c' }));
    expect(fr.push(item({ candidateKey: 'a' }))).toBe(false);
    fr.push(item({ candidateKey: 'd', kind: 'link', targetRoute: '/x' }));
    const order: string[] = [];
    for (let x = fr.pop(new Set()); x; x = fr.pop(new Set())) order.push(x.candidateKey);
    expect(order).toEqual(['d', 'b', 'a', 'c']);
  });
});
