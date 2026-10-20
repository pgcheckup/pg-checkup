// The collector: connects read-only, checks the role, and reads statistics and catalog metadata into a bundle.
// It never imports the checks, so it can be published on its own and read in full.
import net from "node:net";
import pg from "pg";
import type { Ctx, ScanOptions } from "./types.js";
import type { ProviderId } from "./provider.js";
import type { Bundle, BundleDataset } from "./bundle.js";
import { BUNDLE_FORMAT, BUNDLE_VERSION, HOSTING_LABELS } from "./bundle.js";
import { profileFor, providerIdFromUrl, detectProvider } from "./provider.js";
import { ALL_DEFS, VITALS_SQL, collectDatasets, collectVitalsRow } from "./inspect.js";
import { roleSql, roleInfo } from "./role.js";
import { fingerprint } from "./fingerprint.js";

/** Tag on every scanner statement so it can be excluded from the customer's query statistics. */
export const TAG = "/* pg-checkup */";
export const COLLECTOR_VERSION = "0.3.0";

const LOCAL = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
/** True for a database on this machine, where the login is the person's own and a read-only session is enough. */
export const isLocalHost = (connectionString: string) => { try { return LOCAL.has(new URL(connectionString).hostname); } catch { return false; } };
/**
 * `address` pins the TCP connection to an IP that was already vetted (the hosted SSRF guard), so the name can't be
 * re-resolved to somewhere else. The hostname is still used for TLS (SNI), which providers like Neon route on.
 */
const pinned = (address: string) => () => {
  const s = new net.Socket();
  const connect = s.connect.bind(s) as (...a: unknown[]) => net.Socket;
  (s as any).connect = (port: number, _host: string, ...rest: unknown[]) => connect(port, address, ...rest);
  return s;
};
const base = (connectionString: string, address?: string): pg.ClientConfig => ({ connectionString, statement_timeout: 15_000, connectionTimeoutMillis: 10_000, application_name: "pg-checkup", ...(address ? { stream: pinned(address) } : {}) });

/** Remote connections require verified TLS unless the caller explicitly selects another mode. */
async function connect(url: string, local: boolean, address?: string): Promise<{ db: pg.Client; tls: boolean; verified: boolean }> {
  const u = new URL(url);
  const explicit = u.searchParams.has("sslmode") || u.searchParams.has("ssl");
  if (!local && !explicit) u.searchParams.set("sslmode", "verify-full");
  // Put the CA in the URL because node-postgres URL options override the ssl config object. A bare sslrootcert turns
  // TLS on, so a local connection with no sslmode of its own must not get one.
  const mode = u.searchParams.get("sslmode");
  const tlsWanted = mode ? mode !== "disable" : !local && u.searchParams.get("ssl") !== "0";
  if (process.env.PGSSLROOTCERT && !u.searchParams.has("sslrootcert") && tlsWanted) {
    u.searchParams.set("sslrootcert", process.env.PGSSLROOTCERT);
  }
  let db: pg.Client;
  try { db = new pg.Client(base(u.toString(), address)); }
  catch (e) { throw new Error(`Could not set up the connection: ${(e as Error).message}. If PGSSLROOTCERT is set, check that the file exists and is readable.`); }
  db.on("error", () => {});
  try {
    await db.connect();
    const ssl = db.ssl as boolean | { rejectUnauthorized?: boolean };
    return { db, tls: Boolean(ssl), verified: Boolean(ssl && (typeof ssl !== "object" || ssl.rejectUnauthorized !== false)) };
  } catch (e) {
    await db.end().catch(() => {});
    throw e;
  }
}

/** Opens a session that cannot write, regardless of the role's privileges. */
export async function openReadOnlySession(connectionString: string, address?: string) {
  const local = LOCAL.has(new URL(connectionString).hostname);
  const { db, tls, verified } = await connect(connectionString, local, address);
  await db.query(`${TAG} set default_transaction_read_only = on`);
  return { db, tls, verified, local };
}

export interface CollectOptions extends ScanOptions {
  /** "removed" leaves every SQL text out of the bundle. Default "masked": literals replaced by ?. */
  queryText?: "masked" | "removed";
  /** Reports each step as it happens, so the person running it can see what is being done. */
  progress?: (e: { step: "connected"; version: string; tls: boolean; verified: boolean } | { step: "read"; done: number; total: number }) => void;
  /** Called with the role's privileges before anything else is read. Throw to stop. */
  checkRole?: (role: ReturnType<typeof roleInfo>) => void | Promise<void>;
}

