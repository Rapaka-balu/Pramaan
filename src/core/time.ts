// Asia/Kolkata time helpers. IST has no DST, but parts come from Intl so the zone is explicit.

const FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

export interface IstParts {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  second: string;
  ms: string;
}

export function istParts(now: Date = new Date()): IstParts {
  const p: Record<string, string> = {};
  for (const part of FMT.formatToParts(now)) p[part.type] = part.value;
  const get = (k: string): string => p[k] ?? '00';
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
    ms: String(now.getUTCMilliseconds()).padStart(3, '0'),
  };
}

/** e.g. 2026-10-08T14:03:00.123+05:30 */
export function nowIso(now: Date = new Date()): string {
  const p = istParts(now);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}.${p.ms}+05:30`;
}

/** YYYY-MM-DD in IST */
export function istDate(now: Date = new Date()): string {
  const p = istParts(now);
  return `${p.year}-${p.month}-${p.day}`;
}

/** IST date n calendar days from now (n may be negative). */
export function istDatePlus(n: number, now: Date = new Date()): string {
  const [y, m, d] = istDate(now).split('-').map(Number);
  const t = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + n));
  return t.toISOString().slice(0, 10);
}
