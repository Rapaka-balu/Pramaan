// Logger: every message and object passes through redact() before it is written (§2.1).
import { pino, type DestinationStream, type Logger, type LogFn } from 'pino';
import { redact } from './redact.js';

function redactArg(a: unknown): unknown {
  if (a instanceof Error) {
    const e = new Error(redact(a.message));
    e.name = a.name;
    e.stack = a.stack === undefined ? '' : redact(a.stack);
    return e;
  }
  const r = redact(a);
  // redact() leaves non-plain objects alone; handle the common { err } shape.
  if (r !== a && r !== null && typeof r === 'object' && !Array.isArray(r)) {
    for (const [k, v] of Object.entries(r)) if (v instanceof Error) (r as Record<string, unknown>)[k] = redactArg(v);
  }
  return r;
}

/** `dest` is for tests; defaults to stderr. */
export function createLogger(name: string, dest?: DestinationStream): Logger {
  return pino(
    {
      name,
      level: process.env['PRAMAAN_LOG_LEVEL'] ?? 'info',
      hooks: {
        logMethod(this: Logger, args: Parameters<LogFn>, method: LogFn): void {
          method.apply(this, args.map(redactArg) as Parameters<LogFn>);
        },
      },
    },
    dest ?? pino.destination({ dest: 2, sync: true }),
  );
}
