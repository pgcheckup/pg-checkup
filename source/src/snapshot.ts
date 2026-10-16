// Migration checks: a snapshot of what a database is made of (catalog metadata only, never table rows), and a
// comparison of two snapshots that separates real regressions from differences expected when the host changes.
// Public basis: the PostgreSQL system catalogs (pg_class, pg_attribute, pg_index, pg_constraint, pg_policy, pg_proc,
// pg_trigger, pg_extension, pg_roles, pg_sequences, pg_settings) and pg_get_*def() functions.
import type { ProviderId } from "./provider.js";
import { roleSql, roleInfo, requireMonitoringRole } from "./role.js";
import { profileFor, providerIdFromUrl, userSchemaSql, detectProvider } from "./provider.js";
import { openReadOnlySession, TAG } from "./collect.js";

export const SNAPSHOT_FORMAT = "pg-checkup-snapshot";

export type Kind = "extension" | "schema" | "table" | "column" | "index" | "constraint" | "rls" | "policy" | "function" | "trigger" | "view" | "type" | "sequence" | "role" | "grant";
const KINDS: Kind[] = ["extension", "schema", "table", "column", "index", "constraint", "rls", "policy", "function", "trigger", "view", "type", "sequence", "role", "grant"];
const KIND_LABEL: Record<Kind, string> = { extension: "Extension", schema: "Schema", table: "Table", column: "Column", index: "Index", constraint: "Constraint", rls: "Row-level security", policy: "RLS policy", function: "Function", trigger: "Trigger", view: "View", type: "Type", sequence: "Sequence", role: "Role", grant: "Grant" };

export interface Snapshot {
  format: typeof SNAPSHOT_FORMAT; version: 1; takenAt: string;
  provider: ProviderId; hosting: string | null;
  server: { versionNum: number; version: string };
  database: { name: string; encoding: string; collate: string; ctype: string };
  /** kind -> object name -> canonical definition. */
  objects: Record<Kind, Record<string, string>>;
  /** Estimated rows (from the planner's statistics) and whether the table was ever analyzed. */
  tables: Record<string, { estRows: number; analyzed: boolean | null }>;
  /** Current value of each sequence, or null when the role can't read it. */
  sequenceValues: Record<string, number | null>;
  settings: Record<string, string>;
}

export interface Difference {
  kind: Kind | "database" | "data" | "sequence value" | "setting" | "server";
  object: string;
  change: "missing" | "added" | "changed";
  before?: string; after?: string;
  verdict: "regression" | "review" | "expected";
  why: string;
}

/** Extensions a provider installs in every database. Their absence elsewhere is not a regression. */
const PROVIDER_EXTENSIONS: Record<ProviderId, string[]> = { generic: [], supabase: ["pg_graphql", "supabase_vault", "pgsodium", "pgjwt"], neon: ["neon", "neon_utils"] };
const SETTINGS = ["server_encoding", "lc_collate", "timezone", "datestyle", "default_text_search_config", "search_path", "max_connections", "shared_buffers", "work_mem", "maintenance_work_mem", "effective_cache_size", "statement_timeout", "idle_in_transaction_session_timeout", "lock_timeout", "default_transaction_isolation", "standard_conforming_strings", "max_wal_size", "random_page_cost", "jit"];

/** Excludes objects that belong to an extension: they come with CREATE EXTENSION, not with your schema. */
const notExt = (classid: string, objid: string) => `not exists (select 1 from pg_depend d where d.classid = '${classid}'::regclass and d.objid = ${objid} and d.deptype = 'e')`;

