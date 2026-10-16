// Pure module (no Node/pg imports) so the web client can import it.
export type SectionId = "queries" | "tables" | "indexes" | "schema" | "blocking" | "connections" | "replication" | "backups" | "vacuum" | "config" | "capacity" | "logs" | "security" | "extensions";

export interface SectionMeta { id: SectionId; title: string; description: string; note?: string }

export const SECTIONS: SectionMeta[] = [
  { id: "queries", title: "Queries", description: "Where query time goes: heaviest, slowest, most I/O-hungry, most frequent, and temp-file spillers." },
  { id: "tables", title: "Tables", description: "Sizes, row counts, scan patterns, write churn and cache behavior per table." },
  { id: "indexes", title: "Indexes", description: "Index sizes and usage, unused and duplicate indexes, invalid indexes, and foreign keys without a supporting index." },
  { id: "schema", title: "Schema & integrity", description: "Sequences nearing exhaustion, unvalidated constraints, disabled triggers, unlogged tables and large objects." },
  { id: "blocking", title: "Blocked transactions", description: "Lock waits, long-running and idle-in-transaction sessions, prepared transactions, and what is holding back vacuum." },
  { id: "connections", title: "Connections", description: "Connections in use versus the limit, sessions by state, who is connected, and encryption in use." },
  { id: "replication", title: "Replication & WAL", description: "Replication slots, standby lag, WAL volume and retention, checkpoints, archiving and publications." },
  { id: "backups", title: "Backups & recovery", description: "Whether point-in-time recovery is possible, whether WAL archiving is healthy, and what physical backups don't cover.",
    note: "Whether a backup can actually be restored can't be proven from SQL. This area shows what the database can prove (archiving, WAL flow, unprotected objects); the rest needs a restore drill." },
  { id: "vacuum", title: "Vacuum & bloat", description: "Dead tuples, autovacuum activity, and transaction ID / MultiXact wraparound distance." },
  { id: "config", title: "Configuration", description: "Key memory, I/O and connection settings, and everything changed from the defaults." },
  { id: "capacity", title: "Capacity & scaling", description: "Signs that the database is outgrowing its server: memory pressure, disk waits, busy CPU, spills to disk, and where scaling up or out would help.",
    note: "CPU, memory and disk usage of the host aren't visible over SQL, so this area infers pressure from what the database reports. Work through it in order: tune first (queries, indexes, memory settings), then scale up (a bigger instance), then scale out (a read replica, or splitting big tables). The numbers describe the period since statistics were last reset; to see when you will run out of room, compare scans over time." },
  { id: "logs", title: "Logs & activity", description: "What the database reports about errors, deadlocks and temp files, plus how logging is configured.",
    note: "Server log files can't be read over SQL on most managed providers, and need superuser on self-hosted. This section shows what the database itself tracks. To analyze the log files themselves, use your provider's log viewer or pgBadger." },
  { id: "security", title: "Security", description: "Login roles and privileges, row-level security coverage, and policy definitions." },
  { id: "extensions", title: "Extensions", description: "Installed extensions, their versions, and available upgrades." },
];

export const sectionMeta = (id: string) => SECTIONS.find((s) => s.id === id);

export type ColKind = "text" | "mono" | "int" | "id" | "bytes" | "ms" | "secs" | "pct" | "ts" | "bool";
export interface Column {
  key: string; label: string; kind?: ColKind;
  /** Highlight values at/above these thresholds (amber / red). */
  warn?: number; bad?: number;
}
export interface Dataset {
  id: string; section: SectionId; title: string; description: string;
  /** The catalog view(s) the data comes from. */
  source: string;
  layout: "table" | "kv";
  columns: Column[];
  rows: Record<string, unknown>[];
  /** True when the query hit its row cap, so more rows may exist. */
  capped: boolean;
  note?: string; error?: string;
}
export interface Vital { label: string; value: number | string | null; kind?: ColKind; tone?: "ok" | "warn" | "bad"; hint?: string }

export type CheckStatus = "passed" | "flagged" | "skipped" | "na";
/** One line in the "what we checked" list: every check, whether it found something or not. */
export interface CheckResult {
  id: string; section: SectionId; title: string;
  /** What the check looks for, in plain words. */
  looks: string;
  /** When it flags something, and at what severity. */
  flags: string;
  status: CheckStatus;
  severity?: "critical" | "warning" | "info";
  /** Why it was skipped / not applicable, or a note on a pass. */
  reason?: string;
}
export const CATEGORY: Record<SectionId, string> = {
  queries: "Queries", tables: "Tables", indexes: "Indexes", schema: "Schema", blocking: "Locks & transactions", connections: "Connections",
  replication: "Replication & WAL", backups: "Backups & recovery", vacuum: "Vacuum & bloat", config: "Configuration", capacity: "Capacity & scaling", logs: "Logs & activity", security: "Security", extensions: "Extensions",
};
