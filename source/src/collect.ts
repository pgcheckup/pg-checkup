// The collector: connects read-only, checks the role, and reads statistics and catalog metadata into a bundle.
// It never imports the checks, so it can be published on its own and read in full.
import net from "node:net";
import { readFileSync } from "node:fs";
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

/** Errors that mean the server's certificate chain could not be verified, as opposed to any other failure. */
const CERT_ERRORS = /SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER|DEPTH_ZERO|CERT_HAS_EXPIRED|ERR_TLS_CERT_ALTNAME_INVALID|certificate/i;

/**
 * node-postgres sends NO TLS unless asked. For a remote host with no explicit sslmode: TLS with the certificate
 * verified (the system's trusted CAs, plus PGSSLROOTCERT if set); if the chain cannot be verified, TLS without
 * verification, reported as such; plaintext only if the server refuses TLS. That matches libpq's "prefer" while
 * verifying whenever the certificate allows it. An explicit sslmode in the URL is always honoured as written:
 * verify-full and verify-ca verify and never fall back.
 */
async function connect(url: string, local: boolean, address?: string): Promise<{ db: pg.Client; tls: boolean; verified: boolean }> {
  const u = new URL(url);
  const explicit = u.searchParams.has("sslmode") || u.searchParams.has("ssl");
  if (local || explicit) {
    const db = new pg.Client(base(url, address)); db.on("error", () => {}); await db.connect();
    const mode = u.searchParams.get("sslmode") ?? "";
    const tls = explicit ? !/^(disable|allow)$/.test(mode) : false;
    return { db, tls, verified: tls && /^verify-(ca|full)$/.test(mode) };
  }
  let ca: string | undefined;
  if (process.env.PGSSLROOTCERT) { try { ca = readFileSync(process.env.PGSSLROOTCERT, "utf8"); } catch { /* fall through to the system store */ } }
  const verified = new pg.Client({ ...base(url, address), ssl: { rejectUnauthorized: true, ...(ca ? { ca } : {}) } });
  verified.on("error", () => {});
  try { await verified.connect(); return { db: verified, tls: true, verified: true }; }
  catch (e: any) {
    if (/does not support SSL/i.test(String(e.message))) {
      const plain = new pg.Client(base(url, address)); plain.on("error", () => {}); await plain.connect();
      return { db: plain, tls: false, verified: false };
    }
    if (!CERT_ERRORS.test(`${e.code ?? ""} ${e.message ?? ""}`)) throw e;
    const unverified = new pg.Client({ ...base(url, address), ssl: { rejectUnauthorized: false } });
    unverified.on("error", () => {});
    await unverified.connect();
    return { db: unverified, tls: true, verified: false };
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
