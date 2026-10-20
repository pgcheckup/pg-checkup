#!/usr/bin/env node

// src/collector-cli.ts
import { readFileSync as readFileSync2, writeFileSync, statSync as statSync2, mkdirSync, existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { spawnSync } from "node:child_process";
import { createHash as createHash2, randomBytes } from "node:crypto";
import net2 from "node:net";

// src/prompt.ts
import readline from "node:readline";
import { Writable } from "node:stream";
function askHidden(question, input = process.stdin, output = process.stdout) {
  return new Promise((resolve) => {
    let muted = false;
    const quiet = new Writable({ write(chunk, enc2, cb) {
      if (!muted) output.write(chunk, enc2);
      cb();
    } });
    const rl = readline.createInterface({ input, output: quiet, terminal: true });
    let answered = false;
    output.write(question);
    muted = true;
    rl.on("close", () => {
      if (!answered) {
        output.write("\n");
        resolve("");
      }
    });
    rl.question("", (a) => {
      answered = true;
      muted = false;
      rl.close();
      output.write("\n");
      resolve(a.trim());
    });
  });
}

// src/connection.ts
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
var enc = encodeURIComponent;
function readService(name, env = process.env) {
  const file = env.PGSERVICEFILE ?? join(homedir(), ".pg_service.conf");
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  let current = "";
  const out2 = {};
  let found = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const sec = /^\[(.+)\]$/.exec(line);
    if (sec) {
      if (found) break;
      current = sec[1].trim();
      found = current === name;
      continue;
    }
    if (!found) continue;
    const eq = line.indexOf("=");
    if (eq > 0) out2[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return found ? out2 : null;
}
function readPgpass(p, env = process.env) {
  const file = env.PGPASSFILE ?? join(homedir(), ".pgpass");
  let text;
  try {
    if (process.platform !== "win32" && (statSync(file).mode & 63) !== 0) return void 0;
    text = readFileSync(file, "utf8");
  } catch {
    return void 0;
  }
  const wanted = [p.host, p.port, p.database, p.user];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const fields = [];
    let cur = "";
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === "\\" && i + 1 < line.length) {
        cur += line[++i];
        continue;
      }
      if (ch === ":" && fields.length < 4) {
        fields.push(cur);
        cur = "";
        continue;
      }
      cur += ch;
    }
    fields.push(cur);
    if (fields.length < 5) continue;
    if (fields.slice(0, 4).every((f, i) => f === "*" || f === wanted[i])) return fields[4];
  }
  return void 0;
}
var ENV_URL_KEYS = ["DATABASE_URL", "POSTGRES_URL", "POSTGRES_PRISMA_URL", "DIRECT_URL", "PG_URL", "PGURL"];
var ENV_FILES = [".env.local", ".env"];
function readEnvFileUrl(cwd = process.cwd()) {
  for (const file of ENV_FILES) {
    let text;
    try {
      text = readFileSync(join(cwd, file), "utf8");
    } catch {
      continue;
    }
    const vars = /* @__PURE__ */ new Map();
    for (const raw of text.split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(raw);
      if (!m) continue;
      const raw2 = m[2];
      const q = /^(["'])(.*?)\1(?:\s+#.*)?$/.exec(raw2);
      vars.set(m[1], q ? q[2] : raw2.replace(/\s+#.*$/, ""));
    }
    for (const key of ENV_URL_KEYS) {
      const v = vars.get(key);
      if (v && /^postgres(ql)?:\/\//.test(v)) return { url: v, file, key };
    }
  }
  return null;
}
var envHasConnection = (env = process.env) => Boolean(env.DATABASE_URL || env.PGHOST || env.PGDATABASE || env.PGSERVICE || env.PGUSER);
function resolveConnection(a, rawEnv = process.env) {
  const env = Object.fromEntries(Object.entries(rawEnv).filter(([, v]) => v !== void 0 && v !== ""));
  if (a.url) {
    let database2 = "";
    try {
      database2 = decodeURIComponent(new URL(a.url).pathname.slice(1));
    } catch {
    }
    return { url: a.url, structured: false, needsPassword: false, database: database2, passwordSource: /^postgres(ql)?:\/\/[^:@/]*:[^@]*@/.test(a.url) ? "url" : void 0 };
  }
  const svcName = a.service ?? env.PGSERVICE;
  const svc = svcName ? readService(svcName, env) ?? {} : {};
  if (svcName && !Object.keys(svc).length) throw new Error(`Service "${svcName}" was not found in ${env.PGSERVICEFILE ?? "~/.pg_service.conf"}.`);
  const given = a.host ?? a.user ?? a.database ?? a.port ?? svcName ?? (envHasConnection(env) ? "env" : void 0);
  if (given === void 0) return null;
  const host2 = a.host ?? svc.host ?? env.PGHOST ?? "localhost";
  const user = a.user ?? svc.user ?? env.PGUSER ?? env.USER ?? env.USERNAME ?? "postgres";
  const database = a.database ?? svc.dbname ?? env.PGDATABASE ?? user;
  const port = a.port ?? svc.port ?? env.PGPORT ?? "5432";
  const ssl = a.sslmode ?? svc.sslmode ?? env.PGSSLMODE;
  let password = a.password;
  let passwordSource = a.password ? "flag" : void 0;
  if (!password && env.PGPASSWORD) {
    password = env.PGPASSWORD;
    passwordSource = "PGPASSWORD";
  }
  if (!password && svc.password) {
    password = svc.password;
    passwordSource = "service";
  }
  if (!password) {
    password = readPgpass({ host: host2, port, database, user }, env);
    if (password) passwordSource = "pgpass";
  }
  const hostPart = host2.includes(":") && !host2.startsWith("[") ? `[${host2}]` : host2;
  const url = `postgres://${enc(user)}${password ? `:${enc(password)}` : ""}@${hostPart}:${port}/${enc(database)}${ssl ? `?sslmode=${enc(ssl)}` : ""}`;
  return { url, structured: true, needsPassword: !password, database, parts: { host: host2, port, user, database }, passwordSource };
}
function safeName(s, fallback = "backup") {
  const n = s.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 60);
  return n || fallback;
}
function withPassword(url, password) {
  const m = /^(postgres(?:ql)?:\/\/)([^:@/]*)(?::[^@]*)?@([\s\S]*)$/.exec(url);
  return m ? `${m[1]}${m[2]}:${encodeURIComponent(password)}@${m[3]}` : url;
}
function redactUrl(url) {
  return url.replace(/^(postgres(?:ql)?:\/\/[^:@/]*):[^@]*@/, "$1:***@");
}

// src/collect.ts
import net from "node:net";
import pg from "pg";

// src/provider.ts
var SYSTEM_SCHEMAS = ["pg_catalog", "information_schema", "pg_toast"];
var EXTENSION_TABLES = [["cron", "job_run_details"], ["net", "_http_response"], ["net", "http_request_queue"]];
var PROFILES = {
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
    internalAppSql: (c) => `(${c} ~ '^(Supavisor|PostgREST|postgres_exporter|pgbouncer|Supabase)')`
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
      full_page_writes: "Neon turns full_page_writes off on purpose: its storage layer reconstructs pages, so torn writes on the compute don't matter."
    },
    internalSlots: ["wal_proposer_slot", "wal_retention_slot"],
    internalSyncStandbys: ["walproposer"],
    poolerOnPrivateNetwork: true,
    internalAppSql: (c) => `(${c} ~ '^(compute_ctl|vm-monitor|neon_compute_sql_exporter|pgbouncer)')`
  }
};
function profileFor(id) {
  return PROFILES[id];
}
function providerIdFromUrl(url) {
  let host2 = "";
  try {
    host2 = new URL(url).hostname;
  } catch {
    return "generic";
  }
  if (host2.endsWith(".neon.tech")) return "neon";
  if (host2.endsWith(".supabase.co") || host2.endsWith(".supabase.com")) return "supabase";
  return "generic";
}
function userSchemaSql(p, col) {
  const list2 = [...SYSTEM_SCHEMAS, ...p.managedSchemas].map((s) => `'${s}'`).join(",");
  return `(${col} not in (${list2}) and ${col} !~ '^pg_(temp|toast_temp)')`;
}
function userTableSql(p, schemaCol, tableCol) {
  if (!p.watchedTables.length) return userSchemaSql(p, schemaCol);
  const pairs = p.watchedTables.map(([s, t]) => `('${s}','${t}')`).join(",");
  return `(${userSchemaSql(p, schemaCol)} or (${schemaCol}, ${tableCol}) in (${pairs}))`;
}
function hostingNotes(host2) {
  if (/\.rlwy\.net$|\.railway\.app$|railway\.internal$/.test(host2)) return { provider: "Railway", notes: [
    "Railway runs the stock Postgres image with a fixed-size volume. Free disk isn't visible from SQL, so compare the footprint in this report with the volume size in the service's Metrics tab.",
    "The *.railway.internal address only works from services inside the project; scans from outside need the TCP proxy (DATABASE_PUBLIC_URL)."
  ] };
  if (/\.render\.com$/.test(host2)) return { provider: "Render", notes: ["Render manages backups and the instance size; disk usage is in the dashboard, not visible from SQL."] };
  if (/\.rds\.amazonaws\.com$/.test(host2)) return { provider: "Amazon RDS", notes: ["RDS owns fsync, archiving and backups. The rds_superuser role isn't a real superuser, so some catalog views may be unavailable. Free storage is a CloudWatch metric, not visible from SQL."] };
  if (/\.aivencloud\.com$/.test(host2)) return { provider: "Aiven", notes: ["Aiven manages backups and WAL archiving; those checks are informational here."] };
  if (/\.timescale\.com$|\.tsdb\.cloud/.test(host2)) return { provider: "Timescale Cloud", notes: ["Timescale Cloud manages backups and archiving. Hypertable chunks appear as many small tables in the size and bloat datasets."] };
  return null;
}
function detectProvider(url) {
  const id = providerIdFromUrl(url);
  if (id === "neon") return {
    provider: "Neon",
    notes: [
      "fsync and full_page_writes are off by design (Neon's storage layer provides durability), and its walproposer and retention slot are internal. None of those are reported as findings.",
      "pg_stat_statements is available (CREATE EXTENSION) but its stats reset whenever the compute suspends or restarts, so query findings only cover time since the last wake-up.",
      "Roles created in the Neon console get neon_superuser (includes pg_monitor); a SQL-created role must be granted pg_monitor explicitly."
    ]
  };
  if (id === "supabase") return {
    provider: "Supabase",
    notes: [
      "Supabase-managed roles, schemas and internal query traffic are excluded from findings so the report shows your own workload. The pg_cron and pg_net bookkeeping tables (cron.job_run_details, net._http_response) stay in, because they grow with your usage.",
      "pg_stat_statements ships with every project; if query findings are empty, enable it under Database > Extensions."
    ]
  };
  let host2 = "";
  try {
    host2 = new URL(url).hostname;
  } catch {
    return null;
  }
  return hostingNotes(host2);
}

// src/dsutil.ts
var C = (key, label, kind = "text", extra = {}) => ({ key, label, kind, ...extra });
var NUMERIC = ["int", "bytes", "ms", "secs", "pct"];
var us = (c, col) => userSchemaSql(c.profile, col);
var ut = (c, schemaCol, tableCol) => userTableSql(c.profile, schemaCol, tableCol);
var TOOLING_SQL = String.raw`(pg_catalog\.|information_schema\.|\mpg_(timezone_names|available_extensions|extension|namespace|class|proc|policy|policies|type|attribute|attrdef|constraint|index|indexes|roles|authid|auth_members|database|settings|stat_|statio_|description|depend|trigger|rewrite|enum|inherits|tables|views|sequences|locks|replication_slots)\M)`;
var inDb = "(select oid from pg_database where datname = current_database())";
var pgss = (c) => `from pg_stat_statements s join pg_roles r on r.oid = s.userid
  where s.dbid = ${inDb} and not ${c.profile.managedRoleSql("r.rolname")} and s.query !~* '${TOOLING_SQL}' and s.query not like '%/* pg-checkup */%'`;
var SECRET_NAME = String.raw`(pass|secret|token|conninfo|credential|api_?key|private|_command$|(^|[._])key($|[._]))`;
var safeValue = (col = "setting", name = "name") => `case when ${name} ~* '${SECRET_NAME}' or ${col} ~ '://|host=' then '(hidden)' else ${col} end`;
var QUOTED = `'([^']|'')*'`;
var DOLLAR_QUOTED = String.raw`\$([A-Za-z_]*)\$.*?\$\1\$`;
var NUMBER = String.raw`(^|[^\w$.])-?\d+(\.\d+)?(e[+-]?\d+)?\M`;
var KEEP_PREFIX = String.raw`\1`;
var maskSql = (col, n = 400) => `left(regexp_replace(regexp_replace(regexp_replace(${col}, $re$${QUOTED}$re$, $$'?'$$, 'g'), $re$${DOLLAR_QUOTED}$re$, $$'?'$$, 'g'), $re$${NUMBER}$re$, $$${KEEP_PREFIX}?$$, 'g'), ${n})`;
var setting = (names) => `select name, ${safeValue()} as setting, coalesce(unit, '') as unit, source from pg_settings where name in (${names.map((n) => `'${n}'`).join(",")}) order by name`;
var SETTING_COLS = [C("name", "Setting", "mono"), C("setting", "Value", "mono"), C("unit", "Unit"), C("source", "Source")];
function isConnectionLost(e) {
  const x = e;
  return /^08/.test(x?.code ?? "") || /^57P0[123]$/.test(x?.code ?? "") || /Connection terminated|connection.*(closed|ended|reset)|ECONNRESET|EPIPE|Client has encountered a connection error|terminating connection/i.test(x?.message ?? "");
}

// src/inspect_more.ts
var MORE = [
  // ───────── Queries
  {
    id: "q_pgss",
    section: "queries",
    title: "Statement tracking health",
    source: "pg_stat_statements_info",
    layout: "kv",
    limit: 1,
    ext: "pg_stat_statements",
    minPg: 14e4,
    description: "How many statements were evicted from the tracking table. Evictions mean pg_stat_statements.max is too small and history is being lost.",
    columns: [C("dealloc", "Statements evicted", "int", { warn: 1 }), C("stats_reset", "Since", "ts")],
    sql: () => `select dealloc, stats_reset from pg_stat_statements_info`
  },
  // ───────── Tables
  {
    id: "t_stale",
    section: "tables",
    title: "Stale planner statistics",
    source: "pg_stat_user_tables",
    limit: 25,
    description: "Rows changed since the last ANALYZE. The planner picks bad plans when its statistics no longer match the data.",
    columns: [C("table", "Table", "mono"), C("live_rows", "Live rows", "int"), C("mods", "Changed since analyze", "int"), C("mod_pct", "Changed %", "pct", { warn: 20, bad: 50 }), C("last_analyzed", "Last analyzed", "ts"), C("autoanalyzes", "Auto-analyzes", "int")],
    sql: (c) => `select schemaname || '.' || relname as "table", n_live_tup as live_rows, n_mod_since_analyze as mods, round(100.0 * n_mod_since_analyze / nullif(n_live_tup, 0), 1) as mod_pct,
      greatest(last_analyze, last_autoanalyze) as last_analyzed, autoanalyze_count as autoanalyzes
      from pg_stat_user_tables where n_mod_since_analyze > 0 and ${us(c, "schemaname")} order by n_mod_since_analyze desc limit 25`
  },
  {
    id: "t_bloat",
    section: "tables",
    title: "Measured table bloat",
    source: "pgstattuple_approx()",
    limit: 15,
    ext: "pgstattuple",
    hint: "Install pgstattuple to measure bloat instead of estimating: create extension pgstattuple; (the pg_monitor role can run it).",
    description: "Wasted space in the largest tables, measured with pgstattuple_approx (uses the visibility map, so it is cheap).",
    columns: [C("table", "Table", "mono"), C("bytes", "Size", "bytes"), C("dead_pct", "Dead", "pct"), C("free_pct", "Free space", "pct"), C("bloat_pct", "Bloat", "pct", { warn: 30, bad: 60 }), C("wasted_bytes", "Wasted", "bytes")],
    sql: (c) => `select n.nspname || '.' || t.relname as "table", pg_relation_size(t.oid) as bytes, round(a.dead_tuple_percent::numeric, 1) as dead_pct, round(a.approx_free_percent::numeric, 1) as free_pct,
      round((a.dead_tuple_percent + a.approx_free_percent)::numeric, 1) as bloat_pct, (a.dead_tuple_len + a.approx_free_space)::bigint as wasted_bytes
      from pg_class t join pg_namespace n on n.oid = t.relnamespace, lateral pgstattuple_approx(t.oid) a
      where t.relkind = 'r' and ${ut(c, "n.nspname", "t.relname")} and pg_relation_size(t.oid) > 8 * 1024 * 1024 order by pg_relation_size(t.oid) desc limit 15`
  },
  // ───────── Vacuum
  {
    id: "v_never",
    section: "vacuum",
    title: "Busy tables never vacuumed",
    source: "pg_stat_user_tables",
    limit: 25,
    description: "Tables with plenty of writes that neither autovacuum nor a manual VACUUM has ever visited.",
    columns: [C("table", "Table", "mono"), C("writes", "Writes", "int"), C("live_rows", "Live rows", "int"), C("dead_rows", "Dead rows", "int"), C("last_analyzed", "Last analyzed", "ts")],
    sql: (c) => `select schemaname || '.' || relname as "table", (n_tup_ins + n_tup_upd + n_tup_del) as writes, n_live_tup as live_rows, n_dead_tup as dead_rows, greatest(last_analyze, last_autoanalyze) as last_analyzed
      from pg_stat_user_tables where last_vacuum is null and last_autovacuum is null and (n_tup_ins + n_tup_upd + n_tup_del) > 10000 and ${ut(c, "schemaname", "relname")} order by writes desc limit 25`
  },
  // ───────── Indexes
  {
    id: "i_redundant",
    section: "indexes",
    title: "Redundant indexes (prefix of another)",
    source: "pg_index",
    limit: 25,
    description: "A non-unique index whose columns are the leading columns of a longer index on the same table. The longer index can serve the same queries.",
    columns: [C("table", "Table", "mono"), C("redundant", "Redundant index", "mono"), C("covered_by", "Covered by", "mono"), C("bytes", "Size", "bytes")],
    sql: (c) => `with ix as (
        select i.indexrelid, i.indrelid, string_to_array(i.indkey::text, ' ') as k, string_to_array(i.indclass::text, ' ') as cl, string_to_array(i.indoption::text, ' ') as o,
               i.indisunique, i.indisprimary, ic.relam, ic.relname as name
        from pg_index i join pg_class ic on ic.oid = i.indexrelid where i.indisvalid and i.indpred is null and i.indexprs is null)
      select n.nspname || '.' || t.relname as "table", a.name as redundant, b.name as covered_by, pg_relation_size(a.indexrelid) as bytes
      from ix a join ix b on b.indrelid = a.indrelid and b.indexrelid <> a.indexrelid and b.relam = a.relam
        and array_length(b.k, 1) > array_length(a.k, 1)
        and b.k[1:array_length(a.k, 1)] = a.k and b.cl[1:array_length(a.cl, 1)] = a.cl and b.o[1:array_length(a.o, 1)] = a.o
      join pg_class t on t.oid = a.indrelid join pg_namespace n on n.oid = t.relnamespace
      where not a.indisunique and not a.indisprimary and ${us(c, "n.nspname")} order by bytes desc limit 25`
  },
  // ───────── Schema & integrity
  {
    id: "sch_seq",
    section: "schema",
    title: "Sequence usage",
    source: "pg_sequences",
    limit: 30,
    description: "How much of each sequence's range is used. An integer sequence that runs out makes inserts fail. Sequences you can't SELECT show no value.",
    columns: [
      C("sequence", "Sequence", "mono"),
      C("type", "Type"),
      C("last_value", "Last value"),
      C("max_value", "Max value"),
      C("pct_used", "Used", "pct", { warn: 50, bad: 80 }),
      C("cycle", "Cycles", "bool"),
      C("readable", "Readable", "bool"),
      C("owner_table", "Used by", "mono"),
      C("inserts", "Rows inserted since stats reset", "int")
    ],
    sql: (c) => `select s.schemaname || '.' || s.sequencename as sequence, s.data_type::text as type, s.last_value::text as last_value, s.max_value::text as max_value,
      round(100.0 * s.last_value / nullif(s.max_value, 0), 2) as pct_used, s.cycle, has_sequence_privilege(format('%I.%I', s.schemaname, s.sequencename), 'SELECT') as readable,
      o.owner_table, o.inserts
      from pg_sequences s
      left join lateral (select d.refobjid::regclass::text as owner_table, st.n_tup_ins as inserts from pg_depend d
        left join pg_stat_user_tables st on st.relid = d.refobjid
        where d.objid = format('%I.%I', s.schemaname, s.sequencename)::regclass and d.classid = 'pg_class'::regclass
          and d.refclassid = 'pg_class'::regclass and d.deptype in ('a', 'i') limit 1) o on true
      where ${us(c, "s.schemaname")} order by pct_used desc nulls last limit 30`
  },
  {
    id: "sch_notvalid",
    section: "schema",
    title: "Unvalidated constraints",
    source: "pg_constraint",
    limit: 30,
    description: "Constraints added as NOT VALID protect new rows only. Existing rows may still violate them until VALIDATE CONSTRAINT runs.",
    columns: [C("table", "Table", "mono"), C("constraint", "Constraint", "mono"), C("type", "Type"), C("definition", "Definition", "mono")],
    sql: (c) => `select n.nspname || '.' || t.relname as "table", k.conname as "constraint", case k.contype when 'f' then 'foreign key' when 'c' then 'check' else k.contype::text end as type, pg_get_constraintdef(k.oid) as definition
      from pg_constraint k join pg_class t on t.oid = k.conrelid join pg_namespace n on n.oid = t.relnamespace where not k.convalidated and ${us(c, "n.nspname")} limit 30`
  },
  {
    id: "sch_triggers",
    section: "schema",
    title: "Disabled triggers",
    source: "pg_trigger",
    limit: 30,
    description: "Triggers switched off. Often left over from a bulk load, which silently skips the logic they enforce.",
    columns: [C("table", "Table", "mono"), C("trigger", "Trigger", "mono"), C("function", "Function", "mono")],
    sql: (c) => `select n.nspname || '.' || t.relname as "table", g.tgname::text as trigger, g.tgfoid::regproc::text as function
      from pg_trigger g join pg_class t on t.oid = g.tgrelid join pg_namespace n on n.oid = t.relnamespace
      where not g.tgisinternal and g.tgenabled = 'D' and ${us(c, "n.nspname")} limit 30`
  },
  {
    id: "sch_unlogged",
    section: "schema",
    title: "Unlogged tables",
    source: "pg_class",
    limit: 30,
    description: "Not crash-safe and not replicated. Their contents are lost after a crash and absent on standbys.",
    columns: [C("table", "Table", "mono"), C("bytes", "Size", "bytes"), C("est_rows", "Est. rows", "int")],
    sql: (c) => `select n.nspname || '.' || t.relname as "table", pg_total_relation_size(t.oid) as bytes, greatest(t.reltuples, 0)::bigint as est_rows
      from pg_class t join pg_namespace n on n.oid = t.relnamespace where t.relpersistence = 'u' and t.relkind = 'r' and ${us(c, "n.nspname")} order by bytes desc limit 30`
  },
  {
    id: "sch_lo",
    section: "schema",
    title: "Large objects",
    source: "pg_largeobject_metadata",
    layout: "kv",
    limit: 1,
    description: "Legacy large-object storage. It isn't cleaned up when a referencing row is deleted, so orphans accumulate.",
    columns: [C("objects", "Objects", "int"), C("bytes", "Size", "bytes")],
    sql: () => `select (select count(*) from pg_largeobject_metadata)::int as objects, pg_total_relation_size('pg_largeobject') as bytes`
  },
  // ───────── Blocking & connections
  {
    id: "b_running",
    section: "blocking",
    title: "Queries running now",
    source: "pg_stat_activity",
    limit: 15,
    description: "Active statements, longest first.",
    columns: [C("pid", "PID", "id"), C("user", "User"), C("app", "Application"), C("running_s", "Running for", "secs", { warn: 300, bad: 3600 }), C("wait", "Waiting on", "mono"), C("query", "Query", "mono")],
    sql: () => `select pid, usename::text as "user", application_name as app, round(extract(epoch from now() - query_start)::numeric, 1) as running_s,
      coalesce(wait_event_type || ': ' || wait_event, '') as wait, ${maskSql("query")} as query
      from pg_stat_activity where state = 'active' and backend_type = 'client backend' and pid <> pg_backend_pid() order by running_s desc limit 15`
  },
  {
    id: "c_waits",
    section: "connections",
    title: "What active sessions are waiting on",
    source: "pg_stat_activity",
    limit: 20,
    description: "A snapshot of wait events across active sessions. Lock and I/O waits dominate most slowdowns.",
    columns: [C("type", "Wait type"), C("event", "Wait event", "mono"), C("sessions", "Sessions", "int")],
    sql: () => `select coalesce(wait_event_type, 'Running on CPU') as type, coalesce(wait_event, '-') as event, count(*)::int as sessions
      from pg_stat_activity where state = 'active' and backend_type = 'client backend' and pid <> pg_backend_pid() group by 1, 2 order by sessions desc limit 20`
  },
  // ───────── Configuration
  {
    id: "cfg_version",
    section: "config",
    title: "Server version and support",
    source: "pg_settings",
    layout: "kv",
    limit: 1,
    description: "Which release you run. Each major version gets security fixes for five years.",
    columns: [C("version", "Version", "mono"), C("in_recovery", "Is a standby", "bool"), C("data_checksums", "Data checksums", "mono"), C("db_bytes", "This database", "bytes")],
    sql: () => `select current_setting('server_version') as version, current_setting('server_version_num')::int as version_num, pg_is_in_recovery() as in_recovery,
      current_setting('data_checksums') as data_checksums, pg_database_size(current_database()) as db_bytes`
  },
  {
    id: "cfg_safety",
    section: "config",
    title: "Durability, safety and security settings",
    source: "pg_settings",
    limit: 30,
    description: "Settings where the wrong value risks data loss, corruption or exposure.",
    columns: SETTING_COLS,
    sql: () => setting(["fsync", "full_page_writes", "synchronous_commit", "data_checksums", "track_counts", "autovacuum", "password_encryption", "ssl", "wal_level", "archive_mode", "max_replication_slots", "max_wal_size", "shared_buffers", "work_mem", "max_connections"])
  },
  // ───────── Logs & activity
  {
    id: "io_stat",
    section: "logs",
    title: "I/O by backend type",
    source: "pg_stat_io",
    limit: 20,
    minPg: 16e4,
    description: "Reads and writes by process type. Times need track_io_timing.",
    columns: [C("backend", "Backend", "mono"), C("object", "Object"), C("context", "Context"), C("reads", "Reads", "int"), C("read_ms", "Read time", "ms"), C("writes", "Writes", "int"), C("write_ms", "Write time", "ms"), C("hits", "Cache hits", "int"), C("evictions", "Evictions", "int")],
    sql: () => `select backend_type as backend, object, context, reads, round(read_time::numeric) as read_ms, writes, round(write_time::numeric) as write_ms, hits, evictions
      from pg_stat_io where coalesce(reads, 0) > 0 or coalesce(writes, 0) > 0 order by coalesce(read_time, 0) + coalesce(write_time, 0) desc, coalesce(reads, 0) + coalesce(writes, 0) desc limit 20`
  },
  // ───────── Security
  {
    id: "s_definer",
    section: "security",
    title: "SECURITY DEFINER functions",
    source: "pg_proc",
    limit: 40,
    description: "These run with the owner's privileges. Without a fixed search_path, a caller can shadow objects and hijack them.",
    columns: [C("function", "Function", "mono"), C("owner", "Owner"), C("search_path_set", "search_path fixed", "bool"), C("public_exec", "Callable by anyone", "bool")],
    sql: (c) => `select n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as function, pg_get_userbyid(p.proowner)::text as owner,
      exists (select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) cfg where cfg like 'search_path=%') as search_path_set, has_function_privilege('public', p.oid, 'EXECUTE') as public_exec
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where p.prosecdef and ${us(c, "n.nspname")} and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e') order by 3, 1 limit 40`
  },
  {
    id: "s_exposure",
    section: "security",
    title: "Public tables readable by the anon role",
    source: "pg_class, pg_policy",
    only: ["supabase"],
    limit: 50,
    description: "Tables in the public schema that the anon role can read while row-level security is off. On Supabase these are exposed through the public API.",
    columns: [C("table", "Table", "mono"), C("rls", "RLS enabled", "bool"), C("anon_select", "anon can SELECT", "bool"), C("est_rows", "Est. rows", "int")],
    sql: () => `select n.nspname || '.' || t.relname as "table", t.relrowsecurity as rls, has_table_privilege('anon', t.oid, 'SELECT') as anon_select, greatest(t.reltuples, 0)::bigint as est_rows
      from pg_class t join pg_namespace n on n.oid = t.relnamespace
      where n.nspname = 'public' and t.relkind in ('r','p') and not t.relrowsecurity and has_table_privilege('anon', t.oid, 'SELECT') order by est_rows desc limit 50`
  },
  {
    id: "s_hba",
    section: "security",
    title: "Authentication rules",
    source: "pg_hba_file_rules",
    only: ["generic"],
    limit: 60,
    description: "Which hosts may connect, as whom, and how they authenticate. Needs superuser or an explicit GRANT on the view.",
    columns: [C("line", "Line", "id"), C("type", "Type", "mono"), C("database", "Database", "mono"), C("users", "Users", "mono"), C("address", "Address", "mono"), C("method", "Method", "mono")],
    sql: () => `select line_number as line, type, array_to_string(database, ',') as database, array_to_string(user_name, ',') as users, coalesce(address, '') as address, auth_method as method
      from pg_hba_file_rules order by line_number limit 60`
  },
  // ───────── Backups & recovery
  {
    id: "bk_archiving",
    section: "backups",
    title: "WAL archiving",
    source: "pg_settings, pg_stat_archiver",
    layout: "kv",
    limit: 1,
    description: "Continuous archiving is what makes point-in-time recovery possible. The archive command itself is never shown (it can contain credentials); only the tool it uses.",
    columns: [C("archive_mode", "archive_mode", "mono"), C("wal_level", "wal_level", "mono"), C("tool", "Archived with"), C("archive_timeout_s", "archive_timeout", "secs"), C("segments_behind", "Segments not yet archived", "int", { warn: 10, bad: 100 }), C("archived_count", "Archived", "int"), C("failed_count", "Failed", "int", { warn: 1, bad: 10 }), C("last_archived_time", "Last archived", "ts"), C("last_failed_time", "Last failure", "ts")],
    sql: () => `with cfg as (
        select current_setting('archive_mode') as archive_mode, current_setting('wal_level') as wal_level,
               coalesce(nullif(current_setting('archive_library', true), ''), '') as lib, coalesce(current_setting('archive_command', true), '') as cmd,
               (select setting::int from pg_settings where name = 'archive_timeout') as archive_timeout_s,
               (select setting::bigint from pg_settings where name = 'wal_segment_size') as segsize),
      arc as (select * from pg_stat_archiver)
      select cfg.archive_mode, cfg.wal_level,
        case when cfg.archive_mode = 'off' then null
             when cfg.lib <> '' then 'archive_library: ' || cfg.lib
             when cfg.cmd ~* '^s*(/bin/true|/usr/bin/true|true|:|exit 0)s*$' then 'no-op (discards WAL)'
             when cfg.cmd ~* 'pgbackrest' then 'pgBackRest' when cfg.cmd ~* 'wal-g|walg' then 'WAL-G' when cfg.cmd ~* 'barman' then 'Barman' when cfg.cmd ~* 'pg_probackup' then 'pg_probackup'
             when cfg.cmd ~* 'aws s3|s3cmd|s3://' then 'S3 script' when cfg.cmd ~* 'gsutil|gcloud' then 'GCS script' when cfg.cmd ~* '(^|[ /])cp ' then 'cp (local copy)'
             when cfg.cmd in ('', '(disabled)') then 'not set' else 'custom script' end as tool,
        cfg.archive_timeout_s,
        case when cfg.archive_mode = 'off' or pg_is_in_recovery() or arc.last_archived_wal is null then null else
          ((('x' || substr(pg_walfile_name(pg_current_wal_lsn()), 9, 8))::bit(32)::bigint * (4294967296 / cfg.segsize) + ('x' || substr(pg_walfile_name(pg_current_wal_lsn()), 17, 8))::bit(32)::bigint)
         - (('x' || substr(arc.last_archived_wal, 9, 8))::bit(32)::bigint * (4294967296 / cfg.segsize) + ('x' || substr(arc.last_archived_wal, 17, 8))::bit(32)::bigint)) end as segments_behind,
        arc.archived_count, arc.failed_count, arc.last_archived_time, arc.last_failed_time
      from cfg, arc`
  },
  {
    id: "bk_wal_rate",
    section: "backups",
    title: "Archive volume and database size",
    source: "pg_stat_wal, pg_database_size()",
    layout: "kv",
    limit: 1,
    minPg: 14e4,
    description: "How much WAL this database produces (what a WAL archive must store per day) and how big a full backup is. Use these to size storage and estimate restore time.",
    columns: [C("db_bytes", "Database size", "bytes"), C("wal_per_day_bytes", "WAL per day (estimate)", "bytes"), C("window_s", "Measured over", "secs")],
    sql: () => `select pg_database_size(current_database()) as db_bytes,
      round(w.wal_bytes / greatest(extract(epoch from now() - coalesce(w.stats_reset, pg_postmaster_start_time())), 1) * 86400)::bigint as wal_per_day_bytes,
      round(extract(epoch from now() - coalesce(w.stats_reset, pg_postmaster_start_time())))::bigint as window_s from pg_stat_wal w`
  },
  {
    id: "bk_unprotected",
    section: "backups",
    title: "What backups don't cover",
    source: "pg_class, pg_tablespace, pg_roles",
    limit: 40,
    description: "Objects that physical backups or logical dumps handle differently. Unlogged tables are not in the WAL, so they are empty after point-in-time recovery. Roles and tablespaces live outside a per-database dump.",
    columns: [C("kind", "Kind"), C("object", "Object", "mono"), C("detail", "Why it matters")],
    sql: (c) => `select * from (
        select 'Unlogged table' as kind, n.nspname || '.' || t.relname as object, 'Not WAL-logged: missing from PITR restores and replicas.' as detail
          from pg_class t join pg_namespace n on n.oid = t.relnamespace where t.relpersistence = 'u' and t.relkind = 'r' and ${us(c, "n.nspname")}
        union all select 'Tablespace', spcname::text, 'pg_dump does not recreate tablespaces; physical backups must include them.' from pg_tablespace where spcname not in ('pg_default', 'pg_global')
        union all select 'Roles', count(*)::text || ' login role(s)', 'Roles and grants are outside per-database dumps. Back them up with pg_dumpall --globals-only.'
          from pg_roles where rolcanlogin and rolname !~ '^pg_' and not ${c.profile.managedRoleSql("rolname")} having count(*) > 0
        union all select 'Large objects', count(*)::text || ' object(s)', 'Not removed with referencing rows; make sure dumps include them (pg_dump --large-objects).' from pg_largeobject_metadata having count(*) > 0
      ) u limit 40`
  }
];

// src/inspect_cap.ts
var CAP = [
  {
    id: "cap_load",
    section: "capacity",
    title: "Workload since statistics were reset",
    source: "pg_stat_database",
    layout: "kv",
    limit: 1,
    description: "Average rates over the time since statistics were last reset (or the server started). Short windows are noisy.",
    columns: [C("tps", "Transactions / s", "int"), C("disk_read_bps", "Disk reads / s", "bytes"), C("temp_bytes_per_hour", "Temp files / hour", "bytes"), C("tup_read", "Rows read", "int"), C("tup_written", "Rows written", "int"), C("cache_hit_pct", "Cache hit", "pct"), C("window_s", "Window", "secs")],
    sql: () => `select round(((d.xact_commit + d.xact_rollback)::numeric / w.secs), 1) as tps,
        round(d.blks_read::numeric * current_setting('block_size')::numeric / w.secs)::bigint as disk_read_bps,
        round(d.temp_bytes::numeric / w.secs * 3600)::bigint as temp_bytes_per_hour,
        (d.tup_returned + d.tup_fetched)::bigint as tup_read, (d.tup_inserted + d.tup_updated + d.tup_deleted)::bigint as tup_written,
        round(w.secs)::bigint as window_s, round(100.0 * d.blks_hit / nullif(d.blks_hit + d.blks_read, 0), 2) as cache_hit_pct
      from pg_stat_database d cross join lateral (select greatest(extract(epoch from now() - coalesce(d.stats_reset, pg_postmaster_start_time()))::numeric, 1) as secs) w
      where d.datname = current_database()`
  },
  {
    id: "cap_sizing",
    section: "capacity",
    title: "Data size against memory settings",
    source: "pg_settings, pg_class",
    layout: "kv",
    limit: 1,
    description: "How big the data is next to the memory the server is configured to use for caching.",
    columns: [C("db_bytes", "Database size", "bytes"), C("shared_buffers_bytes", "shared_buffers", "bytes"), C("effective_cache_bytes", "effective_cache_size", "bytes"), C("work_mem_bytes", "work_mem", "bytes"), C("max_connections", "max_connections", "int"), C("largest_table_bytes", "Largest table", "bytes")],
    sql: (c) => `select pg_database_size(current_database()) as db_bytes,
        (select setting::bigint * current_setting('block_size')::bigint from pg_settings where name = 'shared_buffers') as shared_buffers_bytes,
        (select setting::bigint * current_setting('block_size')::bigint from pg_settings where name = 'effective_cache_size') as effective_cache_bytes,
        (select setting::bigint * 1024 from pg_settings where name = 'work_mem') as work_mem_bytes,
        current_setting('max_connections')::int as max_connections,
        coalesce((select max(pg_total_relation_size(t.oid)) from pg_class t join pg_namespace n on n.oid = t.relnamespace where t.relkind = 'r' and ${us(c, "n.nspname")}), 0) as largest_table_bytes`
  },
  {
    id: "cap_workers",
    section: "capacity",
    title: "Autovacuum workers",
    source: "pg_stat_activity, pg_settings",
    layout: "kv",
    limit: 1,
    description: "How many autovacuum workers are running right now, out of the maximum.",
    columns: [C("running", "Running now", "int"), C("max_workers", "autovacuum_max_workers", "int")],
    sql: () => `select (select count(*) from pg_stat_activity where backend_type = 'autovacuum worker')::int as running, current_setting('autovacuum_max_workers')::int as max_workers`
  },
  {
    id: "cap_footprint",
    section: "capacity",
    title: "Footprint on disk",
    source: "pg_database_size(), pg_ls_waldir()",
    layout: "kv",
    limit: 1,
    description: "What this server puts on its volume: this database, every other database on the same server, and WAL. Postgres can't see the volume's size or free space, so compare these numbers with your host or provider metrics.",
    columns: [C("db_bytes", "This database", "bytes"), C("other_dbs_bytes", "Other databases", "bytes"), C("wal_bytes", "WAL", "bytes"), C("total_bytes", "Total (at least)", "bytes"), C("temp_bytes_per_day", "Temp files / day", "bytes"), C("window_s", "Measured over", "secs")],
    sql: () => `select d.db_bytes, d.other_dbs_bytes, w.wal_bytes, d.db_bytes + d.other_dbs_bytes + w.wal_bytes as total_bytes,
        (select round(s.temp_bytes / greatest(extract(epoch from now() - coalesce(s.stats_reset, pg_postmaster_start_time())), 1) * 86400)::bigint from pg_stat_database s where s.datname = current_database()) as temp_bytes_per_day,
        (select round(extract(epoch from now() - coalesce(s.stats_reset, pg_postmaster_start_time())))::bigint from pg_stat_database s where s.datname = current_database()) as window_s
      from (select pg_database_size(current_database())::bigint as db_bytes,
                   coalesce(sum(pg_database_size(oid)) filter (where datname <> current_database() and datallowconn), 0)::bigint as other_dbs_bytes from pg_database) d,
           (select coalesce(sum(size), 0)::bigint as wal_bytes from pg_ls_waldir()) w`
  },
  // pg_net: only when the extension is installed
  {
    id: "net_queue",
    section: "extensions",
    title: "pg_net queue and response table",
    source: "net.http_request_queue, net._http_response, pg_settings",
    layout: "kv",
    limit: 1,
    ext: "pg_net",
    optional: true,
    description: "pg_net stores every response in net._http_response and deletes rows older than pg_net.ttl (default 6 hours). Heavy webhook or edge-function traffic churns this table faster than autovacuum reclaims it, and a growing request queue means the worker is behind.",
    columns: [C("queued", "Requests waiting", "int", { warn: 1e3, bad: 1e4 }), C("response_rows", "Responses kept (estimated)", "int"), C("response_dead_rows", "Dead rows", "int"), C("response_bytes", "Response table size", "bytes", { warn: 104857600, bad: 1073741824 }), C("ttl", "pg_net.ttl", "mono"), C("last_autovacuum", "Last autovacuum", "ts")],
    sql: () => `select coalesce((select greatest(s.n_live_tup, c.reltuples::bigint, 0) from pg_stat_user_tables s join pg_class c on c.oid = s.relid where s.schemaname = 'net' and s.relname = 'http_request_queue'), 0)::bigint as queued,
        coalesce(r.n_live_tup, 0)::bigint as response_rows, coalesce(r.n_dead_tup, 0)::bigint as response_dead_rows,
        coalesce((select pg_total_relation_size(c.oid) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'net' and c.relname = '_http_response'), 0)::bigint as response_bytes,
        coalesce(current_setting('pg_net.ttl', true), '6 hours (default)') as ttl, r.last_autovacuum
      from (select 1) x left join pg_stat_user_tables r on r.schemaname = 'net' and r.relname = '_http_response'`
  },
  // pg_cron: only when the extension is installed
  {
    id: "cron_history",
    section: "extensions",
    title: "pg_cron run history",
    source: "pg_stat_user_tables, cron.job_run_details",
    layout: "kv",
    limit: 1,
    ext: "pg_cron",
    optional: true,
    description: "pg_cron records every run in cron.job_run_details, and nothing removes old rows unless you schedule that yourself.",
    columns: [C("jobs", "Jobs (estimated)", "int"), C("run_rows", "Logged runs (estimated)", "int"), C("bytes", "History size", "bytes", { warn: 104857600, bad: 1073741824 })],
    sql: () => `select coalesce((select greatest(s.n_live_tup, c.reltuples::bigint, 0) from pg_stat_user_tables s join pg_class c on c.oid = s.relid where s.schemaname = 'cron' and s.relname = 'job'), 0)::bigint as jobs,
        coalesce((select greatest(s.n_live_tup, c.reltuples::bigint, 0) from pg_stat_user_tables s join pg_class c on c.oid = s.relid where s.schemaname = 'cron' and s.relname = 'job_run_details'), 0)::bigint as run_rows,
        coalesce((select pg_total_relation_size(c.oid) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'cron' and c.relname = 'job_run_details'), 0)::bigint as bytes`
  },
  {
    id: "cron_failures",
    section: "extensions",
    title: "pg_cron jobs that failed this week",
    source: "cron.job_run_details",
    limit: 20,
    ext: "pg_cron",
    optional: true,
    description: "Scheduled jobs with failed runs in the last 7 days. pg_cron only shows a role its own jobs, so this needs the job owner or a superuser.",
    columns: [C("jobid", "Job", "int"), C("failed", "Failed runs", "int"), C("runs", "Runs", "int"), C("last_failure", "Last failure", "ts"), C("message", "Message", "mono")],
    sql: () => `select jobid::bigint as jobid, (count(*) filter (where status = 'failed'))::int as failed, count(*)::int as runs,
        max(start_time) filter (where status = 'failed') as last_failure,
        (array_agg(regexp_replace(${maskSql("return_message", 160)}, $$\\)=\\([^)]*\\)$$, $$)=(?)$$, 'g') order by start_time desc) filter (where status = 'failed'))[1] as message
      from cron.job_run_details where start_time > now() - interval '7 days' group by jobid
      having count(*) filter (where status = 'failed') > 0 order by failed desc limit 20`
  },
  // Public basis: the pg_buffercache extension docs (F.25). Reading it needs pg_monitor, which the checkup role has.
  {
    id: "cap_buffers",
    section: "capacity",
    title: "What's in shared_buffers",
    source: "pg_buffercache",
    limit: 20,
    ext: "pg_buffercache",
    hint: "Install pg_buffercache to see which tables and indexes are in shared_buffers: create extension pg_buffercache; (the pg_monitor role can read it).",
    description: "Tables and indexes taking up shared_buffers, as a share of the cache and of each relation. A busy table that is barely cached, or a cache filled by one rarely used table, says more about shared_buffers than its size alone.",
    columns: [C("relation", "Relation", "mono"), C("kind", "Kind"), C("cached_bytes", "Cached", "bytes"), C("pct_of_buffers", "Share of shared_buffers", "pct"), C("pct_of_relation", "Share of the relation cached", "pct"), C("avg_usage", "Average usage count")],
    sql: (c) => `select n.nspname || '.' || r.relname as relation, case r.relkind when 'i' then 'index' when 'm' then 'materialized view' else 'table' end as kind,
      count(*) * current_setting('block_size')::bigint as cached_bytes,
      round(100.0 * count(*) / (select setting::bigint from pg_settings where name = 'shared_buffers'), 1) as pct_of_buffers,
      round(100.0 * count(*) * current_setting('block_size')::bigint / nullif(pg_relation_size(r.oid), 0), 1) as pct_of_relation,
      round(avg(b.usagecount), 1) as avg_usage
      from pg_buffercache b
      join pg_class r on b.relfilenode = pg_relation_filenode(r.oid)
      join pg_namespace n on n.oid = r.relnamespace
      where b.reldatabase = (select oid from pg_database where datname = current_database()) and b.relforknumber = 0 and ${us(c, "n.nspname")}
      group by n.nspname, r.relname, r.relkind, r.oid order by count(*) desc limit 20`
  }
];

// src/inspect_ops.ts
var OPS = [
  // Only returns a row when the server you connected to is itself a standby.
  {
    id: "r_receiver",
    section: "replication",
    title: "This replica's link to its primary",
    source: "pg_stat_wal_receiver, pg_last_wal_*",
    layout: "kv",
    limit: 1,
    description: "Shown only when you scanned a standby. Whether it is still receiving WAL, how much it has received but not applied, and whether replay is paused.",
    columns: [C("status", "Receiver status"), C("expects_streaming", "Set up to stream", "bool"), C("apply_backlog_bytes", "Received, not applied", "bytes", { warn: 268435456, bad: 2147483648 }), C("secs_since_msg", "Since last message", "secs"), C("paused", "Replay paused", "bool"), C("replay_delay_s", "Since last replayed commit", "secs")],
    sql: () => `select (select count(*) from pg_stat_wal_receiver)::int as receivers, (select status from pg_stat_wal_receiver limit 1) as status,
        coalesce((select setting <> '' from pg_settings where name = 'primary_conninfo'), false) as expects_streaming,
        pg_is_wal_replay_paused() as paused, pg_wal_lsn_diff(pg_last_wal_receive_lsn(), pg_last_wal_replay_lsn())::bigint as apply_backlog_bytes,
        (select round(extract(epoch from now() - last_msg_receipt_time)::numeric)::bigint from pg_stat_wal_receiver limit 1) as secs_since_msg,
        round(extract(epoch from now() - pg_last_xact_replay_timestamp())::numeric)::bigint as replay_delay_s
      where pg_is_in_recovery()`
  },
  {
    id: "r_conflicts",
    section: "replication",
    title: "Queries cancelled by recovery conflicts",
    source: "pg_stat_database_conflicts",
    layout: "kv",
    limit: 1,
    description: "Shown only on a standby. Queries on a replica are cancelled when replay needs to remove rows or take locks they depend on.",
    columns: [C("snapshot", "Old snapshot", "int"), C("lock", "Lock", "int"), C("bufferpin", "Buffer pin", "int"), C("deadlock", "Deadlock", "int"), C("tablespace", "Tablespace", "int"), C("total", "Total", "int", { warn: 5, bad: 50 })],
    sql: () => `select confl_snapshot as snapshot, confl_lock as lock, confl_bufferpin as bufferpin, confl_deadlock as deadlock, confl_tablespace as tablespace,
        (confl_snapshot + confl_lock + confl_bufferpin + confl_deadlock + confl_tablespace) as total
      from pg_stat_database_conflicts where datname = current_database() and pg_is_in_recovery()`
  },
  {
    id: "r_syncstandby",
    section: "replication",
    title: "Synchronous standby",
    source: "pg_settings, pg_stat_replication",
    layout: "kv",
    limit: 1,
    description: "With synchronous replication, a commit waits for a standby to confirm it. If none is connected, commits wait.",
    columns: [C("names", "synchronous_standby_names", "mono"), C("connected", "Synchronous standbys connected", "int")],
    sql: () => `select current_setting('synchronous_standby_names') as names, (select count(*) from pg_stat_replication where sync_state in ('sync', 'quorum'))::int as connected
      from (select 1) x where not pg_is_in_recovery()`
  },
  {
    id: "c_stale",
    section: "connections",
    title: "Long-idle connections",
    source: "pg_stat_activity",
    limit: 20,
    description: "Sessions that have sat idle for more than 30 minutes, grouped by role and application. A session whose client has vanished looks exactly like this.",
    columns: [C("role", "Role", "mono"), C("app", "Application"), C("sessions", "Sessions", "int"), C("oldest_idle_s", "Longest idle", "secs", { warn: 14400, bad: 86400 }), C("oldest_started", "Oldest connection opened", "ts")],
    sql: () => `select coalesce(usename, '')::text as role, coalesce(nullif(application_name, ''), '(none)') as app, count(*)::int as sessions,
        max(extract(epoch from now() - state_change))::bigint as oldest_idle_s, min(backend_start) as oldest_started
      from pg_stat_activity where backend_type = 'client backend' and state = 'idle' and pid <> pg_backend_pid() and now() - state_change > interval '30 minutes'
      group by 1, 2 order by sessions desc limit 20`
  },
  {
    id: "c_timeouts",
    section: "connections",
    title: "Timeouts and keepalives",
    source: "pg_settings",
    layout: "table",
    limit: 12,
    description: "What ends a session whose client is gone. Zero means off, and for the TCP keepalive settings it means the operating system default (often two hours).",
    columns: SETTING_COLS,
    sql: () => setting(["idle_in_transaction_session_timeout", "idle_session_timeout", "tcp_keepalives_idle", "tcp_keepalives_interval", "tcp_keepalives_count", "tcp_user_timeout", "client_connection_check_interval", "statement_timeout"])
  }
];

// src/inspect.ts
var ex = (c) => c.version >= 13e4 ? "_exec_time" : "_time";
var DEFS = [
  // ───────── Queries
  {
    id: "q_total",
    section: "queries",
    title: "Heaviest queries by total time",
    source: "pg_stat_statements",
    ext: "pg_stat_statements",
    limit: 25,
    description: "Statements that consumed the most cumulative execution time. Optimizing the top few has the biggest payoff. Catalog-reading statements (dashboards, ORMs introspecting the schema, monitoring agents) and provider-internal roles are left out so this shows the application's own load.",
    columns: [C("total_ms", "Total", "ms"), C("pct", "% of load", "pct", { warn: 20, bad: 40 }), C("calls", "Calls", "int"), C("mean_ms", "Mean", "ms"), C("rows", "Rows", "int"), C("role", "Role"), C("query", "Query", "mono")],
    sql: (c) => `select round(s.total${ex(c)})::bigint as total_ms, round((100 * s.total${ex(c)} / nullif(sum(s.total${ex(c)}) over (), 0))::numeric, 1) as pct,
      md5(s.query) as fingerprint, s.calls, round(s.mean${ex(c)}::numeric, 2) as mean_ms, s.rows, r.rolname::text as role, ${maskSql("s.query", 600)} as query,
      round(sum(s.total${ex(c)}) over ())::bigint as workload_ms
      ${pgss(c)} order by s.total${ex(c)} desc limit 25`
  },
  {
    id: "q_mean",
    section: "queries",
    title: "Slowest queries per call",
    source: "pg_stat_statements",
    ext: "pg_stat_statements",
    limit: 25,
    description: "Highest average latency (called at least 5 times). These are the ones users feel.",
    columns: [C("mean_ms", "Mean", "ms", { warn: 500, bad: 2e3 }), C("max_ms", "Max", "ms"), C("stddev_ms", "Std dev", "ms"), C("calls", "Calls", "int"), C("total_ms", "Total", "ms"), C("query", "Query", "mono")],
    sql: (c) => `select round(s.mean${ex(c)}::numeric, 1) as mean_ms, round(s.max${ex(c)}::numeric, 1) as max_ms, round(s.stddev${ex(c)}::numeric, 1) as stddev_ms,
      s.calls, round(s.total${ex(c)})::bigint as total_ms, ${maskSql("s.query", 600)} as query
      ${pgss(c)} and s.calls >= 5 order by s.mean${ex(c)} desc limit 25`
  },
  {
    id: "q_io",
    section: "queries",
    title: "Most disk-read queries",
    source: "pg_stat_statements",
    ext: "pg_stat_statements",
    limit: 20,
    description: "Statements reading the most blocks from disk instead of cache.",
    columns: [C("disk_bytes", "Read from disk", "bytes"), C("hit_pct", "Cache hit", "pct"), C("calls", "Calls", "int"), C("mean_ms", "Mean", "ms"), C("query", "Query", "mono")],
    sql: (c) => `select s.shared_blks_read * 8192 as disk_bytes, round((100.0 * s.shared_blks_hit / nullif(s.shared_blks_hit + s.shared_blks_read, 0))::numeric, 1) as hit_pct,
      s.calls, round(s.mean${ex(c)}::numeric, 1) as mean_ms, ${maskSql("s.query", 600)} as query
      ${pgss(c)} and s.shared_blks_read > 0 order by s.shared_blks_read desc limit 20`
  },
  {
    id: "q_calls",
    section: "queries",
    title: "Most frequent queries",
    source: "pg_stat_statements",
    ext: "pg_stat_statements",
    limit: 20,
    description: "Very high call counts with tiny latency often point at N+1 patterns or missing caching.",
    columns: [C("calls", "Calls", "int"), C("mean_ms", "Mean", "ms"), C("total_ms", "Total", "ms"), C("rows_per_call", "Rows/call", "int"), C("query", "Query", "mono")],
    sql: (c) => `select s.calls, round(s.mean${ex(c)}::numeric, 3) as mean_ms, round(s.total${ex(c)})::bigint as total_ms, (s.rows / nullif(s.calls, 0))::bigint as rows_per_call, ${maskSql("s.query", 600)} as query
      ${pgss(c)} order by s.calls desc limit 20`
  },
  {
    id: "q_temp",
    section: "queries",
    title: "Queries spilling to temp files",
    source: "pg_stat_statements",
    ext: "pg_stat_statements",
    limit: 15,
    description: "Sorts and hashes that exceed work_mem and write to disk.",
    columns: [C("temp_bytes", "Temp written", "bytes"), C("calls", "Calls", "int"), C("mean_ms", "Mean", "ms"), C("query", "Query", "mono")],
    sql: (c) => `select s.temp_blks_written * 8192 as temp_bytes, s.calls, round(s.mean${ex(c)}::numeric, 1) as mean_ms, ${maskSql("s.query", 600)} as query
      ${pgss(c)} and s.temp_blks_written > 0 order by s.temp_blks_written desc limit 15`
  },
  {
    id: "q_wal",
    section: "queries",
    title: "Queries generating the most WAL",
    source: "pg_stat_statements",
    ext: "pg_stat_statements",
    limit: 15,
    minPg: 13e4,
    description: "Heavy WAL writers drive replication lag, archive backlog and disk growth.",
    columns: [C("wal_bytes", "WAL written", "bytes"), C("wal_fpi", "Full-page images", "int"), C("calls", "Calls", "int"), C("query", "Query", "mono")],
    sql: (c) => `select s.wal_bytes::bigint as wal_bytes, s.wal_fpi, s.calls, ${maskSql("s.query", 600)} as query
      ${pgss(c)} and s.wal_bytes > 0 order by s.wal_bytes desc limit 15`
  },
  // ───────── Tables
  {
    id: "t_size",
    section: "tables",
    title: "Largest tables",
    source: "pg_stat_user_tables",
    limit: 50,
    description: "Total size split into heap, indexes and TOAST, with live/dead rows and scan counts.",
    columns: [C("table", "Table", "mono"), C("total_bytes", "Total", "bytes"), C("heap_bytes", "Heap", "bytes"), C("index_bytes", "Indexes", "bytes"), C("toast_bytes", "TOAST", "bytes"), C("live_rows", "Live rows", "int"), C("dead_rows", "Dead rows", "int"), C("seq_scan", "Seq scans", "int"), C("idx_scan", "Index scans", "int")],
    sql: (c) => `select st.schemaname || '.' || st.relname as "table", pg_total_relation_size(st.relid) as total_bytes, pg_relation_size(st.relid) as heap_bytes,
      pg_indexes_size(st.relid) as index_bytes, greatest(pg_table_size(st.relid) - pg_relation_size(st.relid), 0) as toast_bytes,
      st.n_live_tup as live_rows, st.n_dead_tup as dead_rows, st.seq_scan, coalesce(st.idx_scan, 0) as idx_scan
      from pg_stat_user_tables st where ${ut(c, "st.schemaname", "st.relname")} order by total_bytes desc limit 50`
  },
  {
    id: "t_seq",
    section: "tables",
    title: "Sequential-scan heavy tables",
    source: "pg_stat_user_tables",
    limit: 25,
    description: "Tables read mostly by full scans. On large tables this is a common source of CPU and I/O load.",
    columns: [C("table", "Table", "mono"), C("seq_scan", "Seq scans", "int"), C("seq_tup_read", "Rows read by seq scans", "int"), C("rows_per_scan", "Rows/scan", "int"), C("idx_scan", "Index scans", "int"), C("live_rows", "Live rows", "int")],
    sql: (c) => `select schemaname || '.' || relname as "table", seq_scan, seq_tup_read, (seq_tup_read / nullif(seq_scan, 0)) as rows_per_scan, coalesce(idx_scan, 0) as idx_scan, n_live_tup as live_rows
      from pg_stat_user_tables where seq_scan > 0 and ${us(c, "schemaname")} order by seq_tup_read desc limit 25`
  },
  {
    id: "t_churn",
    section: "tables",
    title: "Write churn",
    source: "pg_stat_user_tables",
    limit: 25,
    description: "Inserts, updates and deletes since the stats reset. A low HOT-update ratio means updates touch indexed columns and generate extra index and WAL work.",
    columns: [C("table", "Table", "mono"), C("writes", "Total writes", "int"), C("inserts", "Inserts", "int"), C("updates", "Updates", "int"), C("deletes", "Deletes", "int"), C("hot_pct", "HOT updates", "pct"), C("dead_rows", "Dead rows", "int")],
    sql: (c) => `select schemaname || '.' || relname as "table", (n_tup_ins + n_tup_upd + n_tup_del) as writes, n_tup_ins as inserts, n_tup_upd as updates, n_tup_del as deletes,
      round(100.0 * n_tup_hot_upd / nullif(n_tup_upd, 0), 1) as hot_pct, n_dead_tup as dead_rows
      from pg_stat_user_tables where (n_tup_ins + n_tup_upd + n_tup_del) > 0 and ${ut(c, "schemaname", "relname")} order by writes desc limit 25`
  },
  {
    id: "t_cache",
    section: "tables",
    title: "Table cache hit rate",
    source: "pg_statio_user_tables",
    limit: 25,
    description: "Heap reads served from memory versus disk. Low ratios on busy tables suggest memory pressure or scans.",
    columns: [C("table", "Table", "mono"), C("hit_pct", "Cache hit", "pct"), C("disk_reads", "Disk reads", "int"), C("cache_hits", "Cache hits", "int"), C("idx_hit_pct", "Index cache hit", "pct")],
    sql: (c) => `select schemaname || '.' || relname as "table", round(100.0 * heap_blks_hit / nullif(heap_blks_hit + heap_blks_read, 0), 1) as hit_pct,
      heap_blks_read as disk_reads, heap_blks_hit as cache_hits, round(100.0 * idx_blks_hit / nullif(idx_blks_hit + idx_blks_read, 0), 1) as idx_hit_pct
      from pg_statio_user_tables where heap_blks_read + heap_blks_hit > 1000 and ${us(c, "schemaname")} order by heap_blks_read desc limit 25`
  },
  {
    id: "t_nopk",
    section: "tables",
    title: "Tables without a primary key",
    source: "pg_class, pg_index",
    limit: 30,
    description: "No primary key breaks logical replication of updates/deletes and makes row addressing and de-duplication hard.",
    columns: [C("table", "Table", "mono"), C("est_rows", "Est. rows", "int"), C("bytes", "Size", "bytes")],
    sql: (c) => `select n.nspname || '.' || t.relname as "table", greatest(t.reltuples, 0)::bigint as est_rows, pg_total_relation_size(t.oid) as bytes
      from pg_class t join pg_namespace n on n.oid = t.relnamespace
      where t.relkind in ('r','p') and ${us(c, "n.nspname")} and not exists (select 1 from pg_index i where i.indrelid = t.oid and i.indisprimary)
      order by bytes desc limit 30`
  },
  // ───────── Indexes
  {
    id: "i_size",
    section: "indexes",
    title: "Largest indexes",
    source: "pg_stat_user_indexes, pg_index",
    limit: 50,
    description: "Every index with its size and how often it has been scanned.",
    columns: [C("table", "Table", "mono"), C("index", "Index", "mono"), C("bytes", "Size", "bytes"), C("scans", "Scans", "int"), C("unique", "Unique", "bool"), C("pk", "Primary", "bool"), C("definition", "Definition", "mono")],
    sql: (c) => `select s.schemaname || '.' || s.relname as "table", s.indexrelname as "index", pg_relation_size(s.indexrelid) as bytes, s.idx_scan as scans,
      i.indisunique as "unique", i.indisprimary as pk, pg_get_indexdef(s.indexrelid) as definition
      from pg_stat_user_indexes s join pg_index i on i.indexrelid = s.indexrelid where ${us(c, "s.schemaname")} order by bytes desc limit 50`
  },
  {
    id: "i_unused",
    section: "indexes",
    title: "Unused indexes",
    source: "pg_stat_user_indexes",
    limit: 30,
    description: "Never scanned since the stats reset (and not enforcing uniqueness). Each one still costs work on every write.",
    columns: [C("table", "Table", "mono"), C("index", "Index", "mono"), C("bytes", "Size", "bytes"), C("table_writes", "Table writes", "int"), C("definition", "Definition", "mono")],
    sql: (c) => `select s.schemaname || '.' || s.relname as "table", s.indexrelname as "index", pg_relation_size(s.indexrelid) as bytes,
      (t.n_tup_ins + t.n_tup_upd + t.n_tup_del) as table_writes, pg_get_indexdef(s.indexrelid) as definition
      from pg_stat_user_indexes s join pg_index i on i.indexrelid = s.indexrelid join pg_stat_user_tables t on t.relid = s.relid
      where s.idx_scan = 0 and not i.indisunique and not i.indisprimary and ${us(c, "s.schemaname")} order by bytes desc limit 30`
  },
  {
    id: "i_dup",
    section: "indexes",
    title: "Duplicate indexes",
    source: "pg_index",
    limit: 25,
    description: "Two or more indexes on the same table that are interchangeable: same columns, key and included columns, operator classes, collations, sort options, predicate, expressions, access method and uniqueness. All but one can usually be dropped.",
    columns: [C("table", "Table", "mono"), C("indexes", "Indexes", "mono"), C("copies", "Copies", "int"), C("bytes", "Total size", "bytes")],
    sql: (c) => `select n.nspname || '.' || t.relname as "table", array_to_string(array_agg(ic.relname order by ic.relname), ', ') as indexes, count(*)::int as copies, sum(pg_relation_size(i.indexrelid))::bigint as bytes
      from pg_index i join pg_class ic on ic.oid = i.indexrelid join pg_class t on t.oid = i.indrelid join pg_namespace n on n.oid = t.relnamespace
      where ${us(c, "n.nspname")} and i.indisvalid
      group by n.nspname, t.relname, i.indrelid, i.indkey::text, i.indnkeyatts, i.indclass::text, i.indcollation::text, i.indoption::text, i.indisunique, i.indisprimary, i.indimmediate, ${c.version >= 15e4 ? "i.indnullsnotdistinct," : ""} ic.relam, coalesce(pg_get_expr(i.indpred, i.indrelid), ''), coalesce(pg_get_expr(i.indexprs, i.indrelid), '')
      having count(*) > 1 order by bytes desc limit 25`
  },
  {
    id: "i_fk",
    section: "indexes",
    title: "Foreign keys without a supporting index",
    source: "pg_constraint, pg_index",
    limit: 30,
    description: "Deleting or updating a referenced row must scan the referencing table. Without an index on the foreign-key columns that is a full scan (and can take long locks).",
    columns: [C("table", "Referencing table", "mono"), C("constraint", "Constraint", "mono"), C("est_rows", "Est. rows", "int"), C("definition", "Definition", "mono")],
    sql: (c) => `select n.nspname || '.' || t.relname as "table", k.conname as "constraint", greatest(t.reltuples, 0)::bigint as est_rows, pg_get_constraintdef(k.oid) as definition
      from pg_constraint k join pg_class t on t.oid = k.conrelid join pg_namespace n on n.oid = t.relnamespace
      where k.contype = 'f' and ${us(c, "n.nspname")}
        and not exists (select 1 from pg_index i where i.indrelid = k.conrelid and i.indisvalid
                        and (string_to_array(i.indkey::text, ' ')::int2[])[1:array_length(k.conkey, 1)] @> k.conkey)
      order by t.reltuples desc limit 30`
  },
  {
    id: "i_invalid",
    section: "indexes",
    title: "Invalid indexes",
    source: "pg_index",
    limit: 20,
    description: "Left behind by a failed CREATE INDEX CONCURRENTLY. They cost writes and are never used.",
    columns: [C("table", "Table", "mono"), C("index", "Index", "mono"), C("bytes", "Size", "bytes")],
    sql: (c) => `select n.nspname || '.' || t.relname as "table", ic.relname as "index", pg_relation_size(i.indexrelid) as bytes
      from pg_index i join pg_class ic on ic.oid = i.indexrelid join pg_class t on t.oid = i.indrelid join pg_namespace n on n.oid = t.relnamespace
      where not i.indisvalid and ${us(c, "n.nspname")} limit 20`
  },
  // ───────── Blocked transactions
  {
    id: "b_blocked",
    section: "blocking",
    title: "Blocked queries",
    source: "pg_stat_activity, pg_blocking_pids()",
    limit: 25,
    description: "Queries currently waiting on a lock and the session holding it.",
    columns: [
      C("blocked_pid", "Blocked PID", "id"),
      C("blocked_user", "User"),
      C("waiting_s", "Waiting", "secs", { warn: 5, bad: 30 }),
      C("wait_event", "Wait event", "mono"),
      C("blocked_query", "Blocked query", "mono"),
      C("blocking_pid", "Blocker PID", "id"),
      C("blocking_user", "Blocker user"),
      C("blocking_state", "Blocker state"),
      C("blocking_xact_s", "Blocker txn age", "secs", { warn: 30, bad: 300 }),
      C("blocking_query", "Blocker's last query", "mono")
    ],
    sql: () => `select b.pid as blocked_pid, b.usename::text as blocked_user, round(extract(epoch from now() - b.query_start)::numeric, 1) as waiting_s, coalesce(b.wait_event, '') as wait_event, ${maskSql("b.query")} as blocked_query,
      bl.pid as blocking_pid, bl.usename::text as blocking_user, bl.state as blocking_state, round(extract(epoch from now() - bl.xact_start)::numeric, 1) as blocking_xact_s, ${maskSql("bl.query")} as blocking_query
      from pg_stat_activity b cross join lateral unnest(pg_blocking_pids(b.pid)) as bp(pid) join pg_stat_activity bl on bl.pid = bp.pid
      order by waiting_s desc limit 25`
  },
  {
    id: "b_long",
    section: "blocking",
    title: "Long-running transactions",
    source: "pg_stat_activity",
    limit: 25,
    description: "Open for more than 30 seconds. Long transactions hold locks and prevent vacuum from removing dead rows.",
    columns: [C("pid", "PID", "id"), C("user", "User"), C("app", "Application"), C("state", "State"), C("xact_s", "Txn age", "secs", { warn: 60, bad: 600 }), C("state_s", "In state for", "secs"), C("xid", "XID", "id"), C("query", "Last query", "mono")],
    sql: () => `select pid, usename::text as "user", application_name as app, state, round(extract(epoch from now() - xact_start)::numeric, 1) as xact_s,
      round(extract(epoch from now() - state_change)::numeric, 1) as state_s, backend_xid::text as xid, ${maskSql("query")} as query
      from pg_stat_activity where xact_start is not null and now() - xact_start > interval '30 seconds' and pid <> pg_backend_pid() and backend_type = 'client backend'
      order by xact_s desc limit 25`
  },
  {
    id: "b_idle",
    section: "blocking",
    title: "Idle in transaction",
    source: "pg_stat_activity",
    limit: 25,
    description: "Sessions that started a transaction and went quiet. Usually an application that forgot to COMMIT or ROLLBACK.",
    columns: [C("pid", "PID", "id"), C("user", "User"), C("app", "Application"), C("idle_s", "Idle for", "secs", { warn: 60, bad: 300 }), C("xact_s", "Txn age", "secs"), C("query", "Last query", "mono")],
    sql: () => `select pid, usename::text as "user", application_name as app, round(extract(epoch from now() - state_change)::numeric, 1) as idle_s,
      round(extract(epoch from now() - xact_start)::numeric, 1) as xact_s, ${maskSql("query")} as query
      from pg_stat_activity where state = 'idle in transaction' and pid <> pg_backend_pid() order by state_change limit 25`
  },
  {
    id: "b_prepared",
    section: "blocking",
    title: "Prepared transactions",
    source: "pg_prepared_xacts",
    limit: 20,
    description: "Two-phase commit transactions that were prepared but not finished. They hold locks and block vacuum until committed or rolled back.",
    columns: [C("gid", "Global ID", "mono"), C("owner", "Owner"), C("age_s", "Age", "secs", { warn: 300, bad: 3600 }), C("prepared", "Prepared at", "ts")],
    sql: () => `select gid, owner::text as owner, round(extract(epoch from now() - prepared)::numeric) as age_s, prepared from pg_prepared_xacts order by prepared limit 20`
  },
  {
    id: "b_locks",
    section: "blocking",
    title: "Lock summary",
    source: "pg_locks",
    limit: 40,
    description: "Locks held or awaited in this database, grouped by type and mode. Ungranted locks are waits.",
    columns: [C("locktype", "Type", "mono"), C("mode", "Mode", "mono"), C("granted", "Granted", "bool"), C("locks", "Locks", "int"), C("sessions", "Sessions", "int"), C("relations", "Relations", "mono")],
    sql: () => `select locktype, mode, granted, count(*)::int as locks, count(distinct pid)::int as sessions,
      array_to_string((array_agg(distinct relation::regclass::text) filter (where relation is not null))[1:5], ', ') as relations
      from pg_locks where database = ${inDb} or database is null group by locktype, mode, granted order by granted, locks desc limit 40`
  },
  {
    id: "b_xmin",
    section: "blocking",
    title: "What is holding back vacuum",
    source: "pg_stat_activity, pg_replication_slots, pg_prepared_xacts, pg_stat_replication",
    limit: 25,
    description: "Anything with an old xmin stops vacuum from cleaning rows newer than it. The oldest holder sets the horizon for the whole database.",
    columns: [C("holder", "Holder"), C("ref", "Reference", "mono"), C("owner", "Owner"), C("xmin_age", "xmin age", "int", { warn: 1e6, bad: 5e7 }), C("detail", "Detail", "mono")],
    sql: () => `select * from (
        select 'Backend session' as holder, pid::text as ref, usename::text as owner, greatest(age(backend_xmin), age(backend_xid))::bigint as xmin_age, ${maskSql("coalesce(query, '')", 200)} as detail from pg_stat_activity where (backend_xmin is not null or backend_xid is not null) and pid <> pg_backend_pid()
        union all select 'Replication slot', slot_name::text, database::text, age(coalesce(xmin, catalog_xmin))::bigint, slot_type || ' / ' || case when active then 'active' else 'INACTIVE' end from pg_replication_slots where xmin is not null or catalog_xmin is not null
        union all select 'Prepared transaction', gid, owner::text, age(transaction)::bigint, 'prepared ' || prepared::text from pg_prepared_xacts
        union all select 'Standby feedback', coalesce(application_name, ''), usename::text, age(backend_xmin)::bigint, coalesce(client_addr::text, '') from pg_stat_replication where backend_xmin is not null
      ) h order by xmin_age desc nulls last limit 25`
  },
  // ───────── Connections
  {
    id: "c_limits",
    section: "connections",
    title: "Connections in use versus the limit",
    source: "pg_stat_activity, pg_settings",
    layout: "kv",
    limit: 1,
    description: "How close the server is to max_connections.",
    columns: [C("in_use", "In use", "int"), C("max_connections", "max_connections", "int"), C("reserved", "Reserved for superusers", "int"), C("used_pct", "Used", "pct", { warn: 70, bad: 90 }), C("active", "Active", "int"), C("idle", "Idle", "int"), C("idle_in_tx", "Idle in transaction", "int", { warn: 1, bad: 10 })],
    sql: () => `select count(*)::int as in_use, current_setting('max_connections')::int as max_connections, current_setting('superuser_reserved_connections')::int as reserved,
      round(100.0 * count(*) / current_setting('max_connections')::numeric, 1) as used_pct, count(*) filter (where state = 'active')::int as active,
      count(*) filter (where state = 'idle')::int as idle, count(*) filter (where state = 'idle in transaction')::int as idle_in_tx
      from pg_stat_activity where backend_type = 'client backend'`
  },
  {
    id: "c_role",
    section: "connections",
    title: "Connections by role and application",
    source: "pg_stat_activity",
    limit: 30,
    description: "Who is holding connections. A single application using most of them is a pooling opportunity.",
    columns: [C("role", "Role"), C("app", "Application"), C("sessions", "Sessions", "int"), C("active", "Active", "int"), C("idle_in_tx", "Idle in txn", "int"), C("oldest_s", "Oldest session", "secs")],
    sql: () => `select coalesce(usename, '-')::text as role, coalesce(nullif(application_name, ''), '-') as app, count(*)::int as sessions,
      count(*) filter (where state = 'active')::int as active, count(*) filter (where state = 'idle in transaction')::int as idle_in_tx,
      round(extract(epoch from now() - min(backend_start)))::bigint as oldest_s
      from pg_stat_activity where backend_type = 'client backend' group by 1, 2 order by sessions desc limit 30`
  },
  {
    id: "c_ssl",
    section: "connections",
    title: "Encryption in use",
    source: "pg_stat_ssl",
    limit: 20,
    description: "Whether client sessions are encrypted. Loopback clients, provider services and this scan are excluded. On a managed provider, sessions from private addresses are its pooler talking to the database inside its network, not your clients.",
    columns: [C("role", "Role"), C("encrypted", "Encrypted", "bool"), C("tls", "TLS version", "mono"), C("remote", "Remote", "bool"), C("private", "Private network", "bool"), C("sessions", "Sessions", "int")],
    sql: (c) => {
      const priv = `(a.client_addr <<= '10.0.0.0/8'::inet or a.client_addr <<= '172.16.0.0/12'::inet or a.client_addr <<= '192.168.0.0/16'::inet or a.client_addr <<= 'fc00::/7'::inet)`;
      return `select coalesce(a.usename, '?')::text as role, s.ssl as encrypted, coalesce(s.version, '-') as tls,
      (a.client_addr is not null and not (a.client_addr <<= '127.0.0.0/8'::inet or a.client_addr <<= '::1/128'::inet)${c.profile.poolerOnPrivateNetwork ? ` and not ${priv}` : ""}) as remote,
      coalesce(${priv}, false) as private, count(*)::int as sessions
      from pg_stat_ssl s join pg_stat_activity a using (pid)
      where a.backend_type = 'client backend' and a.pid <> pg_backend_pid() and not ${c.profile.managedRoleSql("a.usename")} and not ${c.profile.internalAppSql("coalesce(a.application_name, '')")}
      group by 1, 2, 3, 4, 5 order by sessions desc limit 20`;
    }
  },
  // ───────── Replication & WAL
  {
    id: "r_slots",
    section: "replication",
    title: "Replication slots",
    source: "pg_replication_slots",
    limit: 20,
    description: "An inactive slot forces Postgres to keep WAL it hasn't delivered, which can fill the disk.",
    columns: [C("slot", "Slot", "mono"), C("type", "Type"), C("active", "Active", "bool"), C("status", "WAL status"), C("retained_bytes", "WAL retained", "bytes", { warn: 1073741824, bad: 5368709120 }), C("plugin", "Plugin", "mono")],
    sql: (c) => `select slot_name::text as slot, slot_type as type, active, ${c.version >= 13e4 ? "wal_status" : "null::text"} as status,
      pg_wal_lsn_diff(case when pg_is_in_recovery() then pg_last_wal_replay_lsn() else pg_current_wal_lsn() end, restart_lsn)::bigint as retained_bytes, coalesce(plugin::text, '') as plugin
      from pg_replication_slots order by retained_bytes desc nulls last limit 20`
  },
  {
    id: "r_standby",
    section: "replication",
    title: "Standby lag",
    source: "pg_stat_replication",
    limit: 20,
    description: "Connected replicas and how far behind the primary each is.",
    columns: [C("standby", "Standby", "mono"), C("addr", "Address", "mono"), C("state", "State"), C("sync", "Sync"), C("replay_bytes", "Replay lag", "bytes", { warn: 16777216, bad: 268435456 }), C("replay_lag_s", "Replay lag (time)", "secs", { warn: 5, bad: 60 }), C("flush_lag_s", "Flush lag", "secs")],
    sql: () => `select coalesce(application_name, '') as standby, coalesce(client_addr::text, '') as addr, state, sync_state as sync,
      pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn)::bigint as replay_bytes, round(extract(epoch from replay_lag)::numeric, 2) as replay_lag_s, round(extract(epoch from flush_lag)::numeric, 2) as flush_lag_s
      from pg_stat_replication order by replay_bytes desc nulls last limit 20`
  },
  {
    id: "r_walstats",
    section: "replication",
    title: "WAL generated",
    source: "pg_stat_wal",
    layout: "kv",
    limit: 1,
    minPg: 14e4,
    description: "WAL volume since the stats reset.",
    columns: [C("wal_bytes", "WAL written", "bytes"), C("wal_records", "Records", "int"), C("wal_fpi", "Full-page images", "int"), C("wal_buffers_full", "Buffer-full writes", "int"), C("stats_reset", "Since", "ts")],
    sql: () => `select wal_bytes::bigint as wal_bytes, wal_records, wal_fpi, wal_buffers_full, stats_reset from pg_stat_wal`
  },
  {
    id: "r_waldir",
    section: "replication",
    title: "WAL on disk",
    source: "pg_ls_waldir()",
    layout: "kv",
    limit: 1,
    description: "Segments currently retained in pg_wal.",
    columns: [C("segments", "Segments", "int"), C("bytes", "Size on disk", "bytes"), C("newest", "Newest segment", "ts")],
    sql: () => `select count(*)::int as segments, coalesce(sum(size), 0)::bigint as bytes, max(modification) as newest from pg_ls_waldir()`
  },
  {
    id: "r_archiver",
    section: "replication",
    title: "WAL archiver",
    source: "pg_stat_archiver",
    layout: "kv",
    limit: 1,
    description: "Continuous archiving health. Rising failures let WAL pile up.",
    columns: [C("archived_count", "Archived", "int"), C("failed_count", "Failed", "int", { warn: 1, bad: 10 }), C("last_archived_time", "Last success", "ts"), C("last_failed_time", "Last failure", "ts")],
    sql: () => `select archived_count, failed_count, last_archived_time, last_failed_time from pg_stat_archiver`
  },
  {
    id: "r_checkpoints",
    section: "replication",
    title: "Checkpoints",
    source: "pg_stat_checkpointer / pg_stat_bgwriter",
    layout: "kv",
    limit: 1,
    description: "Requested checkpoints far above timed ones mean WAL volume is forcing checkpoints, adding I/O spikes.",
    columns: [C("timed", "Timed", "int"), C("requested", "Requested (forced)", "int"), C("write_ms", "Write time", "ms"), C("sync_ms", "Sync time", "ms"), C("buffers", "Buffers written", "int")],
    sql: (c) => c.version >= 17e4 ? `select num_timed as timed, num_requested as requested, write_time as write_ms, sync_time as sync_ms, buffers_written as buffers from pg_stat_checkpointer` : `select checkpoints_timed as timed, checkpoints_req as requested, checkpoint_write_time as write_ms, checkpoint_sync_time as sync_ms, buffers_checkpoint as buffers from pg_stat_bgwriter`
  },
  {
    id: "r_settings",
    section: "replication",
    title: "WAL and replication settings",
    source: "pg_settings",
    limit: 20,
    description: "Settings that control WAL size, retention, archiving and replication capacity.",
    columns: SETTING_COLS,
    sql: () => setting(["wal_level", "max_wal_size", "min_wal_size", "wal_keep_size", "max_slot_wal_keep_size", "wal_compression", "archive_mode", "archive_timeout", "checkpoint_timeout", "checkpoint_completion_target", "max_wal_senders", "max_replication_slots", "synchronous_commit"])
  },
  {
    id: "r_pubs",
    section: "replication",
    title: "Publications",
    source: "pg_publication",
    limit: 20,
    description: "Logical replication publications and what they publish.",
    columns: [C("name", "Publication", "mono"), C("all_tables", "All tables", "bool"), C("tables", "Tables", "int"), C("ins", "Insert", "bool"), C("upd", "Update", "bool"), C("del", "Delete", "bool"), C("trunc", "Truncate", "bool")],
    sql: () => `select p.pubname::text as name, p.puballtables as all_tables, (select count(*) from pg_publication_tables t where t.pubname = p.pubname)::int as tables,
      p.pubinsert as ins, p.pubupdate as upd, p.pubdelete as del, p.pubtruncate as trunc from pg_publication p order by p.pubname limit 20`
  },
  // ───────── Vacuum & bloat
  {
    id: "v_dead",
    section: "vacuum",
    title: "Dead tuples and vacuum history",
    source: "pg_stat_user_tables",
    limit: 30,
    description: "Tables carrying dead rows, and when they were last vacuumed and analyzed.",
    columns: [C("table", "Table", "mono"), C("dead_rows", "Dead rows", "int"), C("dead_pct", "Dead %", "pct", { warn: 10, bad: 30 }), C("live_rows", "Live rows", "int"), C("last_vacuum", "Last vacuum", "ts"), C("last_autovacuum", "Last autovacuum", "ts"), C("last_autoanalyze", "Last autoanalyze", "ts"), C("autovacuums", "Autovacuums", "int")],
    sql: (c) => `select schemaname || '.' || relname as "table", n_dead_tup as dead_rows, round(100.0 * n_dead_tup / nullif(n_live_tup + n_dead_tup, 0), 1) as dead_pct, n_live_tup as live_rows,
      last_vacuum, last_autovacuum, last_autoanalyze, autovacuum_count as autovacuums
      from pg_stat_user_tables where n_dead_tup > 0 and ${ut(c, "schemaname", "relname")} order by n_dead_tup desc limit 30`
  },
  {
    id: "v_age",
    section: "vacuum",
    title: "Transaction ID age by table",
    source: "pg_class",
    limit: 25,
    description: "How far each table is from a forced anti-wraparound vacuum (autovacuum_freeze_max_age). Tables near 100% get emergency vacuums.",
    columns: [C("table", "Table", "mono"), C("xid_age", "XID age", "int"), C("pct", "% of freeze limit", "pct", { warn: 70, bad: 95 }), C("mxid_age", "MultiXact age", "int"), C("bytes", "Size", "bytes")],
    sql: (c) => `select n.nspname || '.' || t.relname as "table", age(t.relfrozenxid)::bigint as xid_age, round(100.0 * age(t.relfrozenxid) / current_setting('autovacuum_freeze_max_age')::numeric, 1) as pct,
      mxid_age(t.relminmxid)::bigint as mxid_age, pg_total_relation_size(t.oid) as bytes
      from pg_class t join pg_namespace n on n.oid = t.relnamespace where t.relkind in ('r','m') and ${us(c, "n.nspname")} order by xid_age desc limit 25`
  },
  {
    id: "v_dbage",
    section: "vacuum",
    title: "Wraparound distance per database",
    source: "pg_database",
    limit: 20,
    description: "Transaction IDs wrap at about 2.1 billion. Postgres stops accepting writes to prevent data loss if vacuum can't keep up.",
    columns: [C("database", "Database", "mono"), C("xid_age", "XID age", "int"), C("xid_pct", "% of limit", "pct", { warn: 50, bad: 75 }), C("mxid_age", "MultiXact age", "int"), C("mxid_pct", "% of limit", "pct", { warn: 50, bad: 75 })],
    sql: () => `select datname::text as database, age(datfrozenxid)::bigint as xid_age, round(100.0 * age(datfrozenxid) / 2100000000, 1) as xid_pct,
      mxid_age(datminmxid)::bigint as mxid_age, round(100.0 * mxid_age(datminmxid) / 2100000000, 1) as mxid_pct from pg_database where datallowconn order by xid_age desc limit 20`
  },
  {
    id: "v_running",
    section: "vacuum",
    title: "Vacuums running now",
    source: "pg_stat_progress_vacuum",
    limit: 20,
    description: "Live vacuum progress.",
    columns: [C("pid", "PID", "id"), C("table", "Table", "mono"), C("phase", "Phase"), C("progress_pct", "Progress", "pct"), C("dead_tuples", "Dead tuples collected", "int")],
    sql: (c) => `select pid, relid::regclass::text as "table", phase, round(100.0 * heap_blks_scanned / nullif(heap_blks_total, 0), 1) as progress_pct, ${c.version >= 17e4 ? "num_dead_item_ids" : "num_dead_tuples"} as dead_tuples
      from pg_stat_progress_vacuum where datid = ${inDb} limit 20`
  },
  {
    id: "v_settings",
    section: "vacuum",
    title: "Autovacuum settings",
    source: "pg_settings",
    limit: 20,
    description: "Thresholds that decide when autovacuum runs and how hard it works.",
    columns: SETTING_COLS,
    sql: () => setting(["autovacuum", "autovacuum_naptime", "autovacuum_max_workers", "autovacuum_vacuum_scale_factor", "autovacuum_vacuum_threshold", "autovacuum_analyze_scale_factor", "autovacuum_vacuum_cost_limit", "autovacuum_vacuum_cost_delay", "autovacuum_freeze_max_age", "vacuum_freeze_min_age", "vacuum_freeze_table_age"])
  },
  // ───────── Configuration
  {
    id: "cfg_key",
    section: "config",
    title: "Key settings",
    source: "pg_settings",
    limit: 30,
    description: "Memory, planner, parallelism and timeout settings that most affect behavior.",
    columns: SETTING_COLS,
    sql: () => setting(["shared_buffers", "effective_cache_size", "work_mem", "maintenance_work_mem", "max_connections", "random_page_cost", "effective_io_concurrency", "default_statistics_target", "max_worker_processes", "max_parallel_workers", "max_parallel_workers_per_gather", "jit", "huge_pages", "track_io_timing", "track_activity_query_size", "statement_timeout", "lock_timeout", "idle_in_transaction_session_timeout"])
  },
  {
    id: "cfg_changed",
    section: "config",
    title: "Settings changed from default",
    source: "pg_settings",
    limit: 80,
    description: "Everything not at its built-in default, and where it was set (config file, role, database, or session).",
    columns: SETTING_COLS,
    sql: () => `select name, ${safeValue()} as setting, coalesce(unit, '') as unit, source from pg_settings where source not in ('default', 'override')
      and name !~ '^neon\\.' order by name limit 80`
  },
  // Neon's own settings: not tunable by the customer, and they name the endpoint
  // ───────── Logs & activity
  {
    id: "l_db",
    section: "logs",
    title: "Database-reported errors and activity",
    source: "pg_stat_database",
    layout: "kv",
    limit: 1,
    description: "Counters the database keeps since the last stats reset.",
    columns: [C("commits", "Commits", "int"), C("rollbacks", "Rollbacks", "int"), C("rollback_pct", "Rollback rate", "pct", { warn: 5, bad: 20 }), C("deadlocks", "Deadlocks", "int", { warn: 1, bad: 10 }), C("conflicts", "Recovery conflicts", "int"), C("temp_files", "Temp files", "int"), C("temp_bytes", "Temp bytes", "bytes"), C("checksum_failures", "Checksum failures", "int", { bad: 1 }), C("stats_reset", "Since", "ts"), C("next_xid", "Transaction counter", "int")],
    sql: (c) => `select xact_commit as commits, xact_rollback as rollbacks, round(100.0 * xact_rollback / nullif(xact_commit + xact_rollback, 0), 2) as rollback_pct, deadlocks, conflicts, temp_files, temp_bytes,
      coalesce(checksum_failures, 0) as checksum_failures, stats_reset, ${c.version >= 13e4 ? "pg_snapshot_xmax(pg_current_snapshot())::text::bigint" : "txid_snapshot_xmax(txid_current_snapshot())::bigint"} as next_xid
      from pg_stat_database where datname = current_database()`
  },
  {
    id: "l_settings",
    section: "logs",
    title: "Logging configuration",
    source: "pg_settings",
    limit: 20,
    description: "What the server writes to its logs. Without slow-query and lock-wait logging, incidents leave little evidence.",
    columns: SETTING_COLS,
    sql: () => setting(["log_min_duration_statement", "log_statement", "log_lock_waits", "deadlock_timeout", "log_checkpoints", "log_connections", "log_disconnections", "log_autovacuum_min_duration", "log_temp_files", "log_min_error_statement", "log_destination", "logging_collector"])
  },
  // ───────── Security
  {
    id: "s_roles",
    section: "security",
    title: "Roles and privileges",
    source: "pg_roles",
    limit: 50,
    description: "Login roles and their powers. Superuser, BYPASSRLS and REPLICATION are the ones to keep to a minimum. Provider-managed roles are hidden.",
    columns: [C("role", "Role", "mono"), C("login", "Can login", "bool"), C("superuser", "Superuser", "bool"), C("createrole", "Create role", "bool"), C("createdb", "Create DB", "bool"), C("replication", "Replication", "bool"), C("bypassrls", "Bypass RLS", "bool"), C("conn_limit", "Conn limit", "int"), C("valid_until", "Password expires", "ts"), C("member_of", "Member of", "mono")],
    sql: (c) => `select r.rolname::text as role, r.rolcanlogin as login, r.rolsuper as superuser, r.rolcreaterole as createrole, r.rolcreatedb as createdb, r.rolreplication as replication, r.rolbypassrls as bypassrls,
      r.rolconnlimit as conn_limit, r.rolvaliduntil as valid_until, (select string_agg(b.rolname, ', ' order by b.rolname) from pg_auth_members m join pg_roles b on b.oid = m.roleid where m.member = r.oid) as member_of
      from pg_roles r where r.rolname !~ '^pg_' and not ${c.profile.managedRoleSql("r.rolname")} order by r.rolsuper desc, r.rolcanlogin desc, r.rolname limit 50`
  },
  {
    id: "s_rls",
    section: "security",
    title: "Row-level security coverage",
    source: "pg_class, pg_policy",
    limit: 60,
    description: "Which tables have RLS enabled and how many policies each has. RLS enabled with no policies denies all access; RLS disabled leaves the table open to anyone with privileges.",
    columns: [C("table", "Table", "mono"), C("rls", "RLS enabled", "bool"), C("forced", "Forced", "bool"), C("policies", "Policies", "int")],
    sql: (c) => `select n.nspname || '.' || t.relname as "table", t.relrowsecurity as rls, t.relforcerowsecurity as forced, (select count(*) from pg_policy p where p.polrelid = t.oid)::int as policies
      from pg_class t join pg_namespace n on n.oid = t.relnamespace where t.relkind in ('r','p') and ${us(c, "n.nspname")} order by t.relrowsecurity, policies, 1 limit 60`
  },
  {
    id: "s_policies",
    section: "security",
    title: "Policies",
    source: "pg_policies",
    limit: 60,
    description: "Every policy with its command, roles and expressions. A policy is 'always true' when the expression that gates it (USING for reads, updates and deletes; WITH CHECK for inserts) is missing or literally true.",
    columns: [C("table", "Table", "mono"), C("policy", "Policy", "mono"), C("cmd", "Command"), C("roles", "Roles", "mono"), C("always_true", "Always true", "bool"), C("using_expr", "USING", "mono"), C("check_expr", "WITH CHECK", "mono")],
    sql: (c) => `select schemaname || '.' || tablename as "table", policyname::text as policy, cmd, array_to_string(roles, ', ') as roles,
      case when cmd = 'INSERT' then coalesce(nullif(btrim(with_check), ''), 'true') in ('true', '(true)')
           else coalesce(nullif(btrim(qual), ''), 'true') in ('true', '(true)') end as always_true,
      left(coalesce(qual, ''), 300) as using_expr, left(coalesce(with_check, ''), 300) as check_expr
      from pg_policies where ${us(c, "schemaname")} order by 5 desc, 1, 2 limit 60`
  },
  {
    id: "s_policy_calls",
    section: "security",
    title: "Functions called by policies",
    source: "pg_policy, pg_proc",
    limit: 60,
    description: "Each policy's expression, with the volatility of every function it names (i immutable, s stable, v volatile). PostgreSQL runs a stable or volatile function in a row filter once per row; a scalar sub-select with no outer references is evaluated once per query instead.",
    columns: [C("table", "Table", "mono"), C("policy", "Policy", "mono"), C("cmd", "Command"), C("est_rows", "Est. rows", "int"), C("fn_vols", "Functions", "mono"), C("expr", "Expression", "mono")],
    sql: (c) => `with pol as (
        select n.nspname || '.' || t.relname as tbl, p.polname::text as policy, p.polcmd, t.reltuples::bigint as est_rows,
          concat_ws(' ', pg_get_expr(p.polqual, p.polrelid), pg_get_expr(p.polwithcheck, p.polrelid)) as expr
        from pg_policy p join pg_class t on t.oid = p.polrelid join pg_namespace n on n.oid = t.relnamespace
        where ${us(c, "n.nspname")} and t.relkind in ('r','p'))
      select tbl as "table", policy, case polcmd when 'r' then 'SELECT' when 'a' then 'INSERT' when 'w' then 'UPDATE' when 'd' then 'DELETE' else 'ALL' end as cmd,
        est_rows, left(expr, 2000) as expr,
        (select string_agg(x.name || ':' || x.vol, ',' order by x.name) from (
           select m.name, min(pr.provolatile::text) as vol
           from (select distinct (regexp_matches(pol.expr, '([A-Za-z_][A-Za-z0-9_]*)\\s*\\(', 'g'))[1] as name) m
           join pg_proc pr on pr.proname = m.name group by m.name) x) as fn_vols
      from pol where expr ~ '\\(' order by est_rows desc, 1, 2 limit 60`
  },
  {
    id: "s_policy_overlap",
    section: "security",
    title: "Policies stacked on one table",
    source: "pg_policy",
    limit: 60,
    description: "Tables where more than one permissive policy applies to the same role and command. Permissive policies are combined with OR, so PostgreSQL evaluates each of them for every row it checks.",
    columns: [C("table", "Table", "mono"), C("role", "Role", "mono"), C("cmd", "Command"), C("policies", "Policies", "int", { warn: 3, bad: 5 }), C("names", "Names", "mono")],
    sql: (c) => `select n.nspname || '.' || t.relname as "table", case when x.roleid = 0 then 'public' else r.rolname::text end as role, x.cmd, count(*)::int as policies, string_agg(x.polname::text, ', ' order by x.polname) as names
      from (select p.polrelid, p.polname, unnest(case when p.polroles = '{0}'::oid[] then array[0::oid] else p.polroles end) as roleid, k.cmd
              from pg_policy p, lateral (values ('SELECT', 'r'), ('INSERT', 'a'), ('UPDATE', 'w'), ('DELETE', 'd')) k(cmd, code)
             where p.polpermissive and (p.polcmd = '*' or p.polcmd = k.code)) x
      join pg_class t on t.oid = x.polrelid join pg_namespace n on n.oid = t.relnamespace left join pg_roles r on r.oid = x.roleid
      where ${us(c, "n.nspname")} group by 1, 2, 3 having count(*) > 1 order by policies desc, 1 limit 60`
  },
  {
    id: "s_policy_unindexed",
    section: "security",
    title: "Policy columns without an index",
    source: "pg_policy, pg_depend, pg_index",
    limit: 60,
    description: "Columns a policy's expression reads on its own table, for tables of about 10,000 rows or more, where no index starts with that column. Without one, a policy that compares the column cannot use an index scan.",
    columns: [C("table", "Table", "mono"), C("column", "Column", "mono"), C("policies", "Policies", "mono"), C("est_rows", "Est. rows", "int")],
    sql: (c) => `select n.nspname || '.' || t.relname as "table", a.attname::text as "column", string_agg(distinct p.polname::text, ', ') as policies, t.reltuples::bigint as est_rows
      from pg_policy p join pg_class t on t.oid = p.polrelid join pg_namespace n on n.oid = t.relnamespace
      join pg_depend d on d.classid = 'pg_policy'::regclass and d.objid = p.oid and d.refclassid = 'pg_class'::regclass and d.refobjid = p.polrelid and d.refobjsubid > 0
      join pg_attribute a on a.attrelid = p.polrelid and a.attnum = d.refobjsubid
      where ${us(c, "n.nspname")} and t.relkind in ('r','p') and t.reltuples >= 10000
        and not exists (select 1 from pg_index i where i.indrelid = p.polrelid and i.indisvalid and i.indkey[0] = a.attnum)
      group by 1, 2, t.reltuples order by est_rows desc, 1, 2 limit 60`
  },
  {
    id: "s_policy_lookups",
    section: "security",
    title: "Policies that read other tables",
    source: "pg_policy, pg_depend",
    limit: 60,
    description: "Policies whose expression reads a different table, for example through EXISTS or IN. That read runs as part of every query on the protected table, and is itself subject to row-level security when the other table has it enabled.",
    columns: [C("table", "Table", "mono"), C("policy", "Policy", "mono"), C("reads", "Reads", "mono"), C("reads_rls", "Read table has RLS", "bool")],
    sql: (c) => `select n.nspname || '.' || t.relname as "table", p.polname::text as policy, string_agg(distinct rn.nspname || '.' || rt.relname, ', ') as reads, bool_or(rt.relrowsecurity) as reads_rls
      from pg_policy p join pg_class t on t.oid = p.polrelid join pg_namespace n on n.oid = t.relnamespace
      join pg_depend d on d.classid = 'pg_policy'::regclass and d.objid = p.oid and d.refclassid = 'pg_class'::regclass and d.refobjid <> p.polrelid
      join pg_class rt on rt.oid = d.refobjid and rt.relkind in ('r','p','v','m') join pg_namespace rn on rn.oid = rt.relnamespace
      where ${us(c, "n.nspname")} group by 1, 2 order by bool_or(rt.relrowsecurity) desc, 1, 2 limit 60`
  },
  // ───────── Extensions
  {
    id: "e_installed",
    section: "extensions",
    title: "Installed extensions",
    source: "pg_extension, pg_available_extensions",
    limit: 60,
    description: "Extensions installed in this database and whether a newer version is available.",
    columns: [C("name", "Extension", "mono"), C("version", "Installed", "mono"), C("default_version", "Latest available", "mono"), C("update", "Update available", "bool"), C("schema", "Schema", "mono")],
    sql: () => `select e.extname::text as name, e.extversion as version, av.default_version, (av.default_version is not null and av.default_version <> e.extversion) as update, n.nspname::text as schema
      from pg_extension e join pg_namespace n on n.oid = e.extnamespace left join pg_available_extensions av on av.name = e.extname order by 4 desc, 1 limit 60`
  }
];
function normalize(rows3, cols) {
  const kind = new Map(cols.map((c) => [c.key, c.kind ?? "text"]));
  return rows3.map((r) => {
    const out2 = {};
    for (const [k, v] of Object.entries(r)) {
      if (v instanceof Date) out2[k] = v.toISOString();
      else if (v !== null && NUMERIC.includes(kind.get(k)) && !Number.isNaN(Number(v))) out2[k] = Number(v);
      else if (typeof v === "bigint") out2[k] = v.toString();
      else out2[k] = v;
    }
    return out2;
  });
}
var ALL_DEFS = [...DEFS, ...MORE, ...CAP, ...OPS];
async function collectDatasets(c, onRead) {
  const installed = new Set((await c.q(`select extname from pg_extension`)).map((r) => String(r.extname)));
  const out2 = [];
  let done = 0;
  for (const d of ALL_DEFS) {
    onRead?.(done++, ALL_DEFS.length);
    if (d.only && !d.only.includes(c.profile.id)) continue;
    if (d.minPg && c.version < d.minPg) continue;
    const base2 = { id: d.id, section: d.section, title: d.title, description: d.description, source: d.source, layout: d.layout ?? "table", columns: d.columns, rows: [], capped: false };
    if (d.ext && !installed.has(d.ext) && d.optional) continue;
    if (d.ext && !installed.has(d.ext)) {
      out2.push({ ...base2, note: d.hint ?? `The ${d.ext} extension isn't installed, so this can't be measured. See the quickstart to enable it.` });
      continue;
    }
    try {
      const rows3 = normalize(await c.q(d.sql(c)), d.columns);
      out2.push({ ...base2, rows: rows3, capped: rows3.length >= (d.limit ?? 50) });
    } catch (e) {
      if (isConnectionLost(e)) throw e;
      out2.push({ ...base2, error: String(e.message ?? e).replace(/postgres(ql)?:\/\/\S+/g, "[connection string]") });
    }
  }
  return out2;
}
var VITAL_KEYS = ["db_bytes", "cache_hit", "conns", "max_conns", "xid_age", "uptime_s", "tables", "indexes", "deadlocks"];
var VITALS_SQL = `select pg_database_size(current_database()) as db_bytes,
    (select round(100.0 * sum(blks_hit) / nullif(sum(blks_hit + blks_read), 0), 2) from pg_stat_database where datname = current_database()) as cache_hit,
    (select count(*) from pg_stat_activity where backend_type = 'client backend')::int as conns, current_setting('max_connections')::int as max_conns,
    (select max(age(datfrozenxid)) from pg_database where datallowconn)::bigint as xid_age,
    extract(epoch from now() - pg_postmaster_start_time())::bigint as uptime_s,
    (select count(*) from pg_stat_user_tables)::int as tables, (select count(*) from pg_stat_user_indexes)::int as indexes,
    (select deadlocks from pg_stat_database where datname = current_database()) as deadlocks`;
async function collectVitalsRow(c) {
  const [r] = await c.q(VITALS_SQL);
  return Object.fromEntries(VITAL_KEYS.map((k) => [k, r[k] === null || r[k] === void 0 ? null : Number(r[k])]));
}
function vitalsFrom(r) {
  if (r.db_bytes == null) return [];
  const connPct = 100 * Number(r.conns) / Number(r.max_conns);
  const xidPct = 100 * Number(r.xid_age) / 21e8;
  const cache = r.cache_hit == null ? null : Number(r.cache_hit);
  return [
    { label: "Database size", value: Number(r.db_bytes), kind: "bytes" },
    { label: "Cache hit rate", value: cache, kind: "pct", tone: cache === null ? void 0 : cache < 90 ? "bad" : cache < 99 ? "warn" : "ok", hint: "Aim for 99% or higher on OLTP workloads" },
    { label: "Connections", value: `${r.conns} / ${r.max_conns}`, tone: connPct >= 90 ? "bad" : connPct >= 70 ? "warn" : "ok", hint: `${Math.round(connPct)}% of max_connections` },
    { label: "Oldest XID age", value: Number(r.xid_age), kind: "int", tone: xidPct >= 75 ? "bad" : xidPct >= 50 ? "warn" : "ok", hint: `${xidPct.toFixed(1)}% of the wraparound limit` },
    { label: "Uptime", value: Number(r.uptime_s), kind: "secs" },
    { label: "Tables", value: Number(r.tables), kind: "int" },
    { label: "Indexes", value: Number(r.indexes), kind: "int" },
    { label: "Deadlocks", value: Number(r.deadlocks ?? 0), kind: "int", tone: Number(r.deadlocks) > 0 ? "warn" : "ok", hint: "Since stats reset" }
  ];
}

// src/bundle.ts
var BUNDLE_FORMAT = "pg-checkup-bundle";
var BUNDLE_VERSION = 1;
var MAX_BUNDLE_BYTES = 3 * 1024 * 1024;
var PROVIDERS = ["generic", "supabase", "neon"];
var HOSTING_LABELS = ["Neon", "Supabase", "Railway", "Render", "Amazon RDS", "Aiven", "Timescale Cloud"];
var KNOWN = new Map(ALL_DEFS.map((d) => [d.id, d]));
var KEY = /^[a-z_][a-z0-9_]{0,62}$/i;
var fail = (msg) => {
  throw new Error(`Invalid bundle: ${msg}`);
};
var isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
var str = (v, max, what) => typeof v === "string" && v.length <= max ? v : fail(`${what} must be text of at most ${max} characters`);
var bool = (v, what) => typeof v === "boolean" ? v : fail(`${what} must be true or false`);
var int = (v, what) => typeof v === "number" && Number.isFinite(v) ? v : fail(`${what} must be a number`);
function cell(v, where) {
  if (v === null || typeof v === "boolean") return v;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") return v.length <= 4e3 ? v : v.slice(0, 4e3);
  if (Array.isArray(v) && v.length <= 50 && v.every((x) => x === null || ["string", "number", "boolean"].includes(typeof x))) return v.map((x) => typeof x === "string" ? x.slice(0, 500) : x);
  return fail(`${where} holds a value that isn't text, a number, true/false or a short list`);
}
function parseBundle(input) {
  if (!isObj(input)) fail("expected a JSON object");
  const b = input;
  if (b.format !== BUNDLE_FORMAT) fail(`format must be "${BUNDLE_FORMAT}"`);
  if (b.version !== BUNDLE_VERSION) fail(`version ${String(b.version)} isn't supported; update pg-checkup and collect again`);
  const server = isObj(b.server) ? b.server : fail("missing server");
  const connection3 = isObj(b.connection) ? b.connection : fail("missing connection");
  const s = isObj(b.session) ? b.session : fail("missing session");
  const provider3 = PROVIDERS.includes(b.provider) ? b.provider : fail("unknown provider");
  const hosting = b.hosting == null ? null : HOSTING_LABELS.includes(String(b.hosting)) ? String(b.hosting) : null;
  const vitalsIn = isObj(b.vitals) ? b.vitals : {};
  const vitals = {};
  for (const k of VITAL_KEYS) {
    const v = vitalsIn[k];
    vitals[k] = typeof v === "number" && Number.isFinite(v) ? v : null;
  }
  if (!Array.isArray(b.datasets) || b.datasets.length > KNOWN.size) fail("datasets must be a list");
  const seen = /* @__PURE__ */ new Set();
  const datasets = [];
  for (const d of b.datasets) {
    if (!isObj(d)) fail("each dataset must be an object");
    const id = str(d.id, 64, "dataset id");
    const def = KNOWN.get(id);
    if (!def || seen.has(id)) continue;
    seen.add(id);
    const rowsIn = d.rows;
    if (!Array.isArray(rowsIn)) fail(`${id}.rows must be a list`);
    const rows3 = rowsIn.slice(0, def.limit ?? 50).map((r, i) => {
      if (!isObj(r)) fail(`${id} row ${i} must be an object`);
      const entries = Object.entries(r);
      if (entries.length > 40) fail(`${id} row ${i} has too many fields`);
      return Object.fromEntries(entries.map(([k, v]) => [KEY.test(k) ? k : fail(`${id} has a field named "${k.slice(0, 40)}"`), cell(v, `${id}.${k}`)]));
    });
    const note = d.note, error = d.error;
    datasets.push({ id, rows: rows3, capped: Boolean(d.capped), ...typeof note === "string" ? { note: note.slice(0, 500) } : {}, ...typeof error === "string" ? { error: error.slice(0, 500) } : {} });
  }
  const facts = isObj(b.facts) ? b.facts : {};
  const qt = b.queryText === "removed" ? "removed" : "masked";
  const list2 = (v) => Array.isArray(v) ? v.filter((x) => typeof x === "string").slice(0, 10).map((x) => x.slice(0, 128)) : [];
  return {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    collectedAt: typeof b.collectedAt === "string" && !Number.isNaN(Date.parse(b.collectedAt)) ? new Date(b.collectedAt).toISOString() : (/* @__PURE__ */ new Date()).toISOString(),
    collector: typeof b.collector === "string" ? b.collector.slice(0, 32) : "unknown",
    server: { versionNum: int(server.versionNum, "server.versionNum"), version: str(server.version, 300, "server.version") },
    provider: provider3,
    hosting,
    connection: { tls: bool(connection3.tls, "connection.tls"), local: bool(connection3.local, "connection.local"), ...typeof connection3.verified === "boolean" ? { verified: connection3.verified } : {} },
    session: {
      role: str(s.role, 128, "session.role"),
      superuser: bool(s.superuser, "session.superuser"),
      monitor: bool(s.monitor, "session.monitor"),
      bypassrls: Boolean(s.bypassrls),
      replication: Boolean(s.replication),
      createrole: Boolean(s.createrole),
      createdb: Boolean(s.createdb),
      dataRoles: list2(s.dataRoles),
      readableTables: Number(s.readableTables) || 0,
      writableTables: Number(s.writableTables) || 0,
      readableSample: list2(s.readableSample),
      tls: bool(connection3.tls, "connection.tls"),
      readOnly: true
    },
    ...typeof b.target === "string" && /^[a-f0-9]{24}$/.test(b.target) ? { target: b.target } : {},
    queryText: qt,
    facts: { publicSchemaCreate: typeof facts.publicSchemaCreate === "boolean" ? facts.publicSchemaCreate : null },
    vitals,
    datasets
  };
}

// src/role.ts
var DATA_ROLES = ["pg_read_all_data", "pg_write_all_data", "pg_read_server_files", "pg_write_server_files", "pg_execute_server_program"];
function roleSql(p) {
  const app = `from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r', 'p', 'v', 'm', 'f') and ${userSchemaSql(p, "n.nspname")}
      and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')`;
  const readable = `has_any_column_privilege(c.oid, 'SELECT')`;
  const writable = `(has_table_privilege(c.oid, 'INSERT') or has_table_privilege(c.oid, 'UPDATE') or has_table_privilege(c.oid, 'DELETE') or has_table_privilege(c.oid, 'TRUNCATE'))`;
  return `select current_user::text as role, r.rolsuper as superuser, r.rolbypassrls as bypassrls, r.rolreplication as replication,
      r.rolcreaterole as createrole, r.rolcreatedb as createdb, pg_has_role(current_user, 'pg_monitor', 'member') as monitor,
      array(select g.rolname::text from pg_roles g where g.rolname in (${DATA_ROLES.map((x) => `'${x}'`).join(", ")}) and pg_has_role(current_user, g.oid, 'member') order by 1) as data_roles,
      (select count(*) ${app} and ${readable})::int as readable_tables,
      (select count(*) ${app} and ${writable})::int as writable_tables,
      array(select n.nspname || '.' || c.relname ${app} and ${readable} order by c.reltuples desc limit 5) as readable_sample
    from pg_roles r where r.rolname = current_user`;
}
function roleInfo(r) {
  return {
    role: String(r.role),
    superuser: Boolean(r.superuser),
    monitor: Boolean(r.monitor),
    bypassrls: Boolean(r.bypassrls),
    replication: Boolean(r.replication),
    createrole: Boolean(r.createrole),
    createdb: Boolean(r.createdb),
    dataRoles: (r.data_roles ?? []).map(String),
    readableTables: Number(r.readable_tables ?? 0),
    writableTables: Number(r.writable_tables ?? 0),
    readableSample: (r.readable_sample ?? []).map(String)
  };
}
function roleProblems(r) {
  const out2 = [];
  if (r.superuser) out2.push(`${r.role} is a superuser.`);
  if (r.bypassrls) out2.push(`${r.role} has BYPASSRLS, so row-level security doesn't apply to it.`);
  if (r.replication) out2.push(`${r.role} has REPLICATION, which can stream every row of the database.`);
  if (r.createrole) out2.push(`${r.role} has CREATEROLE, which can grant itself other roles.`);
  if (r.createdb) out2.push(`${r.role} has CREATEDB, which is unnecessary for inspection.`);
  if (r.dataRoles.length) out2.push(`${r.role} is a member of ${r.dataRoles.join(", ")}.`);
  if (r.writableTables) out2.push(`${r.role} can write to ${r.writableTables} application ${r.writableTables === 1 ? "table" : "tables"}.`);
  if (r.readableTables) out2.push(`${r.role} can read ${r.readableTables} application ${r.readableTables === 1 ? "table" : "tables"}${r.readableSample.length ? ` (${r.readableSample.slice(0, 3).join(", ")}${r.readableTables > 3 ? ", ..." : ""})` : ""}.`);
  return out2;
}
var RoleRefused = class extends Error {
  constructor(problems) {
    super(problems.join("\n"));
    this.problems = problems;
    this.name = "RoleRefused";
  }
  problems;
};
function requireMonitoringRole(role, allowPrivilegedRole2 = false) {
  const problems = roleProblems(role);
  if (problems.length && !allowPrivilegedRole2) throw new RoleRefused(problems);
}
var MONITOR_ROLE_SQL = `create role checkup_reader login password 'choose-a-password';
grant pg_monitor to checkup_reader;
-- Nothing else: no table grants, no superuser, no BYPASSRLS, no REPLICATION.`;

// src/fingerprint.ts
import { createHash } from "node:crypto";
function fingerprint(connectionString) {
  const u = new URL(connectionString);
  const host2 = u.hostname.toLowerCase(), user = decodeURIComponent(u.username);
  const tenant = /pooler\./.test(host2) && user.includes(".") ? user.slice(user.indexOf(".") + 1) : "";
  const db = decodeURIComponent(u.pathname.slice(1)) || user;
  return createHash("sha256").update(`pgc-target|${host2}|${u.port || "5432"}|${db}|${tenant}`).digest("hex").slice(0, 24);
}

// src/collect.ts
var TAG = "/* pg-checkup */";
var COLLECTOR_VERSION = "0.3.0";
var LOCAL = /* @__PURE__ */ new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
var isLocalHost = (connectionString) => {
  try {
    return LOCAL.has(new URL(connectionString).hostname);
  } catch {
    return false;
  }
};
var pinned = (address) => () => {
  const s = new net.Socket();
  const connect2 = s.connect.bind(s);
  s.connect = (port, _host, ...rest) => connect2(port, address, ...rest);
  return s;
};
var base = (connectionString, address) => ({ connectionString, statement_timeout: 15e3, connectionTimeoutMillis: 1e4, application_name: "pg-checkup", ...address ? { stream: pinned(address) } : {} });
async function connect(url, local, address) {
  const u = new URL(url);
  const explicit = u.searchParams.has("sslmode") || u.searchParams.has("ssl");
  if (!local && !explicit) u.searchParams.set("sslmode", "verify-full");
  const mode = u.searchParams.get("sslmode");
  const tlsWanted = mode ? mode !== "disable" : !local && u.searchParams.get("ssl") !== "0";
  if (process.env.PGSSLROOTCERT && !u.searchParams.has("sslrootcert") && tlsWanted) {
    u.searchParams.set("sslrootcert", process.env.PGSSLROOTCERT);
  }
  let db;
  try {
    db = new pg.Client(base(u.toString(), address));
  } catch (e) {
    throw new Error(`Could not set up the connection: ${e.message}. If PGSSLROOTCERT is set, check that the file exists and is readable.`);
  }
  db.on("error", () => {
  });
  try {
    await db.connect();
    const ssl = db.ssl;
    return { db, tls: Boolean(ssl), verified: Boolean(ssl && (typeof ssl !== "object" || ssl.rejectUnauthorized !== false)) };
  } catch (e) {
    await db.end().catch(() => {
    });
    throw e;
  }
}
async function openReadOnlySession(connectionString, address) {
  const local = LOCAL.has(new URL(connectionString).hostname);
  const { db, tls, verified } = await connect(connectionString, local, address);
  await db.query(`${TAG} set default_transaction_read_only = on`);
  return { db, tls, verified, local };
}
var VERSION_SQL = `select current_setting('server_version_num')::int as v, version() as s, pg_backend_pid() as pid`;
var PUBLIC_CREATE_SQL = `select has_schema_privilege('public', 'public', 'CREATE') as open`;
function statements(provider3 = "generic", version = 18e4) {
  const profile = profileFor(provider3);
  const ctx = { version, profile, opts: {}, tls: true, local: false, facts: {}, selfPid: 0 };
  return [
    { id: "read_only", title: "Make this session unable to write", sql: "set default_transaction_read_only = on" },
    { id: "session", title: "Server version and this session", sql: VERSION_SQL },
    { id: "role", title: "What the connected role is allowed to do", sql: roleSql(profile) },
    { id: "extensions", title: "Installed extensions", sql: "select extname from pg_extension" },
    ...version < 15e4 ? [{ id: "public_create", title: "Whether every role can create objects in the public schema", sql: PUBLIC_CREATE_SQL }] : [],
    ...ALL_DEFS.filter((d) => (!d.only || d.only.includes(provider3)) && (!d.minPg || version >= d.minPg)).map((d) => ({ id: d.id, title: d.title, sql: d.sql(ctx) })),
    { id: "vitals", title: "Key numbers", sql: VITALS_SQL }
  ].map((x) => ({ ...x, sql: x.sql.replace(/\n\s+/g, "\n  ").trim() }));
}
var TEXT_COLUMNS = /* @__PURE__ */ new Set(["query", "blocked_query", "blocking_query"]);
var SQL_TEXT_DATASETS = /^(q_|b_)/;
var NO_TEXT = "(query text not collected)";
var withoutText = (r) => Object.fromEntries(Object.entries(r).map(([k, x]) => [k, TEXT_COLUMNS.has(k) || k === "detail" && r.holder === "Backend session" ? NO_TEXT : x]));
async function collect(connectionString, opts = {}) {
  const { db, tls, verified, local } = await openReadOnlySession(connectionString, opts.connectAddress);
  try {
    const [{ v, s, pid }] = (await db.query(`${TAG} ${VERSION_SQL}`)).rows;
    const providerId = opts.provider ?? providerIdFromUrl(connectionString);
    const profile = profileFor(providerId);
    const ctx = { db, version: v, opts, profile, selfPid: pid, tls, local, facts: {}, q: async (sql, params) => (await db.query(`${TAG} ${sql}`, params)).rows };
    opts.progress?.({ step: "connected", version: String(s), tls, verified });
    const role = roleInfo((await ctx.q(roleSql(profile)))[0] ?? {});
    await opts.checkRole?.(role);
    const facts = { publicSchemaCreate: v < 15e4 ? await ctx.q(PUBLIC_CREATE_SQL).then((r) => Boolean(r[0]?.open), () => null) : null };
    const removed = opts.queryText === "removed";
    const datasets = (await collectDatasets(ctx, (done, total) => opts.progress?.({ step: "read", done, total }))).map((d) => ({
      id: d.id,
      title: d.title,
      source: d.source,
      capped: d.capped,
      rows: removed && SQL_TEXT_DATASETS.test(d.id) ? d.rows.map(withoutText) : d.rows,
      ...d.note ? { note: d.note } : {},
      ...d.error ? { error: d.error } : {}
    }));
    const vitals = await collectVitalsRow(ctx).catch(() => ({}));
    const hosting = detectProvider(connectionString)?.provider ?? null;
    return {
      format: BUNDLE_FORMAT,
      version: BUNDLE_VERSION,
      collectedAt: (/* @__PURE__ */ new Date()).toISOString(),
      collector: COLLECTOR_VERSION,
      server: { versionNum: v, version: s },
      provider: providerId,
      hosting: hosting && HOSTING_LABELS.includes(hosting) ? hosting : null,
      connection: { tls, local, verified },
      session: { ...role, tls, readOnly: true },
      target: fingerprint(connectionString),
      queryText: removed ? "removed" : "masked",
      facts,
      vitals,
      datasets
    };
  } finally {
    await db.end();
  }
}

// src/sections.ts
var CATEGORY = {
  queries: "Queries",
  tables: "Tables",
  indexes: "Indexes",
  schema: "Schema",
  blocking: "Locks & transactions",
  connections: "Connections",
  replication: "Replication & WAL",
  backups: "Backups & recovery",
  vacuum: "Vacuum & bloat",
  config: "Configuration",
  capacity: "Capacity & scaling",
  logs: "Logs & activity",
  security: "Security",
  extensions: "Extensions"
};

// src/checkdef.ts
var pl = (n, one2, many) => n === 1 ? one2 : many;
var top = (rows3, n = 10) => rows3.slice(0, n);
var GB = 1024 ** 3;
var MB = 1024 ** 2;

// src/checks_a.ts
var num = (v) => Number(v ?? 0);
var age = (iso) => iso ? (Date.now() - new Date(String(iso)).getTime()) / 1e3 : Infinity;
var CHECKS_A = [
  // ───────── Queries
  {
    id: "queries.no_pgss",
    section: "queries",
    title: "Query statistics are collected",
    looks: "Whether pg_stat_statements is installed.",
    flags: "Info when it is missing.",
    run: ({ d }) => d.q_total?.note ? {
      severity: "info",
      title: "pg_stat_statements isn't installed",
      why: "Without it there is no per-query history to find slow or heavy statements.",
      fix: "Add it to shared_preload_libraries (restart), then CREATE EXTENSION pg_stat_statements."
    } : null
  },
  {
    id: "queries.dominant",
    section: "queries",
    title: "No single query dominates the workload",
    looks: "The share of total application query time taken by the top statement, after catalog and tooling queries are excluded.",
    flags: "Warning when one statement is 30% or more of at least 60 s of recorded application query time.",
    uses: ["q_total"],
    run: ({ ctx, rows: rows3 }) => {
      const r = rows3("q_total");
      const t = r[0];
      const minMs = ctx.opts.minWorkloadMs ?? 6e4;
      if (!t) return { note: "No application statements recorded yet." };
      if (num(t.workload_ms) < minMs) return { note: `Only ${(num(t.workload_ms) / 1e3).toFixed(1)} s of query time is recorded, too little to judge. Scan again after the database has been busy.` };
      if (num(t.pct) < 30) return null;
      return {
        severity: "warning",
        title: `One query takes ${t.pct}% of your query time`,
        why: `Of ${Math.round(num(t.workload_ms) / 1e3).toLocaleString()} s of recorded application query time, this one statement accounts for ${t.pct}% across ${num(t.calls).toLocaleString()} calls. It is the highest-leverage thing to optimise.`,
        fix: "EXPLAIN (ANALYZE, BUFFERS) it; look for seq scans, missing indexes, or N+1 call patterns.",
        evidence: top(r, 5)
      };
    }
  },
  {
    id: "queries.slow_average",
    section: "queries",
    title: "No query is slow on average",
    looks: "Statements called 5+ times whose mean time is high.",
    flags: "Warning for any averaging 1 second or more.",
    uses: ["q_mean"],
    run: ({ rows: rows3 }) => {
      const r = rows3("q_mean").filter((x) => num(x.mean_ms) >= 1e3);
      return r.length ? {
        severity: "warning",
        title: `${r.length} ${pl(r.length, "query averages", "queries average")} over 1 second`,
        why: "Slow statements trip client timeouts and hold connections.",
        fix: "Get the plan with EXPLAIN (ANALYZE, BUFFERS) and add the index or rewrite it.",
        evidence: top(r)
      } : null;
    }
  },
  {
    id: "queries.temp_spill",
    section: "queries",
    title: "Queries don't spill to disk",
    looks: "Statements writing large temp files because work_mem is exceeded.",
    flags: "Info at roughly 800 MB or more of temp writes per statement.",
    uses: ["q_temp"],
    run: ({ rows: rows3 }) => {
      const r = rows3("q_temp").filter((x) => num(x.temp_bytes) >= 8192e5);
      return r.length ? {
        severity: "info",
        title: `${r.length} ${pl(r.length, "query spills", "queries spill")} heavily to temp files`,
        why: "Sorts and hashes that exceed work_mem run much slower on disk.",
        fix: "Add an index that avoids the sort, or raise work_mem for that role, not globally.",
        evidence: top(r)
      } : null;
    }
  },
  {
    id: "queries.statements_evicted",
    section: "queries",
    title: "Query history isn't being evicted",
    looks: "Whether pg_stat_statements is dropping old statements.",
    flags: "Info when any statements were evicted.",
    uses: ["q_pgss"],
    run: ({ rows: rows3 }) => {
      const r = rows3("q_pgss")[0];
      return r && num(r.dealloc) > 0 ? {
        severity: "info",
        title: `${num(r.dealloc).toLocaleString()} statements were evicted from tracking`,
        why: "The tracking table is full, so rarely-run queries lose their history.",
        fix: "Raise pg_stat_statements.max (needs a restart).",
        evidence: r
      } : null;
    }
  },
  // ───────── Tables
  {
    id: "tables.seq_scans",
    section: "tables",
    title: "Large tables are read via indexes",
    looks: "Tables over 50,000 rows read mostly by sequential scan.",
    flags: "Warning when seq scans exceed 100 and 5x the index scans.",
    uses: ["t_seq"],
    run: ({ rows: rows3 }) => {
      const r = rows3("t_seq").filter((x) => num(x.live_rows) > 5e4 && num(x.seq_scan) > 100 && num(x.seq_scan) > 5 * num(x.idx_scan));
      return r.length ? {
        severity: "warning",
        title: `${r.length} large ${pl(r.length, "table is", "tables are")} mostly read by sequential scan`,
        why: "Repeated full scans of big tables drive CPU and I/O load.",
        fix: "Find the filtered columns in pg_stat_statements and test a supporting index.",
        evidence: top(r)
      } : null;
    }
  },
  // Public basis: PostgreSQL docs, "Heap-Only Tuples (HOT)" (storage-hot) and the fillfactor storage parameter (CREATE TABLE).
  {
    id: "tables.low_hot_updates",
    section: "tables",
    title: "Updates are mostly HOT",
    looks: "The share of updates done as heap-only tuple (HOT) updates on tables with many updates.",
    flags: "Info when a table with 10,000+ updates since the stats reset has under 50% HOT updates.",
    uses: ["t_churn"],
    run: (x) => {
      const r = x.rows("t_churn").filter((t) => Number(t.updates ?? 0) >= 1e4 && t.hot_pct !== null && Number(t.hot_pct) < 50);
      if (!r.length) return null;
      return {
        severity: "info",
        title: `${r.length} update-heavy ${pl(r.length, "table has", "tables have")} few HOT updates`,
        why: "An update that can't be done as a HOT update writes a new entry into every index on the table, more WAL, and more for vacuum to clean up. An update can't be HOT when it changes an indexed column or the page has no free space.",
        fix: "If the updated columns don't need an index, drop those indexes. Otherwise leave free space in each page with a lower fillfactor, such as 90. It applies to pages written from now on; VACUUM FULL or pg_repack applies it to the whole table.",
        sql: r.slice(0, 10).map((t) => `ALTER TABLE ${t.table} SET (fillfactor = 90);  -- ${Number(t.updates).toLocaleString("en-US")} updates, ${t.hot_pct}% HOT`).join("\n"),
        evidence: r.slice(0, 20).map((t) => ({ table: t.table, updates: t.updates, hot_pct: t.hot_pct }))
      };
    }
  },
  {
    id: "tables.no_primary_key",
    section: "tables",
    title: "Every table has a primary key",
    looks: "Tables without a primary key.",
    flags: "Info for a table with 1,000+ rows or over 8 MB; smaller ones are only noted.",
    uses: ["t_nopk"],
    run: ({ rows: rows3 }) => {
      const all = rows3("t_nopk");
      const r = all.filter((x) => num(x.est_rows) >= 1e3 || num(x.bytes) >= 8 * MB);
      if (r.length) return {
        severity: "info",
        title: `${r.length} ${pl(r.length, "table has", "tables have")} no primary key`,
        why: "Breaks logical replication of updates and deletes, and makes rows hard to address safely.",
        fix: "Add a primary key, or REPLICA IDENTITY FULL if the table is published.",
        evidence: top(r)
      };
      return all.length ? { note: `${all.length} small ${pl(all.length, "table", "tables")} (under 1,000 rows) ${pl(all.length, "has", "have")} no primary key: ${all.slice(0, 5).map((x) => x.table).join(", ")}.` } : null;
    }
  },
  {
    id: "tables.stale_statistics",
    section: "tables",
    title: "Planner statistics are fresh",
    looks: "Tables with many changes since the last ANALYZE.",
    flags: "Warning when 20%+ of a 10k+ row table changed and it wasn't analyzed in the last day.",
    uses: ["t_stale"],
    run: ({ rows: rows3 }) => {
      const r = rows3("t_stale").filter((x) => num(x.live_rows) >= 1e4 && num(x.mod_pct) >= 20 && age(x.last_analyzed) > 86400);
      return r.length ? {
        severity: "warning",
        title: `${r.length} ${pl(r.length, "table has", "tables have")} stale planner statistics`,
        why: "The planner picks bad plans when its statistics no longer match the data.",
        fix: "Run ANALYZE on them, and lower autovacuum_analyze_scale_factor on hot tables.",
        evidence: top(r)
      } : null;
    }
  },
  {
    id: "tables.bloat",
    section: "tables",
    title: "Tables aren't bloated",
    looks: "Measured wasted space in the largest tables (needs pgstattuple).",
    flags: "Warning at 40%+ bloat when the waste is at least 5% of the database (never under 8 MB, never required above 100 MB); critical at 60%+ when it is 1 GB or a fifth of the database.",
    uses: ["t_bloat", "cfg_version"],
    run: ({ ctx, rows: rows3 }) => {
      const db = num(rows3("cfg_version")[0]?.db_bytes);
      const min = ctx.opts.minBloatBytes ?? Math.max(8 * MB, Math.min(100 * MB, 0.05 * db));
      const r = rows3("t_bloat").filter((x) => num(x.bloat_pct) >= 40 && num(x.wasted_bytes) >= min);
      if (!r.length) return null;
      const wasted = r.reduce((a, x) => a + num(x.wasted_bytes), 0);
      const crit = r.some((x) => num(x.bloat_pct) >= 60 && (num(x.wasted_bytes) >= GB || db > 0 && num(x.wasted_bytes) >= 0.2 * db));
      return {
        severity: crit ? "critical" : "warning",
        title: `${r.length} ${pl(r.length, "table is", "tables are")} heavily bloated (${Math.round(wasted / MB).toLocaleString()} MB wasted${db ? `, ${Math.round(100 * wasted / db)}% of the database` : ""})`,
        why: "Wasted space slows scans, bloats caches and wastes disk.",
        fix: "Fix what blocks vacuum, then reclaim space with pg_repack (avoid VACUUM FULL on live tables).",
        evidence: top(r)
      };
    }
  },
  // ───────── Indexes
  {
    id: "indexes.invalid",
    section: "indexes",
    title: "No invalid indexes",
    looks: "Indexes left invalid by a failed CREATE INDEX CONCURRENTLY.",
    flags: "Warning for any.",
    uses: ["i_invalid"],
    run: ({ rows: rows3 }) => {
      const r = rows3("i_invalid");
      return r.length ? {
        severity: "warning",
        title: `${r.length} invalid ${pl(r.length, "index", "indexes")}`,
        why: "It costs writes but is never used for reads.",
        fix: "DROP INDEX CONCURRENTLY it and recreate.",
        evidence: r
      } : null;
    }
  },
  {
    id: "indexes.unused",
    section: "indexes",
    title: "No large unused indexes",
    looks: "Indexes over 8 MB that were never scanned since the stats reset.",
    flags: "Info for any.",
    uses: ["i_unused"],
    run: ({ rows: rows3 }) => {
      const r = rows3("i_unused").filter((x) => num(x.bytes) > 8 * MB);
      return r.length ? {
        severity: "info",
        title: `${r.length} large ${pl(r.length, "index was", "indexes were")} never used`,
        why: "Unused indexes slow every write and take disk and cache.",
        fix: "Confirm the stats cover a full business cycle (and replicas), then DROP INDEX CONCURRENTLY.",
        evidence: top(r)
      } : null;
    }
  },
  {
    id: "indexes.duplicate",
    section: "indexes",
    title: "No duplicate indexes",
    looks: "Identical indexes on the same table.",
    flags: "Info when they waste 1 MB or more; warning at 100 MB. Smaller ones are only noted.",
    uses: ["i_dup"],
    run: ({ rows: rows3 }) => {
      const all = rows3("i_dup");
      if (!all.length) return null;
      const waste = all.reduce((n, x) => n + num(x.bytes) * (1 - 1 / num(x.copies)), 0);
      if (waste < MB) return { note: `${all.length} ${pl(all.length, "set", "sets")} of duplicate indexes on tiny tables (${Math.round(waste / 1024)} KB wasted): ${all.slice(0, 3).map((x) => x.indexes).join("; ")}.` };
      return { severity: waste >= 100 * MB ? "warning" : "info", title: `${all.length} ${pl(all.length, "set", "sets")} of duplicate indexes (${Math.round(waste / MB)} MB wasted)`, why: "Each copy doubles the write cost for no read benefit.", fix: "Keep one, the primary key or unique one if there is such a one, and DROP INDEX CONCURRENTLY the others after checking that no constraint, replication setup or maintenance script refers to them by name.", evidence: top(all) };
    }
  },
  {
    id: "indexes.redundant",
    section: "indexes",
    title: "No redundant (prefix) indexes",
    looks: "Non-unique indexes that are the leading columns of a longer index.",
    flags: "Info when the redundant index is 1 MB or more; smaller ones are only noted.",
    uses: ["i_redundant"],
    run: ({ rows: rows3 }) => {
      const all = rows3("i_redundant");
      const r = all.filter((x) => num(x.bytes) >= MB);
      if (r.length) return { severity: "info", title: `${r.length} redundant ${pl(r.length, "index", "indexes")}`, why: "A longer index on the same columns already serves those queries.", fix: "Drop the shorter index after checking it isn't required by a constraint.", evidence: top(r) };
      return all.length ? { note: `${all.length} redundant ${pl(all.length, "index", "indexes")} on tiny tables (under 1 MB each): ${all.slice(0, 3).map((x) => x.redundant).join(", ")}. Not worth acting on yet.` } : null;
    }
  },
  {
    id: "indexes.fk_without_index",
    section: "indexes",
    title: "Foreign keys are indexed",
    looks: "Foreign-key columns with no supporting index.",
    flags: "Warning when a referencing table has 10k+ rows; info at 1,000+. Smaller tables are only noted.",
    uses: ["i_fk"],
    run: ({ rows: rows3 }) => {
      const all = rows3("i_fk");
      const r = all.filter((x) => num(x.est_rows) >= 1e3);
      if (r.length) return {
        severity: r.some((x) => num(x.est_rows) >= 1e4) ? "warning" : "info",
        title: `${r.length} foreign ${pl(r.length, "key has", "keys have")} no supporting index`,
        why: "Deleting or updating a referenced row scans the whole referencing table and can hold locks.",
        fix: "CREATE INDEX CONCURRENTLY on the referencing columns, largest tables first.",
        evidence: top(r)
      };
      return all.length ? { note: `${all.length} foreign ${pl(all.length, "key", "keys")} on small tables (under 1,000 rows) ${pl(all.length, "has", "have")} no index. Harmless at this size; add indexes as the tables grow.` } : null;
    }
  },
  // ───────── Schema & integrity
  {
    id: "schema.sequence_exhaustion",
    section: "schema",
    title: "Sequences are far from their maximum",
    looks: "How much of each sequence's range is used (integer keys run out at about 2.1 billion).",
    flags: "Warning at 70% used; critical at 90%.",
    uses: ["sch_seq"],
    run: ({ rows: rows3 }) => {
      const all = rows3("sch_seq");
      const readable = all.filter((x) => x.readable);
      const hot = readable.filter((x) => num(x.pct_used) >= 70 && !x.cycle);
      if (hot.length) return {
        severity: hot.some((x) => num(x.pct_used) >= 90) ? "critical" : "warning",
        title: `${hot.length} ${pl(hot.length, "sequence is", "sequences are")} running out of numbers`,
        why: "When a sequence reaches its maximum, inserts start failing.",
        fix: "Migrate the column to bigint (ALTER SEQUENCE ... AS bigint, then the column) before it fills.",
        evidence: top(hot)
      };
      const blind = all.length - readable.length;
      return blind > 0 ? { note: `Checked ${readable.length} of ${all.length} sequences. Grant SELECT on the rest to include them.` } : null;
    }
  },
  {
    id: "schema.constraints_not_validated",
    section: "schema",
    title: "Constraints are validated",
    looks: "Constraints added NOT VALID that were never validated.",
    flags: "Info for any.",
    uses: ["sch_notvalid"],
    run: ({ rows: rows3 }) => {
      const r = rows3("sch_notvalid");
      return r.length ? {
        severity: "info",
        title: `${r.length} ${pl(r.length, "constraint is", "constraints are")} not validated`,
        why: "Existing rows may still violate them; only new writes are checked.",
        fix: "Run ALTER TABLE ... VALIDATE CONSTRAINT (it takes a light lock).",
        evidence: top(r)
      } : null;
    }
  },
  {
    id: "schema.disabled_triggers",
    section: "schema",
    title: "No triggers are disabled",
    looks: "Triggers switched off.",
    flags: "Info for any.",
    uses: ["sch_triggers"],
    run: ({ rows: rows3 }) => {
      const r = rows3("sch_triggers");
      return r.length ? {
        severity: "info",
        title: `${r.length} ${pl(r.length, "trigger is", "triggers are")} disabled`,
        why: "The logic they enforce is silently skipped.",
        fix: "Re-enable with ALTER TABLE ... ENABLE TRIGGER, or drop the ones you no longer need.",
        evidence: top(r)
      } : null;
    }
  },
  // ───────── Blocked transactions
  {
    id: "blocking.lock_waits",
    section: "blocking",
    title: "Nothing is blocked on locks",
    looks: "Queries currently waiting for a lock held by another session.",
    flags: "Warning; critical if anything waits 30 s or more.",
    uses: ["b_blocked"],
    run: ({ rows: rows3 }) => {
      const r = rows3("b_blocked");
      if (!r.length) return null;
      return {
        severity: r.some((x) => num(x.waiting_s) >= 30) ? "critical" : "warning",
        title: `${r.length} ${pl(r.length, "query is", "queries are")} blocked on locks`,
        why: "Blocked queries pile up and can exhaust connections.",
        fix: "Inspect the blocking PID; pg_cancel_backend it if safe, and use lock_timeout in migrations.",
        evidence: top(r)
      };
    }
  },
  {
    id: "blocking.idle_in_transaction",
    section: "blocking",
    title: "No sessions idle in a transaction",
    looks: "Sessions that opened a transaction and went quiet.",
    flags: "Warning at 5 minutes idle.",
    uses: ["b_idle"],
    run: ({ ctx, rows: rows3 }) => {
      const min = ctx.opts.idleTxnSeconds ?? 300;
      const r = rows3("b_idle").filter((x) => num(x.idle_s) >= min);
      return r.length ? {
        severity: "warning",
        title: `${r.length} ${pl(r.length, "session is", "sessions are")} idle in a transaction`,
        why: "They hold locks and pin the vacuum horizon for the whole database.",
        fix: "Find the client that forgot to COMMIT, and set idle_in_transaction_session_timeout.",
        evidence: top(r)
      } : null;
    }
  },
  {
    id: "blocking.long_running_queries",
    section: "blocking",
    title: "No very long-running queries",
    looks: "Statements that have been executing for a long time.",
    flags: "Info at 5 minutes; warning at 30 minutes.",
    uses: ["b_running"],
    run: ({ rows: rows3 }) => {
      const r = rows3("b_running").filter((x) => num(x.running_s) >= 300);
      if (!r.length) return null;
      return {
        severity: r.some((x) => num(x.running_s) >= 1800) ? "warning" : "info",
        title: `${r.length} ${pl(r.length, "query has", "queries have")} been running over 5 minutes`,
        why: "Long statements hold snapshots (blocking vacuum) and resources.",
        fix: "Confirm they are expected; otherwise pg_cancel_backend and add a statement_timeout.",
        evidence: top(r)
      };
    }
  },
  {
    id: "blocking.prepared_transactions",
    section: "blocking",
    title: "No stuck prepared transactions",
    looks: "Two-phase-commit transactions left prepared.",
    flags: "Warning after 5 minutes; critical after 1 hour.",
    uses: ["b_prepared"],
    run: ({ rows: rows3 }) => {
      const r = rows3("b_prepared").filter((x) => num(x.age_s) >= 300);
      if (!r.length) return null;
      return {
        severity: r.some((x) => num(x.age_s) >= 3600) ? "critical" : "warning",
        title: `${r.length} prepared ${pl(r.length, "transaction is", "transactions are")} stuck`,
        why: "They hold locks and block vacuum until resolved.",
        fix: "COMMIT PREPARED or ROLLBACK PREPARED, then fix the transaction manager that lost them.",
        evidence: r
      };
    }
  },
  {
    id: "blocking.vacuum_horizon",
    section: "blocking",
    title: "Nothing is holding back vacuum",
    looks: "The oldest xmin held by a session, slot, prepared transaction or standby.",
    flags: "Warning at 10 million transactions old; critical at 100 million.",
    uses: ["b_xmin"],
    run: ({ rows: rows3 }) => {
      const r = rows3("b_xmin");
      const t = r[0];
      if (!t || num(t.xmin_age) < 1e7) return null;
      return {
        severity: num(t.xmin_age) >= 1e8 ? "critical" : "warning",
        title: `${t.holder} is holding back vacuum (${num(t.xmin_age).toLocaleString()} transactions old)`,
        why: "Dead rows newer than it can't be removed anywhere in the database.",
        fix: "End or fix the oldest holder: close the session, drop the stale slot, or resolve the prepared transaction.",
        evidence: top(r, 5)
      };
    }
  },
  // ───────── Connections
  {
    id: "connections.saturation",
    section: "connections",
    title: "Connections are below the limit",
    looks: "Client connections as a share of max_connections.",
    flags: "Warning at 80%; critical at 90%.",
    uses: ["c_limits"],
    run: ({ rows: rows3 }) => {
      const r = rows3("c_limits")[0];
      if (!r || num(r.used_pct) < 80) return null;
      return {
        severity: num(r.used_pct) >= 90 ? "critical" : "warning",
        title: `Connections at ${r.used_pct}% of the limit (${r.in_use}/${r.max_connections})`,
        why: "At 100% new clients get 'too many clients' errors.",
        fix: "Put a pooler (PgBouncer, pgcat) in transaction mode in front and cap app pool sizes.",
        evidence: r
      };
    }
  },
  {
    id: "connections.idle_sessions",
    section: "connections",
    title: "Idle connections are under control",
    looks: "Many mostly-idle connections.",
    flags: "Info at 50+ idle and 40%+ of max_connections.",
    uses: ["c_limits"],
    run: ({ rows: rows3 }) => {
      const r = rows3("c_limits")[0];
      if (!r || num(r.idle) < 50 || num(r.idle) < 0.4 * num(r.max_connections)) return null;
      return {
        severity: "info",
        title: `${r.idle} idle connections (${Math.round(100 * num(r.idle) / num(r.max_connections))}% of the limit)`,
        why: "Idle connections still use memory and count against max_connections.",
        fix: "Use a pooler and shrink application pool sizes.",
        evidence: r
      };
    }
  },
  {
    id: "connections.plaintext_sessions",
    section: "connections",
    title: "Remote clients use TLS",
    looks: "Remote sessions connected without encryption (excludes this scan and provider services).",
    flags: "Warning for any.",
    uses: ["c_ssl"],
    run: ({ rows: rows3 }) => {
      const r = rows3("c_ssl").filter((x) => x.remote && !x.encrypted);
      const n = r.reduce((a, x) => a + num(x.sessions), 0);
      return n ? {
        severity: "warning",
        title: `${n} remote ${pl(n, "connection isn't", "connections aren't")} using TLS`,
        why: "Credentials and data cross the network unencrypted.",
        fix: "Require TLS (hostssl in pg_hba.conf, or your provider's enforce-SSL setting) and use sslmode=require.",
        evidence: r
      } : null;
    }
  },
  {
    id: "connections.server_accepts_plaintext",
    section: "connections",
    title: "The server enforces TLS",
    looks: "Whether this scan could only connect without TLS.",
    flags: "Warning when a remote server accepted an unencrypted connection.",
    run: ({ ctx }) => ctx.local || ctx.tls ? null : {
      severity: "warning",
      title: "The database accepted an unencrypted connection",
      why: "Credentials and data can cross the network in clear text.",
      fix: "Enforce TLS at the server or provider, and use sslmode=require in clients."
    }
  }
];

// src/checks_b.ts
var num2 = (v) => Number(v ?? 0);
var ts = (v) => v ? new Date(String(v)).getTime() : 0;
var EOL = { 12: "2024-11-21", 13: "2025-11-13", 14: "2026-11-12", 15: "2027-11-11", 16: "2028-11-09", 17: "2029-11-08", 18: "2030-11-14" };
function eolStatus(versionNum, now = Date.now()) {
  const major2 = Math.floor(versionNum / 1e4);
  const date = major2 <= 11 ? "2023-11-09" : EOL[major2];
  if (!date) return { major: major2, date: null, daysLeft: null };
  return { major: major2, date, daysLeft: Math.floor((new Date(date).getTime() - now) / 864e5) };
}
var CHECKS_B = [
  // ───────── Replication & WAL
  {
    id: "replication.bad_slots",
    section: "replication",
    title: "Replication slots are healthy",
    looks: "Inactive or lost replication slots that pin WAL.",
    flags: "Warning; critical if a slot is lost or retains 5 GB+.",
    uses: ["r_slots"],
    run: ({ ctx, rows: rows3 }) => {
      const r = rows3("r_slots").filter((x) => !ctx.profile.internalSlots.includes(String(x.slot))).filter((x) => !x.active || x.status === "unreserved" || x.status === "lost");
      if (!r.length) return null;
      return {
        severity: r.some((x) => x.status === "lost" || num2(x.retained_bytes) > 5 * GB) ? "critical" : "warning",
        title: `${r.length} inactive or unhealthy replication ${pl(r.length, "slot", "slots")}`,
        why: "An inactive slot forces Postgres to keep all undelivered WAL, which can fill the disk.",
        fix: "If the consumer is gone, pg_drop_replication_slot(name). Otherwise fix the consumer, and set max_slot_wal_keep_size.",
        evidence: r
      };
    }
  },
  {
    id: "replication.standby_lag",
    section: "replication",
    title: "Standbys keep up",
    looks: "Replay lag of connected replicas.",
    flags: "Warning at 60 s or 1 GB behind; critical at 300 s or 10 GB.",
    uses: ["r_standby"],
    run: ({ rows: rows3 }) => {
      const r = rows3("r_standby").filter((x) => num2(x.replay_lag_s) >= 60 || num2(x.replay_bytes) >= GB);
      if (!r.length) return null;
      return {
        severity: r.some((x) => num2(x.replay_lag_s) >= 300 || num2(x.replay_bytes) >= 10 * GB) ? "critical" : "warning",
        title: `${r.length} ${pl(r.length, "standby is", "standbys are")} falling behind`,
        why: "Lagging replicas serve stale reads and slow failover.",
        fix: "Check replica I/O and CPU, long queries on the replica (recovery conflicts), and network throughput.",
        evidence: r
      };
    }
  },
  {
    id: "replication.slot_capacity",
    section: "replication",
    title: "Replication slots are below the limit",
    looks: "Slots in use versus max_replication_slots.",
    flags: "Warning at 80%.",
    uses: ["r_slots"],
    run: ({ rows: rows3, setting: setting2 }) => {
      const max = num2(setting2("max_replication_slots"));
      const n = rows3("r_slots").length;
      if (!max || n < 0.8 * max) return null;
      return { severity: "warning", title: `${n} of ${max} replication slots in use`, why: "At the limit, new replicas and logical subscriptions fail to start.", fix: "Drop unused slots or raise max_replication_slots (needs a restart)." };
    }
  },
  {
    id: "replication.forced_checkpoints",
    section: "replication",
    title: "Checkpoints are timed, not forced",
    looks: "Share of checkpoints forced by WAL volume.",
    flags: "Warning when over half of 50+ checkpoints are forced.",
    uses: ["r_checkpoints"],
    run: ({ rows: rows3 }) => {
      const r = rows3("r_checkpoints")[0];
      if (!r) return null;
      const total = num2(r.timed) + num2(r.requested);
      return total >= 50 && num2(r.requested) / total > 0.5 ? {
        severity: "warning",
        title: `${Math.round(100 * num2(r.requested) / total)}% of checkpoints are forced`,
        why: "WAL fills max_wal_size before the timer fires, causing I/O spikes.",
        fix: "Raise max_wal_size (often to 4-16 GB) and keep checkpoint_completion_target near 0.9.",
        evidence: r
      } : null;
    }
  },
  {
    id: "replication.wal_retention",
    section: "replication",
    title: "WAL on disk is bounded",
    looks: "The size of pg_wal versus max_wal_size.",
    flags: "Warning when pg_wal is over twice max_wal_size and 1 GB.",
    uses: ["r_waldir"],
    run: ({ rows: rows3, setting: setting2 }) => {
      const r = rows3("r_waldir")[0];
      const max = num2(setting2("max_wal_size")) * 1024 * 1024;
      if (!r || !max) return null;
      return num2(r.bytes) > 2 * max && num2(r.bytes) > GB ? {
        severity: "warning",
        title: "pg_wal is much larger than max_wal_size",
        why: "Something (slot, archiver, standby) is retaining WAL and can fill the disk.",
        fix: "Check replication slots, archive_command failures and wal_keep_size.",
        evidence: r
      } : null;
    }
  },
  {
    id: "replication.archiver_failing",
    section: "replication",
    title: "WAL archiving is working",
    looks: "The most recent archive attempt.",
    flags: "Critical when the latest attempt failed.",
    uses: ["r_archiver"],
    run: ({ rows: rows3 }) => {
      const r = rows3("r_archiver")[0];
      if (!r || num2(r.failed_count) === 0) return null;
      return ts(r.last_failed_time) > ts(r.last_archived_time) ? {
        severity: "critical",
        title: "WAL archiving is currently failing",
        why: "WAL piles up in pg_wal, and point-in-time recovery has a gap.",
        fix: "Check archive_command output in the server log and destination credentials or space.",
        evidence: r
      } : null;
    }
  },
  // ───────── Vacuum & bloat
  {
    id: "vacuum.dead_tuples",
    section: "vacuum",
    title: "Dead rows are under control",
    looks: "Tables with a large share of dead rows.",
    flags: "Warning at 20%+ (and 10k+ rows); critical at 50%+.",
    uses: ["v_dead"],
    run: ({ rows: rows3 }) => {
      const r = rows3("v_dead").filter((x) => num2(x.dead_rows) > 1e4 && num2(x.dead_pct) > 20);
      if (!r.length) return null;
      return {
        severity: r.some((x) => num2(x.dead_pct) > 50) ? "critical" : "warning",
        title: `${r.length} ${pl(r.length, "table has", "tables have")} more than 20% dead rows`,
        why: "Dead rows waste disk and slow scans; autovacuum isn't keeping up.",
        fix: "Remove vacuum blockers, lower autovacuum_vacuum_scale_factor on hot tables (e.g. 0.02), run VACUUM (VERBOSE).",
        evidence: top(r)
      };
    }
  },
  {
    id: "vacuum.autovacuum_off",
    section: "vacuum",
    title: "Autovacuum is on",
    looks: "The autovacuum setting.",
    flags: "Critical when off.",
    uses: ["cfg_safety"],
    run: ({ setting: setting2 }) => setting2("autovacuum") === "off" ? { severity: "critical", title: "Autovacuum is disabled", why: "Dead rows and XID age grow unchecked until writes halt.", fix: "Set autovacuum = on and vacuum the largest tables." } : null
  },
  {
    id: "vacuum.never_vacuumed",
    section: "vacuum",
    title: "Busy tables get vacuumed",
    looks: "Tables with lots of writes that were never vacuumed.",
    flags: "Warning for any table with 10k+ writes and no vacuum.",
    uses: ["v_never"],
    run: ({ rows: rows3 }) => {
      const r = rows3("v_never");
      return r.length ? {
        severity: "warning",
        title: `${r.length} busy ${pl(r.length, "table has", "tables have")} never been vacuumed`,
        why: "Autovacuum isn't reaching them, so dead rows and freeze debt accumulate.",
        fix: "Check autovacuum workers and per-table settings; run VACUUM (ANALYZE) manually.",
        evidence: top(r)
      } : null;
    }
  },
  {
    id: "vacuum.table_freeze_pressure",
    section: "vacuum",
    title: "Tables aren't near a forced freeze",
    looks: "Table XID age versus autovacuum_freeze_max_age.",
    flags: "Warning at 80%; critical at 95%.",
    uses: ["v_age"],
    run: ({ rows: rows3 }) => {
      const r = rows3("v_age").filter((x) => num2(x.pct) >= 80);
      if (!r.length) return null;
      return {
        severity: r.some((x) => num2(x.pct) >= 95) ? "critical" : "warning",
        title: `${r.length} ${pl(r.length, "table is", "tables are")} close to a forced anti-wraparound vacuum`,
        why: "Emergency vacuums run regardless of load and can't be cancelled.",
        fix: "Run VACUUM (FREEZE) on them in a quiet period, and clear whatever blocks vacuum.",
        evidence: top(r)
      };
    }
  },
  {
    id: "vacuum.xid_wraparound",
    section: "vacuum",
    title: "Transaction ID age is below the limit",
    looks: "The oldest transaction ID versus the ~2.1 billion limit.",
    flags: "Warning at 1.0 billion; critical at 1.5 billion.",
    uses: ["v_dbage"],
    run: ({ rows: rows3 }) => {
      const r = rows3("v_dbage");
      const w = Math.max(0, ...r.map((x) => num2(x.xid_age)));
      if (w < 1e9) return null;
      return {
        severity: w >= 15e8 ? "critical" : "warning",
        title: `Transaction ID age is ${Math.round(100 * w / 21e8)}% of the wraparound limit`,
        why: "At the limit Postgres stops accepting writes to protect data.",
        fix: "Find what blocks vacuum (old transactions, prepared transactions, stale slots), then VACUUM (FREEZE) the oldest tables.",
        evidence: top(r, 5)
      };
    }
  },
  {
    id: "vacuum.multixact_wraparound",
    section: "vacuum",
    title: "MultiXact ID age is below the limit",
    looks: "The oldest MultiXact ID versus its limit.",
    flags: "Warning at 1.0 billion; critical at 1.5 billion.",
    uses: ["v_dbage"],
    run: ({ rows: rows3 }) => {
      const r = rows3("v_dbage");
      const w = Math.max(0, ...r.map((x) => num2(x.mxid_age)));
      if (w < 1e9) return null;
      return {
        severity: w >= 15e8 ? "critical" : "warning",
        title: `MultiXact age is ${Math.round(100 * w / 21e8)}% of the limit`,
        why: "Heavy row-locking (foreign keys, SELECT FOR SHARE) consumes MultiXact IDs; running out halts writes.",
        fix: "Vacuum the oldest tables and reduce long transactions that lock many rows.",
        evidence: top(r, 5)
      };
    }
  },
  // ───────── Configuration
  {
    id: "config.fsync_off",
    section: "config",
    title: "fsync is on",
    looks: "The fsync setting.",
    flags: "Critical when off, unless the provider owns durability (Neon).",
    uses: ["cfg_safety"],
    run: ({ ctx, setting: setting2 }) => {
      if (setting2("fsync") !== "off") return null;
      const owned = ctx.profile.ownedSettings.fsync;
      if (owned) return { note: owned };
      return { severity: "critical", title: "fsync is off", why: "A crash or power loss can corrupt the whole database.", fix: "Set fsync = on. Only ever disable it for throwaway data loads." };
    }
  },
  {
    id: "config.full_page_writes_off",
    section: "config",
    title: "full_page_writes is on",
    looks: "The full_page_writes setting.",
    flags: "Critical when off, unless the provider owns durability (Neon).",
    uses: ["cfg_safety"],
    run: ({ ctx, setting: setting2 }) => {
      if (setting2("full_page_writes") !== "off") return null;
      const owned = ctx.profile.ownedSettings.full_page_writes;
      if (owned) return { note: owned };
      return { severity: "critical", title: "full_page_writes is off", why: "A crash mid-write can leave pages torn and unrecoverable.", fix: "Set full_page_writes = on unless your storage guarantees atomic 8 kB writes." };
    }
  },
  {
    id: "config.track_counts_off",
    section: "config",
    title: "Statistics collection is on",
    looks: "The track_counts setting.",
    flags: "Critical when off.",
    uses: ["cfg_safety"],
    run: ({ setting: setting2 }) => setting2("track_counts") === "off" ? { severity: "critical", title: "Statistics collection is off (track_counts)", why: "Autovacuum needs these statistics; with them off it doesn't work.", fix: "Set track_counts = on." } : null
  },
  {
    id: "config.synchronous_commit_off",
    section: "config",
    title: "Commits are durable",
    looks: "The synchronous_commit setting.",
    flags: "Info when off.",
    uses: ["cfg_safety"],
    run: ({ setting: setting2 }) => setting2("synchronous_commit") === "off" ? { severity: "info", title: "synchronous_commit is off", why: "Recent commits can be lost in a crash (typically the last fraction of a second).", fix: "Keep it off only where that trade-off is intentional; otherwise set it to on." } : null
  },
  {
    id: "config.data_checksums_off",
    section: "config",
    title: "Data checksums are enabled",
    looks: "Whether page checksums are on.",
    flags: "Info when off.",
    selfHosted: true,
    uses: ["cfg_version"],
    run: ({ rows: rows3 }) => rows3("cfg_version")[0]?.data_checksums === "off" ? { severity: "info", title: "Data checksums are off", why: "Silent storage corruption goes undetected until it is read.", fix: "Enable with pg_checksums --enable (offline) or when initializing a new cluster." } : null
  },
  {
    id: "config.shared_buffers_default",
    section: "config",
    title: "shared_buffers is tuned",
    looks: "Whether shared_buffers is still the 128 MB default on a larger database.",
    flags: "Info when default and the database is over 2 GB.",
    selfHosted: true,
    uses: ["cfg_version"],
    run: ({ rows: rows3, setting: setting2 }) => setting2("shared_buffers") === "16384" && num2(rows3("cfg_version")[0]?.db_bytes) > 2 * GB ? {
      severity: "info",
      title: "shared_buffers is at the 128 MB default",
      why: "A large database with a tiny cache reads from disk far more than needed.",
      fix: "Set shared_buffers to about 25% of RAM (restart needed)."
    } : null
  },
  {
    id: "config.work_mem_spills",
    section: "config",
    title: "work_mem suits the workload",
    looks: "Default work_mem alongside heavy temp-file use.",
    flags: "Info when work_mem is 4 MB and over 1 GB was spilled.",
    uses: ["l_db"],
    run: ({ rows: rows3, setting: setting2 }) => setting2("work_mem") === "4096" && num2(rows3("l_db")[0]?.temp_bytes) >= GB ? {
      severity: "info",
      title: "Queries spill over 1 GB to temp files with default work_mem",
      why: "Sorts and hashes are running on disk.",
      fix: "Raise work_mem for the roles that run heavy queries (not globally)."
    } : null
  },
  {
    id: "config.version_supported",
    section: "config",
    title: "PostgreSQL version is supported",
    looks: "The major version's end-of-life date.",
    flags: "Critical after end of life; warning within 180 days.",
    uses: ["cfg_version"],
    run: ({ rows: rows3 }) => {
      const v = rows3("cfg_version")[0];
      if (!v) return null;
      const s = eolStatus(num2(v.version_num));
      if (!s.date || s.daysLeft === null) return null;
      if (s.daysLeft < 0) return { severity: "critical", title: `PostgreSQL ${s.major} reached end of life on ${s.date}`, why: "It no longer receives security or bug fixes.", fix: `Plan an upgrade to a supported major version (17 or 18).`, evidence: v };
      if (s.daysLeft <= 180) return { severity: "warning", title: `PostgreSQL ${s.major} reaches end of life in ${s.daysLeft} days (${s.date})`, why: "After that date it gets no security fixes.", fix: "Schedule the upgrade now; major upgrades need testing.", evidence: v };
      return { note: `PostgreSQL ${s.major} is supported until ${s.date}.` };
    }
  },
  // ───────── Logs & activity
  {
    id: "logs.lock_waits_not_logged",
    section: "logs",
    title: "Lock waits are logged",
    looks: "The log_lock_waits setting.",
    flags: "Info when off.",
    uses: ["l_settings"],
    run: ({ setting: setting2 }) => setting2("log_lock_waits") === "off" ? { severity: "info", title: "Lock waits aren't logged (log_lock_waits = off)", why: "When queries block each other there's no log evidence afterwards.", fix: "Set log_lock_waits = on." } : null
  },
  {
    id: "logs.slow_queries_not_logged",
    section: "logs",
    title: "Slow queries are logged",
    looks: "The log_min_duration_statement setting.",
    flags: "Info when -1 (off).",
    uses: ["l_settings"],
    run: ({ setting: setting2 }) => setting2("log_min_duration_statement") === "-1" ? {
      severity: "info",
      title: "Slow queries aren't logged (log_min_duration_statement = -1)",
      why: "One-off slow statements never show up in aggregate statistics.",
      fix: "Set it to a threshold such as 1000 ms and review logs with pgBadger or your provider's viewer."
    } : null
  },
  {
    id: "logs.track_io_timing_off",
    section: "logs",
    title: "I/O timing is recorded",
    looks: "The track_io_timing setting.",
    flags: "Info when off.",
    uses: ["cfg_key"],
    run: ({ setting: setting2 }) => setting2("track_io_timing") === "off" ? { severity: "info", title: "track_io_timing is off", why: "Query I/O time can't be attributed, so disk-bound problems are harder to diagnose.", fix: "Set track_io_timing = on (small overhead on modern hardware)." } : null
  },
  {
    id: "logs.deadlocks",
    section: "logs",
    title: "No deadlocks",
    looks: "Deadlocks since the stats reset.",
    flags: "Info for any; warning at 10+.",
    uses: ["l_db"],
    run: ({ rows: rows3 }) => {
      const n = num2(rows3("l_db")[0]?.deadlocks);
      return n > 0 ? {
        severity: n >= 10 ? "warning" : "info",
        title: `${n} ${pl(n, "deadlock", "deadlocks")} since the stats reset`,
        why: "Each one aborts a transaction.",
        fix: "Take locks in a consistent order across code paths, and keep transactions short."
      } : null;
    }
  },
  {
    id: "logs.high_rollback_rate",
    section: "logs",
    title: "Rollback rate is normal",
    looks: "Rollbacks as a share of transactions.",
    flags: "Info at 20%+ (with 10k+ transactions).",
    uses: ["l_db"],
    run: ({ rows: rows3 }) => {
      const r = rows3("l_db")[0];
      return r && num2(r.rollback_pct) >= 20 && num2(r.commits) + num2(r.rollbacks) >= 1e4 ? {
        severity: "info",
        title: `${r.rollback_pct}% of transactions roll back`,
        why: "Frequent rollbacks usually mean errors or retries in the application.",
        fix: "Check the application and Postgres logs for the errors behind them."
      } : null;
    }
  },
  {
    id: "logs.checksum_failures",
    section: "logs",
    title: "No data-page checksum failures",
    looks: "Checksum failures recorded by the database.",
    flags: "Critical for any.",
    uses: ["l_db"],
    run: ({ rows: rows3 }) => num2(rows3("l_db")[0]?.checksum_failures) > 0 ? { severity: "critical", title: "Data checksum failures detected", why: "Storage returned corrupted pages.", fix: "Check hardware and storage, and restore affected data from a good backup." } : null
  },
  // ───────── Security
  {
    id: "security.privileged_roles",
    section: "security",
    title: "Few privileged login roles",
    looks: "Login roles with SUPERUSER, BYPASSRLS or REPLICATION (provider-managed roles ignored).",
    flags: "Info when there is more than one.",
    uses: ["s_roles"],
    run: ({ ctx, rows: rows3 }) => {
      const r = rows3("s_roles").filter((x) => x.login && (x.superuser || x.bypassrls || x.replication)).filter((x) => !ctx.profile.expectedAdmins.includes(String(x.role)));
      const allowance = ctx.profile.expectedAdmins.length ? 0 : 1;
      return r.length > allowance ? {
        severity: "info",
        title: `${r.length} login ${pl(r.length, "role has", "roles have")} powerful privileges beyond your admin`,
        why: "Each privileged login is a bigger blast radius if a credential leaks.",
        fix: "Keep one break-glass admin and give applications least-privilege roles.",
        evidence: r
      } : null;
    }
  },
  {
    id: "security.always_true_policies",
    section: "security",
    title: "RLS policies restrict rows",
    looks: "Policies whose gating expression is always true, split by whether they allow writes or only reads.",
    flags: "Warning when a write (INSERT, UPDATE, DELETE, ALL) policy is always true. Info when only SELECT policies are, since public read access is normal for reference data.",
    uses: ["s_policies"],
    run: ({ rows: rows3 }) => {
      const all = rows3("s_policies").filter((x) => x.always_true);
      if (!all.length) return null;
      const writes = all.filter((x) => String(x.cmd).toUpperCase() !== "SELECT"), reads = all.filter((x) => String(x.cmd).toUpperCase() === "SELECT");
      if (writes.length) return {
        severity: "warning",
        title: `${writes.length} row-level security ${pl(writes.length, "policy lets", "policies let")} anyone write every row`,
        why: `An always-true ${writes.length === 1 ? "policy" : "policy set"} on ${[...new Set(writes.map((x) => x.cmd))].join("/")} means every role the policy names can change or delete any row in the table.${reads.length ? ` ${reads.length} always-true SELECT ${pl(reads.length, "policy", "policies")} also exist (see evidence).` : ""}`,
        fix: "Replace with a real predicate (e.g. owner_id = auth.uid()) and a matching WITH CHECK, or restrict the policy to a trusted role.",
        evidence: top([...writes, ...reads])
      };
      const tables = [...new Set(reads.map((x) => x.table))];
      return {
        severity: "info",
        title: `${tables.length} ${pl(tables.length, "table is", "tables are")} readable by everyone through an always-true SELECT policy`,
        why: "That is the right setup for reference data meant to be public (catalogues, lookup lists). It is a leak if any of these tables hold per-user or internal data. Only you can tell which; the evidence lists them.",
        fix: "Confirm each table is meant to be public. For any that isn't, replace USING (true) with a predicate such as owner_id = auth.uid().",
        evidence: top(reads)
      };
    }
  },
  {
    id: "security.rls_per_row_calls",
    section: "security",
    title: "Policies avoid per-row function calls",
    looks: "Policy expressions that call a stable or volatile function in the row filter itself, outside a scalar sub-select.",
    flags: "Warning when the table has about 10,000 rows or more, info on smaller tables. Read from the expression text, so the finding is marked likely.",
    uses: ["s_policy_calls"],
    run: ({ rows: rows3 }) => {
      const cheap = /* @__PURE__ */ new Set(["now", "statement_timestamp", "transaction_timestamp", "clock_timestamp", "timeofday"]);
      const wrapped = /\(\s*SELECT\b(?![^()]*\bFROM\b)(?:[^()]|\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\))*\)/gi;
      const hits = rows3("s_policy_calls").flatMap((r) => {
        const vols = new Map(String(r.fn_vols ?? "").split(",").filter(Boolean).map((x) => [x.slice(0, x.lastIndexOf(":")), x.slice(x.lastIndexOf(":") + 1)]));
        let text = String(r.expr ?? "");
        for (let i = 0; i < 4; i++) text = text.replace(wrapped, " ");
        const names = [...new Set([...text.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)].map((m) => m[1]).filter((n) => ["s", "v"].includes(vols.get(n) ?? "i") && !cheap.has(n)))];
        return names.length ? [{ table: r.table, policy: r.policy, cmd: r.cmd, est_rows: r.est_rows, functions: names.join(", ") }] : [];
      });
      if (!hits.length) return null;
      const big = hits.filter((h) => Number(h.est_rows) >= 1e4);
      const t = new Set(hits.map((h) => h.table)).size;
      return {
        severity: big.length ? "warning" : "info",
        title: `${hits.length} row-level security ${pl(hits.length, "policy calls", "policies call")} a function once per row on ${t} ${pl(t, "table", "tables")}`,
        why: "PostgreSQL runs a stable or volatile function in a row filter once for every row it checks. Inside a scalar sub-select it runs once per query.",
        fix: "Wrap the call: USING (owner_id = (SELECT my_fn())) instead of USING (owner_id = my_fn()). EXPLAIN should then show an InitPlan.",
        evidence: top(big.length ? big : hits)
      };
    }
  },
  {
    id: "security.rls_stacked_policies",
    section: "security",
    title: "Few policies stacked per table",
    looks: "Tables where several permissive policies apply to the same role and command.",
    flags: "Info for two or more, warning for five or more on one table, role and command.",
    uses: ["s_policy_overlap"],
    run: ({ rows: rows3 }) => {
      const r = rows3("s_policy_overlap");
      if (!r.length) return null;
      const worst = Math.max(...r.map((x) => Number(x.policies)));
      return {
        severity: worst >= 5 ? "warning" : "info",
        title: `${r.length} ${pl(r.length, "table has", "tables have")} several permissive policies for the same role and command`,
        why: "Permissive policies are OR-ed together, and each one is evaluated for every row checked.",
        fix: "Merge policies for the same role and command, or limit each one with TO role.",
        evidence: top(r)
      };
    }
  },
  {
    id: "security.rls_unindexed_columns",
    section: "security",
    title: "Policy columns are indexed",
    looks: "Columns read by a policy on a table of about 10,000 rows or more with no index that starts with that column.",
    flags: "Warning for any.",
    uses: ["s_policy_unindexed"],
    run: ({ rows: rows3 }) => {
      const r = rows3("s_policy_unindexed");
      if (!r.length) return null;
      return {
        severity: "warning",
        title: `${r.length} ${pl(r.length, "column", "columns")} used in row-level security policies ${pl(r.length, "has", "have")} no index`,
        why: "A policy adds its condition to every query on the table. Without an index on the column it compares, PostgreSQL reads and tests rows.",
        fix: "Create an index on that column with CREATE INDEX CONCURRENTLY, then check the plan of a typical query.",
        sql: r.slice(0, 5).map((x) => `CREATE INDEX CONCURRENTLY ON ${x.table} (${String(x.column).replace(/"/g, '""')});`).join("\n"),
        evidence: top(r)
      };
    }
  },
  {
    id: "security.rls_policy_lookups",
    section: "security",
    title: "Policies avoid lookups in other protected tables",
    looks: "Policies that read another table that also has row-level security enabled.",
    flags: "Info for any.",
    uses: ["s_policy_lookups"],
    run: ({ rows: rows3 }) => {
      const r = rows3("s_policy_lookups").filter((x) => x.reads_rls);
      if (!r.length) return null;
      return {
        severity: "info",
        title: `${r.length} ${pl(r.length, "policy reads", "policies read")} a table that has row-level security of its own`,
        why: "The lookup runs inside every query on this table, and the other table's policies run inside the lookup.",
        fix: "Compare against a column on the same table, or use a narrow, indexed lookup function.",
        evidence: top(r)
      };
    }
  },
  {
    id: "security.definer_search_path",
    section: "security",
    title: "SECURITY DEFINER functions pin search_path",
    looks: "SECURITY DEFINER functions without a fixed search_path.",
    flags: "Warning for any.",
    uses: ["s_definer"],
    run: ({ rows: rows3 }) => {
      const r = rows3("s_definer").filter((x) => !x.search_path_set);
      return r.length ? {
        severity: "warning",
        title: `${r.length} SECURITY DEFINER ${pl(r.length, "function has", "functions have")} no fixed search_path`,
        why: "A caller can shadow objects the function uses and run code with the owner's privileges.",
        fix: "ALTER FUNCTION ... SET search_path = '' (and schema-qualify names inside).",
        evidence: top(r)
      } : null;
    }
  },
  {
    id: "security.rls_exposure",
    section: "security",
    title: "Public tables are protected by RLS",
    looks: "Public-schema tables the anon role can read with row-level security off.",
    flags: "Critical for any (Supabase).",
    providers: ["supabase"],
    uses: ["s_exposure"],
    run: ({ rows: rows3 }) => {
      const r = rows3("s_exposure");
      return r.length ? {
        severity: "critical",
        title: `${r.length} public ${pl(r.length, "table is", "tables are")} readable by anyone with the anon key`,
        why: "With RLS off, the public API returns every row of these tables.",
        fix: "ALTER TABLE ... ENABLE ROW LEVEL SECURITY and add policies, or revoke access from anon.",
        evidence: top(r)
      } : null;
    }
  },
  {
    id: "security.trust_auth",
    section: "security",
    title: "No passwordless remote access",
    looks: "pg_hba.conf rules using 'trust' for non-local addresses (needs access to the hba view).",
    flags: "Critical for any.",
    selfHosted: true,
    uses: ["s_hba"],
    run: ({ rows: rows3 }) => {
      const r = rows3("s_hba").filter((x) => x.method === "trust" && x.address && !["127.0.0.1", "::1"].includes(String(x.address)));
      return r.length ? {
        severity: "critical",
        title: `${r.length} pg_hba rule${r.length > 1 ? "s allow" : " allows"} remote connections without a password`,
        why: "Anyone who can reach the server on those addresses can log in.",
        fix: "Replace 'trust' with scram-sha-256 and reload.",
        evidence: r
      } : null;
    }
  },
  {
    id: "security.password_encryption",
    section: "security",
    title: "Passwords are hashed with SCRAM",
    looks: "The password_encryption setting.",
    flags: "Warning when md5.",
    uses: ["cfg_safety"],
    run: ({ setting: setting2 }) => setting2("password_encryption") === "md5" ? { severity: "warning", title: "New passwords are hashed with md5", why: "md5 hashes are weak and can be replayed if the hash leaks.", fix: "Set password_encryption = scram-sha-256 and reset role passwords." } : null
  },
  {
    id: "security.ssl_disabled",
    section: "security",
    title: "TLS is enabled on the server",
    looks: "The ssl setting.",
    flags: "Warning when off.",
    selfHosted: true,
    uses: ["cfg_safety"],
    run: ({ setting: setting2 }) => setting2("ssl") === "off" ? { severity: "warning", title: "TLS is disabled on the server", why: "Clients can't encrypt their connections.", fix: "Configure ssl_cert_file and ssl_key_file, set ssl = on, and require TLS in pg_hba.conf." } : null
  },
  {
    id: "security.public_schema_create",
    section: "security",
    title: "Public schema is locked down",
    looks: "Whether every role can create objects in the public schema (PostgreSQL 14 and earlier).",
    flags: "Warning when PUBLIC has CREATE.",
    run: ({ ctx }) => {
      if (ctx.version >= 15e4) return null;
      if (ctx.facts.publicSchemaCreate == null) return { note: "Couldn't read the privileges on the public schema." };
      return ctx.facts.publicSchemaCreate ? { severity: "warning", title: "Every role can create objects in the public schema", why: "It enables trojan-object attacks against SECURITY DEFINER code and shared schemas.", fix: "REVOKE CREATE ON SCHEMA public FROM PUBLIC." } : null;
    }
  },
  // ───────── Extensions
  {
    id: "extensions.updates_available",
    section: "extensions",
    title: "Extensions are up to date",
    looks: "Installed extensions with a newer version available.",
    flags: "Info for any.",
    uses: ["e_installed"],
    run: ({ rows: rows3 }) => {
      const r = rows3("e_installed").filter((x) => x.update);
      return r.length ? {
        severity: "info",
        title: `${r.length} ${pl(r.length, "extension has", "extensions have")} an update available`,
        why: "Updates carry bug and security fixes.",
        fix: "ALTER EXTENSION name UPDATE, after reading its release notes.",
        evidence: r
      } : null;
    }
  }
];

