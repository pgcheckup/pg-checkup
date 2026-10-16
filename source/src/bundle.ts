// Pure module (no Node/pg imports): the collector writes a bundle, the server reads one with parseBundle().
import type { Facts } from "./types.js";
import type { ProviderId } from "./provider.js";
import type { VitalsRow } from "./inspect.js";
import { VITAL_KEYS, ALL_DEFS } from "./inspect.js";

export const BUNDLE_FORMAT = "pg-checkup-bundle";
export const BUNDLE_VERSION = 1;
/** Largest bundle the server accepts. A real one is well under 1 MB. */
export const MAX_BUNDLE_BYTES = 3 * 1024 * 1024;

/** How the collector connected, and what the role it used is allowed to do. */
export interface RoleInfo {
  role: string; superuser: boolean; monitor: boolean;
  bypassrls: boolean; replication: boolean; createrole: boolean; createdb: boolean;
  /** Predefined roles held that grant data or file access (pg_read_all_data, pg_write_all_data, ...). */
  dataRoles: string[];
  /** Application tables and views (not provider-managed, not extension-owned) this role can SELECT, or write to. */
  readableTables: number; writableTables: number;
  /** Up to five of them, so the message can name them. */
  readableSample: string[];
}

export interface BundleDataset {
  id: string;
  /** For a person reading the file. The server takes titles from its own registry, never from the bundle. */
  title?: string; source?: string;
  rows: Record<string, unknown>[];
  capped: boolean;
  note?: string; error?: string;
}

export interface Bundle {
  format: typeof BUNDLE_FORMAT;
  version: typeof BUNDLE_VERSION;
  collectedAt: string;
  collector: string;
  server: { versionNum: number; version: string };
  provider: ProviderId;
  /** The hosting platform recognised from the host name (Railway, Amazon RDS, ...), not the host name itself. */
  hosting: string | null;
  connection: { tls: boolean; local: boolean; /** The server certificate was verified against a trusted CA. Older bundles lack it. */ verified?: boolean };
  session: RoleInfo & { tls: boolean; readOnly: true };
  /** One-way fingerprint of host, port and database name, so a later scan of the same database can be compared. */
  target?: string;
  /** "masked": literals replaced by ? (the default). "removed": no SQL text at all. */
  queryText: "masked" | "removed";
  facts: Facts;
  vitals: VitalsRow;
  datasets: BundleDataset[];
}

const PROVIDERS: ProviderId[] = ["generic", "supabase", "neon"];
export const HOSTING_LABELS = ["Neon", "Supabase", "Railway", "Render", "Amazon RDS", "Aiven", "Timescale Cloud"];
const KNOWN = new Map(ALL_DEFS.map((d) => [d.id, d]));
const KEY = /^[a-z_][a-z0-9_]{0,62}$/i;

const fail = (msg: string): never => { throw new Error(`Invalid bundle: ${msg}`); };
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, max: number, what: string) => (typeof v === "string" && v.length <= max ? v : fail(`${what} must be text of at most ${max} characters`));
const bool = (v: unknown, what: string) => (typeof v === "boolean" ? v : fail(`${what} must be true or false`));
const int = (v: unknown, what: string) => (typeof v === "number" && Number.isFinite(v) ? v : fail(`${what} must be a number`));

function cell(v: unknown, where: string): unknown {
  if (v === null || typeof v === "boolean") return v;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") return v.length <= 4000 ? v : v.slice(0, 4000);
  if (Array.isArray(v) && v.length <= 50 && v.every((x) => x === null || ["string", "number", "boolean"].includes(typeof x))) return v.map((x) => (typeof x === "string" ? x.slice(0, 500) : x));
  return fail(`${where} holds a value that isn't text, a number, true/false or a short list`);
}

/**
 * Validates an uploaded bundle and returns a copy holding only what the analysis reads. Anything the server would
 * display (titles, descriptions, columns) comes from its own registry; the bundle supplies rows and nothing else.
 */
