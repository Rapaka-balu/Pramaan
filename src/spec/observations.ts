// One normalized view of API traffic, from crawl HARs and from Pramaan's own replays (lifecycle probe, authz).
import { readFileSync } from 'node:fs';
import { z } from 'zod';

export interface Observation {
  role: string;
  method: string; // upper case
  url: string;
  path: string; // pathname
  query: string[]; // query keys
  status: number;
  reqBody?: unknown;
  resBody?: unknown;
  location?: string | undefined;
  ts: number; // epoch ms, orders observations across roles
  ref: string; // evidence ref: "crawl/<role>/crawl.har#<i>" or "replay/<file>#<i>"
}

const Har = z.object({
  log: z.object({
    entries: z.array(
      z.object({
        startedDateTime: z.string(),
        request: z.object({
          method: z.string(),
          url: z.string(),
          postData: z.object({ mimeType: z.string().optional(), text: z.string().optional() }).loose().optional(),
        }).loose(),
        response: z.object({
          status: z.number(),
          headers: z.array(z.object({ name: z.string(), value: z.string() })),
          content: z.object({ mimeType: z.string().optional(), text: z.string().optional(), encoding: z.string().optional() }).loose(),
        }).loose(),
      }).loose(),
    ),
  }).loose(),
});

export function parseJsonMaybe(text: string | undefined, mime?: string): unknown {
  if (text === undefined || text === '') return undefined;
  if (mime !== undefined && !/json/i.test(mime) && !/^[[{]/.test(text.trim())) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export function apiMatcher(apiBaseUrl: string | undefined, baseUrl: string): (url: string) => boolean {
  const api = apiBaseUrl ? new URL(apiBaseUrl) : undefined;
  const origin = new URL(baseUrl).origin;
  return (url: string): boolean => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return false;
    }
    if (api) return u.origin === api.origin && u.pathname.startsWith(api.pathname.replace(/\/$/, ''));
    return u.origin === origin && (u.pathname === '/api' || u.pathname.startsWith('/api/'));
  };
}

/** API calls from one crawl HAR. Static assets and other origins are dropped. */
export function observationsFromHar(harPath: string, role: string, refPrefix: string, isApi: (url: string) => boolean): Observation[] {
  const har = Har.parse(JSON.parse(readFileSync(harPath, 'utf8')));
  const out: Observation[] = [];
  har.log.entries.forEach((e, i) => {
    if (!isApi(e.request.url) || e.response.status === 0) return;
    const u = new URL(e.request.url);
    const content = e.response.content;
    const text = content.encoding === 'base64' && content.text ? Buffer.from(content.text, 'base64').toString('utf8') : content.text;
    out.push({
      role,
      method: e.request.method.toUpperCase(),
      url: e.request.url,
      path: u.pathname,
      query: [...new Set(u.searchParams.keys())].sort(),
      status: e.response.status,
      reqBody: parseJsonMaybe(e.request.postData?.text, e.request.postData?.mimeType),
      resBody: parseJsonMaybe(text, content.mimeType),
      location: e.response.headers.find((h) => h.name.toLowerCase() === 'location')?.value,
      ts: Date.parse(e.startedDateTime),
      ref: `${refPrefix}#${i}`,
    });
  });
  return out;
}