// src/checks_c.ts
var num3 = (v) => Number(v ?? 0);
var CHECKS_C = [
  {
    id: "backups.archiving_disabled",
    section: "backups",
    title: "WAL archiving is on (point-in-time recovery is possible)",
    looks: "archive_mode and wal_level on self-managed servers.",
    flags: "Warning at 1 GB+ (info below); off means you can only restore to the last base backup, never a point in time.",
    selfHosted: true,
    uses: ["bk_archiving", "cfg_version"],
    run: ({ rows: rows3 }) => {
      const a = rows3("bk_archiving")[0];
      const db = num3(rows3("cfg_version")[0]?.db_bytes);
      if (!a) return null;
      if (a.wal_level === "minimal") return { severity: "warning", title: "wal_level is minimal: no point-in-time recovery or replication", why: "Minimal WAL can't be archived or streamed, so the only recovery is the last full backup.", fix: "Set wal_level = replica (restart), then enable archiving with a tool such as pgBackRest.", evidence: a };
      if (a.archive_mode !== "off") return null;
      return { severity: db >= GB ? "warning" : "info", title: "WAL archiving is off", why: "You can only restore to the moment of the last base backup or dump. Everything since is lost.", fix: "Enable archive_mode with pgBackRest, WAL-G or Barman, and take a base backup. Use the Backup planner for exact steps.", evidence: a };
    }
  },
  {
    id: "backups.archive_noop",
    section: "backups",
    title: "The archive command really archives",
    looks: "An archive_command that is a no-op such as /bin/true.",
    flags: "Critical when found.",
    selfHosted: true,
    uses: ["bk_archiving"],
    run: ({ rows: rows3 }) => {
      const a = rows3("bk_archiving")[0];
      return a && String(a.tool).startsWith("no-op") ? { severity: "critical", title: "archive_command discards WAL (it always reports success)", why: "Postgres deletes each WAL segment once the command succeeds, so this silently destroys your recovery history.", fix: "Replace it with a real archiver (pgBackRest, WAL-G, Barman) that copies the file and exits non-zero on failure.", evidence: a } : null;
    }
  },
  {
    id: "backups.archive_backlog",
    section: "backups",
    title: "WAL is being archived promptly",
    looks: "How many WAL segments are waiting to be archived.",
    flags: "Warning at 10 segments behind; critical at 100.",
    selfHosted: true,
    uses: ["bk_archiving"],
    run: ({ rows: rows3 }) => {
      const a = rows3("bk_archiving")[0];
      const n = num3(a?.segments_behind);
      if (!a || a.segments_behind === null || n < 10) return null;
      return { severity: n >= 100 ? "critical" : "warning", title: `${n} WAL segments are waiting to be archived`, why: "A growing backlog fills pg_wal and widens the data you'd lose. If it fills the disk, the server shuts down.", fix: "Check the archive command's output and destination, and monitor pg_stat_archiver.", evidence: a };
    }
  },
  {
    id: "backups.archive_timeout_unset",
    section: "backups",
    title: "Data loss window is bounded (archive_timeout)",
    looks: "archive_timeout when archiving is on.",
    flags: "Info when 0 on a self-managed server.",
    selfHosted: true,
    uses: ["bk_archiving"],
    run: ({ rows: rows3 }) => {
      const a = rows3("bk_archiving")[0];
      return a && a.archive_mode !== "off" && num3(a.archive_timeout_s) === 0 ? {
        severity: "info",
        title: "archive_timeout is 0: recent transactions can sit unarchived indefinitely",
        why: "A WAL segment is only archived when it fills. On a quiet system your last changes may not be in the archive for hours.",
        fix: "Set archive_timeout to 60-300 seconds to bound how much you could lose.",
        evidence: a
      } : null;
    }
  },
  {
    id: "backups.replicas_not_backups",
    section: "backups",
    title: "Replicas aren't your only protection",
    looks: "Standbys present while WAL archiving is off.",
    flags: "Warning when replicas exist but nothing is archived.",
    selfHosted: true,
    uses: ["r_standby", "bk_archiving"],
    run: ({ rows: rows3 }) => {
      const s = rows3("r_standby");
      const a = rows3("bk_archiving")[0];
      return s.length && a?.archive_mode === "off" ? {
        severity: "warning",
        title: `${s.length} ${pl(s.length, "replica", "replicas")} but no backup archive`,
        why: "A replica copies mistakes too: a DROP TABLE or a bad UPDATE reaches it within seconds. Replicas protect against hardware failure, not human error.",
        fix: "Add WAL archiving and scheduled base backups on top of replication.",
        evidence: top(s, 5)
      } : null;
    }
  },
  {
    id: "backups.unprotected_objects",
    section: "backups",
    title: "Nothing important sits outside physical backups",
    looks: "Unlogged tables and custom tablespaces.",
    flags: "Info for any.",
    uses: ["bk_unprotected"],
    run: ({ rows: rows3 }) => {
      const r = rows3("bk_unprotected").filter((x) => x.kind === "Unlogged table" || x.kind === "Tablespace");
      return r.length ? {
        severity: "info",
        title: `${r.length} ${pl(r.length, "object isn't", "objects aren't")} fully covered by backups`,
        why: "Unlogged tables are empty after point-in-time recovery, and tablespaces need special handling in dumps and restores.",
        fix: "Make important unlogged tables regular tables, and include tablespaces in your backup and restore procedure.",
        evidence: r
      } : null;
    }
  },
  {
    id: "backups.provider_managed",
    section: "backups",
    title: "Provider backups are configured",
    looks: "Reminds you what your provider covers (this can't be verified from SQL).",
    flags: "Never flags; shows what to confirm in your provider's dashboard.",
    providers: ["supabase", "neon"],
    run: ({ ctx }) => ({ note: ctx.profile.id === "supabase" ? "Supabase takes daily backups (Pro 7 days, Team 14, Enterprise 30) and offers PITR as an add-on. With PITR on, downloadable logical backups stop, so keep your own pg_dump. Confirm the schedule in your dashboard." : "Neon has no traditional backups: instant restore (PITR) works inside your plan's history window. Confirm the window for your plan, and keep periodic pg_dump copies too." })
  }
];

