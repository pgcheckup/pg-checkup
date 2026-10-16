import type { Client } from "pg";
import type { Profile, ProviderId } from "./provider.js";
import type { SectionId } from "./sections.js";

export type Severity = "critical" | "warning" | "info";
/** What to do with a finding, decided by looking at the findings together (see triage.ts), not by severity alone. */
export type Priority = "now" | "next" | "watch" | "ignore";

export interface Finding {
  id: string;
  severity: Severity;
  category: string;
  /** Which data section holds the underlying numbers. */
  section?: SectionId;
  title: string;
  why: string;
  fix: string;
  /** Review-before-run SQL for the fix, built from the evidence. Never executed by the scanner. */
  sql?: string;
  evidence?: Record<string, unknown> | Record<string, unknown>[];
  /** Set by triage(): fix now, fix next, watch, or safe to ignore for now. */
  priority?: Priority;
  /** Set by triage(): the id of the finding that causes this one, when another finding explains it. */
  cause?: string;
  /** Set by triage(): one sentence relating this finding to the others, in database terms. */
  note?: string;
}

/** Facts the collector reads that are not shown as a data table. */
export interface Facts {
  /** PostgreSQL 14 and earlier: whether PUBLIC can CREATE in the public schema. Null when not read. */
  publicSchemaCreate?: boolean | null;
}

/** What the checks see. Everything here comes from the collected bundle, so analysis needs no connection. */
export interface AnalysisCtx {
  version: number; // e.g. 170006
  opts: ScanOptions;
  profile: Profile;
  tls: boolean;
  local: boolean;
  facts: Facts;
}

/** A live connection, used only while collecting. */
export interface Ctx extends AnalysisCtx {
  db: Client;
  /** Sessions and pid of the scanner itself. */
  selfPid: number;
  q: <T = Record<string, any>>(sql: string, params?: unknown[]) => Promise<T[]>;
}

export interface Check {
  id: string;
  run: (ctx: Ctx) => Promise<Finding[]>;
}

export interface ScanOptions {
  /** Connect to this IP instead of resolving the host again (hosted mode pins the address its SSRF guard checked). */
  connectAddress?: string;
  /** Seconds a session may sit idle in transaction before it is reported. */
  idleTxnSeconds?: number;
  /** Override provider auto-detection (defaults to detecting from the host name). */
  provider?: ProviderId;
  /** Minimum total recorded query time (ms) before a "dominant query" is reported. Default 60000. */
  minWorkloadMs?: number;
  /** Minimum wasted bytes before measured table bloat is reported. Default: 5% of the database, clamped to 8 MB..100 MB. */
  minBloatBytes?: number;
}