function queries(p: ReturnType<typeof profileFor>): Record<Kind, string> {
  const us = (c: string) => userSchemaSql(p, c);
  const role = (c: string) => `(not ${p.managedRoleSql(c)} and ${c} !~ '^pg_')`;
  return {
    extension: `select extname as k, extversion as v from pg_extension where extname <> 'plpgsql'`,
    schema: `select nspname as k, '' as v from pg_namespace n where ${us("nspname")} and ${notExt("pg_namespace", "n.oid")}`,
    table: `select n.nspname || '.' || c.relname as k, case c.relkind when 'p' then 'partitioned table' when 'f' then 'foreign table' else 'table' end || case c.relpersistence when 'u' then ', unlogged' else '' end as v
      from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind in ('r', 'p', 'f') and not c.relispartition and ${us("n.nspname")} and ${notExt("pg_class", "c.oid")}`,
    column: `select n.nspname || '.' || c.relname || '.' || a.attname as k,
        format_type(a.atttypid, a.atttypmod) || case when a.attnotnull then ' not null' else '' end || coalesce(' default ' || pg_get_expr(ad.adbin, ad.adrelid), '')
        || case a.attidentity when 'a' then ' identity always' when 'd' then ' identity by default' else '' end || case when a.attgenerated = 's' then ' generated' else '' end as v
      from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace left join pg_attrdef ad on ad.adrelid = a.attrelid and ad.adnum = a.attnum
      where a.attnum > 0 and not a.attisdropped and c.relkind in ('r', 'p', 'f') and not c.relispartition and ${us("n.nspname")} and ${notExt("pg_class", "c.oid")}`,
    index: `select n.nspname || '.' || ic.relname as k, pg_get_indexdef(i.indexrelid) || case when i.indisvalid then '' else ' (INVALID)' end as v
      from pg_index i join pg_class ic on ic.oid = i.indexrelid join pg_class t on t.oid = i.indrelid join pg_namespace n on n.oid = ic.relnamespace
      where not t.relispartition and ${us("n.nspname")} and ${notExt("pg_class", "t.oid")}`,
    constraint: `select n.nspname || '.' || t.relname || '.' || k.conname as k, pg_get_constraintdef(k.oid) || case when k.convalidated then '' else ' (NOT VALIDATED)' end as v
      from pg_constraint k join pg_class t on t.oid = k.conrelid join pg_namespace n on n.oid = t.relnamespace where not t.relispartition and ${us("n.nspname")} and ${notExt("pg_class", "t.oid")}`,
    rls: `select n.nspname || '.' || c.relname as k, case when c.relrowsecurity then 'enabled' else 'disabled' end || case when c.relforcerowsecurity then ', forced' else '' end as v
      from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind in ('r', 'p') and not c.relispartition and ${us("n.nspname")} and ${notExt("pg_class", "c.oid")}`,
    policy: `select schemaname || '.' || tablename || '.' || policyname as k,
        permissive || ' for ' || cmd || ' to ' || array_to_string(roles, ',') || coalesce(' using (' || qual || ')', '') || coalesce(' with check (' || with_check || ')', '') as v
      from pg_policies where ${us("schemaname")}`,
    function: `select n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as k,
        l.lanname || ' returns ' || pg_get_function_result(p.oid) || ' ' || case p.provolatile when 'i' then 'immutable' when 's' then 'stable' else 'volatile' end
        || case when p.prosecdef then ' security definer' else '' end || coalesce(' set ' || array_to_string(p.proconfig, ','), '') || ' body ' || md5(coalesce(p.prosrc, '')) as v
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_language l on l.oid = p.prolang where ${us("n.nspname")} and ${notExt("pg_proc", "p.oid")}`,
    trigger: `select n.nspname || '.' || c.relname || '.' || t.tgname as k, pg_get_triggerdef(t.oid) || case t.tgenabled when 'D' then ' (DISABLED)' else '' end as v
      from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace where not t.tgisinternal and ${us("n.nspname")} and ${notExt("pg_class", "c.oid")}`,
    view: `select n.nspname || '.' || c.relname as k, case c.relkind when 'm' then 'materialized view ' else 'view ' end || md5(pg_get_viewdef(c.oid)) as v
      from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind in ('v', 'm') and ${us("n.nspname")} and ${notExt("pg_class", "c.oid")}`,
    type: `select n.nspname || '.' || t.typname as k, case t.typtype when 'e' then 'enum (' || (select string_agg(e.enumlabel, ', ' order by e.enumsortorder) from pg_enum e where e.enumtypid = t.oid) || ')'
        when 'd' then 'domain over ' || format_type(t.typbasetype, t.typtypmod) else 'composite' end as v
      from pg_type t join pg_namespace n on n.oid = t.typnamespace where t.typtype in ('e', 'd') and ${us("n.nspname")} and ${notExt("pg_type", "t.oid")}`,
    sequence: `select s.schemaname || '.' || s.sequencename as k, format_type(s.data_type, null) || ' increment ' || s.increment_by || ' max ' || s.max_value || case when s.cycle then ' cycle' else '' end as v
      from pg_sequences s where ${us("s.schemaname")}`,
    role: `select rolname as k, concat_ws(' ', case when rolcanlogin then 'login' else 'nologin' end, case when rolsuper then 'superuser' end, case when rolcreaterole then 'createrole' end,
        case when rolcreatedb then 'createdb' end, case when rolreplication then 'replication' end, case when rolbypassrls then 'bypassrls' end, case when not rolinherit then 'noinherit' end) as v
      from pg_roles where ${role("rolname")}`,
    grant: `select n.nspname || '.' || c.relname || ' to ' || case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as k, string_agg(a.privilege_type, ', ' order by a.privilege_type) as v
      from pg_class c join pg_namespace n on n.oid = c.relnamespace cross join lateral aclexplode(c.relacl) a
      where c.relkind in ('r', 'p', 'v', 'm', 'S') and c.relacl is not null and a.grantee <> c.relowner and ${us("n.nspname")} and ${notExt("pg_class", "c.oid")}
        and (a.grantee = 0 or ${role("pg_get_userbyid(a.grantee)")})
      group by 1`,
  };
}