// src/checks_d.ts
var num4 = (v) => Number(v ?? 0);
var gb = (n) => n >= GB ? `${(n / GB).toFixed(n >= 10 * GB ? 0 : 1)} GB` : `${Math.round(n / 1024 ** 2)} MB`;
var HOUR_MS_WINDOW = 1800;
var UP = {
  supabase: "In the Supabase dashboard, open Project Settings, then Compute and Disk, and pick a larger compute size.",
  neon: "In the Neon console, raise the autoscaling maximum for this endpoint, or choose a larger fixed compute.",
  generic: "Move to an instance with more memory and vCPUs. On RDS or Cloud SQL that means changing the instance class, which restarts or fails over briefly."
};
var OUT = {
  supabase: "Add a read replica from the dashboard and send read-only traffic to it.",
  neon: "Add a read replica compute and point read-only traffic at it.",
  generic: "Add a streaming replica and route read-only queries to it (from the application or a pooler)."
};
var provider = (x) => x.ctx.profile.id in UP ? x.ctx.profile.id : "generic";
function waitShare(x, type) {
  const active = Math.max(0, num4(x.rows("c_limits")[0]?.active) - 1);
  const n = x.rows("c_waits").filter((r) => r.type === type).reduce((a, r) => a + num4(r.sessions), 0);
  return { share: active ? n / active : 0, active, n };
}
var CHECKS_D = [
  {
    id: "capacity.working_set",
    section: "capacity",
    title: "The working data fits in memory",
    looks: "Database size against shared_buffers / effective_cache_size, and the share of reads served from cache.",
    flags: "Warning when data is over twice the memory and the cache hit rate is under 97%; info under 99%.",
    uses: ["cap_sizing", "cap_load"],
    run: (x) => {
      const s = x.rows("cap_sizing")[0], l = x.rows("cap_load")[0];
      if (!s || !l || l.cache_hit_pct === null || num4(l.window_s) < HOUR_MS_WINDOW) return null;
      const mem = Math.max(num4(s.shared_buffers_bytes), num4(s.effective_cache_bytes)), db = num4(s.db_bytes), hit = num4(l.cache_hit_pct);
      if (db < 2 * mem || hit >= 99) return null;
      return {
        severity: hit < 97 ? "warning" : "info",
        title: `Data (${gb(db)}) is much larger than memory (${gb(mem)}), and ${(100 - hit).toFixed(1)}% of reads go to disk`,
        why: "Reads that miss the cache wait on storage. As the data grows past memory, latency rises and disk I/O becomes the limit.",
        fix: `Tune first: drop unused indexes and add missing ones so fewer pages are read, and check the largest queries in Queries. Then scale up memory. ${UP[provider(x)]}`,
        evidence: { db_bytes: db, shared_buffers_bytes: num4(s.shared_buffers_bytes), effective_cache_bytes: num4(s.effective_cache_bytes), cache_hit_pct: hit, disk_read_bps: num4(l.disk_read_bps) }
      };
    }
  },
  {
    id: "capacity.io_wait",
    section: "capacity",
    title: "Sessions aren't waiting on disk",
    looks: "The share of currently active sessions waiting on I/O, from a wait-event snapshot.",
    flags: "Warning when 40% or more of at least 3 active sessions wait on I/O.",
    uses: ["c_waits", "c_limits"],
    run: (x) => {
      const w = waitShare(x, "IO");
      if (w.active < 3 || w.share < 0.4) return null;
      return {
        severity: "warning",
        title: `${w.n} of ${w.active} active sessions are waiting on disk I/O`,
        why: "This is a snapshot, so run the checkup again a few times to confirm. If it keeps showing, storage speed (IOPS or throughput) is the limit, not the queries' CPU.",
        fix: `Tune first: find the queries reading the most from disk (Queries) and index them. Then move to faster or larger storage (more provisioned IOPS, or a bigger instance which usually brings more). ${UP[provider(x)]}`,
        evidence: x.rows("c_waits").filter((r) => r.type === "IO")
      };
    }
  },
  {
    id: "capacity.cpu_bound",
    section: "capacity",
    title: "Active sessions aren't all on CPU",
    looks: "Active sessions that are running (no wait event) against max_connections, from a snapshot.",
    flags: "Info when at least 8 sessions, and a quarter of max_connections, are running on CPU together.",
    uses: ["c_waits", "c_limits"],
    run: (x) => {
      const w = waitShare(x, "Running on CPU"), max = num4(x.rows("c_limits")[0]?.max_connections);
      if (w.n < 8 || w.n < 0.25 * max || w.share < 0.6) return null;
      return {
        severity: "info",
        title: `${w.n} sessions are running on CPU at the same moment`,
        why: "Many queries executing at once compete for the same cores. If the host's CPU is also near 100% (check your provider's metrics, SQL can't see it), the server is CPU-bound.",
        fix: `Tune first: the top statements in Queries usually account for most of the CPU. If they are already efficient, scale up vCPUs. ${UP[provider(x)]}`,
        evidence: x.rows("c_waits").slice(0, 5)
      };
    }
  },
  {
    id: "capacity.temp_spill",
    section: "capacity",
    title: "Queries aren't spilling to temp files heavily",
    looks: "Temp file volume per hour since the last statistics reset.",
    flags: "Info at 1 GB per hour or more; warning at 5 GB.",
    uses: ["cap_load"],
    run: (x) => {
      const l = x.rows("cap_load")[0];
      const perHour = num4(l?.temp_bytes_per_hour);
      if (!l || num4(l.window_s) < HOUR_MS_WINDOW || perHour < GB) return null;
      return {
        severity: perHour >= 5 * GB ? "warning" : "info",
        title: `About ${gb(perHour)} of temp files are written per hour`,
        why: "Sorts and hash joins that don't fit in work_mem go to disk, which is far slower than memory and adds write load.",
        fix: `Tune first: raise work_mem for the roles running the big reports (alter role reporting set work_mem = '128MB'), and look at q_temp in Queries. If that isn't enough, add memory. ${UP[provider(x)]}`,
        evidence: l
      };
    }
  },
  {
    id: "capacity.read_replica",
    section: "capacity",
    title: "Reads and writes are balanced, or there is a replica",
    looks: "Read-to-write row ratio, when the database is also showing memory, disk or CPU pressure and has no replica.",
    flags: "Info when reads are 5 times writes (or more), pressure signals are present, and no standby is attached.",
    uses: ["cap_load", "c_waits", "c_limits"],
    run: (x) => {
      const l = x.rows("cap_load")[0];
      if (!l || num4(l.window_s) < HOUR_MS_WINDOW || x.rows("r_standby").length) return null;
      const ratio = num4(l.tup_read) / Math.max(1, num4(l.tup_written));
      const pressure = l.cache_hit_pct !== null && num4(l.cache_hit_pct) < 99 || waitShare(x, "IO").share >= 0.4 || waitShare(x, "Running on CPU").n >= 8;
      if (ratio < 5 || !pressure) return null;
      return {
        severity: "info",
        title: `Reads outnumber writes ${Math.round(ratio)} to 1, with no replica to share the load`,
        why: "A read-heavy workload under pressure is where scaling out helps most: a replica serves reports and dashboards without touching the primary. It does nothing for writes, so if writes are the limit, a bigger primary is the answer.",
        fix: `Tune first (indexes, caching in the application). Then scale out. ${OUT[provider(x)]} Keep the primary for writes and for reads that must be current.`,
        evidence: { rows_read: num4(l.tup_read), rows_written: num4(l.tup_written), ratio: Math.round(ratio) }
      };
    }
  },
  {
    id: "capacity.large_table",
    section: "capacity",
    title: "No single table dominates the database",
    looks: "The largest table's size and its share of the database.",
    flags: "Info at 100 GB, or 20 GB when it is 60% or more of the database.",
    uses: ["cap_sizing"],
    run: (x) => {
      const s = x.rows("cap_sizing")[0];
      if (!s) return null;
      const t = num4(s.largest_table_bytes), db = num4(s.db_bytes);
      if (!(t >= 100 * GB || t >= 20 * GB && t >= 0.6 * db)) return null;
      return {
        severity: "info",
        title: `One table holds ${gb(t)} (${Math.round(100 * t / Math.max(1, db))}% of the database)`,
        why: "Very large tables make vacuum, index builds, backups and restores slow, and every query on them scans more data.",
        fix: "Split it by time or key with declarative partitioning, then archive or drop old partitions instead of deleting rows. Plan it before the table doubles: moving data into partitions gets harder as it grows.",
        evidence: s
      };
    }
  },
  {
    id: "capacity.autovacuum_saturated",
    section: "capacity",
    title: "Autovacuum workers have spare capacity",
    looks: "Autovacuum workers running now against autovacuum_max_workers.",
    flags: "Info when every worker is busy at scan time.",
    uses: ["cap_workers"],
    run: (x) => {
      const w = x.rows("cap_workers")[0];
      if (!w || num4(w.max_workers) < 1 || num4(w.running) < num4(w.max_workers)) return null;
      return {
        severity: "info",
        title: `All ${num4(w.max_workers)} autovacuum ${pl(num4(w.max_workers), "worker is", "workers are")} busy right now`,
        why: "When every worker is occupied, other tables wait for their turn. It's a snapshot, but if it keeps showing, cleanup is falling behind the write rate.",
        fix: "Tune first: raise autovacuum_max_workers (restart needed) and autovacuum_vacuum_cost_limit, and lower the scale factor on the biggest tables. If vacuum is still I/O-bound after that, storage is the limit.",
        evidence: w
      };
    }
  },
  // Disk: what SQL can and cannot see
  {
    id: "capacity.footprint",
    section: "capacity",
    title: "Footprint on disk is known",
    looks: "This database, the other databases on the server and WAL, added up. Postgres cannot see the volume's size or free space.",
    flags: "Never flags on its own. Warning when WAL alone is over half the size of the data, which usually means retention is stuck. The total is for you to compare with your volume.",
    uses: ["cap_footprint"],
    run: (x) => {
      const f = x.rows("cap_footprint")[0];
      if (!f) return null;
      const db = num4(f.db_bytes), other = num4(f.other_dbs_bytes), wal = num4(f.wal_bytes), total = num4(f.total_bytes);
      const parts = [`this database ${gb(db)}`, other ? `other databases ${gb(other)}` : "", `WAL ${gb(wal)}`].filter(Boolean).join(", ");
      if (wal > 256 * 1024 ** 2 && wal > 0.5 * (db + other)) return {
        severity: "warning",
        title: `WAL takes ${gb(wal)} on disk, more than half the size of the data`,
        why: "WAL should recycle at around max_wal_size. When it keeps growing, a replication slot, a failing archiver or a stalled standby is pinning it, and it will fill the volume.",
        fix: "Look at Replication & WAL: inactive slots, archiver failures and wal_keep_size. The footprint here is at least " + gb(total) + ".",
        evidence: f
      };
      const temp = num4(f.window_s) >= 3600 ? ` and temp files (about ${gb(num4(f.temp_bytes_per_day))}/day)` : "";
      return { note: `At least ${gb(total)} on the volume (${parts}), plus logs${temp}. Free space isn't visible from SQL: compare with your host or provider metrics.` };
    }
  },
  // pg_net
  {
    id: "extensions.pg_net_responses",
    section: "extensions",
    title: "pg_net's response table is kept small",
    looks: "The size and dead-row share of net._http_response, and how many requests are waiting in net.http_request_queue.",
    flags: "Warning when the response table is over 100 MB, or over 10 MB with more dead than live rows; critical at 1 GB. Warning when 1,000+ requests are queued.",
    uses: ["net_queue"],
    run: (x) => {
      const q = x.rows("net_queue")[0];
      if (!q) return null;
      const bytes = num4(q.response_bytes), live = num4(q.response_rows), dead = num4(q.response_dead_rows), queued = num4(q.queued);
      if (queued >= 1e3) return {
        severity: queued >= 1e4 ? "critical" : "warning",
        title: `${queued.toLocaleString()} pg_net requests are waiting to be sent`,
        why: "The pg_net background worker sends requests from this queue in batches. A backlog means webhooks and edge-function calls are going out late, or not at all if the worker has stopped.",
        fix: "Check that the worker is running (select * from pg_stat_activity where backend_type like '%pg_net%'), raise pg_net.batch_size if it is simply behind, and look for a slow or unreachable destination.",
        evidence: q
      };
      const bloated = bytes >= 10 * 1024 ** 2 && dead > live;
      if (bytes < 100 * 1024 ** 2 && !bloated) return null;
      return {
        severity: bytes >= GB ? "critical" : "warning",
        title: `pg_net's response table is ${gb(bytes)}${bloated ? ` and mostly dead rows (${dead.toLocaleString()} dead, ${live.toLocaleString()} live)` : ""}`,
        why: "pg_net inserts a row per response and deletes rows older than pg_net.ttl (default 6 hours). With heavy webhook or trigger traffic the deletes outrun autovacuum, the table fills with dead rows, and every insert and the TTL delete itself get slower. This is one of the most common sources of unexplained disk growth on Supabase.",
        fix: "Vacuum it now, then keep it small: lower the TTL (alter role postgres set pg_net.ttl = '1 hour'; then select net.worker_restart();), or make autovacuum much more aggressive on the table.",
        sql: "-- reclaim dead rows now (does not lock out writes)\nVACUUM (VERBOSE, ANALYZE) net._http_response;\n\n-- keep fewer responses: 1 hour instead of the 6 hour default\nALTER ROLE postgres SET pg_net.ttl = '1 hour';\nSELECT net.worker_restart();\n\n-- and let autovacuum keep up with the churn\nALTER TABLE net._http_response SET (autovacuum_vacuum_scale_factor = 0.01, autovacuum_vacuum_cost_delay = 0);\n",
        evidence: q
      };
    }
  },
  // pg_cron
  {
    id: "extensions.cron_history",
    section: "extensions",
    title: "pg_cron run history is kept small",
    looks: "The size of cron.job_run_details, where pg_cron logs every run.",
    flags: "Info at 100 MB; warning at 1 GB.",
    uses: ["cron_history"],
    run: (x) => {
      const h = x.rows("cron_history")[0];
      const b = num4(h?.bytes);
      if (!h || b < 100 * 1024 ** 2) return null;
      return {
        severity: b >= GB ? "warning" : "info",
        title: `pg_cron's run history is ${gb(b)}`,
        why: "pg_cron logs every run and never deletes anything. A job that runs each minute adds over half a million rows a year, which slows the table and adds to backups.",
        fix: "Delete old rows and schedule a nightly cleanup with cron.schedule, or turn off logging for the busiest jobs with cron.log_run = off.",
        evidence: h
      };
    }
  },
  {
    id: "extensions.cron_failures",
    section: "extensions",
    title: "pg_cron jobs are succeeding",
    looks: "Scheduled jobs with failed runs in the last 7 days.",
    flags: "Warning when any job failed. Needs the job owner or a superuser, because pg_cron hides other roles' jobs.",
    uses: ["cron_failures"],
    run: (x) => {
      const r = x.rows("cron_failures");
      if (!r.length) return null;
      return {
        severity: "warning",
        title: `${r.length} scheduled ${pl(r.length, "job has", "jobs have")} failed runs this week`,
        why: "A failing scheduled job usually means work isn't happening: cleanups, rollups, refreshes or partition maintenance silently stop.",
        fix: "Read the latest message in the evidence, fix the job's SQL or permissions, and check its history with select * from cron.job_run_details where jobid = <id> order by start_time desc.",
        evidence: r.slice(0, 10)
      };
    }
  },
  // ── Read replicas and replication that stopped ──
  {
    id: "replication.receiver_down",
    section: "replication",
    title: "This replica is receiving WAL from its primary",
    looks: "On a standby: whether the WAL receiver is running and streaming, and how long since it heard from the primary.",
    flags: "Critical when a streaming standby has no active receiver; warning when it hasn't heard from the primary in 2 minutes.",
    uses: ["r_receiver"],
    run: (x) => {
      const r = x.rows("r_receiver")[0];
      if (!r || !r.expects_streaming) return null;
      if (num4(r.receivers) === 0 || r.status !== "streaming") return {
        severity: "critical",
        title: `This replica has stopped receiving WAL${r.status ? ` (receiver status: ${r.status})` : ""}`,
        why: "The replica is frozen at the last data it received. Reads from it are stale and growing staler, and if the primary fails now, everything since is missing.",
        fix: "Check the standby's log for the reason (network, a removed WAL segment, an authentication change, or a dropped slot). If the primary already discarded the WAL it needs, the replica must be rebuilt from a fresh base backup. On a managed provider, look at the replica's status in the dashboard and replace it if it stays broken.",
        evidence: r
      };
      if (r.secs_since_msg !== null && num4(r.secs_since_msg) > 120) return {
        severity: "warning",
        title: `No message from the primary for ${Math.round(num4(r.secs_since_msg) / 60)} minutes`,
        why: "A healthy link exchanges messages every few seconds even when nothing is being written. Silence means the connection may be half-dead.",
        fix: "Check the network path between the two servers, and wal_sender_timeout on the primary and wal_receiver_timeout here.",
        evidence: r
      };
      return null;
    }
  },
  {
    id: "replication.replay_paused",
    section: "replication",
    title: "Replay is running on this replica",
    looks: "Whether replay of received WAL is paused on a standby.",
    flags: "Warning when paused.",
    uses: ["r_receiver"],
    run: (x) => {
      const r = x.rows("r_receiver")[0];
      return r && r.paused ? {
        severity: "warning",
        title: "WAL replay is paused on this replica",
        why: "The replica keeps receiving WAL but stops applying it, so reads go stale. It's usually a maintenance step someone forgot to undo.",
        fix: "Resume it with select pg_wal_replay_resume(); once you are sure that is safe.",
        evidence: r
      } : null;
    }
  },
  {
    id: "replication.replica_backlog",
    section: "replication",
    title: "This replica applies WAL as fast as it receives it",
    looks: "WAL received but not yet applied on a standby.",
    flags: "Warning at 256 MB; critical at 2 GB.",
    uses: ["r_receiver"],
    run: (x) => {
      const r = x.rows("r_receiver")[0];
      const b = num4(r?.apply_backlog_bytes);
      if (!r || b < 256 * 1024 ** 2) return null;
      return {
        severity: b >= 2 * GB ? "critical" : "warning",
        title: `The replica has ${gb(b)} of WAL received but not applied`,
        why: "Replay is single-threaded, and it stalls behind long queries that conflict with it or a slow disk. Reads see data that is that far behind.",
        fix: "Look at recovery conflicts and long-running queries on the replica first. Then check its disk speed against the primary's, and consider a replica of the same size as the primary.",
        evidence: r
      };
    }
  },
  {
    id: "replication.recovery_conflicts",
    section: "replication",
    title: "Queries on this replica aren't being cancelled",
    looks: "Recovery conflicts recorded on a standby.",
    flags: "Warning at 5 or more cancelled queries.",
    uses: ["r_conflicts"],
    run: (x) => {
      const r = x.rows("r_conflicts")[0];
      if (!r || num4(r.total) < 5) return null;
      const top2 = ["snapshot", "lock", "bufferpin", "deadlock", "tablespace"].sort((a, b) => num4(r[b]) - num4(r[a]))[0];
      return {
        severity: "warning",
        title: `${num4(r.total)} queries on this replica were cancelled by recovery conflicts`,
        why: "Replay has to remove old row versions and take locks, and a long query on the replica can hold them up. Postgres either delays replay or cancels the query; here it cancelled.",
        fix: `Most cancellations are "${top2}". Options, each with a trade-off: raise max_standby_streaming_delay (replay waits longer, so the replica lags more); turn on hot_standby_feedback (the primary keeps old rows longer, which can bloat it); or move long analytical queries to a dedicated replica. Keep queries on the replica short where you can.`,
        evidence: r
      };
    }
  },
  {
    id: "replication.sync_standby_missing",
    section: "replication",
    title: "The synchronous standby is connected",
    looks: "synchronous_standby_names against the standbys actually connected.",
    flags: "Critical when synchronous replication is configured and no synchronous standby is connected.",
    uses: ["r_syncstandby"],
    run: (x) => {
      const r = x.rows("r_syncstandby")[0];
      const names = String(r?.names ?? "").trim();
      if (!r || !names || num4(r.connected) > 0) return null;
      if (x.ctx.profile.internalSyncStandbys.some((n) => names === n || names.includes(n))) return { note: `synchronous_standby_names is "${names}", which is the provider's own replication machinery, not a standby you run.` };
      return {
        severity: "critical",
        title: "Synchronous replication is on, but no synchronous standby is connected",
        why: "Every commit waits for a standby to confirm it. With none connected, writes hang until one returns or you change the setting, so the application looks frozen.",
        fix: "Reconnect the standby, or remove it from synchronous_standby_names (alter system set synchronous_standby_names = ''; select pg_reload_conf();) to let commits through, and accept the weaker durability until it is back.",
        evidence: r
      };
    }
  },
  {
    id: "replication.standby_state",
    section: "replication",
    title: "Connected standbys are streaming",
    looks: "The state of each standby in pg_stat_replication.",
    flags: "Warning for a standby that is not streaming and is more than 16 MB behind, or is starting or in backup.",
    uses: ["r_standby"],
    run: (x) => {
      const r = x.rows("r_standby").filter((s) => s.state !== "streaming" && (s.state !== "catchup" || num4(s.replay_bytes) > 16 * 1024 ** 2));
      if (!r.length) return null;
      return {
        severity: "warning",
        title: `${r.length} ${pl(r.length, "standby is", "standbys are")} not streaming (${[...new Set(r.map((s) => s.state))].join(", ")})`,
        why: "A standby in catch-up is still working through backlog, and one that stays there is losing the race with the primary's write rate.",
        fix: "If it doesn't reach 'streaming' soon, check its log and the primary's WAL retention (max_wal_size, wal_keep_size, or a slot) so the WAL it needs still exists.",
        evidence: r.slice(0, 5)
      };
    }
  },
  // ── Stale connections ──
  {
    id: "connections.stale_sessions",
    section: "connections",
    title: "No connections are stale",
    looks: "Sessions idle for more than 30 minutes, and the keepalive and timeout settings that would end a dead one.",
    flags: "Info at 5 or more; warning at 20 or more, or when they are hours old with keepalives at the OS default.",
    uses: ["c_stale"],
    run: (x) => {
      const rows3 = x.rows("c_stale"), n = rows3.reduce((a, r) => a + num4(r.sessions), 0), oldest = Math.max(0, ...rows3.map((r) => num4(r.oldest_idle_s)));
      if (n < 5) return null;
      const set = (name) => x.rows("c_timeouts").find((r) => r.name === name)?.setting;
      const osDefault = String(set("tcp_keepalives_idle") ?? "0") === "0";
      return {
        severity: n >= 20 || osDefault && oldest >= 4 * 3600 ? "warning" : "info",
        title: `${n} connections have been idle for over 30 minutes (longest ${oldest >= 86400 ? Math.round(oldest / 86400) + " days" : Math.round(oldest / 3600) + " hours"})`,
        why: "Idle is normal for a connection pool, but a client that crashed or lost its network leaves a session that looks identical. Postgres only notices when the operating system's keepalive fires, which defaults to two hours or more. Until then each one holds a connection slot and memory.",
        fix: "First check that they're dead, not pooled on purpose: compare with the application's pool size. Then make dead peers drop quickly: set tcp_keepalives_idle = 60, tcp_keepalives_interval = 10 and tcp_keepalives_count = 6, and on PostgreSQL 14+ set client_connection_check_interval = '10s' so running queries stop when the client has gone. Set your pool's idle timeout below the firewall's. idle_session_timeout (PostgreSQL 14+) also works, but it closes healthy idle connections too, so use it only if your clients reconnect cleanly.",
        sql: "-- self-managed servers (managed providers: set these in the dashboard's database settings)\nALTER SYSTEM SET tcp_keepalives_idle = 60;\nALTER SYSTEM SET tcp_keepalives_interval = 10;\nALTER SYSTEM SET tcp_keepalives_count = 6;\nALTER SYSTEM SET client_connection_check_interval = '10s';  -- PostgreSQL 14+\nSELECT pg_reload_conf();\n",
        evidence: rows3.slice(0, 10)
      };
    }
  }
];

