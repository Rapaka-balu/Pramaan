// Type declarations for server.mjs so TypeScript tests can import the demo app.

export interface DemoRequestLogEntry {
  /** ISO timestamp when the response finished. */
  ts: string;
  method: string;
  /** Path without query string, e.g. `/api/leaves/4/approve`. */
  path: string;
  status: number;
  /** Authenticated user id (also set for a successful login), or null. */
  userId: number | null;
  tenant: string | null;
}

export interface DemoServer {
  /** Base URL, e.g. `http://127.0.0.1:4600`. */
  url: string;
  /** The real bound port (useful with `port: 0`). */
  port: number;
  /** Every `/api` request, appended after its response finishes. */
  requestLog: DemoRequestLogEntry[];
  close(): Promise<void>;
}

export interface StartDemoOptions {
  port?: number;
  host?: string;
  /** Source of DEMO_BUGS, DEMO_FLAKY, DEMO_SEED, DEMO_DRIFT, DEMO_API_V2. Defaults to process.env. */
  env?: Record<string, string | undefined>;
}

export declare const KNOWN_BUGS: readonly string[];

export declare function startDemo(options?: StartDemoOptions): Promise<DemoServer>;
