import type { Ctx } from "./types.js";
import type { Column, ColKind, Dataset, Vital } from "./sections.js";
import { type Def, C, NUMERIC, us, ut, inDb, pgss, setting, safeValue, maskSql, isConnectionLost, SETTING_COLS } from "./dsutil.js";
import { MORE } from "./inspect_more.js";
import { CAP } from "./inspect_cap.js";
import { OPS } from "./inspect_ops.js";

export const DEFS: Def[] = [
  // ───────── Queries
  { id: "q_total", section: "queries", title: "Heaviest queries by total time", source: "pg_stat_statements", ext: "pg_stat_statements", limit: 25,
    description: "Statements that consumed the most cumulative execution time. Optimizing the top few has the biggest payoff. Catalog-reading statements (dashboards, ORMs introspecting the schema, monitoring agents) and provider-internal roles are left out so this shows the application's own load.",
    columns: [C("total_ms", "Total", "ms"), C("pct", "% of load", "pct", { warn: 20, bad: 40 }), C("calls", "Calls", "int"), C("mean_ms", "Mean", "ms"), C("rows", "Rows", "int"), C("role", "Role"), C("query", "Query", "mono")],
    sql: (c) => `select round(s.total_exec_time)::bigint as total_ms, round((100 * s.total_exec_time / nullif(sum(s.total_exec_time) over (), 0))::numeric, 1) as pct,
      md5(s.query) as fingerprint, s.calls, round(s.mean_exec_time::numeric, 2) as mean_ms, s.rows, r.rolname::text as role, ${maskSql("s.query", 600)} as query,
      round(sum(s.total_exec_time) over ())::bigint as workload_ms
      ${pgss(c)} order by s.total_exec_time desc limit 25` },
  { id: "q_mean", section: "queries", title: "Slowest queries per call", source: "pg_stat_statements", ext: "pg_stat_statements", limit: 25,
    description: "Highest average latency (called at least 5 times). These are the ones users feel.",
    columns: [C("mean_ms", "Mean", "ms", { warn: 500, bad: 2000 }), C("max_ms", "Max", "ms"), C("stddev_ms", "Std dev", "ms"), C("calls", "Calls", "int"), C("total_ms", "Total", "ms"), C("query", "Query", "mono")],
    sql: (c) => `select round(s.mean_exec_time::numeric, 1) as mean_ms, round(s.max_exec_time::numeric, 1) as max_ms, round(s.stddev_exec_time::numeric, 1) as stddev_ms,
      s.calls, round(s.total_exec_time)::bigint as total_ms, ${maskSql("s.query", 600)} as query
      ${pgss(c)} and s.calls >= 5 order by s.mean_exec_time desc limit 25` },
  { id: "q_io", section: "queries", title: "Most disk-read queries", source: "pg_stat_statements", ext: "pg_stat_statements", limit: 20,
    description: "Statements reading the most blocks from disk instead of cache.",
    columns: [C("disk_bytes", "Read from disk", "bytes"), C("hit_pct", "Cache hit", "pct"), C("calls", "Calls", "int"), C("mean_ms", "Mean", "ms"), C("query", "Query", "mono")],
    sql: (c) => `select s.shared_blks_read * 8192 as disk_bytes, round((100.0 * s.shared_blks_hit / nullif(s.shared_blks_hit + s.shared_blks_read, 0))::numeric, 1) as hit_pct,
      s.calls, round(s.mean_exec_time::numeric, 1) as mean_ms, ${maskSql("s.query", 600)} as query
      ${pgss(c)} and s.shared_blks_read > 0 order by s.shared_blks_read desc limit 20` },
  { id: "q_calls", section: "queries", title: "Most frequent queries", source: "pg_stat_statements", ext: "pg_stat_statements", limit: 20,
    description: "Very high call counts with tiny latency often point at N+1 patterns or missing caching.",
    columns: [C("calls", "Calls", "int"), C("mean_ms", "Mean", "ms"), C("total_ms", "Total", "ms"), C("rows_per_call", "Rows/call", "int"), C("query", "Query", "mono")],
    sql: (c) => `select s.calls, round(s.mean_exec_time::numeric, 3) as mean_ms, round(s.total_exec_time)::bigint as total_ms, (s.rows / nullif(s.calls, 0))::bigint as rows_per_call, ${maskSql("s.query", 600)} as query
      ${pgss(c)} order by s.calls desc limit 20` },
  { id: "q_temp", section: "queries", title: "Queries spilling to temp files", source: "pg_stat_statements", ext: "pg_stat_statements", limit: 15,
    description: "Sorts and hashes that exceed work_mem and write to disk.",
    columns: [C("temp_bytes", "Temp written", "bytes"), C("calls", "Calls", "int"), C("mean_ms", "Mean", "ms"), C("query", "Query", "mono")],
    sql: (c) => `select s.temp_blks_written * 8192 as temp_bytes, s.calls, round(s.mean_exec_time::numeric, 1) as mean_ms, ${maskSql("s.query", 600)} as query
      ${pgss(c)} and s.temp_blks_written > 0 order by s.temp_blks_written desc limit 15` },
  { id: "q_wal", section: "queries", title: "Queries generating the most WAL", source: "pg_stat_statements", ext: "pg_stat_statements", limit: 15,
    description: "Heavy WAL writers drive replication lag, archive backlog and disk growth.",
    columns: [C("wal_bytes", "WAL written", "bytes"), C("wal_fpi", "Full-page images", "int"), C("calls", "Calls", "int"), C("query", "Query", "mono")],
    sql: (c) => `select s.wal_bytes::bigint as wal_bytes, s.wal_fpi, s.calls, ${maskSql("s.query", 600)} as query
      ${pgss(c)} and s.wal_bytes > 0 order by s.wal_bytes desc limit 15` },

  // ───────── Tables
  { id: "t_size", section: "tables", title: "Largest tables", source: "pg_stat_user_tables", limit: 50,
    description: "Total size split into heap, indexes and TOAST, with live/dead rows and scan counts.",
    columns: [C("table", "Table", "mono"), C("total_bytes", "Total", "bytes"), C("heap_bytes", "Heap", "bytes"), C("index_bytes", "Indexes", "bytes"), C("toast_bytes", "TOAST", "bytes"), C("live_rows", "Live rows", "int"), C("dead_rows", "Dead rows", "int"), C("seq_scan", "Seq scans", "int"), C("idx_scan", "Index scans", "int")],
    sql: (c) => `select st.schemaname || '.' || st.relname as "table", pg_total_relation_size(st.relid) as total_bytes, pg_relation_size(st.relid) as heap_bytes,
      pg_indexes_size(st.relid) as index_bytes, greatest(pg_table_size(st.relid) - pg_relation_size(st.relid), 0) as toast_bytes,
      st.n_live_tup as live_rows, st.n_dead_tup as dead_rows, st.seq_scan, coalesce(st.idx_scan, 0) as idx_scan
      from pg_stat_user_tables st where ${ut(c, "st.schemaname", "st.relname")} order by total_bytes desc limit 50` },
  { id: "t_seq", section: "tables", title: "Sequential-scan heavy tables", source: "pg_stat_user_tables", limit: 25,
    description: "Tables read mostly by full scans. On large tables this is a common source of CPU and I/O load.",
    columns: [C("table", "Table", "mono"), C("seq_scan", "Seq scans", "int"), C("seq_tup_read", "Rows read by seq scans", "int"), C("rows_per_scan", "Rows/scan", "int"), C("idx_scan", "Index scans", "int"), C("live_rows", "Live rows", "int")],
    sql: (c) => `select schemaname || '.' || relname as "table", seq_scan, seq_tup_read, (seq_tup_read / nullif(seq_scan, 0)) as rows_per_scan, coalesce(idx_scan, 0) as idx_scan, n_live_tup as live_rows
      from pg_stat_user_tables where seq_scan > 0 and ${us(c, "schemaname")} order by seq_tup_read desc limit 25` },
  { id: "t_churn", section: "tables", title: "Write churn", source: "pg_stat_user_tables", limit: 25,
    description: "Inserts, updates and deletes since the stats reset. A low HOT-update ratio means updates touch indexed columns and generate extra index and WAL work.",
    columns: [C("table", "Table", "mono"), C("writes", "Total writes", "int"), C("inserts", "Inserts", "int"), C("updates", "Updates", "int"), C("deletes", "Deletes", "int"), C("hot_pct", "HOT updates", "pct"), C("dead_rows", "Dead rows", "int")],
    sql: (c) => `select schemaname || '.' || relname as "table", (n_tup_ins + n_tup_upd + n_tup_del) as writes, n_tup_ins as inserts, n_tup_upd as updates, n_tup_del as deletes,
      round(100.0 * n_tup_hot_upd / nullif(n_tup_upd, 0), 1) as hot_pct, n_dead_tup as dead_rows
      from pg_stat_user_tables where (n_tup_ins + n_tup_upd + n_tup_del) > 0 and ${ut(c, "schemaname", "relname")} order by writes desc limit 25` },
  { id: "t_cache", section: "tables", title: "Table cache hit rate", source: "pg_statio_user_tables", limit: 25,
    description: "Heap reads served from memory versus disk. Low ratios on busy tables suggest memory pressure or scans.",
    columns: [C("table", "Table", "mono"), C("hit_pct", "Cache hit", "pct"), C("disk_reads", "Disk reads", "int"), C("cache_hits", "Cache hits", "int"), C("idx_hit_pct", "Index cache hit", "pct")],
    sql: (c) => `select schemaname || '.' || relname as "table", round(100.0 * heap_blks_hit / nullif(heap_blks_hit + heap_blks_read, 0), 1) as hit_pct,
      heap_blks_read as disk_reads, heap_blks_hit as cache_hits, round(100.0 * idx_blks_hit / nullif(idx_blks_hit + idx_blks_read, 0), 1) as idx_hit_pct
      from pg_statio_user_tables where heap_blks_read + heap_blks_hit > 1000 and ${us(c, "schemaname")} order by heap_blks_read desc limit 25` },
  { id: "t_nopk", section: "tables", title: "Tables without a primary key", source: "pg_class, pg_index", limit: 30,
    description: "No primary key breaks logical replication of updates/deletes and makes row addressing and de-duplication hard.",
    columns: [C("table", "Table", "mono"), C("est_rows", "Est. rows", "int"), C("bytes", "Size", "bytes")],
    sql: (c) => `select n.nspname || '.' || t.relname as "table", greatest(t.reltuples, 0)::bigint as est_rows, pg_total_relation_size(t.oid) as bytes
      from pg_class t join pg_namespace n on n.oid = t.relnamespace
      where t.relkind in ('r','p') and ${us(c, "n.nspname")} and not exists (select 1 from pg_index i where i.indrelid = t.oid and i.indisprimary)
      order by bytes desc limit 30` },

  // ───────── Indexes
  { id: "i_size", section: "indexes", title: "Largest indexes", source: "pg_stat_user_indexes, pg_index", limit: 50,
    description: "Every index with its size and how often it has been scanned.",
    columns: [C("table", "Table", "mono"), C("index", "Index", "mono"), C("bytes", "Size", "bytes"), C("scans", "Scans", "int"), C("unique", "Unique", "bool"), C("pk", "Primary", "bool"), C("definition", "Definition", "mono")],
    sql: (c) => `select s.schemaname || '.' || s.relname as "table", s.indexrelname as "index", pg_relation_size(s.indexrelid) as bytes, s.idx_scan as scans,
      i.indisunique as "unique", i.indisprimary as pk, pg_get_indexdef(s.indexrelid) as definition
      from pg_stat_user_indexes s join pg_index i on i.indexrelid = s.indexrelid where ${us(c, "s.schemaname")} order by bytes desc limit 50` },
  { id: "i_unused", section: "indexes", title: "Unused indexes", source: "pg_stat_user_indexes", limit: 30,
    description: "Never scanned since the stats reset (and not enforcing uniqueness). Each one still costs work on every write.",
    columns: [C("table", "Table", "mono"), C("index", "Index", "mono"), C("bytes", "Size", "bytes"), C("table_writes", "Table writes", "int"), C("definition", "Definition", "mono")],
    sql: (c) => `select s.schemaname || '.' || s.relname as "table", s.indexrelname as "index", pg_relation_size(s.indexrelid) as bytes,
      (t.n_tup_ins + t.n_tup_upd + t.n_tup_del) as table_writes, pg_get_indexdef(s.indexrelid) as definition
      from pg_stat_user_indexes s join pg_index i on i.indexrelid = s.indexrelid join pg_stat_user_tables t on t.relid = s.relid
      where s.idx_scan = 0 and not i.indisunique and not i.indisprimary and ${us(c, "s.schemaname")} order by bytes desc limit 30` },
  { id: "i_dup", section: "indexes", title: "Duplicate indexes", source: "pg_index", limit: 25,
    description: "Two or more indexes on the same table with identical columns, operator classes, predicate and expressions. All but one can usually be dropped.",
    columns: [C("table", "Table", "mono"), C("indexes", "Indexes", "mono"), C("copies", "Copies", "int"), C("bytes", "Total size", "bytes")],
    sql: (c) => `select n.nspname || '.' || t.relname as "table", array_to_string(array_agg(ic.relname order by ic.relname), ', ') as indexes, count(*)::int as copies, sum(pg_relation_size(i.indexrelid))::bigint as bytes
      from pg_index i join pg_class ic on ic.oid = i.indexrelid join pg_class t on t.oid = i.indrelid join pg_namespace n on n.oid = t.relnamespace
      where ${us(c, "n.nspname")} and i.indisvalid
      group by n.nspname, t.relname, i.indrelid, i.indkey::text, i.indclass::text, i.indoption::text, coalesce(pg_get_expr(i.indpred, i.indrelid), ''), coalesce(pg_get_expr(i.indexprs, i.indrelid), '')
      having count(*) > 1 order by bytes desc limit 25` },
  { id: "i_fk", section: "indexes", title: "Foreign keys without a supporting index", source: "pg_constraint, pg_index", limit: 30,
    description: "Deleting or updating a referenced row must scan the referencing table. Without an index on the foreign-key columns that is a full scan (and can take long locks).",
    columns: [C("table", "Referencing table", "mono"), C("constraint", "Constraint", "mono"), C("est_rows", "Est. rows", "int"), C("definition", "Definition", "mono")],
    sql: (c) => `select n.nspname || '.' || t.relname as "table", k.conname as "constraint", greatest(t.reltuples, 0)::bigint as est_rows, pg_get_constraintdef(k.oid) as definition
      from pg_constraint k join pg_class t on t.oid = k.conrelid join pg_namespace n on n.oid = t.relnamespace
      where k.contype = 'f' and ${us(c, "n.nspname")}
        and not exists (select 1 from pg_index i where i.indrelid = k.conrelid and i.indisvalid
                        and (string_to_array(i.indkey::text, ' ')::int2[])[1:array_length(k.conkey, 1)] @> k.conkey)
      order by t.reltuples desc limit 30` },
  { id: "i_invalid", section: "indexes", title: "Invalid indexes", source: "pg_index", limit: 20,
    description: "Left behind by a failed CREATE INDEX CONCURRENTLY. They cost writes and are never used.",
    columns: [C("table", "Table", "mono"), C("index", "Index", "mono"), C("bytes", "Size", "bytes")],
    sql: (c) => `select n.nspname || '.' || t.relname as "table", ic.relname as "index", pg_relation_size(i.indexrelid) as bytes
      from pg_index i join pg_class ic on ic.oid = i.indexrelid join pg_class t on t.oid = i.indrelid join pg_namespace n on n.oid = t.relnamespace
      where not i.indisvalid and ${us(c, "n.nspname")} limit 20` },

  // ───────── Blocked transactions
  { id: "b_blocked", section: "blocking", title: "Blocked queries", source: "pg_stat_activity, pg_blocking_pids()", limit: 25,
    description: "Queries currently waiting on a lock and the session holding it.",
    columns: [C("blocked_pid", "Blocked PID", "id"), C("blocked_user", "User"), C("waiting_s", "Waiting", "secs", { warn: 5, bad: 30 }), C("wait_event", "Wait event", "mono"), C("blocked_query", "Blocked query", "mono"),
      C("blocking_pid", "Blocker PID", "id"), C("blocking_user", "Blocker user"), C("blocking_state", "Blocker state"), C("blocking_xact_s", "Blocker txn age", "secs", { warn: 30, bad: 300 }), C("blocking_query", "Blocker's last query", "mono")],
    sql: () => `select b.pid as blocked_pid, b.usename::text as blocked_user, round(extract(epoch from now() - b.query_start)::numeric, 1) as waiting_s, coalesce(b.wait_event, '') as wait_event, ${maskSql("b.query")} as blocked_query,
      bl.pid as blocking_pid, bl.usename::text as blocking_user, bl.state as blocking_state, round(extract(epoch from now() - bl.xact_start)::numeric, 1) as blocking_xact_s, ${maskSql("bl.query")} as blocking_query
      from pg_stat_activity b cross join lateral unnest(pg_blocking_pids(b.pid)) as bp(pid) join pg_stat_activity bl on bl.pid = bp.pid
      order by waiting_s desc limit 25` },
  { id: "b_long", section: "blocking", title: "Long-running transactions", source: "pg_stat_activity", limit: 25,
    description: "Open for more than 30 seconds. Long transactions hold locks and prevent vacuum from removing dead rows.",
    columns: [C("pid", "PID", "id"), C("user", "User"), C("app", "Application"), C("state", "State"), C("xact_s", "Txn age", "secs", { warn: 60, bad: 600 }), C("state_s", "In state for", "secs"), C("xid", "XID", "id"), C("query", "Last query", "mono")],
    sql: () => `select pid, usename::text as "user", application_name as app, state, round(extract(epoch from now() - xact_start)::numeric, 1) as xact_s,
      round(extract(epoch from now() - state_change)::numeric, 1) as state_s, backend_xid::text as xid, ${maskSql("query")} as query
      from pg_stat_activity where xact_start is not null and now() - xact_start > interval '30 seconds' and pid <> pg_backend_pid() and backend_type = 'client backend'
      order by xact_s desc limit 25` },
  { id: "b_idle", section: "blocking", title: "Idle in transaction", source: "pg_stat_activity", limit: 25,
    description: "Sessions that started a transaction and went quiet. Usually an application that forgot to COMMIT or ROLLBACK.",
    columns: [C("pid", "PID", "id"), C("user", "User"), C("app", "Application"), C("idle_s", "Idle for", "secs", { warn: 60, bad: 300 }), C("xact_s", "Txn age", "secs"), C("query", "Last query", "mono")],
    sql: () => `select pid, usename::text as "user", application_name as app, round(extract(epoch from now() - state_change)::numeric, 1) as idle_s,
      round(extract(epoch from now() - xact_start)::numeric, 1) as xact_s, ${maskSql("query")} as query
      from pg_stat_activity where state = 'idle in transaction' and pid <> pg_backend_pid() order by state_change limit 25` },
  { id: "b_prepared", section: "blocking", title: "Prepared transactions", source: "pg_prepared_xacts", limit: 20,
    description: "Two-phase commit transactions that were prepared but not finished. They hold locks and block vacuum until committed or rolled back.",
    columns: [C("gid", "Global ID", "mono"), C("owner", "Owner"), C("age_s", "Age", "secs", { warn: 300, bad: 3600 }), C("prepared", "Prepared at", "ts")],
    sql: () => `select gid, owner::text as owner, round(extract(epoch from now() - prepared)::numeric) as age_s, prepared from pg_prepared_xacts order by prepared limit 20` },
  { id: "b_locks", section: "blocking", title: "Lock summary", source: "pg_locks", limit: 40,
    description: "Locks held or awaited in this database, grouped by type and mode. Ungranted locks are waits.",
    columns: [C("locktype", "Type", "mono"), C("mode", "Mode", "mono"), C("granted", "Granted", "bool"), C("locks", "Locks", "int"), C("sessions", "Sessions", "int"), C("relations", "Relations", "mono")],
    sql: () => `select locktype, mode, granted, count(*)::int as locks, count(distinct pid)::int as sessions,
      array_to_string((array_agg(distinct relation::regclass::text) filter (where relation is not null))[1:5], ', ') as relations
      from pg_locks where database = ${inDb} or database is null group by locktype, mode, granted order by granted, locks desc limit 40` },
  { id: "b_xmin", section: "blocking", title: "What is holding back vacuum", source: "pg_stat_activity, pg_replication_slots, pg_prepared_xacts, pg_stat_replication", limit: 25,
    description: "Anything with an old xmin stops vacuum from cleaning rows newer than it. The oldest holder sets the horizon for the whole database.",
    columns: [C("holder", "Holder"), C("ref", "Reference", "mono"), C("owner", "Owner"), C("xmin_age", "xmin age", "int", { warn: 1_000_000, bad: 50_000_000 }), C("detail", "Detail", "mono")],
    sql: () => `select * from (
        select 'Backend session' as holder, pid::text as ref, usename::text as owner, greatest(age(backend_xmin), age(backend_xid))::bigint as xmin_age, ${maskSql("coalesce(query, '')", 200)} as detail from pg_stat_activity where (backend_xmin is not null or backend_xid is not null) and pid <> pg_backend_pid()
        union all select 'Replication slot', slot_name::text, database::text, age(coalesce(xmin, catalog_xmin))::bigint, slot_type || ' / ' || case when active then 'active' else 'INACTIVE' end from pg_replication_slots where xmin is not null or catalog_xmin is not null
        union all select 'Prepared transaction', gid, owner::text, age(transaction)::bigint, 'prepared ' || prepared::text from pg_prepared_xacts
        union all select 'Standby feedback', coalesce(application_name, ''), usename::text, age(backend_xmin)::bigint, coalesce(client_addr::text, '') from pg_stat_replication where backend_xmin is not null
      ) h order by xmin_age desc nulls last limit 25` },

  // ───────── Connections
  { id: "c_limits", section: "connections", title: "Connections in use versus the limit", source: "pg_stat_activity, pg_settings", layout: "kv", limit: 1,
    description: "How close the server is to max_connections.",
    columns: [C("in_use", "In use", "int"), C("max_connections", "max_connections", "int"), C("reserved", "Reserved for superusers", "int"), C("used_pct", "Used", "pct", { warn: 70, bad: 90 }), C("active", "Active", "int"), C("idle", "Idle", "int"), C("idle_in_tx", "Idle in transaction", "int", { warn: 1, bad: 10 })],
    sql: () => `select count(*)::int as in_use, current_setting('max_connections')::int as max_connections, current_setting('superuser_reserved_connections')::int as reserved,
      round(100.0 * count(*) / current_setting('max_connections')::numeric, 1) as used_pct, count(*) filter (where state = 'active')::int as active,
      count(*) filter (where state = 'idle')::int as idle, count(*) filter (where state = 'idle in transaction')::int as idle_in_tx
      from pg_stat_activity where backend_type = 'client backend'` },
  { id: "c_role", section: "connections", title: "Connections by role and application", source: "pg_stat_activity", limit: 30,
    description: "Who is holding connections. A single application using most of them is a pooling opportunity.",
    columns: [C("role", "Role"), C("app", "Application"), C("sessions", "Sessions", "int"), C("active", "Active", "int"), C("idle_in_tx", "Idle in txn", "int"), C("oldest_s", "Oldest session", "secs")],
    sql: () => `select coalesce(usename, '-')::text as role, coalesce(nullif(application_name, ''), '-') as app, count(*)::int as sessions,
      count(*) filter (where state = 'active')::int as active, count(*) filter (where state = 'idle in transaction')::int as idle_in_tx,
      round(extract(epoch from now() - min(backend_start)))::bigint as oldest_s
      from pg_stat_activity where backend_type = 'client backend' group by 1, 2 order by sessions desc limit 30` },
  { id: "c_ssl", section: "connections", title: "Encryption in use", source: "pg_stat_ssl", limit: 20,
    description: "Whether client sessions are encrypted. Loopback clients, provider services and this scan are excluded. On a managed provider, sessions from private addresses are its pooler talking to the database inside its network, not your clients.",
    columns: [C("role", "Role"), C("encrypted", "Encrypted", "bool"), C("tls", "TLS version", "mono"), C("remote", "Remote", "bool"), C("private", "Private network", "bool"), C("sessions", "Sessions", "int")],
    sql: (c) => {
      const priv = `(a.client_addr <<= '10.0.0.0/8'::inet or a.client_addr <<= '172.16.0.0/12'::inet or a.client_addr <<= '192.168.0.0/16'::inet or a.client_addr <<= 'fc00::/7'::inet)`;
      return `select coalesce(a.usename, '?')::text as role, s.ssl as encrypted, coalesce(s.version, '-') as tls,
      (a.client_addr is not null and not (a.client_addr <<= '127.0.0.0/8'::inet or a.client_addr <<= '::1/128'::inet)${c.profile.poolerOnPrivateNetwork ? ` and not ${priv}` : ""}) as remote,
      coalesce(${priv}, false) as private, count(*)::int as sessions
      from pg_stat_ssl s join pg_stat_activity a using (pid)
      where a.backend_type = 'client backend' and a.pid <> pg_backend_pid() and not ${c.profile.managedRoleSql("a.usename")} and not ${c.profile.internalAppSql("coalesce(a.application_name, '')")}
      group by 1, 2, 3, 4, 5 order by sessions desc limit 20`; } },

  // ───────── Replication & WAL
  { id: "r_slots", section: "replication", title: "Replication slots", source: "pg_replication_slots", limit: 20,
    description: "An inactive slot forces Postgres to keep WAL it hasn't delivered, which can fill the disk.",
    columns: [C("slot", "Slot", "mono"), C("type", "Type"), C("active", "Active", "bool"), C("status", "WAL status"), C("retained_bytes", "WAL retained", "bytes", { warn: 1_073_741_824, bad: 5_368_709_120 }), C("plugin", "Plugin", "mono")],
    sql: () => `select slot_name::text as slot, slot_type as type, active, wal_status as status,
      pg_wal_lsn_diff(case when pg_is_in_recovery() then pg_last_wal_replay_lsn() else pg_current_wal_lsn() end, restart_lsn)::bigint as retained_bytes, coalesce(plugin::text, '') as plugin
      from pg_replication_slots order by retained_bytes desc nulls last limit 20` },
  { id: "r_standby", section: "replication", title: "Standby lag", source: "pg_stat_replication", limit: 20,
    description: "Connected replicas and how far behind the primary each is.",
    columns: [C("standby", "Standby", "mono"), C("addr", "Address", "mono"), C("state", "State"), C("sync", "Sync"), C("replay_bytes", "Replay lag", "bytes", { warn: 16_777_216, bad: 268_435_456 }), C("replay_lag_s", "Replay lag (time)", "secs", { warn: 5, bad: 60 }), C("flush_lag_s", "Flush lag", "secs")],
    sql: () => `select coalesce(application_name, '') as standby, coalesce(client_addr::text, '') as addr, state, sync_state as sync,
      pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn)::bigint as replay_bytes, round(extract(epoch from replay_lag)::numeric, 2) as replay_lag_s, round(extract(epoch from flush_lag)::numeric, 2) as flush_lag_s
      from pg_stat_replication order by replay_bytes desc nulls last limit 20` },
  { id: "r_walstats", section: "replication", title: "WAL generated", source: "pg_stat_wal", layout: "kv", limit: 1,
    description: "WAL volume since the stats reset.",
    columns: [C("wal_bytes", "WAL written", "bytes"), C("wal_records", "Records", "int"), C("wal_fpi", "Full-page images", "int"), C("wal_buffers_full", "Buffer-full writes", "int"), C("stats_reset", "Since", "ts")],
    sql: () => `select wal_bytes::bigint as wal_bytes, wal_records, wal_fpi, wal_buffers_full, stats_reset from pg_stat_wal` },
  { id: "r_waldir", section: "replication", title: "WAL on disk", source: "pg_ls_waldir()", layout: "kv", limit: 1,
    description: "Segments currently retained in pg_wal.",
    columns: [C("segments", "Segments", "int"), C("bytes", "Size on disk", "bytes"), C("newest", "Newest segment", "ts")],
    sql: () => `select count(*)::int as segments, coalesce(sum(size), 0)::bigint as bytes, max(modification) as newest from pg_ls_waldir()` },
  { id: "r_archiver", section: "replication", title: "WAL archiver", source: "pg_stat_archiver", layout: "kv", limit: 1,
    description: "Continuous archiving health. Rising failures let WAL pile up.",
    columns: [C("archived_count", "Archived", "int"), C("failed_count", "Failed", "int", { warn: 1, bad: 10 }), C("last_archived_time", "Last success", "ts"), C("last_failed_time", "Last failure", "ts")],
    sql: () => `select archived_count, failed_count, last_archived_time, last_failed_time from pg_stat_archiver` },
  { id: "r_checkpoints", section: "replication", title: "Checkpoints", source: "pg_stat_checkpointer / pg_stat_bgwriter", layout: "kv", limit: 1,
    description: "Requested checkpoints far above timed ones mean WAL volume is forcing checkpoints, adding I/O spikes.",
    columns: [C("timed", "Timed", "int"), C("requested", "Requested (forced)", "int"), C("write_ms", "Write time", "ms"), C("sync_ms", "Sync time", "ms"), C("buffers", "Buffers written", "int")],
    sql: (c) => c.version >= 170000
      ? `select num_timed as timed, num_requested as requested, write_time as write_ms, sync_time as sync_ms, buffers_written as buffers from pg_stat_checkpointer`
      : `select checkpoints_timed as timed, checkpoints_req as requested, checkpoint_write_time as write_ms, checkpoint_sync_time as sync_ms, buffers_checkpoint as buffers from pg_stat_bgwriter` },
  { id: "r_settings", section: "replication", title: "WAL and replication settings", source: "pg_settings", limit: 20,
    description: "Settings that control WAL size, retention, archiving and replication capacity.", columns: SETTING_COLS,
    sql: () => setting(["wal_level", "max_wal_size", "min_wal_size", "wal_keep_size", "max_slot_wal_keep_size", "wal_compression", "archive_mode", "archive_timeout", "checkpoint_timeout", "checkpoint_completion_target", "max_wal_senders", "max_replication_slots", "synchronous_commit"]) },
  { id: "r_pubs", section: "replication", title: "Publications", source: "pg_publication", limit: 20,
    description: "Logical replication publications and what they publish.",
    columns: [C("name", "Publication", "mono"), C("all_tables", "All tables", "bool"), C("tables", "Tables", "int"), C("ins", "Insert", "bool"), C("upd", "Update", "bool"), C("del", "Delete", "bool"), C("trunc", "Truncate", "bool")],
    sql: () => `select p.pubname::text as name, p.puballtables as all_tables, (select count(*) from pg_publication_tables t where t.pubname = p.pubname)::int as tables,
      p.pubinsert as ins, p.pubupdate as upd, p.pubdelete as del, p.pubtruncate as trunc from pg_publication p order by p.pubname limit 20` },

  // ───────── Vacuum & bloat
  { id: "v_dead", section: "vacuum", title: "Dead tuples and vacuum history", source: "pg_stat_user_tables", limit: 30,
    description: "Tables carrying dead rows, and when they were last vacuumed and analyzed.",
    columns: [C("table", "Table", "mono"), C("dead_rows", "Dead rows", "int"), C("dead_pct", "Dead %", "pct", { warn: 10, bad: 30 }), C("live_rows", "Live rows", "int"), C("last_vacuum", "Last vacuum", "ts"), C("last_autovacuum", "Last autovacuum", "ts"), C("last_autoanalyze", "Last autoanalyze", "ts"), C("autovacuums", "Autovacuums", "int")],
    sql: (c) => `select schemaname || '.' || relname as "table", n_dead_tup as dead_rows, round(100.0 * n_dead_tup / nullif(n_live_tup + n_dead_tup, 0), 1) as dead_pct, n_live_tup as live_rows,
      last_vacuum, last_autovacuum, last_autoanalyze, autovacuum_count as autovacuums
      from pg_stat_user_tables where n_dead_tup > 0 and ${ut(c, "schemaname", "relname")} order by n_dead_tup desc limit 30` },
  { id: "v_age", section: "vacuum", title: "Transaction ID age by table", source: "pg_class", limit: 25,
    description: "How far each table is from a forced anti-wraparound vacuum (autovacuum_freeze_max_age). Tables near 100% get emergency vacuums.",
    columns: [C("table", "Table", "mono"), C("xid_age", "XID age", "int"), C("pct", "% of freeze limit", "pct", { warn: 70, bad: 95 }), C("mxid_age", "MultiXact age", "int"), C("bytes", "Size", "bytes")],
    sql: (c) => `select n.nspname || '.' || t.relname as "table", age(t.relfrozenxid)::bigint as xid_age, round(100.0 * age(t.relfrozenxid) / current_setting('autovacuum_freeze_max_age')::numeric, 1) as pct,
      mxid_age(t.relminmxid)::bigint as mxid_age, pg_total_relation_size(t.oid) as bytes
      from pg_class t join pg_namespace n on n.oid = t.relnamespace where t.relkind in ('r','m') and ${us(c, "n.nspname")} order by xid_age desc limit 25` },
  { id: "v_dbage", section: "vacuum", title: "Wraparound distance per database", source: "pg_database", limit: 20,
    description: "Transaction IDs wrap at about 2.1 billion. Postgres stops accepting writes to prevent data loss if vacuum can't keep up.",
    columns: [C("database", "Database", "mono"), C("xid_age", "XID age", "int"), C("xid_pct", "% of limit", "pct", { warn: 50, bad: 75 }), C("mxid_age", "MultiXact age", "int"), C("mxid_pct", "% of limit", "pct", { warn: 50, bad: 75 })],
    sql: () => `select datname::text as database, age(datfrozenxid)::bigint as xid_age, round(100.0 * age(datfrozenxid) / 2100000000, 1) as xid_pct,
      mxid_age(datminmxid)::bigint as mxid_age, round(100.0 * mxid_age(datminmxid) / 2100000000, 1) as mxid_pct from pg_database where datallowconn order by xid_age desc limit 20` },
  { id: "v_running", section: "vacuum", title: "Vacuums running now", source: "pg_stat_progress_vacuum", limit: 20,
    description: "Live vacuum progress.",
    columns: [C("pid", "PID", "id"), C("table", "Table", "mono"), C("phase", "Phase"), C("progress_pct", "Progress", "pct"), C("dead_tuples", "Dead tuples collected", "int")],
    sql: () => `select pid, relid::regclass::text as "table", phase, round(100.0 * heap_blks_scanned / nullif(heap_blks_total, 0), 1) as progress_pct, num_dead_item_ids as dead_tuples
      from pg_stat_progress_vacuum where datid = ${inDb} limit 20` },
  { id: "v_settings", section: "vacuum", title: "Autovacuum settings", source: "pg_settings", limit: 20,
    description: "Thresholds that decide when autovacuum runs and how hard it works.", columns: SETTING_COLS,
    sql: () => setting(["autovacuum", "autovacuum_naptime", "autovacuum_max_workers", "autovacuum_vacuum_scale_factor", "autovacuum_vacuum_threshold", "autovacuum_analyze_scale_factor", "autovacuum_vacuum_cost_limit", "autovacuum_vacuum_cost_delay", "autovacuum_freeze_max_age", "vacuum_freeze_min_age", "vacuum_freeze_table_age"]) },

  // ───────── Configuration
  { id: "cfg_key", section: "config", title: "Key settings", source: "pg_settings", limit: 30,
    description: "Memory, planner, parallelism and timeout settings that most affect behavior.", columns: SETTING_COLS,
    sql: () => setting(["shared_buffers", "effective_cache_size", "work_mem", "maintenance_work_mem", "max_connections", "random_page_cost", "effective_io_concurrency", "default_statistics_target", "max_worker_processes", "max_parallel_workers", "max_parallel_workers_per_gather", "jit", "huge_pages", "track_io_timing", "track_activity_query_size", "statement_timeout", "lock_timeout", "idle_in_transaction_session_timeout"]) },
  { id: "cfg_changed", section: "config", title: "Settings changed from default", source: "pg_settings", limit: 80,
    description: "Everything not at its built-in default, and where it was set (config file, role, database, or session).", columns: SETTING_COLS,
    sql: () => `select name, ${safeValue()} as setting, coalesce(unit, '') as unit, source from pg_settings where source not in ('default', 'override')
      and name !~ '^neon\\.' order by name limit 80` },  // Neon's own settings: not tunable by the customer, and they name the endpoint

  // ───────── Logs & activity
  { id: "l_db", section: "logs", title: "Database-reported errors and activity", source: "pg_stat_database", layout: "kv", limit: 1,
    description: "Counters the database keeps since the last stats reset.",
    columns: [C("commits", "Commits", "int"), C("rollbacks", "Rollbacks", "int"), C("rollback_pct", "Rollback rate", "pct", { warn: 5, bad: 20 }), C("deadlocks", "Deadlocks", "int", { warn: 1, bad: 10 }), C("conflicts", "Recovery conflicts", "int"), C("temp_files", "Temp files", "int"), C("temp_bytes", "Temp bytes", "bytes"), C("checksum_failures", "Checksum failures", "int", { bad: 1 }), C("stats_reset", "Since", "ts"), C("next_xid", "Transaction counter", "int")],
    sql: () => `select xact_commit as commits, xact_rollback as rollbacks, round(100.0 * xact_rollback / nullif(xact_commit + xact_rollback, 0), 2) as rollback_pct, deadlocks, conflicts, temp_files, temp_bytes,
      coalesce(checksum_failures, 0) as checksum_failures, stats_reset, pg_snapshot_xmax(pg_current_snapshot())::text::bigint as next_xid
      from pg_stat_database where datname = current_database()` },
  { id: "l_settings", section: "logs", title: "Logging configuration", source: "pg_settings", limit: 20,
    description: "What the server writes to its logs. Without slow-query and lock-wait logging, incidents leave little evidence.", columns: SETTING_COLS,
    sql: () => setting(["log_min_duration_statement", "log_statement", "log_lock_waits", "deadlock_timeout", "log_checkpoints", "log_connections", "log_disconnections", "log_autovacuum_min_duration", "log_temp_files", "log_min_error_statement", "log_destination", "logging_collector"]) },

  // ───────── Security
  { id: "s_roles", section: "security", title: "Roles and privileges", source: "pg_roles", limit: 50,
    description: "Login roles and their powers. Superuser, BYPASSRLS and REPLICATION are the ones to keep to a minimum. Provider-managed roles are hidden.",
    columns: [C("role", "Role", "mono"), C("login", "Can login", "bool"), C("superuser", "Superuser", "bool"), C("createrole", "Create role", "bool"), C("createdb", "Create DB", "bool"), C("replication", "Replication", "bool"), C("bypassrls", "Bypass RLS", "bool"), C("conn_limit", "Conn limit", "int"), C("valid_until", "Password expires", "ts"), C("member_of", "Member of", "mono")],
    sql: (c) => `select r.rolname::text as role, r.rolcanlogin as login, r.rolsuper as superuser, r.rolcreaterole as createrole, r.rolcreatedb as createdb, r.rolreplication as replication, r.rolbypassrls as bypassrls,
      r.rolconnlimit as conn_limit, r.rolvaliduntil as valid_until, (select string_agg(b.rolname, ', ' order by b.rolname) from pg_auth_members m join pg_roles b on b.oid = m.roleid where m.member = r.oid) as member_of
      from pg_roles r where r.rolname !~ '^pg_' and not ${c.profile.managedRoleSql("r.rolname")} order by r.rolsuper desc, r.rolcanlogin desc, r.rolname limit 50` },
  { id: "s_rls", section: "security", title: "Row-level security coverage", source: "pg_class, pg_policy", limit: 60,
    description: "Which tables have RLS enabled and how many policies each has. RLS enabled with no policies denies all access; RLS disabled leaves the table open to anyone with privileges.",
    columns: [C("table", "Table", "mono"), C("rls", "RLS enabled", "bool"), C("forced", "Forced", "bool"), C("policies", "Policies", "int")],
    sql: (c) => `select n.nspname || '.' || t.relname as "table", t.relrowsecurity as rls, t.relforcerowsecurity as forced, (select count(*) from pg_policy p where p.polrelid = t.oid)::int as policies
      from pg_class t join pg_namespace n on n.oid = t.relnamespace where t.relkind in ('r','p') and ${us(c, "n.nspname")} order by t.relrowsecurity, policies, 1 limit 60` },
  { id: "s_policies", section: "security", title: "Policies", source: "pg_policies", limit: 60,
    description: "Every policy with its command, roles and expressions. A policy is 'always true' when the expression that gates it (USING for reads, updates and deletes; WITH CHECK for inserts) is missing or literally true.",
    columns: [C("table", "Table", "mono"), C("policy", "Policy", "mono"), C("cmd", "Command"), C("roles", "Roles", "mono"), C("always_true", "Always true", "bool"), C("using_expr", "USING", "mono"), C("check_expr", "WITH CHECK", "mono")],
    sql: (c) => `select schemaname || '.' || tablename as "table", policyname::text as policy, cmd, array_to_string(roles, ', ') as roles,
      case when cmd = 'INSERT' then coalesce(nullif(btrim(with_check), ''), 'true') in ('true', '(true)')
           else coalesce(nullif(btrim(qual), ''), 'true') in ('true', '(true)') end as always_true,
      left(coalesce(qual, ''), 300) as using_expr, left(coalesce(with_check, ''), 300) as check_expr
      from pg_policies where ${us(c, "schemaname")} order by 5 desc, 1, 2 limit 60` },

  // ───────── Extensions
  { id: "e_installed", section: "extensions", title: "Installed extensions", source: "pg_extension, pg_available_extensions", limit: 60,
    description: "Extensions installed in this database and whether a newer version is available.",
    columns: [C("name", "Extension", "mono"), C("version", "Installed", "mono"), C("default_version", "Latest available", "mono"), C("update", "Update available", "bool"), C("schema", "Schema", "mono")],
    sql: () => `select e.extname::text as name, e.extversion as version, av.default_version, (av.default_version is not null and av.default_version <> e.extversion) as update, n.nspname::text as schema
      from pg_extension e join pg_namespace n on n.oid = e.extnamespace left join pg_available_extensions av on av.name = e.extname order by 4 desc, 1 limit 60` },
];

