// Failure signature (§8 M9): sha1(testId + errorClass + normalizedMessage + topUserFrame + failingStepTitle).
// Normalization removes what changes run to run (numbers, ids, dates, the run tag, quoted dynamic values), so the
// same defect keeps one signature across runs.
import { sha1 } from '../core/stable-json.js';

export function errorClass(message: string): string {
  const m = /^(\w*Error)\b/.exec(message.trim());
  if (m?.[1]) return m[1];
  if (/expect\(|Expected:|Received:/.test(message)) return 'AssertionError';
  if (/Timeout \d+ms exceeded|timed out/i.test(message)) return 'TimeoutError';
  return 'Error';
}

export function normalizeMessage(message: string): string {
  return message
    .split('\n')
    .slice(0, 8) // the headline and the expected/received lines; call logs vary
    .join('\n')
    .replace(/PRM-\d{8}-\d{4}-[0-9a-f]{4}[\w-]*/g, '<tag>')
    .replace(/\b\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?\b/g, '<date>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/https?:\/\/[^\s'"]+/g, (u) => {
      try {
        return new URL(u).pathname.replace(/\/\d+(?=\/|$)/g, '/<id>');
      } catch {
        return '<url>';
      }
    })
    .replace(/(["'`])(?:(?!\1).){0,200}?\1/g, (q) => (/^.[a-z_]+[a-z0-9_]*.$/i.test(q) && q.length < 40 ? q : '<str>'))
    .replace(/\b\d+(\.\d+)?\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim();
}

/** First stack frame in user code (specs/, pages/, flows/, helpers/, fixtures/), without line/column numbers. */
export function topUserFrame(stack: string): string {
  const frame = stack.split('\n').find((l) => /[\\/](specs|pages|flows|helpers|fixtures)[\\/]/.test(l));
  return frame ? (frame.match(/(specs|pages|flows|helpers|fixtures)[\\/][^:)]+/)?.[0] ?? '').replace(/\\/g, '/') : '';
}

export function signature(input: { testId: string; message: string; stack?: string; step?: string }): string {
  return sha1([input.testId, errorClass(input.message), normalizeMessage(input.message), topUserFrame(input.stack ?? input.message), input.step ?? ''].join('|'));
}
