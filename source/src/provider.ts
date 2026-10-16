export interface ProviderNote { provider: string; notes: string[] }

export type ProviderId = "supabase" | "neon" | "generic";

/** What a managed provider owns, so we don't report its internals as the customer's problems. */
export interface Profile {
  id: ProviderId;
  /** SQL boolean expression: true when `col` (a role name) is provider-managed. */
  managedRoleSql: (col: string) => string;
  managedSchemas: string[];
  /**
   * Tables inside managed schemas that are still the customer's operational burden (extension bookkeeping
   * that grows with their workload). They stay in the size, dead-row and bloat datasets.
   */
  watchedTables: [schema: string, table: string][];
  /** Login roles that are the customer's expected admin (not counted as extra privileged roles). */
  expectedAdmins: string[];
  /** Settings the provider sets on purpose (name -> why). A check on one of these passes with that explanation instead of flagging. */
  ownedSettings: Record<string, string>;
  /** Replication slots the provider creates for its own machinery. */
  internalSlots: string[];
  /** Values of synchronous_standby_names that name the provider's own machinery, not a standby the customer runs. */
  internalSyncStandbys: string[];
  /** The provider's pooler reaches the database over a private network without TLS; such sessions are not the customer's clients. */
  poolerOnPrivateNetwork: boolean;
  /** SQL boolean expression: true when `col` (an application_name) is the provider's own pooler, API layer or monitoring agent. */
  internalAppSql: (col: string) => string;
}

const SYSTEM_SCHEMAS = ["pg_catalog", "information_schema", "pg_toast"];
/** pg_cron and pg_net keep per-run bookkeeping tables that grow forever unless someone trims them. */
const EXTENSION_TABLES: [string, string][] = [["cron", "job_run_details"], ["net", "_http_response"], ["net", "http_request_queue"]];

const PROFILES: Record<ProviderId, Profile> = {
  generic: { id: "generic", managedRoleSql: () => "false", managedSchemas: [], watchedTables: [], expectedAdmins: [], ownedSettings: {}, internalSlots: [], internalSyncStandbys: [], poolerOnPrivateNetwork: false, internalAppSql: () => "false" },
  supabase: {
    id: "supabase",
    // Internal service roles only (supabase_auth_admin, supabase_storage_admin, ...). API roles such as
    // anon/authenticated/service_role run the customer's own traffic, so they are deliberately NOT listed.
    managedRoleSql: (c) => `(${c} ~ '^supabase_' or ${c} in ('pgbouncer','dashboard_user'))`,
    expectedAdmins: ["postgres"],
    managedSchemas: ["auth", "storage", "realtime", "_realtime", "vault", "extensions", "graphql", "graphql_public", "pgsodium", "pgsodium_masks", "supabase_functions", "supabase_migrations", "net", "cron", "pgbouncer", "_analytics", "_supavisor"],
    watchedTables: EXTENSION_TABLES,
    ownedSettings: {},
    internalSlots: [],
    internalSyncStandbys: [],
    poolerOnPrivateNetwork: true,
    // Supavisor (the pooler) and PostgREST connect as customer roles, sometimes from public AWS addresses and without TLS,
    // because they sit inside Supabase's own network. Their application_name is how to tell them apart.
    internalAppSql: (c) => `(${c} ~ '^(Supavisor|PostgREST|postgres_exporter|pgbouncer|Supabase)')`,
  },
  neon: {
    id: "neon",
    managedRoleSql: (c) => `(${c} in ('cloud_admin') or ${c} ~ '^neon_')`,
    managedSchemas: ["neon"],
    watchedTables: EXTENSION_TABLES,
    expectedAdmins: [],
    // Neon's compute writes WAL to its own storage service (safekeepers + pageservers), which handles durability.
    // The local data directory is a cache, so the two on-disk safety settings are off by design.
    ownedSettings: {
      fsync: "Neon turns fsync off on purpose: durability comes from its storage layer, not the compute's local disk.",
      full_page_writes: "Neon turns full_page_writes off on purpose: its storage layer reconstructs pages, so torn writes on the compute don't matter.",
    },
    internalSlots: ["wal_proposer_slot", "wal_retention_slot"],
    internalSyncStandbys: ["walproposer"],
    poolerOnPrivateNetwork: true,
    internalAppSql: (c) => `(${c} ~ '^(compute_ctl|vm-monitor|neon_compute_sql_exporter|pgbouncer)')`,
  },
};