// src/fixes.ts
var qi = (s) => `"${s.replace(/"/g, '""')}"`;
var one = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
var rel = (s) => {
  const t = String(s ?? "");
  const i = t.indexOf(".");
  return i > 0 && i < t.length - 1 ? `${qi(t.slice(0, i))}.${qi(t.slice(i + 1))}` : null;
};
var schemaOf = (s) => {
  const t = String(s ?? "");
  const i = t.indexOf(".");
  return i > 0 ? qi(t.slice(0, i)) : null;
};
var rows = (e) => Array.isArray(e) ? e : e ? [e] : [];
var HEAD_INDEX = "-- CREATE/DROP INDEX CONCURRENTLY cannot run inside a transaction block: run each statement on its own (psql does this by default). They also wait for open transactions to finish, so end any long or idle-in-transaction sessions first.\n";
var HEAD_LOCK = "-- Fails fast instead of queueing behind long transactions and blocking everyone else. Retry if it times out.\nSET lock_timeout = '5s';\n";
var GEN = {
  "extensions.cron_history": () => [
    "-- one-off cleanup of old run history\ndelete from cron.job_run_details where end_time < now() - interval '7 days';",
    "-- then keep it trimmed every night\nselect cron.schedule('purge-cron-history', '0 3 * * *', $$delete from cron.job_run_details where end_time < now() - interval '7 days'$$);"
  ],
  "indexes.invalid": (r) => r.flatMap((x) => {
    const t = schemaOf(x.table);
    return t && x.index ? [`DROP INDEX CONCURRENTLY IF EXISTS ${t}.${qi(String(x.index))};  -- then recreate it with CREATE INDEX CONCURRENTLY`] : [];
  }),
  "indexes.unused": (r) => r.flatMap((x) => {
    const t = schemaOf(x.table);
    return t && x.index ? [`-- undo: ${one(x.definition)}
DROP INDEX CONCURRENTLY IF EXISTS ${t}.${qi(String(x.index))};`] : [];
  }),
  "indexes.redundant": (r) => r.flatMap((x) => {
    const t = schemaOf(x.table);
    return t && x.redundant ? [`-- covered by ${one(x.covered_by)}
DROP INDEX CONCURRENTLY IF EXISTS ${t}.${qi(String(x.redundant))};`] : [];
  }),
  "indexes.duplicate": (r) => r.flatMap((x) => {
    const t = schemaOf(x.table);
    const names = String(x.indexes ?? "").split(", ").filter(Boolean);
    return t && names.length > 1 ? [`-- keeping ${one(names[0])}; if a drop fails, that index backs a constraint, so keep it and drop the other
${names.slice(1).map((n) => `DROP INDEX CONCURRENTLY IF EXISTS ${t}.${qi(n)};`).join("\n")}`] : [];
  }),
  "indexes.fk_without_index": (r) => r.flatMap((x) => {
    const t = rel(x.table);
    const m = /FOREIGN KEY \((.+?)\) REFERENCES/.exec(String(x.definition ?? ""));
    return t && m ? [`CREATE INDEX CONCURRENTLY ON ${t} (${m[1]});  -- ${one(x.constraint)}`] : [];
  }),
  "schema.constraints_not_validated": (r) => r.flatMap((x) => {
    const t = rel(x.table);
    return t && x.constraint ? [`ALTER TABLE ${t} VALIDATE CONSTRAINT ${qi(String(x.constraint))};`] : [];
  }),
  "schema.disabled_triggers": (r) => r.flatMap((x) => {
    const t = rel(x.table);
    return t && x.trigger ? [`ALTER TABLE ${t} ENABLE TRIGGER ${qi(String(x.trigger))};`] : [];
  }),
  "tables.stale_statistics": (r) => r.flatMap((x) => {
    const t = rel(x.table);
    return t ? [`ANALYZE ${t};
ALTER TABLE ${t} SET (autovacuum_analyze_scale_factor = 0.02);  -- re-analyze after ~2% of rows change`] : [];
  })
};
var NEEDS_LOCK = /* @__PURE__ */ new Set(["schema.constraints_not_validated", "schema.disabled_triggers", "tables.stale_statistics"]);
var NEEDS_INDEX_NOTE = /* @__PURE__ */ new Set(["indexes.invalid", "indexes.unused", "indexes.redundant", "indexes.duplicate", "indexes.fk_without_index"]);
function fixSql(id, evidence) {
  const gen = GEN[id];
  if (!gen) return void 0;
  const stmts = gen(rows(evidence));
  if (!stmts.length) return void 0;
  return (NEEDS_INDEX_NOTE.has(id) ? HEAD_INDEX : "") + (NEEDS_LOCK.has(id) ? HEAD_LOCK : "") + stmts.join("\n\n") + "\n";
}