function normalize(rows: Record<string, unknown>[], cols: Column[]) {
  const kind = new Map(cols.map((c) => [c.key, c.kind ?? "text"]));
  return rows.map((r) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) {
      if (v instanceof Date) out[k] = v.toISOString();
      else if (v !== null && NUMERIC.includes(kind.get(k) as ColKind) && !Number.isNaN(Number(v))) out[k] = Number(v);
      else if (typeof v === "bigint") out[k] = v.toString();
      else out[k] = v;
    }
    return out;
  });
}

/** Every dataset the collector can read, in display order. Also the allow-list for uploaded bundles. */
export const ALL_DEFS: Def[] = [...DEFS, ...MORE, ...CAP, ...OPS];

export async function collectDatasets(c: Ctx, onRead?: (done: number, total: number) => void): Promise<Dataset[]> {
  const installed = new Set((await c.q(`select extname from pg_extension`)).map((r) => String(r.extname)));
  const out: Dataset[] = [];
  let done = 0;
  for (const d of ALL_DEFS) {
    onRead?.(done++, ALL_DEFS.length);
    if (d.only && !d.only.includes(c.profile.id)) continue;
    if (d.minPg && c.version < d.minPg) continue;
    const base: Dataset = { id: d.id, section: d.section, title: d.title, description: d.description, source: d.source, layout: d.layout ?? "table", columns: d.columns, rows: [], capped: false };
    if (d.ext && !installed.has(d.ext) && d.optional) continue;
    if (d.ext && !installed.has(d.ext)) { out.push({ ...base, note: d.hint ?? `The ${d.ext} extension isn't installed, so this can't be measured. See the quickstart to enable it.` }); continue; }
    try {
      const rows = normalize(await c.q(d.sql(c)), d.columns);
      out.push({ ...base, rows, capped: rows.length >= (d.limit ?? 50) });
    } catch (e: any) {
      if (isConnectionLost(e)) throw e; // the connection is gone: fail the scan instead of reporting a hollow result
      out.push({ ...base, error: String(e.message ?? e).replace(/postgres(ql)?:\/\/\S+/g, "[connection string]") });
    }
  }
  return out;
}

