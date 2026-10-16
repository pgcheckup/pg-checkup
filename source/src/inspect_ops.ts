import { type Def, C, setting, SETTING_COLS } from "./dsutil.js";

/** Read replicas, replication that stopped, and stale connections. */
export const OPS: Def[] = [
  // Only returns a row when the server you connected to is itself a standby.
  { id: "r_receiver", section: "replication", title: "This replica's link to its primary", source: "pg_stat_wal_receiver, pg_last_wal_*", layout: "kv", limit: 1,
    description: "Shown only when you scanned a standby. Whether it is still receiving WAL, how much it has received but not applied, and whether replay is paused.",
    columns: [C("status", "Receiver status"), C("expects_streaming", "Set up to stream", "bool"), C("apply_backlog_bytes", "Received, not applied", "bytes", { warn: 268_435_456, bad: 2_147_483_648 }), C("secs_since_msg", "Since last message", "secs"), C("paused", "Replay paused", "bool"), C("replay_delay_s", "Since last replayed commit", "secs")],
    sql: () => `select (select count(*) from pg_stat_wal_receiver)::int as receivers, (select status from pg_stat_wal_receiver limit 1) as status,
        coalesce((select setting <> '' from pg_settings where name = 'primary_conninfo'), false) as expects_streaming,
        pg_is_wal_replay_paused() as paused, pg_wal_lsn_diff(pg_last_wal_receive_lsn(), pg_last_wal_replay_lsn())::bigint as apply_backlog_bytes,
        (select round(extract(epoch from now() - last_msg_receipt_time)::numeric)::bigint from pg_stat_wal_receiver limit 1) as secs_since_msg,
        round(extract(epoch from now() - pg_last_xact_replay_timestamp())::numeric)::bigint as replay_delay_s
      where pg_is_in_recovery()` },
  { id: "r_conflicts", section: "replication", title: "Queries cancelled by recovery conflicts", source: "pg_stat_database_conflicts", layout: "kv", limit: 1,
    description: "Shown only on a standby. Queries on a replica are cancelled when replay needs to remove rows or take locks they depend on.",
    columns: [C("snapshot", "Old snapshot", "int"), C("lock", "Lock", "int"), C("bufferpin", "Buffer pin", "int"), C("deadlock", "Deadlock", "int"), C("tablespace", "Tablespace", "int"), C("total", "Total", "int", { warn: 5, bad: 50 })],
    sql: () => `select confl_snapshot as snapshot, confl_lock as lock, confl_bufferpin as bufferpin, confl_deadlock as deadlock, confl_tablespace as tablespace,
        (confl_snapshot + confl_lock + confl_bufferpin + confl_deadlock + confl_tablespace) as total
      from pg_stat_database_conflicts where datname = current_database() and pg_is_in_recovery()` },
  { id: "r_syncstandby", section: "replication", title: "Synchronous standby", source: "pg_settings, pg_stat_replication", layout: "kv", limit: 1,
    description: "With synchronous replication, a commit waits for a standby to confirm it. If none is connected, commits wait.",
    columns: [C("names", "synchronous_standby_names", "mono"), C("connected", "Synchronous standbys connected", "int")],
    sql: () => `select current_setting('synchronous_standby_names') as names, (select count(*) from pg_stat_replication where sync_state in ('sync', 'quorum'))::int as connected
      from (select 1) x where not pg_is_in_recovery()` },

  { id: "c_stale", section: "connections", title: "Long-idle connections", source: "pg_stat_activity", limit: 20,
    description: "Sessions that have sat idle for more than 30 minutes, grouped by role and application. A session whose client has vanished looks exactly like this.",
    columns: [C("role", "Role", "mono"), C("app", "Application"), C("sessions", "Sessions", "int"), C("oldest_idle_s", "Longest idle", "secs", { warn: 14_400, bad: 86_400 }), C("oldest_started", "Oldest connection opened", "ts")],
    sql: () => `select coalesce(usename, '')::text as role, coalesce(nullif(application_name, ''), '(none)') as app, count(*)::int as sessions,
        max(extract(epoch from now() - state_change))::bigint as oldest_idle_s, min(backend_start) as oldest_started
      from pg_stat_activity where backend_type = 'client backend' and state = 'idle' and pid <> pg_backend_pid() and now() - state_change > interval '30 minutes'
      group by 1, 2 order by sessions desc limit 20` },
  { id: "c_timeouts", section: "connections", title: "Timeouts and keepalives", source: "pg_settings", layout: "table", limit: 12,
    description: "What ends a session whose client is gone. Zero means off, and for the TCP keepalive settings it means the operating system default (often two hours).",
    columns: SETTING_COLS, sql: () => setting(["idle_in_transaction_session_timeout", "idle_session_timeout", "tcp_keepalives_idle", "tcp_keepalives_interval", "tcp_keepalives_count", "tcp_user_timeout", "client_connection_check_interval", "statement_timeout"]) },
];
