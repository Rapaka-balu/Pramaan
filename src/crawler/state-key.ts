// State key (§8 M2): sha1(normalizedRoute + '|' + structuralSignature).
import { isIdLikeSegment } from '../core/ownership-guard.js';
import { sha1 } from '../core/stable-json.js';

/** Pathname with id-like segments as {id}; query keys sorted, values dropped. */
export function normalizeRoute(url: string): string {
  const u = new URL(url, 'http://x.invalid');
  const segs = u.pathname
    .split('/')
    .map((s) => {
      let d = s;
      try {
        d = decodeURIComponent(s);
      } catch {
        // keep raw segment
      }
      return d !== '' && isIdLikeSegment(d) ? '{id}' : s;
    })
    .join('/');
  const path = segs.length > 1 ? segs.replace(/\/+$/, '') : segs;
  const keys = [...new Set([...u.searchParams.keys()])].sort();
  return keys.length > 0 ? `${path}?${keys.join('&')}` : path;
}

const KEPT_ROLES = new Set(['heading', 'button', 'link', 'tab', 'textbox', 'combobox', 'checkbox', 'dialog']);
const MAX_NAME = 40;

interface AriaNode {
  role: string;
  name: string | undefined;
  children: AriaNode[];
}

// "- role "name" [attr=x]:" or "- role: inline text". Lines starting "- /prop:" or "- text:" carry no structure.
const LINE_RE = /^(\s*)- ([a-z][a-z-]*)(?: "((?:[^"\\]|\\.)*)")?((?: \[[^\]]*\])*)(:.*)?$/;

/** Parses Playwright's ariaSnapshot() YAML-ish text into a tree. Unknown lines are ignored. */
export function parseAriaSnapshot(text: string): AriaNode[] {
  const root: AriaNode = { role: 'root', name: undefined, children: [] };
  const stack: { indent: number; node: AriaNode }[] = [{ indent: -1, node: root }];
  for (const line of text.split(/\r?\n/)) {
    const m = LINE_RE.exec(line);
    if (!m) continue;
    const indent = m[1]?.length ?? 0;
    const role = m[2] ?? '';
    if (role === 'text') continue;
    const node: AriaNode = { role, name: m[3]?.replace(/\\(.)/g, '$1'), children: [] };
    while (stack.length > 1 && (stack[stack.length - 1]?.indent ?? -1) >= indent) stack.pop();
    stack[stack.length - 1]?.node.children.push(node);
    stack.push({ indent, node });
  }
  return root.children;
}

export function countBucket(n: number): string {
  return n <= 1 ? '1' : n <= 10 ? '2-10' : '>10';
}

function normName(name: string | undefined): string | undefined {
  if (name === undefined) return undefined;
  const t = name.replace(/\s+/g, ' ').trim();
  if (t === '' || t.length > MAX_NAME) return undefined;
  return t.replace(/\d/g, '#');
}

/** Identical sibling signatures collapse into one entry with a count bucket (first-occurrence order). */
function collapse(sigs: string[]): string[] {
  const counts = new Map<string, number>();
  for (const s of sigs) counts.set(s, (counts.get(s) ?? 0) + 1);
  return [...counts].map(([s, n]) => (n > 1 ? `${s}*${countBucket(n)}` : s));
}

function sigOf(node: AriaNode): string {
  const kids = collapse(node.children.map(sigOf).filter((s) => s !== ''));
  if (KEPT_ROLES.has(node.role)) {
    const name = normName(node.name);
    const head = name === undefined ? node.role : `${node.role}"${name}"`;
    return kids.length > 0 ? `${head}{${kids.join(',')}}` : head;
  }
  // Non-kept roles are transparent, but still group their children (so table rows collapse).
  if (kids.length === 0) return '';
  return kids.length === 1 ? (kids[0] ?? '') : `(${kids.join(',')})`;
}

export function structuralSignature(ariaSnapshot: string): string {
  return collapse(parseAriaSnapshot(ariaSnapshot).map(sigOf).filter((s) => s !== '')).join(',');
}

export function stateKey(url: string, ariaSnapshot: string): string {
  return sha1(`${normalizeRoute(url)}|${structuralSignature(ariaSnapshot)}`);
}