/** The raw numbers behind the key-numbers row. Collected as one row so an uploaded bundle carries numbers, not presentation. */
export const VITAL_KEYS = ["db_bytes", "cache_hit", "conns", "max_conns", "xid_age", "uptime_s", "tables", "indexes", "deadlocks"] as const;
export type VitalsRow = Partial<Record<(typeof VITAL_KEYS)[number], number | null>>;

export const VITALS_SQL = `select pg_database_size(current_database()) as db_bytes,
    (select round(100.0 * sum(blks_hit) / nullif(sum(blks_hit + blks_read), 0), 2) from pg_stat_database where datname = current_database()) as cache_hit,
    (select count(*) from pg_stat_activity where backend_type = 'client backend')::int as conns, current_setting('max_connections')::int as max_conns,
    (select max(age(datfrozenxid)) from pg_database where datallowconn)::bigint as xid_age,
    extract(epoch from now() - pg_postmaster_start_time())::bigint as uptime_s,
    (select count(*) from pg_stat_user_tables)::int as tables, (select count(*) from pg_stat_user_indexes)::int as indexes,
    (select deadlocks from pg_stat_database where datname = current_database()) as deadlocks`;

export async function collectVitalsRow(c: Ctx): Promise<VitalsRow> {
  const [r] = await c.q(VITALS_SQL);
  return Object.fromEntries(VITAL_KEYS.map((k) => [k, r[k] === null || r[k] === undefined ? null : Number(r[k])]));
}