// src/triage.ts
var PRIORITIES = ["now", "next", "watch", "ignore"];
var PRIORITY_LABEL = { now: "Fix now", next: "Fix next", watch: "Watch", ignore: "Safe to ignore for now" };
var DEFAULT = { critical: "now", warning: "next", info: "watch" };
var SEV = ["critical", "warning", "info"];
var num5 = (v) => Number.isFinite(Number(v)) ? Number(v) : 0;
var lc = (t) => t.charAt(0).toLowerCase() + t.slice(1);
var fmtN = (n) => Math.round(n).toLocaleString("en-US");
var span = (s) => s < 7200 ? `${Math.max(1, Math.round(s / 60))} minutes` : s < 172800 ? `${Math.round(s / 3600)} hours` : `${Math.round(s / 86400)} days`;
var esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function mentions(sql, table) {
  const name = table.includes(".") ? table.slice(table.indexOf(".") + 1) : table;
  return new RegExp(`(^|[^\\w$])"?${esc(name)}"?($|[^\\w$])`, "i").test(String(sql ?? ""));
}
var tablesIn = (f) => Array.isArray(f?.evidence) ? f.evidence.map((r) => String(r.table ?? "")).filter(Boolean) : [];
var list = (names, max = 3) => names.slice(0, max).join(", ") + (names.length > max ? ` and ${names.length - max} more` : "");
var HOLDS_VACUUM = ["vacuum.dead_tuples", "tables.bloat", "vacuum.xid_wraparound", "vacuum.multixact_wraparound", "vacuum.table_freeze_pressure"];
var QUERY_FINDINGS = ["queries.dominant", "queries.slow_average"];
var CAPACITY = ["capacity.cpu_bound", "capacity.working_set", "capacity.io_wait", "capacity.read_replica"];
var HORIZON_MIN = 1e5;
function triage(input, datasets, vitals = []) {
  const fs = input.map(({ priority: _p, cause: _c, note: _n, confidence: _k, ...f }) => ({ ...f, priority: DEFAULT[f.severity] ?? "watch" }));
  const by = (id) => fs.find((f) => f.id === id);
  const rows3 = (id) => datasets.find((d) => d.id === id)?.rows ?? [];
  const notes = /* @__PURE__ */ new Map();
  const note = (f, s) => notes.set(f.id, [...notes.get(f.id) ?? [], s]);
  const rank = (p) => PRIORITIES.indexOf(p);
  const link = (cause, effect, confidence = "demonstrated") => {
    if (cause === effect || effect.cause) return;
    effect.cause = cause.id;
    effect.confidence = confidence;
    if (rank(cause.priority) > rank(effect.priority)) cause.priority = effect.priority;
  };
  const deadPct = new Map(rows3("v_dead").map((r) => [String(r.table), num5(r.dead_pct)]));
  const dead = by("vacuum.dead_tuples");
  const deadTables = tablesIn(dead);
  const top2 = rows3("b_xmin")[0];
  const horizon = by("blocking.vacuum_horizon");
  let holder;
  if (top2 && (horizon || num5(top2.xmin_age) >= HORIZON_MIN)) {
    const ref = String(top2.ref ?? "");
    const pidIn = (id) => rows3(id).some((r) => String(r.pid) === ref);
    const session = top2.holder === "Backend session";
    holder = (session && pidIn("b_idle") ? by("blocking.idle_in_transaction") : void 0) ?? (session && pidIn("b_running") ? by("blocking.long_running_queries") : void 0) ?? (top2.holder === "Prepared transaction" ? by("blocking.prepared_transactions") : void 0) ?? (top2.holder === "Replication slot" ? by("replication.bad_slots") : void 0) ?? horizon;
  }
  const who = !top2 ? "" : top2.holder === "Backend session" ? rows3("b_idle").some((r) => String(r.pid) === String(top2.ref)) ? `the session idle in a transaction (PID ${top2.ref})` : rows3("b_running").some((r) => String(r.pid) === String(top2.ref)) ? `the query running as PID ${top2.ref}` : `the transaction in PID ${top2.ref}` : top2.holder === "Prepared transaction" ? `the prepared transaction ${top2.ref}` : top2.holder === "Replication slot" ? `the replication slot ${top2.ref}` : `the standby ${top2.ref}`;
  const effects = HOLDS_VACUUM.map(by).filter((f) => Boolean(f));
  if (holder && effects.length) {
    holder.priority = "now";
    note(holder, `Fix this first. ${who.charAt(0).toUpperCase() + who.slice(1)} has held back cleanup for ${fmtN(num5(top2.xmin_age))} transactions, so vacuum can't remove dead rows in any table${deadTables.length ? `, including ${list(deadTables)}` : ""}.`);
    if (horizon && horizon !== holder) {
      link(holder, horizon);
      note(horizon, `The oldest holder is ${who}.`);
    }
    for (const e of effects) {
      link(holder, e);
      note(e, /wraparound|freeze/.test(e.id) ? `VACUUM (FREEZE) can't move the oldest transaction ID forward until ${who} ends.` : `Caused at least in part by ${who}: VACUUM can't remove these rows until it ends. End it, then scan again.`);
    }
  }
  const stale = by("tables.stale_statistics");
  const staleTables = tablesIn(stale);
  const reason = (t, query) => {
    const subject = query ? `This query reads ${t}.` : `${t}:`;
    if (deadTables.includes(t) && dead) {
      const blocked2 = Boolean(holder && dead.cause);
      return { cause: blocked2 ? holder : dead, text: `${subject} ${deadPct.get(t) ?? "Many"}% of its rows are dead, and sequential scans read dead rows too. ${blocked2 ? `End ${who}` : `Vacuum ${t}`}, then measure again before adding an index.` };
    }
    if (staleTables.includes(t) && stale) return { cause: stale, text: `${subject} Its planner statistics are stale. Run ANALYZE ${t} and measure again before rewriting ${query ? "the query" : "queries"} or adding an index.` };
    return null;
  };
  const seq = by("tables.seq_scans");
  if (seq) for (const t of tablesIn(seq)) {
    const r = reason(t, false);
    if (r) {
      link(r.cause, seq, "likely");
      note(seq, r.text);
      break;
    }
  }
  for (const q of QUERY_FINDINGS.map(by)) {
    if (!q || !Array.isArray(q.evidence)) continue;
    const sql = q.evidence.map((r2) => r2.query);
    const t = [...deadTables, ...staleTables].find((x) => sql.some((s) => mentions(s, x)));
    const r = t ? reason(t, true) : null;
    if (r) {
      link(r.cause, q, "likely");
      note(q, r.text);
    }
  }
  const blocked = by("blocking.lock_waits");
  if (blocked) {
    const bl = rows3("b_blocked");
    const idle = by("blocking.idle_in_transaction"), running = by("blocking.long_running_queries");
    const fromIdle = bl.find((r) => r.blocking_state === "idle in transaction");
    const fromRunning = bl.find((r) => rows3("b_running").some((x) => String(x.pid) === String(r.blocking_pid)));
    if (fromIdle && idle) {
      link(idle, blocked);
      note(blocked, `The blocking session (PID ${fromIdle.blocking_pid}) is idle in a transaction. Ending that transaction releases the lock.`);
      note(idle, `It also holds a lock that ${bl.length === 1 ? "a query is" : `${bl.length} queries are`} waiting for.`);
    } else if (fromRunning && running) {
      link(running, blocked);
      note(blocked, `The blocking session (PID ${fromRunning.blocking_pid}) is a long-running query.`);
    }
  }
  const sat = by("connections.saturation");
  if (sat) {
    const c = rows3("c_limits")[0];
    const idleConns = by("connections.idle_sessions");
    if (blocked) {
      link(blocked, sat);
      note(sat, "Queries waiting on locks keep their connections open, so fix the lock waits and check the count again.");
    } else if (idleConns) {
      link(idleConns, sat);
      note(sat, `${fmtN(num5(c?.idle))} of the ${fmtN(num5(c?.in_use))} connections are idle. A connection pooler lowers the count; raising max_connections adds memory for every connection.`);
    }
  }
  const culprit = by("queries.dominant") ?? seq ?? by("queries.slow_average");
  for (const c of CAPACITY.map(by)) {
    if (!c) continue;
    const ioCause = c.id === "capacity.io_wait" ? by("tables.bloat") ?? dead : void 0;
    const cause = ioCause ?? culprit;
    if (!cause) continue;
    link(cause, c, "likely");
    note(c, `Before adding CPU or memory: ${lc(cause.title)}. A larger instance would run the same plans, so fix that first and measure again.`);
  }
  const spillQ = by("queries.temp_spill");
  for (const id of ["capacity.temp_spill", "config.work_mem_spills"]) {
    const f = by(id);
    if (f && spillQ) {
      link(spillQ, f);
      note(f, "The statements writing the temp files are in the queries finding listed before this one. Raise work_mem only for the roles that run them: a global increase applies to every sort in every connection.");
    }
  }
  const reset = rows3("l_db")[0]?.stats_reset;
  const uptime = vitals.find((v) => v.label === "Uptime")?.value;
  const windowS = reset ? (Date.now() - new Date(String(reset)).getTime()) / 1e3 : typeof uptime === "number" ? uptime : null;
  const unused = by("indexes.unused");
  if (unused && windowS !== null && windowS < 7 * 86400) {
    unused.priority = "ignore";
    note(unused, `Index usage counts cover only the last ${span(windowS)}. An index used by a weekly or monthly job would look unused, so check again after a full business cycle before dropping any.`);
  }
  const out2 = fs.map((f) => ({ ...f, ...notes.has(f.id) ? { note: notes.get(f.id).join(" ") } : {} })).sort((a, b) => rank(a.priority) - rank(b.priority) || SEV.indexOf(a.severity) - SEV.indexOf(b.severity));
  for (let pass = 0; pass < out2.length; pass++) {
    let moved2 = false;
    for (let i = 0; i < out2.length; i++) {
      const j = out2[i].cause ? out2.findIndex((f) => f.id === out2[i].cause) : -1;
      if (j > i) {
        out2.splice(i, 0, out2.splice(j, 1)[0]);
        moved2 = true;
        break;
      }
    }
    if (!moved2) break;
  }
  return out2;
}