/** Reads the snapshot over a read-only session. Catalog metadata only; function and view bodies are kept as hashes. */
export async function takeSnapshot(connectionString: string, opts: { provider?: ProviderId; allowPrivilegedRole?: boolean } = {}): Promise<Snapshot> {
  const { db } = await openReadOnlySession(connectionString);
  const q = async (sql: string) => (await db.query(`${TAG} ${sql}`)).rows as Record<string, any>[];
  try {
    const provider = opts.provider ?? providerIdFromUrl(connectionString);
    const p = profileFor(provider);
    requireMonitoringRole(roleInfo((await q(roleSql(p)))[0]), opts.allowPrivilegedRole);
    const [srv] = await q(`select current_setting('server_version_num')::int as n, version() as v, current_database() as db, pg_encoding_to_char(encoding) as enc, datcollate as collate, datctype as ctype from pg_database where datname = current_database()`);
    const objects = {} as Snapshot["objects"];
    const qs = queries(p);
    for (const k of KINDS) objects[k] = Object.fromEntries((await q(qs[k])).map((r) => [String(r.k), String(r.v ?? "")]));
    // Analyzed: an ANALYZE is recorded, or the planner has column statistics. Unknown (null) when the counters were reset
    // and the role can't see pg_stats for the table (pg_stats only shows columns the role may read).
    const tables = Object.fromEntries((await q(`select n.nspname || '.' || c.relname as k, greatest(c.reltuples, 0)::bigint as est,
        case when s.last_analyze is not null or s.last_autoanalyze is not null then true
             when has_table_privilege(c.oid, 'SELECT') then exists (select 1 from pg_stats st where st.schemaname = n.nspname and st.tablename = c.relname)
        end as analyzed
      from pg_class c join pg_namespace n on n.oid = c.relnamespace left join pg_stat_user_tables s on s.relid = c.oid
      where c.relkind in ('r', 'p') and not c.relispartition and ${userSchemaSql(p, "n.nspname")} and ${notExt("pg_class", "c.oid")}`)).map((r) => [String(r.k), { estRows: Number(r.est), analyzed: r.analyzed === null ? null : Boolean(r.analyzed) }]));
    // pg_sequences.last_value is null when the role lacks USAGE or SELECT on the sequence, and also before its first nextval().
    const sequenceValues = Object.fromEntries((await q(`select schemaname || '.' || sequencename as k, case when has_sequence_privilege(format('%I.%I', schemaname, sequencename), 'SELECT') then coalesce(last_value, start_value - increment_by) end as v from pg_sequences where ${userSchemaSql(p, "schemaname")}`)).map((r) => [String(r.k), r.v === null ? null : Number(r.v)]));
    const settings = Object.fromEntries((await q(`select name, setting || coalesce(unit, '') as v from pg_settings where name in (${SETTINGS.map((s) => `'${s}'`).join(", ")})`)).map((r) => [String(r.name), String(r.v)]));
    const hosting = detectProvider(connectionString)?.provider ?? null;
    return { format: SNAPSHOT_FORMAT, version: 1, takenAt: new Date().toISOString(), provider, hosting, server: { versionNum: Number(srv.n), version: String(srv.v) }, database: { name: String(srv.db), encoding: String(srv.enc), collate: String(srv.collate), ctype: String(srv.ctype) }, objects, tables, sequenceValues, settings };
  } finally {
    await db.end();
  }
}