export function vitalsFrom(r: VitalsRow): Vital[] {
  if (r.db_bytes == null) return []; // the vitals query failed while collecting
  const connPct = (100 * Number(r.conns)) / Number(r.max_conns);
  const xidPct = (100 * Number(r.xid_age)) / 2_100_000_000;
  const cache = r.cache_hit == null ? null : Number(r.cache_hit);
  return [
    { label: "Database size", value: Number(r.db_bytes), kind: "bytes" },
    { label: "Cache hit rate", value: cache, kind: "pct", tone: cache === null ? undefined : cache < 90 ? "bad" : cache < 99 ? "warn" : "ok", hint: "Aim for 99% or higher on OLTP workloads" },
    { label: "Connections", value: `${r.conns} / ${r.max_conns}`, tone: connPct >= 90 ? "bad" : connPct >= 70 ? "warn" : "ok", hint: `${Math.round(connPct)}% of max_connections` },
    { label: "Oldest XID age", value: Number(r.xid_age), kind: "int", tone: xidPct >= 75 ? "bad" : xidPct >= 50 ? "warn" : "ok", hint: `${xidPct.toFixed(1)}% of the wraparound limit` },
    { label: "Uptime", value: Number(r.uptime_s), kind: "secs" },
    { label: "Tables", value: Number(r.tables), kind: "int" },
    { label: "Indexes", value: Number(r.indexes), kind: "int" },
    { label: "Deadlocks", value: Number(r.deadlocks ?? 0), kind: "int", tone: Number(r.deadlocks) > 0 ? "warn" : "ok", hint: "Since stats reset" },
  ];
}