// src/analyze.ts
var CHECKS = [...CHECKS_A, ...CHECKS_B, ...CHECKS_C, ...CHECKS_D];
async function evaluate(def, ctx, byId) {
  const base2 = { id: def.id, section: def.section, title: def.title, looks: def.looks, flags: def.flags };
  const na = (reason) => ({ result: { ...base2, status: "na", reason } });
  const skip = (reason) => ({ result: { ...base2, status: "skipped", reason } });
  if (def.selfHosted && ctx.profile.id !== "generic") return na(`Handled by your provider (${ctx.profile.id}).`);
  if (def.providers && !def.providers.includes(ctx.profile.id)) return na(`Only applies to ${def.providers.join(", ")}.`);
  for (const u of def.uses ?? []) {
    const d = byId[u];
    if (!d) return na("Not available on this server version or provider.");
    if (d.error) return skip(`Couldn't read ${d.title.toLowerCase()}: ${d.error}`);
    if (d.note) return skip(d.note);
  }
  const rows3 = (id) => byId[id]?.rows ?? [];
  const x = { ctx, d: byId, rows: rows3, setting: (name) => {
    for (const d of Object.values(byId)) for (const r of d.rows) if (r.name === name && "setting" in r) return String(r.setting);
  } };
  try {
    const out2 = await def.run(x);
    if (out2 && "severity" in out2) {
      const finding = { id: def.id, section: def.section, category: CATEGORY[def.section], severity: out2.severity, title: out2.title, why: out2.why, fix: out2.fix, sql: out2.sql ?? fixSql(def.id, out2.evidence), evidence: out2.evidence };
      return { result: { ...base2, status: "flagged", severity: out2.severity }, finding };
    }
    return { result: { ...base2, status: "passed", reason: out2?.note } };
  } catch (e) {
    return skip(String(e.message ?? e));
  }
}
function datasetsFrom(bundle) {
  const got = new Map(bundle.datasets.map((d) => [d.id, d]));
  const out2 = [];
  for (const def of ALL_DEFS) {
    const d = got.get(def.id);
    if (!d) continue;
    out2.push({ id: def.id, section: def.section, title: def.title, description: def.description, source: def.source, layout: def.layout ?? "table", columns: def.columns, rows: d.rows, capped: d.capped, ...d.note ? { note: d.note } : {}, ...d.error ? { error: d.error } : {} });
  }
  return out2;
}
async function analyze(bundle, opts = {}) {
  const ctx = { version: bundle.server.versionNum, opts, profile: profileFor(opts.provider ?? bundle.provider), tls: bundle.connection.tls, local: bundle.connection.local, facts: bundle.facts };
  const datasets = datasetsFrom(bundle);
  const byId = Object.fromEntries(datasets.map((d) => [d.id, d]));
  const found = [];
  const checks = [];
  for (const def of CHECKS) {
    const { result, finding } = await evaluate(def, ctx, byId);
    checks.push(result);
    if (finding) found.push(finding);
  }
  const skipped = checks.filter((c) => c.status === "skipped").map((c) => ({ check: c.id, reason: c.reason ?? "" }));
  const vitals = vitalsFrom(bundle.vitals);
  return { findings: triage(found, datasets, vitals), checks, skipped, serverVersion: bundle.server.version, provider: ctx.profile.id, datasets, vitals, session: bundle.session };
}

// src/report.ts
var ORDER = ["critical", "warning", "info"];
function sortFindings(f) {
  if (f.length && f.every((x) => x.priority)) return [...f];
  return [...f].sort((a, b) => ORDER.indexOf(a.severity) - ORDER.indexOf(b.severity));
}
var groups = (fs) => PRIORITIES.map((p) => ({ p, label: PRIORITY_LABEL[p], items: fs.filter((f) => (f.priority ?? "watch") === p) })).filter((g) => g.items.length);
var DOT = { critical: "\u{1F534}", warning: "\u{1F7E0}", info: "\u{1F535}" };
var STATE = { passed: "\u2705 Passed", flagged: "\u26A0\uFE0F Flagged", skipped: "\u2796 Skipped", na: "\xB7 N/A" };
var esc2 = (v, n = 120) => String(v ?? "").replace(/\|/g, "\\|").replace(/\s+/g, " ").slice(0, n);
function toMarkdown(findings, datasets = [], meta = {}) {
  const sorted = sortFindings(findings);
  const n = (s) => findings.filter((f) => f.severity === s).length;
  const active = (meta.checks ?? []).filter((c) => c.status !== "na");
  const passed = active.filter((c) => c.status === "passed").length;
  const when2 = meta.scannedAt ? new Date(meta.scannedAt).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "";
  const out2 = ["# Postgres health report", ""];
  const facts = [meta.version && `**Server:** ${meta.version}${meta.provider && meta.provider !== "generic" ? ` (${meta.provider})` : ""}`, when2 && `**Scanned:** ${when2}`].filter(Boolean);
  if (facts.length) out2.push(facts.join("  \xB7  "), "");
  out2.push("## Summary", "", "| Critical | Warning | Info | Checks passed |", "|:-:|:-:|:-:|:-:|", `| ${n("critical")} | ${n("warning")} | ${n("info")} | ${active.length ? `${passed} / ${active.length}` : "-"} |`, "");
  out2.push(`## Findings (${findings.length})`, "");
  if (!sorted.length) out2.push("No problems found. \u2705", "");
  for (const g of groups(sorted)) {
    out2.push(`### ${g.label}`, "");
    for (const f of g.items) {
      out2.push(`#### ${DOT[f.severity]} ${f.title}`, "", `**Severity:** ${f.severity}  \xB7  **Area:** ${f.category}`, "", ...f.note ? [`**First:** ${f.note}`, ""] : [], `**Why it matters:** ${f.why}`, "", `**How to fix:** ${f.fix}`, "", ...f.sql ? ["```sql", f.sql.trimEnd(), "```", ""] : []);
      if (f.evidence) out2.push("<details><summary>Evidence</summary>", "", "```json", JSON.stringify(f.evidence, null, 2), "```", "", "</details>", "");
    }
  }
  if (active.length) {
    out2.push("## All checks", "", "| Result | Area | Check |", "|---|---|---|");
    for (const c of active) out2.push(`| ${STATE[c.status]} | ${CATEGORY[c.section]} | ${esc2(c.title)}${c.reason && c.status !== "flagged" ? ` \u2014 ${esc2(c.reason, 90)}` : ""} |`);
    out2.push("");
  }
  const shown = datasets.filter((d) => d.rows.length);
  if (shown.length) out2.push("## Data", "");
  for (const d of shown) {
    const cols = d.columns.filter((c) => d.rows.some((row) => row[c.key] !== null && row[c.key] !== void 0));
    out2.push(`### ${d.title}`, `*Source: ${d.source}*`, "", `| ${cols.map((c) => c.label).join(" | ")} |`, `| ${cols.map(() => "---").join(" | ")} |`);
    for (const row of d.rows.slice(0, 25)) out2.push(`| ${cols.map((c) => esc2(row[c.key])).join(" | ")} |`);
    out2.push("");
  }
  out2.push("---", "*Generated by pg-checkup. Read-only checks; no table contents were read.*", "");
  return out2.join("\n");
}