const major = (n: number) => Math.floor(n / 10000);
const host = (s: Snapshot) => s.hosting ?? (s.provider === "generic" ? "a self-managed or unrecognised host" : s.provider);

/** Every difference between a baseline (before) and a snapshot of the new database (after), each with a verdict. */
export function diffSnapshots(before: Snapshot, after: Snapshot): Difference[] {
  const out: Difference[] = [];
  const moved = before.provider !== after.provider || before.hosting !== after.hosting;
  const versionChanged = major(before.server.versionNum) !== major(after.server.versionNum);
  if (versionChanged) out.push({ kind: "server", object: "PostgreSQL version", change: "changed", before: String(major(before.server.versionNum)), after: String(major(after.server.versionNum)), verdict: "review", why: "A new major version can change query plans and behaviour. Read the release notes' incompatibilities section for every version in between." });
  for (const f of ["encoding", "collate", "ctype"] as const) {
    if (before.database[f] !== after.database[f]) out.push({ kind: "database", object: f === "encoding" ? "Encoding" : f === "collate" ? "Collation (LC_COLLATE)" : "Character classification (LC_CTYPE)", change: "changed", before: before.database[f], after: after.database[f], verdict: "regression",
      why: f === "encoding" ? "Text that can't be represented in the new encoding fails to insert." : "Text sorts and compares differently, so ORDER BY results, unique constraints on text and text indexes can behave differently." });
  }
  const extOf = (id: ProviderId) => PROVIDER_EXTENSIONS[id] ?? [];
  for (const kind of KINDS) {
    const a = before.objects[kind] ?? {}, b = after.objects[kind] ?? {};
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const was = a[k], now = b[k];
      if (was === now) continue;
      const change = was === undefined ? "added" : now === undefined ? "missing" : "changed";
      out.push({ kind, object: k, change, ...(was !== undefined ? { before: was } : {}), ...(now !== undefined ? { after: now } : {}), ...verdict(kind, k, change, was, now, { moved, versionChanged, from: before, to: after, extOf }) });
    }
  }
  for (const [t, was] of Object.entries(before.tables)) {
    const now = after.tables[t];
    if (!now) continue; // reported as a missing table above
    if (now.analyzed === false && (now.estRows > 0 || was.estRows > 0)) out.push({ kind: "data", object: t, change: "changed", verdict: "regression", why: "Never analyzed in the new database, so the planner has no statistics for it and can choose very slow plans. Run ANALYZE (a restore doesn't carry statistics)." });
    else if (now.analyzed === null && (now.estRows > 0 || was.estRows > 0)) out.push({ kind: "data", object: t, change: "changed", verdict: "review", why: "No ANALYZE is recorded since the statistics counters were last reset. If the data was restored from a dump, run ANALYZE so the planner has statistics." });
    else if (was.estRows >= 1000 && now.estRows < was.estRows * 0.5) out.push({ kind: "data", object: t, change: "changed", before: `~${was.estRows.toLocaleString("en-US")} rows`, after: `~${now.estRows.toLocaleString("en-US")} rows`, verdict: "review", why: "The new table looks less than half as large. These are planner estimates: run ANALYZE, then compare exact counts with SELECT count(*) on both sides." });
  }
  for (const [s, was] of Object.entries(before.sequenceValues)) {
    if (!(s in after.sequenceValues)) continue;
    const now = after.sequenceValues[s];
    if (was === null || now === null) { if (was !== null || now !== null) out.push({ kind: "sequence value", object: s, change: "changed", verdict: "review", why: "Couldn't read the sequence's current value on one side. Grant SELECT on it to the role you scan with, or compare it as the owner." }); continue; }
    if (now < was) out.push({ kind: "sequence value", object: s, change: "changed", before: String(was), after: String(now), verdict: "regression", why: `The sequence is behind where it was, so new rows can be given ids that already exist. Run SELECT setval('${s}', ${was}); or higher.` });
  }
  for (const k of new Set([...Object.keys(before.settings), ...Object.keys(after.settings)])) {
    const was = before.settings[k], now = after.settings[k];
    if (was === now) continue;
    out.push({ kind: "setting", object: k, change: was === undefined ? "added" : now === undefined ? "missing" : "changed", before: was, after: now,
      verdict: moved ? "expected" : k === "timezone" || k === "search_path" || k === "default_transaction_isolation" || k === "standard_conforming_strings" ? "review" : "expected",
      why: moved ? `Server settings are set by the host, and this database moved from ${host(before)} to ${host(after)}.` : "Check that the application doesn't depend on the old value." });
  }
  const order = { regression: 0, review: 1, expected: 2 };
  return out.sort((x, y) => order[x.verdict] - order[y.verdict]);
}

