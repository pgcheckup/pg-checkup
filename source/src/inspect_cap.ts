import { type Def, C, us, maskSql } from "./dsutil.js";

/** Capacity & scaling: what the database reports about load and memory, plus pg_cron and pg_net health. */
export const CAP: Def[] = [
  { id: "cap_load", section: "capacity", title: "Workload since statistics were reset", source: "pg_stat_database", layout: "kv", limit: 1,
    description: "Average rates over the time since statistics were last reset (or the server started). Short windows are noisy.",
    columns: [C("tps", "Transactions / s", "int"), C("disk_read_bps", "Disk reads / s", "bytes"), C("temp_bytes_per_hour", "Temp files / hour", "bytes"), C("tup_read", "Rows read", "int"), C("tup_written", "Rows written", "int"), C("cache_hit_pct", "Cache hit", "pct"), C("window_s", "Window", "secs")],
    sql: () => `select round(((d.xact_commit + d.xact_rollback)::numeric / w.secs), 1) as tps,
        round(d.blks_read::numeric * current_setting('block_size')::numeric / w.secs)::bigint as disk_read_bps,
        round(d.temp_bytes::numeric / w.secs * 3600)::bigint as temp_bytes_per_hour,
        (d.tup_returned + d.tup_fetched)::bigint as tup_read, (d.tup_inserted + d.tup_updated + d.tup_deleted)::bigint as tup_written,
        round(w.secs)::bigint as window_s, round(100.0 * d.blks_hit / nullif(d.blks_hit + d.blks_read, 0), 2) as cache_hit_pct
      from pg_stat_database d cross join lateral (select greatest(extract(epoch from now() - coalesce(d.stats_reset, pg_postmaster_start_time()))::numeric, 1) as secs) w
      where d.datname = current_database()` },
  { id: "cap_sizing", section: "capacity", title: "Data size against memory settings", source: "pg_settings, pg_class", layout: "kv", limit: 1,
    description: "How big the data is next to the memory the server is configured to use for caching.",
    columns: [C("db_bytes", "Database size", "bytes"), C("shared_buffers_bytes", "shared_buffers", "bytes"), C("effective_cache_bytes", "effective_cache_size", "bytes"), C("work_mem_bytes", "work_mem", "bytes"), C("max_connections", "max_connections", "int"), C("largest_table_bytes", "Largest table", "bytes")],
    sql: (c) => `select pg_database_size(current_database()) as db_bytes,
        (select setting::bigint * current_setting('block_size')::bigint from pg_settings where name = 'shared_buffers') as shared_buffers_bytes,
        (select setting::bigint * current_setting('block_size')::bigint from pg_settings where name = 'effective_cache_size') as effective_cache_bytes,
        (select setting::bigint * 1024 from pg_settings where name = 'work_mem') as work_mem_bytes,
        current_setting('max_connections')::int as max_connections,
        coalesce((select max(pg_total_relation_size(t.oid)) from pg_class t join pg_namespace n on n.oid = t.relnamespace where t.relkind = 'r' and ${us(c, "n.nspname")}), 0) as largest_table_bytes` },
  { id: "cap_workers", section: "capacity", title: "Autovacuum workers", source: "pg_stat_activity, pg_settings", layout: "kv", limit: 1,
    description: "How many autovacuum workers are running right now, out of the maximum.",
    columns: [C("running", "Running now", "int"), C("max_workers", "autovacuum_max_workers", "int")],
    sql: () => `select (select count(*) from pg_stat_activity where backend_type = 'autovacuum worker')::int as running, current_setting('autovacuum_max_workers')::int as max_workers` },

  { id: "cap_footprint", section: "capacity", title: "Footprint on disk", source: "pg_database_size(), pg_ls_waldir()", layout: "kv", limit: 1,
    description: "What this server puts on its volume: this database, every other database on the same server, and WAL. Postgres can't see the volume's size or free space, so compare these numbers with your host or provider metrics.",
    columns: [C("db_bytes", "This database", "bytes"), C("other_dbs_bytes", "Other databases", "bytes"), C("wal_bytes", "WAL", "bytes"), C("total_bytes", "Total (at least)", "bytes"), C("temp_bytes_per_day", "Temp files / day", "bytes"), C("window_s", "Measured over", "secs")],
    sql: () => `select d.db_bytes, d.other_dbs_bytes, w.wal_bytes, d.db_bytes + d.other_dbs_bytes + w.wal_bytes as total_bytes,
        (select round(s.temp_bytes / greatest(extract(epoch from now() - coalesce(s.stats_reset, pg_postmaster_start_time())), 1) * 86400)::bigint from pg_stat_database s where s.datname = current_database()) as temp_bytes_per_day,
        (select round(extract(epoch from now() - coalesce(s.stats_reset, pg_postmaster_start_time())))::bigint from pg_stat_database s where s.datname = current_database()) as window_s
      from (select pg_database_size(current_database())::bigint as db_bytes,
                   coalesce(sum(pg_database_size(oid)) filter (where datname <> current_database() and datallowconn), 0)::bigint as other_dbs_bytes from pg_database) d,
           (select coalesce(sum(size), 0)::bigint as wal_bytes from pg_ls_waldir()) w` },

  // pg_net: only when the extension is installed
  { id: "net_queue", section: "extensions", title: "pg_net queue and response table", source: "net.http_request_queue, net._http_response, pg_settings", layout: "kv", limit: 1, ext: "pg_net", optional: true,
    description: "pg_net stores every response in net._http_response and deletes rows older than pg_net.ttl (default 6 hours). Heavy webhook or edge-function traffic churns this table faster than autovacuum reclaims it, and a growing request queue means the worker is behind.",
    columns: [C("queued", "Requests waiting", "int", { warn: 1000, bad: 10000 }), C("response_rows", "Responses kept (estimated)", "int"), C("response_dead_rows", "Dead rows", "int"), C("response_bytes", "Response table size", "bytes", { warn: 104857600, bad: 1073741824 }), C("ttl", "pg_net.ttl", "mono"), C("last_autovacuum", "Last autovacuum", "ts")],
    sql: () => `select coalesce((select greatest(s.n_live_tup, c.reltuples::bigint, 0) from pg_stat_user_tables s join pg_class c on c.oid = s.relid where s.schemaname = 'net' and s.relname = 'http_request_queue'), 0)::bigint as queued,
        coalesce(r.n_live_tup, 0)::bigint as response_rows, coalesce(r.n_dead_tup, 0)::bigint as response_dead_rows,
        coalesce((select pg_total_relation_size(c.oid) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'net' and c.relname = '_http_response'), 0)::bigint as response_bytes,
        coalesce(current_setting('pg_net.ttl', true), '6 hours (default)') as ttl, r.last_autovacuum
      from (select 1) x left join pg_stat_user_tables r on r.schemaname = 'net' and r.relname = '_http_response'` },

  // pg_cron: only when the extension is installed
  { id: "cron_history", section: "extensions", title: "pg_cron run history", source: "pg_stat_user_tables, cron.job_run_details", layout: "kv", limit: 1, ext: "pg_cron", optional: true,
    description: "pg_cron records every run in cron.job_run_details, and nothing removes old rows unless you schedule that yourself.",
    columns: [C("jobs", "Jobs (estimated)", "int"), C("run_rows", "Logged runs (estimated)", "int"), C("bytes", "History size", "bytes", { warn: 104857600, bad: 1073741824 })],
    sql: () => `select coalesce((select greatest(s.n_live_tup, c.reltuples::bigint, 0) from pg_stat_user_tables s join pg_class c on c.oid = s.relid where s.schemaname = 'cron' and s.relname = 'job'), 0)::bigint as jobs,
        coalesce((select greatest(s.n_live_tup, c.reltuples::bigint, 0) from pg_stat_user_tables s join pg_class c on c.oid = s.relid where s.schemaname = 'cron' and s.relname = 'job_run_details'), 0)::bigint as run_rows,
        coalesce((select pg_total_relation_size(c.oid) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'cron' and c.relname = 'job_run_details'), 0)::bigint as bytes` },
  { id: "cron_failures", section: "extensions", title: "pg_cron jobs that failed this week", source: "cron.job_run_details", limit: 20, ext: "pg_cron", optional: true,
    description: "Scheduled jobs with failed runs in the last 7 days. pg_cron only shows a role its own jobs, so this needs the job owner or a superuser.",
    columns: [C("jobid", "Job", "int"), C("failed", "Failed runs", "int"), C("runs", "Runs", "int"), C("last_failure", "Last failure", "ts"), C("message", "Message", "mono")],
    sql: () => `select jobid::bigint as jobid, (count(*) filter (where status = 'failed'))::int as failed, count(*)::int as runs,
        max(start_time) filter (where status = 'failed') as last_failure,
        (array_agg(regexp_replace(${maskSql("return_message", 160)}, $$\\)=\\([^)]*\\)$$, $$)=(?)$$, 'g') order by start_time desc) filter (where status = 'failed'))[1] as message
      from cron.job_run_details where start_time > now() - interval '7 days' group by jobid
      having count(*) filter (where status = 'failed') > 0 order by failed desc limit 20` },
  // Public basis: the pg_buffercache extension docs (F.25). Reading it needs pg_monitor, which the checkup role has.
  { id: "cap_buffers", section: "capacity", title: "What's in shared_buffers", source: "pg_buffercache", limit: 20, ext: "pg_buffercache",
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
      group by n.nspname, r.relname, r.relkind, r.oid order by count(*) desc limit 20` },
];