// src/snapshot.ts
var SNAPSHOT_FORMAT = "pg-checkup-snapshot";
var KINDS = ["extension", "schema", "table", "column", "index", "constraint", "rls", "policy", "function", "trigger", "view", "type", "sequence", "role", "grant"];
var KIND_LABEL = { extension: "Extension", schema: "Schema", table: "Table", column: "Column", index: "Index", constraint: "Constraint", rls: "Row-level security", policy: "RLS policy", function: "Function", trigger: "Trigger", view: "View", type: "Type", sequence: "Sequence", role: "Role", grant: "Grant" };
var PROVIDER_EXTENSIONS = { generic: [], supabase: ["pg_graphql", "supabase_vault", "pgsodium", "pgjwt"], neon: ["neon", "neon_utils"] };
var SETTINGS = ["server_encoding", "lc_collate", "timezone", "datestyle", "default_text_search_config", "search_path", "max_connections", "shared_buffers", "work_mem", "maintenance_work_mem", "effective_cache_size", "statement_timeout", "idle_in_transaction_session_timeout", "lock_timeout", "default_transaction_isolation", "standard_conforming_strings", "max_wal_size", "random_page_cost", "jit"];
var notExt = (classid, objid) => `not exists (select 1 from pg_depend d where d.classid = '${classid}'::regclass and d.objid = ${objid} and d.deptype = 'e')`;
function queries(p) {
  const us2 = (c) => userSchemaSql(p, c);
  const role = (c) => `(not ${p.managedRoleSql(c)} and ${c} !~ '^pg_')`;
  return {
    extension: `select extname as k, extversion as v from pg_extension where extname <> 'plpgsql'`,
    schema: `select nspname as k, '' as v from pg_namespace n where ${us2("nspname")} and ${notExt("pg_namespace", "n.oid")}`,
    table: `select n.nspname || '.' || c.relname as k, case c.relkind when 'p' then 'partitioned table' when 'f' then 'foreign table' else 'table' end || case c.relpersistence when 'u' then ', unlogged' else '' end as v
      from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind in ('r', 'p', 'f') and not c.relispartition and ${us2("n.nspname")} and ${notExt("pg_class", "c.oid")}`,
    column: `select n.nspname || '.' || c.relname || '.' || a.attname as k,
        format_type(a.atttypid, a.atttypmod) || case when a.attnotnull then ' not null' else '' end || coalesce(' default ' || pg_get_expr(ad.adbin, ad.adrelid), '')
        || case a.attidentity when 'a' then ' identity always' when 'd' then ' identity by default' else '' end || case when a.attgenerated = 's' then ' generated' else '' end as v
      from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace left join pg_attrdef ad on ad.adrelid = a.attrelid and ad.adnum = a.attnum
      where a.attnum > 0 and not a.attisdropped and c.relkind in ('r', 'p', 'f') and not c.relispartition and ${us2("n.nspname")} and ${notExt("pg_class", "c.oid")}`,
    index: `select n.nspname || '.' || ic.relname as k, pg_get_indexdef(i.indexrelid) || case when i.indisvalid then '' else ' (INVALID)' end as v
      from pg_index i join pg_class ic on ic.oid = i.indexrelid join pg_class t on t.oid = i.indrelid join pg_namespace n on n.oid = ic.relnamespace
      where not t.relispartition and ${us2("n.nspname")} and ${notExt("pg_class", "t.oid")}`,
    constraint: `select n.nspname || '.' || t.relname || '.' || k.conname as k, pg_get_constraintdef(k.oid) || case when k.convalidated then '' else ' (NOT VALIDATED)' end as v
      from pg_constraint k join pg_class t on t.oid = k.conrelid join pg_namespace n on n.oid = t.relnamespace where not t.relispartition and ${us2("n.nspname")} and ${notExt("pg_class", "t.oid")}`,
    rls: `select n.nspname || '.' || c.relname as k, case when c.relrowsecurity then 'enabled' else 'disabled' end || case when c.relforcerowsecurity then ', forced' else '' end as v
      from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind in ('r', 'p') and not c.relispartition and ${us2("n.nspname")} and ${notExt("pg_class", "c.oid")}`,
    policy: `select schemaname || '.' || tablename || '.' || policyname as k,
        permissive || ' for ' || cmd || ' to ' || array_to_string(roles, ',') || coalesce(' using (' || qual || ')', '') || coalesce(' with check (' || with_check || ')', '') as v
      from pg_policies where ${us2("schemaname")}`,
    function: `select n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as k,
        l.lanname || ' returns ' || pg_get_function_result(p.oid) || ' ' || case p.provolatile when 'i' then 'immutable' when 's' then 'stable' else 'volatile' end
        || case when p.prosecdef then ' security definer' else '' end || coalesce(' set ' || array_to_string(p.proconfig, ','), '') || ' body ' || md5(coalesce(p.prosrc, '')) as v
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_language l on l.oid = p.prolang where ${us2("n.nspname")} and ${notExt("pg_proc", "p.oid")}`,
    trigger: `select n.nspname || '.' || c.relname || '.' || t.tgname as k, pg_get_triggerdef(t.oid) || case t.tgenabled when 'D' then ' (DISABLED)' else '' end as v
      from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace where not t.tgisinternal and ${us2("n.nspname")} and ${notExt("pg_class", "c.oid")}`,
    view: `select n.nspname || '.' || c.relname as k, case c.relkind when 'm' then 'materialized view ' else 'view ' end || md5(pg_get_viewdef(c.oid)) as v
      from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind in ('v', 'm') and ${us2("n.nspname")} and ${notExt("pg_class", "c.oid")}`,
    type: `select n.nspname || '.' || t.typname as k, case t.typtype when 'e' then 'enum (' || (select string_agg(e.enumlabel, ', ' order by e.enumsortorder) from pg_enum e where e.enumtypid = t.oid) || ')'
        when 'd' then 'domain over ' || format_type(t.typbasetype, t.typtypmod) else 'composite' end as v
      from pg_type t join pg_namespace n on n.oid = t.typnamespace where t.typtype in ('e', 'd') and ${us2("n.nspname")} and ${notExt("pg_type", "t.oid")}`,
    sequence: `select s.schemaname || '.' || s.sequencename as k, format_type(s.data_type, null) || ' increment ' || s.increment_by || ' max ' || s.max_value || case when s.cycle then ' cycle' else '' end as v
      from pg_sequences s where ${us2("s.schemaname")}`,
    role: `select rolname as k, concat_ws(' ', case when rolcanlogin then 'login' else 'nologin' end, case when rolsuper then 'superuser' end, case when rolcreaterole then 'createrole' end,
        case when rolcreatedb then 'createdb' end, case when rolreplication then 'replication' end, case when rolbypassrls then 'bypassrls' end, case when not rolinherit then 'noinherit' end) as v
      from pg_roles where ${role("rolname")}`,
    grant: `select n.nspname || '.' || c.relname || ' to ' || case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as k, string_agg(a.privilege_type, ', ' order by a.privilege_type) as v
      from pg_class c join pg_namespace n on n.oid = c.relnamespace cross join lateral aclexplode(c.relacl) a
      where c.relkind in ('r', 'p', 'v', 'm', 'S') and c.relacl is not null and a.grantee <> c.relowner and ${us2("n.nspname")} and ${notExt("pg_class", "c.oid")}
        and (a.grantee = 0 or ${role("pg_get_userbyid(a.grantee)")})
      group by 1`
  };
}
async function takeSnapshot(connectionString, opts = {}) {
  const { db } = await openReadOnlySession(connectionString);
  const q = async (sql) => (await db.query(`${TAG} ${sql}`)).rows;
  try {
    const provider3 = opts.provider ?? providerIdFromUrl(connectionString);
    const p = profileFor(provider3);
    requireMonitoringRole(roleInfo((await q(roleSql(p)))[0]), opts.allowPrivilegedRole);
    const [srv] = await q(`select current_setting('server_version_num')::int as n, version() as v, current_database() as db, pg_encoding_to_char(encoding) as enc, datcollate as collate, datctype as ctype from pg_database where datname = current_database()`);
    const objects = {};
    const qs = queries(p);
    for (const k of KINDS) objects[k] = Object.fromEntries((await q(qs[k])).map((r) => [String(r.k), String(r.v ?? "")]));
    const tables = Object.fromEntries((await q(`select n.nspname || '.' || c.relname as k, greatest(c.reltuples, 0)::bigint as est,
        case when s.last_analyze is not null or s.last_autoanalyze is not null then true
             when has_table_privilege(c.oid, 'SELECT') then exists (select 1 from pg_stats st where st.schemaname = n.nspname and st.tablename = c.relname)
        end as analyzed
      from pg_class c join pg_namespace n on n.oid = c.relnamespace left join pg_stat_user_tables s on s.relid = c.oid
      where c.relkind in ('r', 'p') and not c.relispartition and ${userSchemaSql(p, "n.nspname")} and ${notExt("pg_class", "c.oid")}`)).map((r) => [String(r.k), { estRows: Number(r.est), analyzed: r.analyzed === null ? null : Boolean(r.analyzed) }]));
    const sequenceValues = Object.fromEntries((await q(`select schemaname || '.' || sequencename as k, case when has_sequence_privilege(format('%I.%I', schemaname, sequencename), 'SELECT') then coalesce(last_value, start_value - increment_by) end as v from pg_sequences where ${userSchemaSql(p, "schemaname")}`)).map((r) => [String(r.k), r.v === null ? null : Number(r.v)]));
    const settings = Object.fromEntries((await q(`select name, setting || coalesce(unit, '') as v from pg_settings where name in (${SETTINGS.map((s) => `'${s}'`).join(", ")})`)).map((r) => [String(r.name), String(r.v)]));
    const hosting = detectProvider(connectionString)?.provider ?? null;
    return { format: SNAPSHOT_FORMAT, version: 1, takenAt: (/* @__PURE__ */ new Date()).toISOString(), provider: provider3, hosting, server: { versionNum: Number(srv.n), version: String(srv.v) }, database: { name: String(srv.db), encoding: String(srv.enc), collate: String(srv.collate), ctype: String(srv.ctype) }, objects, tables, sequenceValues, settings };
  } finally {
    await db.end();
  }
}
var major = (n) => Math.floor(n / 1e4);
var host = (s) => s.hosting ?? (s.provider === "generic" ? "a self-managed or unrecognised host" : s.provider);
function diffSnapshots(before, after) {
  const out2 = [];
  const moved2 = before.provider !== after.provider || before.hosting !== after.hosting;
  const versionChanged = major(before.server.versionNum) !== major(after.server.versionNum);
  if (versionChanged) out2.push({ kind: "server", object: "PostgreSQL version", change: "changed", before: String(major(before.server.versionNum)), after: String(major(after.server.versionNum)), verdict: "review", why: "A new major version can change query plans and behaviour. Read the release notes' incompatibilities section for every version in between." });
  for (const f of ["encoding", "collate", "ctype"]) {
    if (before.database[f] !== after.database[f]) out2.push({
      kind: "database",
      object: f === "encoding" ? "Encoding" : f === "collate" ? "Collation (LC_COLLATE)" : "Character classification (LC_CTYPE)",
      change: "changed",
      before: before.database[f],
      after: after.database[f],
      verdict: "regression",
      why: f === "encoding" ? "Text that can't be represented in the new encoding fails to insert." : "Text sorts and compares differently, so ORDER BY results, unique constraints on text and text indexes can behave differently."
    });
  }
  const extOf = (id) => PROVIDER_EXTENSIONS[id] ?? [];
  for (const kind of KINDS) {
    const a = before.objects[kind] ?? {}, b = after.objects[kind] ?? {};
    for (const k of /* @__PURE__ */ new Set([...Object.keys(a), ...Object.keys(b)])) {
      const was = a[k], now = b[k];
      if (was === now) continue;
      const change = was === void 0 ? "added" : now === void 0 ? "missing" : "changed";
      out2.push({ kind, object: k, change, ...was !== void 0 ? { before: was } : {}, ...now !== void 0 ? { after: now } : {}, ...verdict(kind, k, change, was, now, { moved: moved2, versionChanged, from: before, to: after, extOf }) });
    }
  }
  for (const [t, was] of Object.entries(before.tables)) {
    const now = after.tables[t];
    if (!now) continue;
    if (now.analyzed === false && (now.estRows > 0 || was.estRows > 0)) out2.push({ kind: "data", object: t, change: "changed", verdict: "regression", why: "Never analyzed in the new database, so the planner has no statistics for it and can choose very slow plans. Run ANALYZE (a restore doesn't carry statistics)." });
    else if (now.analyzed === null && (now.estRows > 0 || was.estRows > 0)) out2.push({ kind: "data", object: t, change: "changed", verdict: "review", why: "No ANALYZE is recorded since the statistics counters were last reset. If the data was restored from a dump, run ANALYZE so the planner has statistics." });
    else if (was.estRows >= 1e3 && now.estRows < was.estRows * 0.5) out2.push({ kind: "data", object: t, change: "changed", before: `~${was.estRows.toLocaleString("en-US")} rows`, after: `~${now.estRows.toLocaleString("en-US")} rows`, verdict: "review", why: "The new table looks less than half as large. These are planner estimates: run ANALYZE, then compare exact counts with SELECT count(*) on both sides." });
  }
  for (const [s, was] of Object.entries(before.sequenceValues)) {
    if (!(s in after.sequenceValues)) continue;
    const now = after.sequenceValues[s];
    if (was === null || now === null) {
      if (was !== null || now !== null) out2.push({ kind: "sequence value", object: s, change: "changed", verdict: "review", why: "Couldn't read the sequence's current value on one side. Grant SELECT on it to the role you scan with, or compare it as the owner." });
      continue;
    }
    if (now < was) out2.push({ kind: "sequence value", object: s, change: "changed", before: String(was), after: String(now), verdict: "regression", why: `The sequence is behind where it was, so new rows can be given ids that already exist. Run SELECT setval('${s}', ${was}); or higher.` });
  }
  for (const k of /* @__PURE__ */ new Set([...Object.keys(before.settings), ...Object.keys(after.settings)])) {
    const was = before.settings[k], now = after.settings[k];
    if (was === now) continue;
    out2.push({
      kind: "setting",
      object: k,
      change: was === void 0 ? "added" : now === void 0 ? "missing" : "changed",
      before: was,
      after: now,
      verdict: moved2 ? "expected" : k === "timezone" || k === "search_path" || k === "default_transaction_isolation" || k === "standard_conforming_strings" ? "review" : "expected",
      why: moved2 ? `Server settings are set by the host, and this database moved from ${host(before)} to ${host(after)}.` : "Check that the application doesn't depend on the old value."
    });
  }
  const order = { regression: 0, review: 1, expected: 2 };
  return out2.sort((x, y) => order[x.verdict] - order[y.verdict]);
}
function verdict(kind, k, change, was, now, c) {
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
    case "rls":
      return { verdict: "regression", why: was?.startsWith("enabled") ? "Row-level security was on and isn't now, so every role with table access sees every row." : "Row-level security differs." };
    case "policy":
      return { verdict: "regression", why: (missing ? "Without this policy, rows it allowed are hidden, or with RLS off, everything is visible." : "The policy now allows different rows.") + reformatted };
    case "grant":
      return { verdict: "regression", why: missing ? "This role has lost access to the table." : "This role's privileges on the table changed." };
    case "table":
    case "column":
    case "constraint":
    case "type":
      return { verdict: "regression", why: (missing ? "Queries that use it fail." : kind === "constraint" ? "The constraint enforces something different, or no longer validates existing rows." : "Its definition changed.") + (missing ? "" : reformatted) };
    case "index":
      return { verdict: missing ? "regression" : "review", why: missing ? "Queries that used it now scan instead, and if it was unique, duplicates are allowed." : `Its definition differs.${now?.includes("INVALID") ? " It is INVALID: a CREATE INDEX CONCURRENTLY failed; drop and recreate it." : reformatted}` };
    case "function":
    case "view":
    case "trigger":
      return { verdict: "regression", why: (missing ? "Anything that calls it fails." : "Its definition changed.") + (missing ? "" : reformatted) };
    case "sequence":
      return { verdict: missing ? "regression" : "review", why: missing ? "Inserts that use it as a default fail." : "Its type, increment or limit changed." };
    case "schema":
      return { verdict: "regression", why: "Everything in it is missing." };
    default:
      return { verdict: "review", why: "Differs." };
  }
}
var kindLabel = (k) => k in KIND_LABEL ? KIND_LABEL[k] : k.charAt(0).toUpperCase() + k.slice(1);
function diffText(diffs, before, after) {
  const on = (x) => x.hosting ?? (x.provider !== "generic" ? x.provider : null);
  const lines = [`Compared ${before.database.name}${on(before) ? ` on ${on(before)}` : ""} (baseline from ${before.takenAt.slice(0, 16).replace("T", " ")} UTC) with ${after.database.name}${on(after) ? ` on ${on(after)}` : ""}.`, ""];
  const groups2 = [["regression", "Needs fixing"], ["review", "Check these"], ["expected", `Expected${before.provider !== after.provider || before.hosting !== after.hosting ? ` when moving from ${host(before)} to ${host(after)}` : ""}`]];
  if (!diffs.length) lines.push("No differences in the captured schema, security, functions, grants, sequences or settings.", "");
  for (const [v, title] of groups2) {
    const ds = diffs.filter((d) => d.verdict === v);
    if (!ds.length) continue;
    lines.push(`${title} (${ds.length})`);
    for (const d of ds) {
      lines.push(`  ${d.change === "missing" ? "-" : d.change === "added" ? "+" : "~"} ${kindLabel(d.kind)} ${d.object}${d.before !== void 0 && d.after !== void 0 ? `: ${short(d.before)} -> ${short(d.after)}` : ""}`);
      lines.push(`      ${d.why}`);
    }
    lines.push("");
  }
  lines.push("Query performance isn't compared here: right after a move the cache is cold and statistics are new.", "Use pg-checkup observe --seconds 300 --representative on each database under equivalent warmed traffic, then compare the two window files.");
  lines.push("This checks database metadata, not row equality or application behavior. Sequence values may be unavailable to a restricted role.");
  if (before.provider === "supabase" || after.provider === "supabase") lines.push("Supabase handoff: separately verify Auth logins/OAuth callbacks, Storage objects and policies, Edge Functions/secrets, Realtime subscriptions and TLS/pooler configuration. Provider-managed schemas are excluded from this comparison.");
  return lines.join("\n");
}
var short = (s) => s.length > 80 ? `${s.slice(0, 77)}...` : s;

// src/checkup-compare.ts
var COMPARISON_FORMAT = "pg-checkup-comparison";
var SEV2 = ["critical", "warning", "info"];
var BETTER = { "Cache hit rate": "higher", Connections: "lower", Deadlocks: "lower" };
var moved = (before, after) => before !== null && after !== null && after !== before && Math.abs(after - before) >= Math.max(5e-3 * Math.abs(before), 1e-9);
var slim = (f) => ({ id: f.id, title: f.title, severity: f.severity });
var num6 = (v) => v === null || v === void 0 || v === "" || !Number.isFinite(Number(v)) ? null : Number(v);
var rows2 = (b, id) => b.datasets.find((d) => d.id === id)?.rows ?? [];
var hours = (ms) => Math.round(ms / 36e4) / 10;
function window(b) {
  const at = Date.parse(b.collectedAt);
  const reset = rows2(b, "l_db")[0]?.stats_reset;
  if (reset && Date.parse(String(reset))) return hours(at - Date.parse(String(reset)));
  const up = num6(b.vitals?.uptime_s);
  return up === null ? null : hours(up * 1e3);
}
function unavailableOrCapped(b) {
  const d = b.datasets.find((d2) => d2.id === "v_dead");
  return !d || Boolean(d.error || d.note || d.capped);
}
function compareCheckups(a, b) {
  const was = new Map(a.findings.map((f) => [f.id, f])), now = new Map(b.findings.map((f) => [f.id, f]));
  const passed = new Set(b.checks.filter((c) => c.status === "passed").map((c) => c.id));
  const fixed = a.findings.filter((f) => !now.has(f.id) && passed.has(f.id)).map(slim);
  const unknown = a.findings.filter((f) => !now.has(f.id) && !passed.has(f.id)).map(slim);
  const added = b.findings.filter((f) => !was.has(f.id)).map(slim);
  const open = b.findings.filter((f) => was.has(f.id)).map(slim);
  const worse = b.findings.filter((f) => was.has(f.id) && SEV2.indexOf(f.severity) < SEV2.indexOf(was.get(f.id).severity)).map(slim);
  const vb = new Map(a.vitals.map((v) => [v.label, v])), va = new Map(b.vitals.map((v) => [v.label, v]));
  const numbers = [.../* @__PURE__ */ new Set([...vb.keys(), ...va.keys()])].filter((l) => l !== "Uptime").map((label) => {
    const x = vb.get(label), y = va.get(label);
    return { label, before: num6(x?.value), after: num6(y?.value), kind: (y ?? x)?.kind, better: BETTER[label] ?? null };
  }).filter((n) => n.before !== null || n.after !== null);
  const named = /* @__PURE__ */ new Set();
  for (const f of [...a.findings, ...b.findings]) for (const e of Array.isArray(f.evidence) ? f.evidence : f.evidence ? [f.evidence] : []) if (typeof e.table === "string") named.add(e.table);
  const deadB = new Map(rows2(a.bundle, "v_dead").map((r) => [String(r.table), r])), deadA = new Map(rows2(b.bundle, "v_dead").map((r) => [String(r.table), r]));
  const cappedB = unavailableOrCapped(a.bundle), cappedA = unavailableOrCapped(b.bundle);
  const dead = (m, capped, t, key) => m.has(t) ? num6(m.get(t)[key]) : capped ? null : 0;
  const tables = [...new Set([...named].filter((t) => deadB.has(t) || deadA.has(t)))].map((table) => ({
    table,
    deadBefore: dead(deadB, cappedB, table, "dead_rows"),
    deadAfter: dead(deadA, cappedA, table, "dead_rows"),
    pctBefore: dead(deadB, cappedB, table, "dead_pct"),
    pctAfter: dead(deadA, cappedA, table, "dead_pct")
  })).sort((x, y) => (y.deadBefore ?? 0) - (x.deadBefore ?? 0)).slice(0, 10);
  const resetAt = rows2(b.bundle, "l_db")[0]?.stats_reset;
  const statsReset = Boolean(resetAt && Date.parse(String(resetAt)) > Date.parse(a.bundle.collectedAt));
  const sameDatabase = a.bundle.target && b.bundle.target ? a.bundle.target === b.bundle.target : null;
  const wh = { before: window(a.bundle), after: window(b.bundle) };
  const limits = [];
  if (sameDatabase === false) limits.push("These are two different databases, so nothing below is a before-and-after.");
  if (statsReset) limits.push("The statistics were reset between the two checkups, so counters such as calls, scans and dead rows started over and are not comparable.");
  if (wh.after !== null && wh.after < 1) limits.push(`The later checkup has only ${Math.round(wh.after * 60)} minutes of statistics behind it; usage-based findings need real traffic first.`);
  limits.push("Two snapshots show what changed inside the database. They do not show that the application got faster: that needs query timings under comparable traffic, which pg-checkup observe measures on each side.");
  return {
    format: COMPARISON_FORMAT,
    version: 1,
    sameDatabase,
    before: { collectedAt: a.bundle.collectedAt, server: a.bundle.server.version.split(" on ")[0].split(",")[0] },
    after: { collectedAt: b.bundle.collectedAt, server: b.bundle.server.version.split(" on ")[0].split(",")[0] },
    hoursBetween: hours(Date.parse(b.bundle.collectedAt) - Date.parse(a.bundle.collectedAt)),
    windowHours: wh,
    statsReset,
    fixed,
    new: added,
    open,
    unknown,
    worse,
    numbers,
    tables,
    regression: [...added, ...worse].some((f) => f.severity !== "info"),
    limits
  };
}
var fmtN2 = (n, kind) => {
  if (n === null) return "\u2013";
  if (kind === "bytes") {
    const u = ["B", "KB", "MB", "GB", "TB"];
    let i = 0, v = n;
    while (v >= 1024 && i < u.length - 1) {
      v /= 1024;
      i++;
    }
    return `${v < 10 && i ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
  }
  if (kind === "pct") return `${Math.round(n * 10) / 10}%`;
  if (kind === "secs") return n < 7200 ? `${Math.round(n / 60)} min` : n < 172800 ? `${Math.round(n / 3600)} h` : `${Math.round(n / 86400)} d`;
  return Math.round(n).toLocaleString("en-US");
};
var when = (iso) => iso.replace("T", " ").slice(0, 16) + " UTC";
var span2 = (h) => h < 1 ? `${Math.round(h * 60)} minutes` : h < 48 ? `${Math.round(h)} hours` : `${Math.round(h / 24)} days`;
var windowText = (h) => h === null ? "unknown" : span2(h);
function checkupComparisonText(c) {
  const L = [];
  L.push(`Before: ${when(c.before.collectedAt)}, ${c.before.server}.  After: ${when(c.after.collectedAt)}, ${c.after.server}.  ${span2(c.hoursBetween)} apart${c.sameDatabase === true ? ", same database" : c.sameDatabase === false ? ", DIFFERENT databases" : ""}.`);
  L.push(`Statistics behind each: ${windowText(c.windowHours.before)} before, ${windowText(c.windowHours.after)} after${c.statsReset ? " (reset in between)" : ""}.`);
  const group = (title, mark, items) => {
    if (!items.length) return;
    L.push("", `${title}  ${items.length}`);
    for (const f of items) L.push(`${mark} ${f.title}  (${f.severity})`);
  };
  group("FIXED", "\u2713", c.fixed);
  group("NEW", "!", c.new);
  group("WORSE", "!", c.worse);
  group("STILL OPEN", "\xB7", c.open.filter((f) => !c.worse.some((w2) => w2.id === f.id)));
  group("UNKNOWN (the check did not run the second time)", "?", c.unknown);
  if (!c.fixed.length && !c.new.length && !c.worse.length && !c.open.length) L.push("", "No findings in either checkup.");
  const w = 28;
  const line = (label, before, after, tail = "") => L.push(`${label.padEnd(w)}${before.padStart(12)}${after.padStart(12)}${tail ? "  " + tail : ""}`);
  if (c.tables.length || c.numbers.length) {
    L.push("", `${"NUMBERS".padEnd(w)}${"before".padStart(12)}${"after".padStart(12)}`);
  }
  for (const t of c.tables) {
    const dir = moved(t.deadBefore, t.deadAfter) ? t.deadAfter < t.deadBefore ? "lower" : "higher" : "";
    line(`Dead rows, ${t.table}`.slice(0, w - 1), fmtN2(t.deadBefore), fmtN2(t.deadAfter), dir);
  }
  for (const n of c.numbers) {
    const changed = moved(n.before, n.after) && fmtN2(n.before, n.kind) !== fmtN2(n.after, n.kind);
    const dir = changed ? n.after < n.before ? "lower" : "higher" : "";
    const verdict2 = changed && n.better ? dir === n.better ? "better" : "worse" : dir;
    line(n.label.slice(0, w - 1), fmtN2(n.before, n.kind), fmtN2(n.after, n.kind), verdict2);
  }
  L.push("");
  for (const l of c.limits) L.push(l);
  return L.join("\n");
}

// src/cli-options.ts
import { Command, CommanderError, InvalidArgumentError, Option } from "commander";
var UsageError = class extends Error {
};
var PROVIDERS2 = ["generic", "supabase", "neon"];
var SEVERITIES = ["critical", "warning", "info"];
var isUrl = (s) => /^postgres(ql)?:\/\//.test(s);
var integer = (lo, hi) => (v) => {
  if (!/^\d+$/.test(v) || Number(v) < lo || Number(v) > hi) throw new InvalidArgumentError(`Must be a whole number from ${lo} to ${hi}.`);
  return v;
};
function connection(c) {
  return c.argument("[connection]", "a postgres:// URL; otherwise the flags, PG* variables or ./.env are used").option("-h, --host <host>", "database server host").option("-p, --port <port>", "database server port", integer(1, 65535)).option("-U, --user <user>", "database user name").option("-d, --dbname <dbname>", "database name").option("--service <name>", "connection service from ~/.pg_service.conf").option("--sslmode <mode>", "disable, allow, prefer, require, verify-ca or verify-full").option("-W, --password", "always prompt for the password").option("-w, --no-password", "never prompt for the password").addOption(new Option("--provider <provider>", "override host detection, e.g. behind a tunnel").choices(PROVIDERS2)).option("--allow-privileged-role", "proceed on a remote database with a login that can read tables");
}
function reading(c) {
  return c.option("-v, --verbose", "also list every check that passed, was skipped or did not apply").option("--md", "print the report as Markdown on stdout").addOption(new Option("--fail-on <severity>", "exit 1 when a finding of this severity or worse exists").choices(SEVERITIES));
}
function toOptions(o) {
  const names = { dbname: "database", failOn: "fail-on", includeQueryText: "include-query-text", allowPrivilegedRole: "allow-privileged-role" };
  const out2 = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === void 0) continue;
    if (k === "password") {
      if (v === true) out2.password = true;
      else if (v === false) out2["no-password"] = true;
      continue;
    }
    if (k === "upload") {
      if (v === true) out2.upload = true;
      else if (v === false) out2["no-upload"] = true;
      continue;
    }
    if (k === "color") {
      if (v === false) out2["no-color"] = true;
      continue;
    }
    if (k === "input") {
      if (v === false) out2["no-input"] = true;
      continue;
    }
    if (k === "pace") {
      if (v === false) out2["no-pace"] = true;
      continue;
    }
    out2[names[k] ?? k] = v;
  }
  if (out2.md && out2.json) throw new UsageError("--md and --json cannot be combined.");
  if (out2.json && (out2.upload || out2.send)) throw new UsageError("--json cannot be combined with --upload or --send; upload the saved file separately.");
  return out2;
}
var AFTER = `
Connection: a postgres:// URL, or -h/-p/-U/-d, or --service NAME, or PGHOST PGPORT PGUSER PGDATABASE
  PGSERVICE PGSSLMODE. With none of those, DATABASE_URL is read from ./.env.local or ./.env.
  Password: the URL, PGPASSWORD, the service file, ~/.pgpass, then a hidden prompt.

Examples:
  pg-checkup postgres://checkup_reader@db.example.com/app
  pg-checkup -h db.example.com -U checkup_reader -d app
  pg-checkup show checkup.json --md

Nothing leaves this machine except through "upload", which sends the saved file and nothing else.
Exit codes: 0 completed, 1 regression or --fail-on match, 2 usage or runtime error, 3 remote login
  has more access than needed, 4 comparison inconclusive, 130 cancelled.`;
function buildProgram(version, record, quiet = false) {
  const program = new Command("pg-checkup").description("Read-only checkup of a PostgreSQL database, run on your machine.\nRuns every check, reads the findings together, and prints what to fix first, why, and how.").usage("[connection] [options]\n       pg-checkup <command> [options]").version(version, "-V, --version", "print the version").helpOption("--help", "show help").helpCommand(false).option("-o, --out <file>", "where to save the result; an existing file is never overwritten").option("--json", "the result as JSON on stdout; messages stay on stderr").option("--no-color", "plain text (NO_COLOR=1 does the same)").option("--no-input", "never prompt; for scripts and CI").option("--no-pace", "print all findings at once instead of one at a time").option("--strict", "exit 1 when any diagnostic view could not be read (for CI)").addHelpText("after", AFTER).showHelpAfterError("(run pg-checkup --help)").exitOverride();
  if (quiet) program.configureOutput({ writeOut: () => {
  }, writeErr: () => {
  } });
  const done = (command, positionals2, cmd2) => record({ command, positionals: positionals2, options: toOptions(cmd2.optsWithGlobals()) });
  reading(connection(program.command("scan", { isDefault: true }).description("run the checkup and save the statistics to a file (the default)"))).option("--include-query-text", "keep SQL text in the file, with literals masked").option("--upload", "upload the saved file afterwards, for a shareable report").option("--send <code>", "upload for the page that is waiting, with the one-time code shown on pgcheckup.com/scan").addOption(new Option("--no-upload").hideHelp()).action((conn, _o, cmd2) => {
    if (conn !== void 0 && !isUrl(conn)) throw new UsageError(`unknown command "${conn}". A connection is a postgres:// URL; run pg-checkup --help for the commands.`);
    done("scan", conn ? [conn] : [], cmd2);
  });
  reading(program.command("show").description("run the checkup again on a saved file").argument("<file>")).option("--all", "also print every collected row").addOption(new Option("--provider <provider>", "analyse as this provider").choices(PROVIDERS2)).action((file, _o, cmd2) => done("show", [file], cmd2));
  connection(program.command("doctor").description("say how pg-checkup would connect and what the login can do, then stop")).action((conn, _o, cmd2) => done("doctor", conn ? [conn] : [], cmd2));
  program.command("role").description("print SQL that creates a statistics-only login").action((_o, cmd2) => done("role", [], cmd2));
  program.command("sql").description("print every query the checkup runs, in order").addOption(new Option("--provider <provider>", "the queries as run for this provider").choices(PROVIDERS2)).action((_o, cmd2) => done("sql", [], cmd2));
  program.command("schedule").description("print a ready-made schedule (GitHub Actions, or a cron line) that runs the checkup and uploads it").addOption(new Option("--every <interval>", "how often").choices(["daily", "weekly"]).default("weekly")).option("--cron", "print a crontab line instead of a GitHub Actions file").option("--write", "write .github/workflows/pg-checkup.yml (never overwrites)").action((_o, cmd2) => done("schedule", [], cmd2));
  program.command("upload").description("send a saved file to pgcheckup.com for a shareable report").argument("<file>").option("-y, --yes", "upload without asking").action((file, _o, cmd2) => done("upload", [file], cmd2));
  program.command("delete").description("remove an uploaded report").argument("<receipt>", "the receipt file written by upload").action((receipt, _o, cmd2) => done("delete", [receipt], cmd2));
  connection(program.command("baseline").description("save schema, security and settings before a migration")).action((conn, _o, cmd2) => done("baseline", conn ? [conn] : [], cmd2));
  connection(program.command("verify").description("explain what differs after the migration").argument("<baseline>", "file written by baseline").argument("[after]", "a second baseline file")).action((baseline, after, conn, cmd2) => done("verify", [baseline, ...after ? [after] : [], ...conn ? [conn] : []], cmd2));
  program.command("compare").description("compare two checkup files (fixed, new, still open, the numbers), or two observation or baseline files").argument("<before>").argument("<after>").action((before, after, _o, cmd2) => done("compare", [before, after], cmd2));
  connection(program.command("observe").description("measure a window of real traffic from pg_stat_statements")).option("--seconds <n>", "length of the window", integer(10, 3600), "300").option("--label <label>", "name for the window, e.g. before-release-42").option("--representative", "attest that this is normal traffic with warm caches").action((conn, _o, cmd2) => done("observe", conn ? [conn] : [], cmd2));
  return program;
}
var normalizeArgv = (argv) => argv.map((a, i) => a === "-h" && (argv[i + 1] === void 0 || argv[i + 1].startsWith("-")) ? "--help" : a);
var terminalText = (value) => String(value).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "").replace(/\r/g, "");

// src/collector-cli.ts
import { CommanderError as CommanderError2 } from "commander";

// src/workload.ts
var WINDOW_FORMAT = "pg-checkup-window";
var WORKLOAD_SQL = `select s.userid::text || ':' || s.queryid::text || ':' || s.toplevel::text as key,
  md5(s.query) as family, s.calls::text as calls, s.total_exec_time as ms, s.rows::text as rows, to_jsonb(s)->>'stats_since' as since
  from pg_stat_statements s where s.dbid = (select oid from pg_database where datname = current_database())
  and s.queryid is not null and s.query is not null and s.query not like '%/* pg-checkup */%'
  order by s.userid, s.queryid, s.toplevel limit 10001`;
var WINDOW_META_SQL = `select clock_timestamp() as at, stats_reset as reset, dealloc,
  pg_postmaster_start_time() as restart from pg_stat_statements_info`;