function verdict(kind: Kind, k: string, change: Difference["change"], was: string | undefined, now: string | undefined,
  c: { moved: boolean; versionChanged: boolean; from: Snapshot; to: Snapshot; extOf: (id: ProviderId) => string[] }): Pick<Difference, "verdict" | "why"> {
  const reformatted = c.versionChanged ? " The server version changed, so this can be formatting only: compare the two definitions." : "";
  if (kind === "extension") {
    if (change === "missing" && c.extOf(c.from.provider).includes(k)) return { verdict: "expected", why: `${host(c.from)} installs this extension itself; it isn't part of your schema.` };
    if (change === "added" && c.extOf(c.to.provider).includes(k)) return { verdict: "expected", why: `${host(c.to)} installs this extension itself.` };
    if (change === "missing") return { verdict: "regression", why: "Anything that uses its functions or types fails. Check the new host supports it, then CREATE EXTENSION." };
    if (change === "changed") return { verdict: "review", why: "A different extension version can change function behaviour. Read its changelog." };
    return { verdict: "review", why: "Not in the old database." };
  }
  if (kind === "role") {
    if (change === "missing" && profileFor(c.from.provider).expectedAdmins.includes(k)) return { verdict: "expected", why: `The admin role that ${host(c.from)} creates.` };
    if (change === "missing") return { verdict: "regression", why: "Logins as this role fail, and grants and policies that name it don't apply. Create the role, then re-run the grants." };
    if (change === "changed" && c.moved) return { verdict: "expected", why: `Managed hosts limit role attributes such as SUPERUSER and REPLICATION; this database moved from ${host(c.from)} to ${host(c.to)}.` };
    return { verdict: "review", why: change === "added" ? "A role that wasn't in the old database." : "Role attributes differ." };
  }
  if (change === "added") return { verdict: "review", why: `Not in the old database. Expected only if a migration ran after the copy.` };
  const missing = change === "missing";
  switch (kind) {
    case "rls": return { verdict: "regression", why: was?.startsWith("enabled") ? "Row-level security was on and isn't now, so every role with table access sees every row." : "Row-level security differs." };
    case "policy": return { verdict: "regression", why: (missing ? "Without this policy, rows it allowed are hidden, or with RLS off, everything is visible." : "The policy now allows different rows.") + reformatted };
    case "grant": return { verdict: "regression", why: missing ? "This role has lost access to the table." : "This role's privileges on the table changed." };
    case "table": case "column": case "constraint": case "type": return { verdict: "regression", why: (missing ? "Queries that use it fail." : kind === "constraint" ? "The constraint enforces something different, or no longer validates existing rows." : "Its definition changed.") + (missing ? "" : reformatted) };
    case "index": return { verdict: missing ? "regression" : "review", why: missing ? "Queries that used it now scan instead, and if it was unique, duplicates are allowed." : `Its definition differs.${now?.includes("INVALID") ? " It is INVALID: a CREATE INDEX CONCURRENTLY failed; drop and recreate it." : reformatted}` };
    case "function": case "view": case "trigger": return { verdict: "regression", why: (missing ? "Anything that calls it fails." : "Its definition changed.") + (missing ? "" : reformatted) };
    case "sequence": return { verdict: missing ? "regression" : "review", why: missing ? "Inserts that use it as a default fail." : "Its type, increment or limit changed." };
    case "schema": return { verdict: "regression", why: "Everything in it is missing." };
    default: return { verdict: "review", why: "Differs." };
  }
}

