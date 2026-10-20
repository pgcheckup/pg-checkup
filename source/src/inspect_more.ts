import { type Def, C, us, ut, inDb, pgss, setting, maskSql, SETTING_COLS } from "./dsutil.js";

/** Additional datasets: schema integrity, stale stats, bloat, redundant indexes, security surface, version and I/O. */
export const MORE: Def[] = [
  // ───────── Queries
  { id: "q_pgss", section: "queries", title: "Statement tracking health", source: "pg_stat_statements_info", layout: "kv", limit: 1, ext: "pg_stat_statements", minPg: 140000,
    description: "How many statements were evicted from the tracking table. Evictions mean pg_stat_statements.max is too small and history is being lost.",
    columns: [C("dealloc", "Statements evicted", "int", { warn: 1 }), C("stats_reset", "Since", "ts")],
    sql: () => `select dealloc, stats_reset from pg_stat_statements_info` },

  // ───────── Tables
  { id: "t_stale", section: "tables", title: "Stale planner statistics", source: "pg_stat_user_tables", limit: 25,
    description: "Rows changed since the last ANALYZE. The planner picks bad plans when its statistics no longer match the data.",
    columns: [C("table", "Table", "mono"), C("live_rows", "Live rows", "int"), C("mods", "Changed since analyze", "int"), C("mod_pct", "Changed %", "pct", { warn: 20, bad: 50 }), C("last_analyzed", "Last analyzed", "ts"), C("autoanalyzes", "Auto-analyzes", "int")],
    sql: (c) => `select schemaname || '.' || relname as "table", n_live_tup as live_rows, n_mod_since_analyze as mods, round(100.0 * n_mod_since_analyze / nullif(n_live_tup, 0), 1) as mod_pct,
      greatest(last_analyze, last_autoanalyze) as last_analyzed, autoanalyze_count as autoanalyzes
      from pg_stat_user_tables where n_mod_since_analyze > 0 and ${us(c, "schemaname")} order by n_mod_since_analyze desc limit 25` },
  { id: "t_bloat", section: "tables", title: "Measured table bloat", source: "pgstattuple_approx()", limit: 15, ext: "pgstattuple",
    hint: "Install pgstattuple to measure bloat instead of estimating: create extension pgstattuple; (the pg_monitor role can run it).",
    description: "Wasted space in the largest tables, measured with pgstattuple_approx (uses the visibility map, so it is cheap).",
    columns: [C("table", "Table", "mono"), C("bytes", "Size", "bytes"), C("dead_pct", "Dead", "pct"), C("free_pct", "Free space", "pct"), C("bloat_pct", "Bloat", "pct", { warn: 30, bad: 60 }), C("wasted_bytes", "Wasted", "bytes")],
    sql: (c) => `select n.nspname || '.' || t.relname as "table", pg_relation_size(t.oid) as bytes, round(a.dead_tuple_percent::numeric, 1) as dead_pct, round(a.approx_free_percent::numeric, 1) as free_pct,
      round((a.dead_tuple_percent + a.approx_free_percent)::numeric, 1) as bloat_pct, (a.dead_tuple_len + a.approx_free_space)::bigint as wasted_bytes
      from pg_class t join pg_namespace n on n.oid = t.relnamespace, lateral pgstattuple_approx(t.oid) a
      where t.relkind = 'r' and ${ut(c, "n.nspname", "t.relname")} and pg_relation_size(t.oid) > 8 * 1024 * 1024 order by pg_relation_size(t.oid) desc limit 15` },

  // ───────── Vacuum
  { id: "v_never", section: "vacuum", title: "Busy tables never vacuumed", source: "pg_stat_user_tables", limit: 25,
    description: "Tables with plenty of writes that neither autovacuum nor a manual VACUUM has ever visited.",
    columns: [C("table", "Table", "mono"), C("writes", "Writes", "int"), C("live_rows", "Live rows", "int"), C("dead_rows", "Dead rows", "int"), C("last_analyzed", "Last analyzed", "ts")],
    sql: (c) => `select schemaname || '.' || relname as "table", (n_tup_ins + n_tup_upd + n_tup_del) as writes, n_live_tup as live_rows, n_dead_tup as dead_rows, greatest(last_analyze, last_autoanalyze) as last_analyzed
      from pg_stat_user_tables where last_vacuum is null and last_autovacuum is null and (n_tup_ins + n_tup_upd + n_tup_del) > 10000 and ${ut(c, "schemaname", "relname")} order by writes desc limit 25` },

  // ───────── Indexes
  { id: "i_redundant", section: "indexes", title: "Redundant indexes (prefix of another)", source: "pg_index", limit: 25,
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
      where not a.indisunique and not a.indisprimary and ${us(c, "n.nspname")} order by bytes desc limit 25` },

  // ───────── Schema & integrity
  { id: "sch_seq", section: "schema", title: "Sequence usage", source: "pg_sequences", limit: 30,
    description: "How much of each sequence's range is used. An integer sequence that runs out makes inserts fail. Sequences you can't SELECT show no value.",
    columns: [C("sequence", "Sequence", "mono"), C("type", "Type"), C("last_value", "Last value"), C("max_value", "Max value"), C("pct_used", "Used", "pct", { warn: 50, bad: 80 }), C("cycle", "Cycles", "bool"), C("readable", "Readable", "bool"),
      C("owner_table", "Used by", "mono"), C("inserts", "Rows inserted since stats reset", "int")],
    sql: (c) => `select s.schemaname || '.' || s.sequencename as sequence, s.data_type::text as type, s.last_value::text as last_value, s.max_value::text as max_value,
      round(100.0 * s.last_value / nullif(s.max_value, 0), 2) as pct_used, s.cycle, has_sequence_privilege(format('%I.%I', s.schemaname, s.sequencename), 'SELECT') as readable,
      o.owner_table, o.inserts
      from pg_sequences s
      left join lateral (select d.refobjid::regclass::text as owner_table, st.n_tup_ins as inserts from pg_depend d
        left join pg_stat_user_tables st on st.relid = d.refobjid
        where d.objid = format('%I.%I', s.schemaname, s.sequencename)::regclass and d.classid = 'pg_class'::regclass
          and d.refclassid = 'pg_class'::regclass and d.deptype in ('a', 'i') limit 1) o on true
      where ${us(c, "s.schemaname")} order by pct_used desc nulls last limit 30` },
  { id: "sch_notvalid", section: "schema", title: "Unvalidated constraints", source: "pg_constraint", limit: 30,
    description: "Constraints added as NOT VALID protect new rows only. Existing rows may still violate them until VALIDATE CONSTRAINT runs.",
    columns: [C("table", "Table", "mono"), C("constraint", "Constraint", "mono"), C("type", "Type"), C("definition", "Definition", "mono")],
    sql: (c) => `select n.nspname || '.' || t.relname as "table", k.conname as "constraint", case k.contype when 'f' then 'foreign key' when 'c' then 'check' else k.contype::text end as type, pg_get_constraintdef(k.oid) as definition
      from pg_constraint k join pg_class t on t.oid = k.conrelid join pg_namespace n on n.oid = t.relnamespace where not k.convalidated and ${us(c, "n.nspname")} limit 30` },
  { id: "sch_triggers", section: "schema", title: "Disabled triggers", source: "pg_trigger", limit: 30,
    description: "Triggers switched off. Often left over from a bulk load, which silently skips the logic they enforce.",
    columns: [C("table", "Table", "mono"), C("trigger", "Trigger", "mono"), C("function", "Function", "mono")],
    sql: (c) => `select n.nspname || '.' || t.relname as "table", g.tgname::text as trigger, g.tgfoid::regproc::text as function
      from pg_trigger g join pg_class t on t.oid = g.tgrelid join pg_namespace n on n.oid = t.relnamespace
      where not g.tgisinternal and g.tgenabled = 'D' and ${us(c, "n.nspname")} limit 30` },
  { id: "sch_unlogged", section: "schema", title: "Unlogged tables", source: "pg_class", limit: 30,
    description: "Not crash-safe and not replicated. Their contents are lost after a crash and absent on standbys.",
    columns: [C("table", "Table", "mono"), C("bytes", "Size", "bytes"), C("est_rows", "Est. rows", "int")],
    sql: (c) => `select n.nspname || '.' || t.relname as "table", pg_total_relation_size(t.oid) as bytes, greatest(t.reltuples, 0)::bigint as est_rows
      from pg_class t join pg_namespace n on n.oid = t.relnamespace where t.relpersistence = 'u' and t.relkind = 'r' and ${us(c, "n.nspname")} order by bytes desc limit 30` },
  { id: "sch_lo", section: "schema", title: "Large objects", source: "pg_largeobject_metadata", layout: "kv", limit: 1,
    description: "Legacy large-object storage. It isn't cleaned up when a referencing row is deleted, so orphans accumulate.",
    columns: [C("objects", "Objects", "int"), C("bytes", "Size", "bytes")],
    sql: () => `select (select count(*) from pg_largeobject_metadata)::int as objects, pg_total_relation_size('pg_largeobject') as bytes` },

  // ───────── Blocking & connections
  { id: "b_running", section: "blocking", title: "Queries running now", source: "pg_stat_activity", limit: 15,
    description: "Active statements, longest first.",
    columns: [C("pid", "PID", "id"), C("user", "User"), C("app", "Application"), C("running_s", "Running for", "secs", { warn: 300, bad: 3600 }), C("wait", "Waiting on", "mono"), C("query", "Query", "mono")],
    sql: () => `select pid, usename::text as "user", application_name as app, round(extract(epoch from now() - query_start)::numeric, 1) as running_s,
      coalesce(wait_event_type || ': ' || wait_event, '') as wait, ${maskSql("query")} as query
      from pg_stat_activity where state = 'active' and backend_type = 'client backend' and pid <> pg_backend_pid() order by running_s desc limit 15` },
  { id: "c_waits", section: "connections", title: "What active sessions are waiting on", source: "pg_stat_activity", limit: 20,
    description: "A snapshot of wait events across active sessions. Lock and I/O waits dominate most slowdowns.",
    columns: [C("type", "Wait type"), C("event", "Wait event", "mono"), C("sessions", "Sessions", "int")],
    sql: () => `select coalesce(wait_event_type, 'Running on CPU') as type, coalesce(wait_event, '-') as event, count(*)::int as sessions
      from pg_stat_activity where state = 'active' and backend_type = 'client backend' and pid <> pg_backend_pid() group by 1, 2 order by sessions desc limit 20` },

  // ───────── Configuration
  { id: "cfg_version", section: "config", title: "Server version and support", source: "pg_settings", layout: "kv", limit: 1,
    description: "Which release you run. Each major version gets security fixes for five years.",
    columns: [C("version", "Version", "mono"), C("in_recovery", "Is a standby", "bool"), C("data_checksums", "Data checksums", "mono"), C("db_bytes", "This database", "bytes")],
    sql: () => `select current_setting('server_version') as version, current_setting('server_version_num')::int as version_num, pg_is_in_recovery() as in_recovery,
      current_setting('data_checksums') as data_checksums, pg_database_size(current_database()) as db_bytes` },
  { id: "cfg_safety", section: "config", title: "Durability, safety and security settings", source: "pg_settings", limit: 30,
    description: "Settings where the wrong value risks data loss, corruption or exposure.", columns: SETTING_COLS,
    sql: () => setting(["fsync", "full_page_writes", "synchronous_commit", "data_checksums", "track_counts", "autovacuum", "password_encryption", "ssl", "wal_level", "archive_mode", "max_replication_slots", "max_wal_size", "shared_buffers", "work_mem", "max_connections"]) },

  // ───────── Logs & activity
  { id: "io_stat", section: "logs", title: "I/O by backend type", source: "pg_stat_io", limit: 20, minPg: 160000,
    description: "Reads and writes by process type. Times need track_io_timing.",
    columns: [C("backend", "Backend", "mono"), C("object", "Object"), C("context", "Context"), C("reads", "Reads", "int"), C("read_ms", "Read time", "ms"), C("writes", "Writes", "int"), C("write_ms", "Write time", "ms"), C("hits", "Cache hits", "int"), C("evictions", "Evictions", "int")],
    sql: () => `select backend_type as backend, object, context, reads, round(read_time::numeric) as read_ms, writes, round(write_time::numeric) as write_ms, hits, evictions
      from pg_stat_io where coalesce(reads, 0) > 0 or coalesce(writes, 0) > 0 order by coalesce(read_time, 0) + coalesce(write_time, 0) desc, coalesce(reads, 0) + coalesce(writes, 0) desc limit 20` },

  // ───────── Security
  { id: "s_definer", section: "security", title: "SECURITY DEFINER functions", source: "pg_proc", limit: 40,
    description: "These run with the owner's privileges. Without a fixed search_path, a caller can shadow objects and hijack them.",
    columns: [C("function", "Function", "mono"), C("owner", "Owner"), C("search_path_set", "search_path fixed", "bool"), C("public_exec", "Callable by anyone", "bool")],
    sql: (c) => `select n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as function, pg_get_userbyid(p.proowner)::text as owner,
      exists (select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) cfg where cfg like 'search_path=%') as search_path_set, has_function_privilege('public', p.oid, 'EXECUTE') as public_exec
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where p.prosecdef and ${us(c, "n.nspname")} and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e') order by 3, 1 limit 40` },
  { id: "s_exposure", section: "security", title: "Public tables readable by the anon role", source: "pg_class, pg_policy", only: ["supabase"], limit: 50,
    description: "Tables in the public schema that the anon role can read while row-level security is off. On Supabase these are exposed through the public API.",
    columns: [C("table", "Table", "mono"), C("rls", "RLS enabled", "bool"), C("anon_select", "anon can SELECT", "bool"), C("est_rows", "Est. rows", "int")],
    sql: () => `select n.nspname || '.' || t.relname as "table", t.relrowsecurity as rls, has_table_privilege('anon', t.oid, 'SELECT') as anon_select, greatest(t.reltuples, 0)::bigint as est_rows
      from pg_class t join pg_namespace n on n.oid = t.relnamespace
      where n.nspname = 'public' and t.relkind in ('r','p') and not t.relrowsecurity and has_table_privilege('anon', t.oid, 'SELECT') order by est_rows desc limit 50` },
  { id: "s_hba", section: "security", title: "Authentication rules", source: "pg_hba_file_rules", only: ["generic"], limit: 60,
    description: "Which hosts may connect, as whom, and how they authenticate. Needs superuser or an explicit GRANT on the view.",
    columns: [C("line", "Line", "id"), C("type", "Type", "mono"), C("database", "Database", "mono"), C("users", "Users", "mono"), C("address", "Address", "mono"), C("method", "Method", "mono")],
    sql: () => `select line_number as line, type, array_to_string(database, ',') as database, array_to_string(user_name, ',') as users, coalesce(address, '') as address, auth_method as method
      from pg_hba_file_rules order by line_number limit 60` },

  // ───────── Backups & recovery
  { id: "bk_archiving", section: "backups", title: "WAL archiving", source: "pg_settings, pg_stat_archiver", layout: "kv", limit: 1,
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
             when cfg.cmd ~* '^\s*(/bin/true|/usr/bin/true|true|:|exit 0)\s*$' then 'no-op (discards WAL)'
             when cfg.cmd ~* 'pgbackrest' then 'pgBackRest' when cfg.cmd ~* 'wal-g|walg' then 'WAL-G' when cfg.cmd ~* 'barman' then 'Barman' when cfg.cmd ~* 'pg_probackup' then 'pg_probackup'
             when cfg.cmd ~* 'aws s3|s3cmd|s3://' then 'S3 script' when cfg.cmd ~* 'gsutil|gcloud' then 'GCS script' when cfg.cmd ~* '(^|[ /])cp ' then 'cp (local copy)'
             when cfg.cmd in ('', '(disabled)') then 'not set' else 'custom script' end as tool,
        cfg.archive_timeout_s,
        case when cfg.archive_mode = 'off' or pg_is_in_recovery() or arc.last_archived_wal is null then null else
          ((('x' || substr(pg_walfile_name(pg_current_wal_lsn()), 9, 8))::bit(32)::bigint * (4294967296 / cfg.segsize) + ('x' || substr(pg_walfile_name(pg_current_wal_lsn()), 17, 8))::bit(32)::bigint)
         - (('x' || substr(arc.last_archived_wal, 9, 8))::bit(32)::bigint * (4294967296 / cfg.segsize) + ('x' || substr(arc.last_archived_wal, 17, 8))::bit(32)::bigint)) end as segments_behind,
        arc.archived_count, arc.failed_count, arc.last_archived_time, arc.last_failed_time
      from cfg, arc` },
  { id: "bk_wal_rate", section: "backups", title: "Archive volume and database size", source: "pg_stat_wal, pg_database_size()", layout: "kv", limit: 1, minPg: 140000,
    description: "How much WAL this database produces (what a WAL archive must store per day) and how big a full backup is. Use these to size storage and estimate restore time.",
    columns: [C("db_bytes", "Database size", "bytes"), C("wal_per_day_bytes", "WAL per day (estimate)", "bytes"), C("window_s", "Measured over", "secs")],
    sql: () => `select pg_database_size(current_database()) as db_bytes,
      round(w.wal_bytes / greatest(extract(epoch from now() - coalesce(w.stats_reset, pg_postmaster_start_time())), 1) * 86400)::bigint as wal_per_day_bytes,
      round(extract(epoch from now() - coalesce(w.stats_reset, pg_postmaster_start_time())))::bigint as window_s from pg_stat_wal w` },
  { id: "bk_unprotected", section: "backups", title: "What backups don't cover", source: "pg_class, pg_tablespace, pg_roles", limit: 40,
    description: "Objects that physical backups or logical dumps handle differently. Unlogged tables are not in the WAL, so they are empty after point-in-time recovery. Roles and tablespaces live outside a per-database dump.",
    columns: [C("kind", "Kind"), C("object", "Object", "mono"), C("detail", "Why it matters")],
    sql: (c) => `select * from (
        select 'Unlogged table' as kind, n.nspname || '.' || t.relname as object, 'Not WAL-logged: missing from PITR restores and replicas.' as detail
          from pg_class t join pg_namespace n on n.oid = t.relnamespace where t.relpersistence = 'u' and t.relkind = 'r' and ${us(c, "n.nspname")}
        union all select 'Tablespace', spcname::text, 'pg_dump does not recreate tablespaces; physical backups must include them.' from pg_tablespace where spcname not in ('pg_default', 'pg_global')
        union all select 'Roles', count(*)::text || ' login role(s)', 'Roles and grants are outside per-database dumps. Back them up with pg_dumpall --globals-only.'
          from pg_roles where rolcanlogin and rolname !~ '^pg_' and not ${c.profile.managedRoleSql("rolname")} having count(*) > 0
        union all select 'Large objects', count(*)::text || ' object(s)', 'Not removed with referencing rows; make sure dumps include them (pg_dump --large-objects).' from pg_largeobject_metadata having count(*) > 0
      ) u limit 40` },
];
void inDb; void pgss;