const VERSION_SQL = `select current_setting('server_version_num')::int as v, version() as s, pg_backend_pid() as pid`;
const PUBLIC_CREATE_SQL = `select has_schema_privilege('public', 'public', 'CREATE') as open`;

/**
 * Every statement the collector can run, in order, as it would run for this provider and server version. A dataset
 * whose extension isn't installed, or that doesn't apply to the version or provider, is skipped at run time.
 */
export function statements(provider: ProviderId = "generic", version = 180000): { id: string; title: string; sql: string }[] {
  const profile = profileFor(provider);
  const ctx = { version, profile, opts: {}, tls: true, local: false, facts: {}, selfPid: 0 } as unknown as Ctx;
  return [
    { id: "read_only", title: "Make this session unable to write", sql: "set default_transaction_read_only = on" },
    { id: "session", title: "Server version and this session", sql: VERSION_SQL },
    { id: "role", title: "What the connected role is allowed to do", sql: roleSql(profile) },
    { id: "extensions", title: "Installed extensions", sql: "select extname from pg_extension" },
    ...(version < 150000 ? [{ id: "public_create", title: "Whether every role can create objects in the public schema", sql: PUBLIC_CREATE_SQL }] : []),
    ...ALL_DEFS.filter((d) => (!d.only || d.only.includes(provider)) && (!d.minPg || version >= d.minPg)).map((d) => ({ id: d.id, title: d.title, sql: d.sql(ctx) })),
    { id: "vitals", title: "Key numbers", sql: VITALS_SQL },
  ].map((x) => ({ ...x, sql: x.sql.replace(/\n\s+/g, "\n  ").trim() }));
}

/** SQL text columns, emptied when query text is removed. */
const TEXT_COLUMNS = new Set(["query", "blocked_query", "blocking_query"]);
const SQL_TEXT_DATASETS = /^(q_|b_)/;
const NO_TEXT = "(query text not collected)";
const withoutText = (r: Record<string, unknown>) => Object.fromEntries(Object.entries(r).map(([k, x]) => [k, TEXT_COLUMNS.has(k) || (k === "detail" && r.holder === "Backend session") ? NO_TEXT : x]));

/** Reads statistics and catalog metadata into a bundle. Reads no table rows, and the session cannot write. */
export async function collect(connectionString: string, opts: CollectOptions = {}): Promise<Bundle> {
  const { db, tls, verified, local } = await openReadOnlySession(connectionString, opts.connectAddress);
  try {
    const [{ v, s, pid }] = (await db.query(`${TAG} ${VERSION_SQL}`)).rows;
    const providerId = opts.provider ?? providerIdFromUrl(connectionString);
    const profile = profileFor(providerId);
    const ctx: Ctx = { db, version: v, opts, profile, selfPid: pid, tls, local, facts: {}, q: async (sql, params) => (await db.query(`${TAG} ${sql}`, params as any[])).rows };
    opts.progress?.({ step: "connected", version: String(s), tls, verified });
    const role = roleInfo((await ctx.q(roleSql(profile)))[0] ?? {});
    await opts.checkRole?.(role);
    const facts = { publicSchemaCreate: v < 150000 ? await ctx.q(PUBLIC_CREATE_SQL).then((r) => Boolean(r[0]?.open), () => null) : null };
    const removed = opts.queryText === "removed";
    const datasets: BundleDataset[] = (await collectDatasets(ctx, (done, total) => opts.progress?.({ step: "read", done, total }))).map((d) => ({
      id: d.id, title: d.title, source: d.source, capped: d.capped,
      rows: removed && SQL_TEXT_DATASETS.test(d.id) ? d.rows.map(withoutText) : d.rows,
      ...(d.note ? { note: d.note } : {}), ...(d.error ? { error: d.error } : {}),
    }));
    const vitals = await collectVitalsRow(ctx).catch(() => ({}));
    const hosting = detectProvider(connectionString)?.provider ?? null;
    return {
      format: BUNDLE_FORMAT, version: BUNDLE_VERSION, collectedAt: new Date().toISOString(), collector: COLLECTOR_VERSION,
      server: { versionNum: v, version: s }, provider: providerId, hosting: hosting && HOSTING_LABELS.includes(hosting) ? hosting : null,
      connection: { tls, local, verified }, session: { ...role, tls, readOnly: true }, target: fingerprint(connectionString),
      queryText: removed ? "removed" : "masked", facts, vitals, datasets,
    };
  } finally {
    await db.end();
  }
}