export const kindLabel = (k: Difference["kind"]) => (k in KIND_LABEL ? KIND_LABEL[k as Kind] : k.charAt(0).toUpperCase() + k.slice(1));

/** Plain-text summary for the terminal. */
export function diffText(diffs: Difference[], before: Snapshot, after: Snapshot): string {
  const on = (x: Snapshot) => (x.hosting ?? (x.provider !== "generic" ? x.provider : null));
  const lines: string[] = [`Compared ${before.database.name}${on(before) ? ` on ${on(before)}` : ""} (baseline from ${before.takenAt.slice(0, 16).replace("T", " ")} UTC) with ${after.database.name}${on(after) ? ` on ${on(after)}` : ""}.`, ""];
  const groups: [Difference["verdict"], string][] = [["regression", "Needs fixing"], ["review", "Check these"], ["expected", `Expected${before.provider !== after.provider || before.hosting !== after.hosting ? ` when moving from ${host(before)} to ${host(after)}` : ""}`]];
  if (!diffs.length) lines.push("No differences in the captured schema, security, functions, grants, sequences or settings.", "");
  for (const [v, title] of groups) {
    const ds = diffs.filter((d) => d.verdict === v);
    if (!ds.length) continue;
    lines.push(`${title} (${ds.length})`);
    for (const d of ds) {
      lines.push(`  ${d.change === "missing" ? "-" : d.change === "added" ? "+" : "~"} ${kindLabel(d.kind)} ${d.object}${d.before !== undefined && d.after !== undefined ? `: ${short(d.before)} -> ${short(d.after)}` : ""}`);
      lines.push(`      ${d.why}`);
    }
    lines.push("");
  }
  lines.push("Query performance isn't compared here: right after a move the cache is cold and statistics are new.", "Use pg-checkup observe --seconds 300 --representative on each database under equivalent warmed traffic, then compare the two window files.");
  lines.push("This checks database metadata, not row equality or application behavior. Sequence values may be unavailable to a restricted role.");
  if (before.provider === "supabase" || after.provider === "supabase") lines.push("Supabase handoff: separately verify Auth logins/OAuth callbacks, Storage objects and policies, Edge Functions/secrets, Realtime subscriptions and TLS/pooler configuration. Provider-managed schemas are excluded from this comparison.");
  return lines.join("\n");
}
const short = (s: string) => (s.length > 80 ? `${s.slice(0, 77)}...` : s);