export function parseBundle(input: unknown): Bundle {
  if (!isObj(input)) fail("expected a JSON object");
  const b = input as Record<string, unknown>;
  if (b.format !== BUNDLE_FORMAT) fail(`format must be "${BUNDLE_FORMAT}"`);
  if (b.version !== BUNDLE_VERSION) fail(`version ${String(b.version)} isn't supported; update pg-checkup and collect again`);
  const server = isObj(b.server) ? b.server : fail("missing server");
  const connection = isObj(b.connection) ? b.connection : fail("missing connection");
  const s = isObj(b.session) ? b.session : fail("missing session");
  const provider = PROVIDERS.includes(b.provider as ProviderId) ? (b.provider as ProviderId) : fail("unknown provider");
  const hosting = b.hosting == null ? null : HOSTING_LABELS.includes(String(b.hosting)) ? String(b.hosting) : null;
  const vitalsIn = isObj(b.vitals) ? b.vitals : {};
  const vitals: VitalsRow = {};
  for (const k of VITAL_KEYS) { const v = vitalsIn[k]; vitals[k] = typeof v === "number" && Number.isFinite(v) ? v : null; }
  if (!Array.isArray(b.datasets) || b.datasets.length > KNOWN.size) fail("datasets must be a list");
  const seen = new Set<string>();
  const datasets: BundleDataset[] = [];
  for (const d of b.datasets as unknown[]) {
    if (!isObj(d)) fail("each dataset must be an object");
    const id = str((d as any).id, 64, "dataset id");
    const def = KNOWN.get(id);
    if (!def || seen.has(id)) continue; // unknown or repeated datasets are dropped, not trusted
    seen.add(id);
    const rowsIn = (d as any).rows;
    if (!Array.isArray(rowsIn)) fail(`${id}.rows must be a list`);
    const rows = (rowsIn as unknown[]).slice(0, def.limit ?? 50).map((r, i) => {
      if (!isObj(r)) fail(`${id} row ${i} must be an object`);
      const entries = Object.entries(r as object);
      if (entries.length > 40) fail(`${id} row ${i} has too many fields`);
      return Object.fromEntries(entries.map(([k, v]) => [KEY.test(k) ? k : fail(`${id} has a field named "${k.slice(0, 40)}"`), cell(v, `${id}.${k}`)]));
    });
    const note = (d as any).note, error = (d as any).error;
    datasets.push({ id, rows, capped: Boolean((d as any).capped), ...(typeof note === "string" ? { note: note.slice(0, 500) } : {}), ...(typeof error === "string" ? { error: error.slice(0, 500) } : {}) });
  }
  const facts = isObj(b.facts) ? b.facts : {};
  const qt = b.queryText === "removed" ? "removed" : "masked";
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 10).map((x) => x.slice(0, 128)) : []);
  return {
    format: BUNDLE_FORMAT, version: BUNDLE_VERSION,
    collectedAt: typeof b.collectedAt === "string" && !Number.isNaN(Date.parse(b.collectedAt)) ? new Date(b.collectedAt).toISOString() : new Date().toISOString(),
    collector: typeof b.collector === "string" ? b.collector.slice(0, 32) : "unknown",
    server: { versionNum: int(server.versionNum, "server.versionNum"), version: str(server.version, 300, "server.version") },
    provider, hosting,
    connection: { tls: bool(connection.tls, "connection.tls"), local: bool(connection.local, "connection.local"), ...(typeof connection.verified === "boolean" ? { verified: connection.verified } : {}) },
    session: {
      role: str(s.role, 128, "session.role"), superuser: bool(s.superuser, "session.superuser"), monitor: bool(s.monitor, "session.monitor"),
      bypassrls: Boolean(s.bypassrls), replication: Boolean(s.replication), createrole: Boolean(s.createrole), createdb: Boolean(s.createdb),
      dataRoles: list(s.dataRoles), readableTables: Number(s.readableTables) || 0, writableTables: Number(s.writableTables) || 0, readableSample: list(s.readableSample),
      tls: bool(connection.tls, "connection.tls"), readOnly: true,
    },
    ...(typeof b.target === "string" && /^[a-f0-9]{24}$/.test(b.target) ? { target: b.target } : {}),
    queryText: qt,
    facts: { publicSchemaCreate: typeof facts.publicSchemaCreate === "boolean" ? facts.publicSchemaCreate : null },
    vitals, datasets,
  };
}