async function observe(connection3, opts = {}) {
  const seconds = opts.seconds ?? 300;
  if (!Number.isInteger(seconds) || seconds < 10 || seconds > 3600) throw new Error("Observation must last 10\u20133600 seconds.");
  const { db } = await openReadOnlySession(connection3);
  try {
    const provider3 = opts.provider ?? providerIdFromUrl(connection3);
    const q = async (sql) => (await db.query(`${TAG} ${sql}`)).rows;
    requireMonitoringRole(roleInfo((await q(roleSql(profileFor(provider3))))[0]), opts.allowPrivilegedRole);
    const [{ version }] = await q("select current_setting('server_version_num')::int as version");
    if (version < 14e4) throw new Error("Observation needs PostgreSQL 14+ and pg_stat_statements 1.9+ with reset tracking.");
    const sample = async () => {
      const [meta] = await q(WINDOW_META_SQL);
      const counters = (await q(WORKLOAD_SQL)).map((r) => ({ key: String(r.key), family: String(r.family), calls: Number(r.calls), ms: Number(r.ms), rows: Number(r.rows), since: r.since ?? null }));
      const [after] = await q(WINDOW_META_SQL);
      if (new Date(meta.reset).getTime() !== new Date(after.reset).getTime() || Number(meta.dealloc) !== Number(after.dealloc)) throw new Error("Statistics changed while reading counters. Repeat the observation.");
      if (counters.length > 1e4) throw new Error("More than 10,000 query entries: observation would be incomplete. Narrow the workload before comparing.");
      if (counters.some((r) => !Number.isSafeInteger(r.calls) || !Number.isSafeInteger(r.rows))) throw new Error("Query counters exceed safe numeric precision; cannot compare this window reliably.");
      return { at: new Date(meta.at).toISOString(), reset: new Date(meta.reset).toISOString(), restart: new Date(meta.restart).toISOString(), dealloc: Number(meta.dealloc), counters };
    };
    const start = await sample();
    const deadline = Date.now() + seconds * 1e3;
    while (Date.now() < deadline) {
      if (opts.signal?.aborted) throw new Error("Observation cancelled; no result was written.");
      opts.progress?.(Math.ceil((deadline - Date.now()) / 1e3));
      await new Promise((resolve) => setTimeout(resolve, Math.min(1e3, deadline - Date.now())));
    }
    return { format: WINDOW_FORMAT, version: 1, target: fingerprint(connection3), provider: provider3, major: Math.floor(version / 1e4), representative: Boolean(opts.representative), ...opts.label ? { label: opts.label.slice(0, 120) } : {}, start, end: await sample() };
  } catch (e) {
    if (e.code === "42P01" || e.code === "42703") throw new Error("Observation needs pg_stat_statements with reset tracking. Ask your database administrator to enable/update it, then retry.");
    throw e;
  } finally {
    await db.end();
  }
}
function parseWindow(value) {
  const w = value;
  if (!w || w.format !== WINDOW_FORMAT || w.version !== 1 || !Number.isInteger(w.major) || typeof w.representative !== "boolean" || !["generic", "supabase", "neon"].includes(w.provider) || !/^[a-f0-9]{24}$/.test(w.target)) throw new Error("Not a supported pg-checkup observation file.");
  for (const s of [w.start, w.end]) {
    if (!s || ![s.at, s.reset, s.restart].every((v) => typeof v === "string" && Number.isFinite(Date.parse(v))) || !Number.isSafeInteger(s.dealloc) || s.dealloc < 0 || !Array.isArray(s.counters) || s.counters.length > 1e4) throw new Error("Invalid observation sample.");
    const keys = /* @__PURE__ */ new Set();
    for (const r of s.counters) {
      if (!r || typeof r.key !== "string" || keys.has(r.key) || !/^[a-f0-9]{32}$/.test(r.family) || !Number.isSafeInteger(r.calls) || !Number.isSafeInteger(r.rows) || !Number.isFinite(r.ms) || Math.min(r.calls, r.rows, r.ms) < 0) throw new Error("Invalid or duplicate query counter.");
      keys.add(r.key);
    }
  }
  if (w.label !== void 0 && (typeof w.label !== "string" || w.label.length > 120)) throw new Error("Invalid observation label.");
  if (Date.parse(w.end.at) <= Date.parse(w.start.at)) throw new Error("Observation end must follow its start.");
  return w;
}
function deltas(w) {
  const reasons = [];
  if (w.start.reset !== w.end.reset || w.start.restart !== w.end.restart) reasons.push("Statistics reset or the server restarted during the observation.");
  if (w.start.dealloc !== w.end.dealloc) reasons.push("Query entries were evicted during the observation.");
  const before = new Map(w.start.counters.map((r) => [r.key, r]));
  const after = new Set(w.end.counters.map((r) => r.key));
  if (w.start.counters.some((r) => !after.has(r.key))) reasons.push("Query counters disappeared during the observation.");
  const families = /* @__PURE__ */ new Map();
  for (const end of w.end.counters) {
    const start = before.get(end.key);
    const calls = end.calls - (start?.calls ?? 0), ms = end.ms - (start?.ms ?? 0), rows3 = end.rows - (start?.rows ?? 0);
    if (calls < 0 || ms < 0 || rows3 < 0 || start && (start.family !== end.family || start.since !== end.since)) {
      reasons.push("A query counter reset or its representative text changed.");
      continue;
    }
    if (!calls) continue;
    const old = families.get(end.family) ?? { calls: 0, ms: 0, rows: 0 };
    families.set(end.family, { calls: old.calls + calls, ms: old.ms + ms, rows: old.rows + rows3 });
  }
  return { families, reasons };
}
function compareWorkloads(a, b) {
  parseWindow(a);
  parseWindow(b);
  const x = deltas(a), y = deltas(b);
  const reasons = [...x.reasons.map((s) => `Before: ${s}`), ...y.reasons.map((s) => `After: ${s}`)];
  const duration = (w) => (Date.parse(w.end.at) - Date.parse(w.start.at)) / 1e3;
  const da = duration(a), db = duration(b);
  const count = (m) => [...m.values()].reduce((s, r) => s + r.calls, 0);
  const ca = count(x.families), cb = count(y.families);
  if (!a.representative || !b.representative) reasons.push("Both windows must be marked representative: normal traffic, after warm-up, without a restore or bulk import.");
  if (Math.min(da, db) < 60) reasons.push("Each observation needs at least 60 seconds.");
  if (Math.max(da, db) / Math.min(da, db) > 1.2) reasons.push("Observation durations differ by more than 20%.");
  if (a.major !== b.major) reasons.push("PostgreSQL major versions differ; query matching and planner behavior may differ.");
  if (Math.min(ca, cb) < 100) reasons.push("Each window needs at least 100 query calls.");
  if (Math.min(ca, cb) > 0 && Math.max(ca / da, cb / db) / Math.min(ca / da, cb / db) > 1.25) reasons.push("Traffic rates differ by more than 25%.");
  const families = /* @__PURE__ */ new Set([...x.families.keys(), ...y.families.keys()]);
  const variation = [...families].reduce((s, f) => s + Math.abs((x.families.get(f)?.calls ?? 0) / (ca || 1) - (y.families.get(f)?.calls ?? 0) / (cb || 1)), 0) / 2;
  if (variation > 0.15) reasons.push("The query mix changed by more than 15%; compare equivalent traffic.");
  const queries2 = [];
  for (const [family, before] of x.families) {
    const after = y.families.get(family);
    if (!after || Math.min(before.calls, after.calls) < 20 || before.ms <= 0) continue;
    if (Math.max(before.rows / before.calls, after.rows / after.calls) > 1.25 * Math.max(1, Math.min(before.rows / before.calls, after.rows / after.calls))) {
      reasons.push(`Query ${family.slice(0, 8)} processes a different number of rows per call.`);
      continue;
    }
    const beforeMs = before.ms / before.calls, afterMs = after.ms / after.calls, changePct = (afterMs / beforeMs - 1) * 100;
    queries2.push({ family, beforeMs, afterMs, changePct, beforeCalls: before.calls, afterCalls: after.calls, status: changePct >= 20 && afterMs - beforeMs >= 1 ? "slower" : changePct <= -20 && beforeMs - afterMs >= 1 ? "faster" : "similar" });
  }
  if (!queries2.length) reasons.push("No matching query family has at least 20 calls in both windows.");
  return { comparable: !reasons.length, reasons: [...new Set(reasons)], queries: reasons.length ? [] : queries2.sort((a2, b2) => b2.changePct - a2.changePct), notes: [
    "Compares mean database execution time, not API, network or pooler latency. This is evidence of a timing change, not proof of its cause.",
    "Targeted counter resets on older PostgreSQL versions may be undetectable if counters regrow during the window. Avoid resetting statistics while observing.",
    "Query families match exact representative SQL hashes; changed formatting or SQL may remain unmatched. No SQL text is saved.",
    ...a.provider !== b.provider ? ["The hosting provider changed. Check compute size, pooler behavior and provider metrics before attributing a timing change to the migration."] : []
  ] };
}
function workloadText(c) {
  if (!c.comparable) return ["COMPARISON INCONCLUSIVE", ...c.reasons.map((r) => `  \u2022 ${r}`), "", "Next: observe the same workload for the same duration after traffic and caches settle."].join("\n");
  return ["WORKLOAD COMPARISON", ...c.queries.map((q) => `  ${q.status.toUpperCase().padEnd(8)} ${q.family.slice(0, 12)}  ${q.beforeMs.toFixed(2)} \u2192 ${q.afterMs.toFixed(2)} ms/call (${q.changePct >= 0 ? "+" : ""}${q.changePct.toFixed(1)}%)  ${q.beforeCalls}/${q.afterCalls} calls`), "", ...c.notes].join("\n");
}

// src/schedule.ts
var CRON = { daily: "17 6 * * *", weekly: "17 6 * * 1" };
var WHEN = { daily: "every day at 06:17 UTC", weekly: "every Monday at 06:17 UTC" };
function githubWorkflow(every = "weekly") {
  return `# Runs pg-checkup ${WHEN[every]} and uploads the statistics file to your pgcheckup.com account.
# Secrets (Settings, Secrets and variables, Actions):
#   DATABASE_URL     a statistics-only login (pg-checkup role prints the SQL to create one)
#   PGCHECKUP_TOKEN  from Settings on pgcheckup.com; it can only add reports to your account
name: pg-checkup
on:
  schedule:
    - cron: "${CRON[every]}"
  workflow_dispatch:
jobs:
  checkup:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - name: Run the checkup and upload it
        env:
          DATABASE_URL: \${{ secrets.DATABASE_URL }}
          PGCHECKUP_TOKEN: \${{ secrets.PGCHECKUP_TOKEN }}
        run: |
          npx --yes pg-checkup --no-input --no-pace --no-color -o checkup.json
          npx --yes pg-checkup upload checkup.json --yes --no-input
`;
}
function crontabLine(every = "weekly") {
  const f = CRON[every].split(" ");
  return `${f.join(" ")} cd "$(mktemp -d)" && npx --yes pg-checkup --no-input --no-pace --no-color -o checkup.json && npx --yes pg-checkup upload checkup.json --yes --no-input`;
}
var SCHEDULE_NOTES = (target) => [
  `Your connection string stays in ${target === "github" ? "your repository's secrets" : "this machine's environment"}. pgcheckup.com receives only the statistics file, and only through the token.`,
  `Each upload is compared with the previous one for the same database, so the report shows what was fixed, what is new, and what is getting worse.`,
  target === "github" ? `GitHub-hosted runners have changing IP addresses. If your database only allows listed addresses, use a self-hosted runner inside your network.` : `The machine running this must be able to reach the database.`
];

// src/collector-cli.ts
var parsed = (() => {
  let p;
  const program = buildProgram(COLLECTOR_VERSION, (x) => {
    p = x;
  });
  try {
    program.parse(normalizeArgv(process.argv.slice(2)), { from: "user" });
  } catch (e) {
    if (e instanceof CommanderError2) process.exit(e.code === "commander.helpDisplayed" || e.code === "commander.help" || e.code === "commander.version" ? 0 : 2);
    if (e instanceof UsageError) {
      process.stderr.write(`pg-checkup: ${e.message}
`);
      process.exit(2);
    }
    throw e;
  }
  if (!p) process.exit(0);
  return p;
})();
var cmd = parsed.command;
var { options, positionals } = parsed;
var flag = (n) => options[n] === true;
var opt = (n) => typeof options[n] === "string" ? options[n] : void 0;
var tty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
var canPrompt = Boolean(process.stdin.isTTY && process.stderr.isTTY) && !flag("no-input") && !flag("no-password");
var color = Boolean(process.stdout.isTTY) && !flag("no-color") && !process.env.NO_COLOR && process.env.TERM !== "dumb";
var ink = (n, s) => color ? `\x1B[${n}m${s}\x1B[0m` : s;
var bold = (s) => ink(1, s);
var say = (s = "") => process.stderr.write(terminalText(s) + "\n");
var out = (s = "") => process.stdout.write(terminalText(s) + "\n");
var SITE = (process.env.PGCHECKUP_URL ?? "https://pgcheckup.com").replace(/\/+$/, "");
var HOST = new URL(SITE).host;
var sha = (s) => createHash2("sha256").update(s).digest("hex");
var json = (v) => JSON.stringify(v, null, 2) + "\n";
var USAGE = `Usage: pg-checkup [postgres://URL | -h HOST -p PORT -U USER -d DBNAME] [options]
       pg-checkup show FILE | role | sql | --help

Examples:
  pg-checkup postgres://checkup_reader@db.example.com/app
  pg-checkup -h db.example.com -U checkup_reader -d app
  PGSERVICE=prod pg-checkup`;
var UsageError2 = class extends Error {
};
var listening = (port) => new Promise((done) => {
  const s = net2.connect({ host: "127.0.0.1", port });
  const end = (v) => {
    s.destroy();
    done(v);
  };
  s.setTimeout(200, () => end(false));
  s.once("connect", () => end(true));
  s.once("error", () => end(false));
});
async function localHints() {
  const [pg2, supabase] = await Promise.all([listening(5432), listening(54322)]);
  const hints = [pg2 ? "\nA Postgres is listening on localhost:5432:  pg-checkup -h localhost" : "", supabase ? "\nSupabase local is listening on 54322:         pg-checkup postgres://postgres:postgres@127.0.0.1:54322/postgres" : ""].filter(Boolean);
  return hints.length ? "\n" + hints.join("") + "\n" : "";
}
var stamp = () => (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-").slice(0, 19) + "-" + randomBytes(2).toString("hex");
function save(value, prefix, password = "") {
  const file = opt("out") ?? `${prefix}-${stamp()}.json`;
  const text = json(value);
  const esc3 = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (password && new RegExp(`postgres(?:ql)?://[^\\s"'@/]*:(?:${esc3(password)}|${esc3(encodeURIComponent(password))})@`).test(text)) throw new Error("The result contains the connection password. Nothing was saved.");
  writeFileSync(file, text, { mode: 384, flag: "wx" });
  return { file, text };
}
function load(file) {
  if (!file) throw new Error(`Missing file. Run pg-checkup --help.`);
  let size;
  try {
    size = statSync2(file).size;
  } catch (e) {
    if (e.code === "ENOENT") throw new Error(`File not found: ${file}`);
    throw e;
  }
  if (size > MAX_BUNDLE_BYTES) throw new Error("File exceeds the 3 MB inspection limit.");
  const text = readFileSync2(file, "utf8");
  try {
    return { text, value: JSON.parse(text) };
  } catch {
    throw new Error(`${file} is not valid JSON.`);
  }
}
function parseSnapshot(value) {
  const s = value;
  if (!s || s.format !== SNAPSHOT_FORMAT || s.version !== 1 || !s.server || !s.database || !s.objects || !s.tables || !s.settings || !s.sequenceValues || !["generic", "supabase", "neon"].includes(s.provider)) throw new Error("Not a supported migration baseline.");
  for (const o of Object.values(s.objects)) if (!o || typeof o !== "object" || Object.values(o).some((v) => typeof v !== "string")) throw new Error("Invalid baseline objects.");
  return s;
}
async function connection2() {
  const given = positionals.find((a) => /^postgres(ql)?:\/\//.test(a));
  const url = given ?? (process.env.DATABASE_URL || void 0);
  let r = resolveConnection({ url, host: opt("host"), port: opt("port"), user: opt("user"), database: opt("database"), sslmode: opt("sslmode"), service: opt("service") });
  let source = given ? "the URL given" : url ? "DATABASE_URL" : r?.parts ? opt("host") || opt("user") || opt("database") ? "the -h/-U/-d flags" : opt("service") || process.env.PGSERVICE ? `service "${opt("service") ?? process.env.PGSERVICE}"` : "the PG* environment" : "";
  if (!r) {
    const env = readEnvFileUrl();
    if (env) {
      source = `${env.key} in ./${env.file}`;
      r = resolveConnection({ url: env.url });
    }
  }
  if (!r) throw new UsageError2(`no database given.

${USAGE}

Also read: DATABASE_URL in ./.env or ./.env.local.${await localHints()}
Run pg-checkup --help for everything else.`);
  say(`Read-only: runs SELECTs on pg_catalog and pg_stat views only; never writes, reads no table rows, sends nothing anywhere.`);
  say(`Connecting with ${source}: ${redactUrl(r.url)}`);
  let full = r.url;
  if (r.structured && r.parts) {
    const wantPrompt = flag("password") || r.needsPassword && canPrompt;
    if (wantPrompt) full = withPassword(full, await askHidden(`Password for ${r.parts.user}@${r.parts.host} (hidden): `, process.stdin, process.stderr));
  }
  return { url: full, database: r.database, password: decodeURIComponent(new URL(full).password) };
}
var provider2 = opt("provider");
var allowPrivilegedRole = flag("allow-privileged-role");
var snapshotOptionsFor = (url) => ({ provider: provider2, allowPrivilegedRole: allowPrivilegedRole || isLocalHost(url) });
var SEV_MARK = color ? { critical: ink(31, "\u25CF"), warning: ink(33, "\u25CF"), info: ink(34, "\u25CF") } : { critical: "\u2717", warning: "!", info: "\xB7" };
var SEV_INK = { critical: 31, warning: 33, info: 34 };
var GROUP_INK = { now: 31, next: 33, watch: 34, ignore: 2 };
var paced = Boolean(process.stdout.isTTY) && !flag("no-pace");
var pause = (ms) => paced ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
var rule = () => dim("\u2500".repeat(Math.min(WIDTH, 72)));
var dim = (s) => ink(2, s);
var WIDTH = Math.min(Math.max(process.stdout.columns ?? 100, 60), 120);
function wrap(text, pad = 4, first = pad) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let line = " ".repeat(first);
  let lead = first;
  for (const w of words) {
    if (line.length > lead && line.length + 1 + w.length > WIDTH) {
      lines.push(line);
      line = " ".repeat(pad);
      lead = pad;
    }
    line += (line.length > lead ? " " : "") + w;
  }
  if (line.length > lead) lines.push(line);
  return lines;
}
var para = (text, pad = 4, first = pad) => wrap(text, pad, first).forEach((l) => out(l));
var plural = (n, one2, many = one2 + "s") => `${n} ${n === 1 ? one2 : many}`;
var SEV_RANK = ["critical", "warning", "info"];
async function printReport(r, b, file) {
  const findings = r.findings;
  const count = (s) => findings.filter((f) => f.severity === s).length;
  const active = r.checks.filter((c) => c.status !== "na");
  const passed = active.filter((c) => c.status === "passed");
  const skipped = active.filter((c) => c.status === "skipped");
  const na = r.checks.length - active.length;
  const version = b.server.version.split(" on ")[0].split(",")[0];
  const sev = SEV_RANK.map((x) => count(x)).some(Boolean) ? SEV_RANK.filter((x) => count(x)).map((x) => ink(SEV_INK[x], `${count(x)} ${x}`)).join(dim(" \xB7 ")) : ink(32, "nothing flagged");
  out(`${bold(version)}${b.hosting ? dim(`  ${b.hosting}`) : ""}  ${sev}`);
  const step = Math.min(450, Math.round(5e3 / Math.max(findings.length, 1)));
  if (findings.length > 1) out(`${dim("Start here:")} ${findings[0].title}`);
  const limited = evidenceWindowHours(b);
  if (limited !== null && limited < 1) out(ink(33, `Statistics cover only ${plural(Math.max(1, Math.round(limited * 60)), "minute")}. Findings about queries, scans and unused indexes need real traffic; run again after the database has been busy.`));
  await pause(step);
  for (const p of PRIORITIES) {
    const group = findings.filter((f) => (f.priority ?? "watch") === p);
    if (!group.length) continue;
    out();
    out(`${ink(GROUP_INK[p], bold(PRIORITY_LABEL[p].toUpperCase()))}  ${dim(`${group.length}`)}`);
    out(rule());
    for (const f of group) {
      out(`${SEV_MARK[f.severity]} ${bold(f.title)}  ${dim(f.category)}`);
      if (f.note) para(f.cause ? `${f.confidence === "likely" ? "Likely, from the findings together: " : "Shown by the statistics: "}${f.note}` : f.note);
      para(`${dim("Why:")} ${f.why}`);
      para(`${dim("Fix:")} ${f.fix}`);
      await pause(step);
    }
  }
  out();
  const tail = [plural(passed.length, "check") + " passed", skipped.length ? `${skipped.length} skipped` : "", na ? `${na} not applicable here` : ""].filter(Boolean).join(", ");
  out(`${tail}.${flag("verbose") ? "" : " -v lists them."}`);
  if (flag("verbose")) {
    for (const c of passed) out(dim(`${ink(32, "\u2713")} ${c.title}${c.reason ? ": " + c.reason : ""}`));
    for (const c of skipped) out(dim(`- ${c.title}: ${firstSentence(c.reason ?? "")}`));
    for (const c of r.checks.filter((x) => x.status === "na")) out(dim(`  ${c.title}: ${firstSentence(c.reason ?? "")}`));
  } else {
    for (const c of skipped) out(dim(`- ${c.title}: ${firstSentence(c.reason ?? "")}`));
  }
  if (!b.session.monitor) out(dim(`${b.session.role} is not in pg_monitor, so other sessions' activity may be missing.`));
  if (file) {
    const rows3 = b.datasets.reduce((n, d) => n + d.rows.length, 0);
    out();
    out(`Saved ${file}: ${rows3} rows of statistics and catalog metadata, ${b.queryText === "removed" ? "no SQL text" : "SQL text with literals masked"}, no table data. Object and role names are in it; read it before sharing.`);
    out(`  every row:                   pg-checkup show ${quote(file)} --all`);
    out(`  did a fix work:              pg-checkup compare EARLIER.json ${quote(file)}`);
    out(`  shareable report, fix SQL:   pg-checkup upload ${quote(file)}   (sends this file to ${HOST}, nothing else)`);
  }
}
function evidenceWindowHours(b) {
  const at = Date.parse(b.collectedAt);
  const reset = b.datasets.find((d) => d.id === "l_db")?.rows[0]?.stats_reset;
  if (reset && Date.parse(String(reset))) return (at - Date.parse(String(reset))) / 36e5;
  const up = Number(b.vitals?.uptime_s);
  return Number.isFinite(up) && up > 0 ? up / 3600 : null;
}
var fails = (findings) => {
  const at = opt("fail-on");
  return at ? findings.some((f) => SEV_RANK.indexOf(f.severity) <= SEV_RANK.indexOf(at)) : false;
};
function strictFails(b) {
  if (!flag("strict")) return false;
  const broken = b.datasets.filter((d) => d.error);
  if (!broken.length) return false;
  say(`--strict: ${broken.length} diagnostic ${broken.length === 1 ? "view" : "views"} could not be read:`);
  for (const d of broken) say(`  - ${d.title ?? d.id}: ${firstSentence(d.error)}`);
  return true;
}
var markdown = (r, b) => toMarkdown(r.findings, r.datasets, { version: r.serverVersion, provider: r.provider, scannedAt: b.collectedAt, checks: r.checks });
var withAnalysis = (b, r) => ({ ...b, findings: r.findings, checks: r.checks, skipped: r.skipped });
var firstSentence = (s) => (s.match(/^[^.:]*[.:]?/)?.[0] ?? s).replace(/[.:]$/, "").trim();
var quote = (f) => /[^\w./-]/.test(f) ? JSON.stringify(f) : f;
function allRows(b) {
  const text = b.datasets.map((d) => `${d.id} \u2014 ${d.title ?? d.id}
${d.note ?? d.error ?? ""}
${json(d.rows)}`).join("\n");
  if (tty) {
    const result = spawnSync("less", ["-S"], { input: terminalText(text), stdio: ["pipe", "inherit", "inherit"] });
    if (!result.error && result.status === 0) return;
  }
  out(text);
}
function validateDestination(url) {
  const u = new URL(url);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname))) throw new Error("Uploads require HTTPS (HTTP is allowed only on localhost).");
  if (u.username || u.password) throw new Error("Upload destinations cannot contain credentials.");
  return u;
}
async function confirm(q) {
  if (flag("yes")) return true;
  if (!canPrompt) throw new Error("upload needs confirmation. Add --yes to upload without a prompt.");
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^y(es)?$/i.test((await rl.question(q)).trim());
  } finally {
    rl.close();
  }
}
async function upload(text, file) {
  validateDestination(SITE);
  const token = process.env.PGCHECKUP_TOKEN?.trim();
  const b = parseBundle(JSON.parse(text));
  const rows3 = b.datasets.reduce((n, d) => n + d.rows.length, 0);
  say(`This sends ${file} (${(Buffer.byteLength(text) / 1024).toFixed(0)} KB: ${rows3} rows of statistics, ${b.queryText === "removed" ? "no SQL text" : "masked SQL text"}, no table data) to ${HOST}.`);
  const code = opt("send");
  if (code !== void 0 && !/^[a-f0-9]{32}$/.test(code)) throw new Error("--send needs the code shown on pgcheckup.com/scan. Copy the whole command from the page.");
  say(token ? `Saved to your account (PGCHECKUP_TOKEN is set). On the plan it is a full report with fix SQL, kept, and compared with your last checkup of this database.` : `You get the same findings as a shareable web page with the evidence tables. Kept 7 days under an unguessable link; anyone with the link can read it. "pg-checkup delete" removes it. Set PGCHECKUP_TOKEN (Settings on the site) to save it to your account.`);
  if (code) say("Sending it because you passed --send; the page that showed the code opens the report.");
  else if (!await confirm("Upload? [y/N] ")) {
    say("Not uploaded.");
    return;
  }
  say(`Uploading\u2026`);
  const res = await fetch(`${SITE}/api/bundle`, { method: "POST", headers: { "content-type": "application/json", ...token ? { authorization: `Bearer ${token}` } : {}, ...code ? { "x-pgcheckup-handoff": code } : {} }, body: text, signal: AbortSignal.timeout(6e4), redirect: "error" });
  const r = await res.json();
  if (!res.ok || !r.url || !r.id || !r.key) throw new Error(`Upload refused: ${r.error ?? res.status}. Your local file is unchanged.`);
  if (new URL(r.url).origin !== new URL(SITE).origin) throw new Error("The server returned a report on a different origin. Check PGCHECKUP_URL.");
  const receipt = `${file.replace(/\.json$/, "")}.${stamp()}.receipt.json`;
  writeFileSync(receipt, json({ report: r.url, id: r.id, deleteKey: r.key, sha256: sha(text), uploadedAt: (/* @__PURE__ */ new Date()).toISOString() }), { flag: "wx", mode: 384 });
  if (r.sha256 !== sha(text)) throw new Error(`The server's hash does not match your file. Treat the upload as unverified: pg-checkup delete ${quote(receipt)} removes it.`);
  const report = new URL(r.url);
  if (flag("json")) out(json({ report: String(report), receipt, sha256: r.sha256, ...r.account ? { account: r.account, full: Boolean(r.full) } : {} }));
  else {
    out(`Report:  ${report}`);
    if (r.account) out(`Saved to ${r.account}${r.full ? " as a full report" : ""}${r.previous ? ", compared with your previous checkup of this database" : ""}.`);
    out(`Receipt: ${receipt}  (pg-checkup delete ${quote(receipt)} removes the report)`);
  }
}
async function scan() {
  const c = await connection2();
  const local = isLocalHost(c.url);
  const t0 = Date.now();
  let tls = false, verified = false;
  const b = await collect(c.url, {
    provider: provider2,
    queryText: flag("include-query-text") ? "masked" : "removed",
    checkRole: (r2) => {
      if (allowPrivilegedRole) return;
      if (!local) return requireMonitoringRole(r2);
      if (roleProblems(r2).length) say(`${r2.role} can read tables. Accepted because the database is on this machine; a remote database needs a statistics-only login (pg-checkup role).`);
    },
    progress: (e) => {
      if (e.step === "connected") {
        tls = e.tls;
        verified = e.verified;
        return;
      }
      if (process.stderr.isTTY && !flag("json")) process.stderr.write(`\rReading statistics views ${e.done}/${e.total}\u2026\x1B[K`);
    }
  });
  if (process.stderr.isTTY && !flag("json")) process.stderr.write("\r\x1B[K");
  say(`Connected ${tls ? verified ? "with TLS, certificate verified" : "with TLS, certificate not verified" : "without TLS"}${allowPrivilegedRole ? ", privileged-role check skipped" : ""}; read ${b.datasets.length} statistics views in ${((Date.now() - t0) / 1e3).toFixed(1)} s`);
  if (tls && !verified && !local) say(`Certificate verification is disabled for this connection. To require verification: sslmode=verify-full in the URL, and PGSSLROOTCERT=path to your provider's CA file.`);
  if (flag("include-query-text")) say("SQL text is kept with literals masked. Comments and identifiers can still be sensitive; read the file before sharing.");
  const saved = save(b, `pg-checkup-${safeName(c.database)}`, c.password);
  const r = await analyze(b, { provider: provider2 });
  const code = fails(r.findings) || strictFails(b) ? 1 : 0;
  if (flag("json")) {
    say(`Saved ${saved.file}`);
    process.stdout.write(json(withAnalysis(b, r)));
    return code;
  }
  if (flag("md")) {
    say(`Saved ${saved.file}`);
    process.stdout.write(markdown(r, b));
    return code;
  }
  out();
  await printReport(r, b, saved.file);
  if (flag("upload") || opt("send")) {
    out();
    await upload(saved.text, saved.file);
  }
  return code;
}
async function main() {
  if (cmd === "role") {
    out(MONITOR_ROLE_SQL);
    return 0;
  }
  if (cmd === "schedule") {
    const every = opt("every") === "daily" ? "daily" : "weekly";
    if (flag("cron")) {
      out(crontabLine(every));
      for (const n of SCHEDULE_NOTES("cron")) say(n);
      return 0;
    }
    const yaml = githubWorkflow(every);
    if (flag("write")) {
      const path = ".github/workflows/pg-checkup.yml";
      if (existsSync(path)) throw new Error(`${path} already exists; it was not changed.`);
      mkdirSync(".github/workflows", { recursive: true });
      writeFileSync(path, yaml, { flag: "wx" });
      say(`Wrote ${path}. Add the two secrets it lists, commit it, and run it once from the Actions tab.`);
    } else out(yaml);
    for (const n of SCHEDULE_NOTES("github")) say(n);
    return 0;
  }
  if (cmd === "sql") {
    for (const s of statements(provider2)) out(`-- ${s.id}: ${s.title}
${s.sql};
`);
    out(`-- Observation metadata and counters (PostgreSQL 14+)
${WINDOW_META_SQL};
${WORKLOAD_SQL};`);
    return 0;
  }
  if (cmd === "doctor") {
    out(`pg-checkup ${COLLECTOR_VERSION}, Node ${process.version} on ${process.platform}`);
    const c = await connection2();
    const { db, tls, verified, local } = await openReadOnlySession(c.url);
    try {
      const [{ v, s }] = (await db.query(`select current_setting('server_version_num')::int as v, version() as s`)).rows;
      out(`${tls && !verified && !local ? ink(33, "!") : ink(32, "\u2713")} Connected: ${String(s).split(" on ")[0].split(",")[0]} (${v}), ${tls ? verified ? "TLS, certificate verified" : "TLS, certificate not verified" : "no TLS"}, read-only session${local ? ", local" : ""}`);
      if (tls && !verified && !local) out(`    To require verification: sslmode=verify-full in the URL, and PGSSLROOTCERT=path to your provider's CA file.`);
      const role = roleInfo((await db.query(roleSql(profileFor(provider2 ?? providerIdFromUrl(c.url))))).rows[0] ?? {});
      const problems = roleProblems(role);
      out(`${problems.length ? local ? ink(33, "!") : ink(31, "\u2717") : ink(32, "\u2713")} Login ${role.role}: ${role.monitor ? "in pg_monitor" : "not in pg_monitor (other sessions may be hidden)"}${problems.length ? "" : ", statistics only"}`);
      for (const p of problems) out(`    - ${p}`);
      if (problems.length) out(`    ${local ? "Accepted for a local database." : "A checkup of a remote database stops here. Create a statistics-only login: pg-checkup role"}`);
      const ext = (await db.query(`select extname from pg_extension`)).rows.map((r) => r.extname);
      out(`${ext.includes("pg_stat_statements") ? ink(32, "\u2713") : ink(33, "!")} pg_stat_statements ${ext.includes("pg_stat_statements") ? "installed" : "not installed: query checks will be skipped"}`);
      out(`${ext.includes("pgstattuple") ? ink(32, "\u2713") : ink(2, "-")} pgstattuple ${ext.includes("pgstattuple") ? "installed" : "not installed: bloat is estimated, not measured"}`);
      return problems.length && !local ? 3 : 0;
    } finally {
      await db.end();
    }
  }
  if (cmd === "show" || cmd === "upload") {
    const { text, value } = load(positionals[0]);
    const b = parseBundle(value);
    if (cmd === "show") {
      const r = await analyze(b, { provider: provider2 });
      const code = fails(r.findings) || strictFails(b) ? 1 : 0;
      if (flag("json")) {
        process.stdout.write(json(withAnalysis(b, r)));
        return code;
      }
      if (flag("md")) {
        process.stdout.write(markdown(r, b));
        return code;
      }
      out(dim(`${positionals[0]}, collected ${b.collectedAt.replace("T", " ").slice(0, 16)} UTC`));
      await printReport(r, b);
      if (flag("all")) {
        out();
        allRows(b);
      } else out(dim(`
Every row: pg-checkup show ${quote(positionals[0])} --all`));
      return code;
    }
    await upload(text, positionals[0]);
    return 0;
  }
  if (cmd === "delete") {
    const { value: r } = load(positionals[0]);
    if (!r.report || !/^[a-f0-9]{32}$/.test(r.id) || typeof r.deleteKey !== "string") throw new Error("Not a deletion receipt.");
    const u = validateDestination(r.report);
    if (u.origin !== new URL(SITE).origin) throw new Error("Receipt belongs to a different server. Set PGCHECKUP_URL to that server to delete from it.");
    const res = await fetch(`${u.origin}/api/report/${r.id}`, { method: "DELETE", headers: { "content-type": "application/json" }, body: json({ key: r.deleteKey }), signal: AbortSignal.timeout(3e4), redirect: "error" });
    if (res.status !== 204 && res.status !== 404) throw new Error(`Deletion refused (HTTP ${res.status}).`);
    if (flag("json")) out(json({ deleted: true }));
    else out("Report deleted (or already gone).");
    return 0;
  }
  if (cmd === "baseline") {
    const c = await connection2();
    say("Saving schema, security and settings. Nothing is uploaded.");
    const s = await takeSnapshot(c.url, snapshotOptionsFor(c.url));
    const { file, text } = save(s, `pg-checkup-baseline-${safeName(c.database)}`, c.password);
    if (flag("json")) {
      say(`Saved ${file}`);
      process.stdout.write(text);
      return 0;
    }
    out(`Saved ${file}: ${Object.values(s.objects).reduce((n, o) => n + Object.keys(o).length, 0)} objects.`);
    out(`After the migration: pg-checkup verify ${quote(file)} -h NEW_HOST -U checkup_reader -d ${safeName(c.database)}`);
    out("Runtime performance is a separate step: pg-checkup observe on each side, then compare.");
    return 0;
  }
  if (cmd === "observe") {
    const c = await connection2();
    const seconds = Number(opt("seconds") ?? 300);
    say(`Observing ${seconds} s of existing traffic. No benchmark queries, nothing uploaded.`);
    const w = await observe(c.url, { ...snapshotOptionsFor(c.url), seconds, representative: flag("representative"), label: opt("label"), progress: (n) => {
      if (n % 30 === 0) say(`${n} s remaining\u2026`);
    } });
    const { file, text } = save(w, `pg-checkup-window-${safeName(c.database)}`, c.password);
    if (flag("json")) {
      say(`Saved ${file}`);
      process.stdout.write(text);
      return 0;
    }
    out(`Saved ${file}.`);
    out(`Compare: pg-checkup compare ${quote(file)} AFTER.json`);
    if (!w.representative) out("This window is exploratory. Pass --representative only after caches are warm and normal traffic has resumed.");
    return 0;
  }
  if (cmd === "compare" || cmd === "verify") {
    const before = load(positionals[0]).value;
    const second = positionals.slice(1).find((s) => !/^postgres(ql)?:\/\//.test(s));
    if (before.format === BUNDLE_FORMAT) {
      const [x, y] = [parseBundle(before), parseBundle(load(second).value)];
      const [rx, ry] = [await analyze(x, { provider: provider2 }), await analyze(y, { provider: provider2 })];
      const c = compareCheckups({ bundle: x, findings: rx.findings, checks: rx.checks, vitals: rx.vitals }, { bundle: y, findings: ry.findings, checks: ry.checks, vitals: ry.vitals });
      if (flag("json")) process.stdout.write(json(c));
      else out(checkupComparisonText(c));
      return c.sameDatabase === false ? 4 : c.regression ? 1 : 0;
    }
    if (before.format === WINDOW_FORMAT) {
      const result = compareWorkloads(parseWindow(before), parseWindow(load(second).value));
      if (flag("json")) process.stdout.write(json(result));
      else out(workloadText(result));
      return !result.comparable ? 4 : result.queries.some((q) => q.status === "slower") ? 1 : 0;
    }
    const a = parseSnapshot(before);
    const after = second ? parseSnapshot(load(second).value) : await (async () => {
      const c = await connection2();
      return takeSnapshot(c.url, snapshotOptionsFor(c.url));
    })();
    const differences = diffSnapshots(a, after);
    if (flag("json")) process.stdout.write(json(differences));
    else out(diffText(differences, a, after));
    return differences.some((d) => d.verdict === "regression") ? 1 : 0;
  }
  return scan();
}
function failure(e) {
  if (e instanceof UsageError2) {
    say(`pg-checkup: ${e.message}`);
    return 2;
  }
  if (e instanceof RoleRefused) {
    say(`${ink(31, "\u2717")} Stopped before reading anything: this login has more access than a checkup needs.`);
    for (const p of e.problems) say(`    - ${p}`);
    say(`
  Create a statistics-only login (this is also what "pg-checkup role" prints):
`);
    for (const line of MONITOR_ROLE_SQL.split("\n")) say(`    ${line}`);
    say(`
  Then run again as checkup_reader. To go ahead with this login anyway: --allow-privileged-role`);
    return 3;
  }
  const messages = {
    EEXIST: "That output file already exists and was kept. Choose another --out path.",
    ENOTFOUND: "Host not found. Check -h/--host or the hostname in the URL.",
    ECONNREFUSED: "Connection refused. Is Postgres listening on that host and port? Check -h and -p.",
    ETIMEDOUT: "Connection timed out. Check the host, port, firewall and VPN.",
    "28P01": "Password authentication failed. Check -U/--user and the password: a URL, PGPASSWORD, ~/.pgpass, or the prompt when run in a terminal.",
    "28000": "The server rejected this login (pg_hba.conf). Check the user, database and connection method.",
    "3D000": "Database not found. Check -d/--dbname.",
    "57P03": "The server is starting up or shutting down. Try again shortly."
  };
  const message = messages[e.code] ?? (e.code ? `Database or system error (${e.code}). Check the connection settings and the role's permissions.` : String(e.message ?? e).replace(/postgres(?:ql)?:\/\/\S+/gi, "[connection hidden]"));
  say(`pg-checkup: ${message}`);
  return 2;
}
process.on("SIGINT", () => {
  process.stderr.write("\nCancelled. Files already saved are kept.\n");
  process.exit(130);
});
main().then((code) => {
  process.exitCode = code;
}).catch((e) => {
  process.exitCode = failure(e);
});
//# sourceMappingURL=pg-checkup.js.map