export function profileFor(id: ProviderId): Profile { return PROFILES[id]; }

export function providerIdFromUrl(url: string): ProviderId {
  let host = "";
  try { host = new URL(url).hostname; } catch { return "generic"; }
  if (host.endsWith(".neon.tech")) return "neon";
  if (host.endsWith(".supabase.co") || host.endsWith(".supabase.com")) return "supabase";
  return "generic";
}

/** SQL predicate: schema column is a user schema (not system, not provider-managed). */
export function userSchemaSql(p: Profile, col: string): string {
  const list = [...SYSTEM_SCHEMAS, ...p.managedSchemas].map((s) => `'${s}'`).join(",");
  return `(${col} not in (${list}) and ${col} !~ '^pg_(temp|toast_temp)')`;
}

/** Like userSchemaSql, but also lets through the extension bookkeeping tables the customer has to keep in check. */
export function userTableSql(p: Profile, schemaCol: string, tableCol: string): string {
  if (!p.watchedTables.length) return userSchemaSql(p, schemaCol);
  const pairs = p.watchedTables.map(([s, t]) => `('${s}','${t}')`).join(",");
  return `(${userSchemaSql(p, schemaCol)} or (${schemaCol}, ${tableCol}) in (${pairs}))`;
}

/** Hosts we recognise without owning a full profile: the server is stock Postgres, but the platform shapes what to look at. */
function hostingNotes(host: string): ProviderNote | null {
  if (/\.rlwy\.net$|\.railway\.app$|railway\.internal$/.test(host)) return { provider: "Railway", notes: [
    "Railway runs the stock Postgres image with a fixed-size volume. Free disk isn't visible from SQL, so compare the footprint in this report with the volume size in the service's Metrics tab.",
    "The *.railway.internal address only works from services inside the project; scans from outside need the TCP proxy (DATABASE_PUBLIC_URL).",
  ] };
  if (/\.render\.com$/.test(host)) return { provider: "Render", notes: ["Render manages backups and the instance size; disk usage is in the dashboard, not visible from SQL."] };
  if (/\.rds\.amazonaws\.com$/.test(host)) return { provider: "Amazon RDS", notes: ["RDS owns fsync, archiving and backups. The rds_superuser role isn't a real superuser, so some catalog views may be unavailable. Free storage is a CloudWatch metric, not visible from SQL."] };
  if (/\.aivencloud\.com$/.test(host)) return { provider: "Aiven", notes: ["Aiven manages backups and WAL archiving; those checks are informational here."] };
  if (/\.timescale\.com$|\.tsdb\.cloud/.test(host)) return { provider: "Timescale Cloud", notes: ["Timescale Cloud manages backups and archiving. Hypertable chunks appear as many small tables in the size and bloat datasets."] };
  return null;
}

// Only claims verified against provider docs (Sept 2026).
export function detectProvider(url: string): ProviderNote | null {
  const id = providerIdFromUrl(url);
  if (id === "neon") return {
    provider: "Neon",
    notes: [
      "fsync and full_page_writes are off by design (Neon's storage layer provides durability), and its walproposer and retention slot are internal. None of those are reported as findings.",
      "pg_stat_statements is available (CREATE EXTENSION) but its stats reset whenever the compute suspends or restarts, so query findings only cover time since the last wake-up.",
      "Roles created in the Neon console get neon_superuser (includes pg_monitor); a SQL-created role must be granted pg_monitor explicitly.",
    ],
  };
  if (id === "supabase") return {
    provider: "Supabase",
    notes: [
      "Supabase-managed roles, schemas and internal query traffic are excluded from findings so the report shows your own workload. The pg_cron and pg_net bookkeeping tables (cron.job_run_details, net._http_response) stay in, because they grow with your usage.",
      "pg_stat_statements ships with every project; if query findings are empty, enable it under Database > Extensions.",
    ],
  };
  let host = "";
  try { host = new URL(url).hostname; } catch { return null; }
  return hostingNotes(host);
}
