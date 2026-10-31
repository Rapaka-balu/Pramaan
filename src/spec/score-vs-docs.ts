// Score the observed spec against published API docs (§8 M3, HRMS). Scoring only — the docs are never an
// input to inference.

/** Flasgger's UI page names its spec URL (`"url": "/apispec_1.json"`); fall back to that default. */
export function specUrlFromDocsPage(html: string, docsUrl: string): string {
  const m = /["']?url["']?\s*:\s*["']([^"']+\.json)["']/.exec(html);
  return new URL(m?.[1] ?? '/apispec_1.json', docsUrl).toString();
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

/** "GET /api/leaves/{}" keys from a Swagger 2 / OpenAPI 3 document. Flask "<int:id>" params count as {}. */
export function docOperations(doc: unknown): Set<string> {
  const out = new Set<string>();
  if (doc === null || typeof doc !== 'object') return out;
  const d = doc as { paths?: Record<string, Record<string, unknown>>; basePath?: string };
  const base = (d.basePath ?? '').replace(/\/$/, '');
  for (const [path, item] of Object.entries(d.paths ?? {})) {
    for (const m of Object.keys(item)) {
      if (METHODS.includes(m.toLowerCase())) out.add(opKey(m, `${base}${path}`));
    }
  }
  return out;
}

export function opKey(method: string, path: string): string {
  const p = path.replace(/<(?:[a-z]+:)?[^>]+>/g, '{}').replace(/\{[^}]*\}/g, '{}').replace(/\/+$/, '') || '/';
  return `${method.toUpperCase()} ${p}`;
}

export interface DocsScore {
  observed: number;
  documented: number;
  matched: number;
  precision: number; // matched / observed
  recall: number; // matched / documented
  undocumented: string[]; // observed but not in the docs
}

export function scoreAgainstDocs(observedKeys: readonly string[], documented: ReadonlySet<string>): DocsScore {
  const obs = new Set(observedKeys.map((k) => {
    const [m = 'GET', p = '/'] = k.split(' ');
    return opKey(m, p);
  }));
  const matched = [...obs].filter((k) => documented.has(k));
  return {
    observed: obs.size,
    documented: documented.size,
    matched: matched.length,
    precision: obs.size === 0 ? 0 : matched.length / obs.size,
    recall: documented.size === 0 ? 0 : matched.length / documented.size,
    undocumented: [...obs].filter((k) => !documented.has(k)).sort(),
  };
}
