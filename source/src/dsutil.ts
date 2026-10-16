import type { Ctx } from "./types.js";
import type { Column, ColKind, SectionId } from "./sections.js";
import type { ProviderId } from "./provider.js";
import { userSchemaSql, userTableSql } from "./provider.js";

export interface Def {
  id: string; section: SectionId; title: string; description: string; source: string;
  layout?: "table" | "kv"; columns: Column[]; limit?: number;
  /** Needs this extension installed; otherwise the dataset shows `hint` instead of rows. */
  ext?: string; hint?: string;
  /** With `ext`: when the extension is missing, leave the dataset out entirely (its checks become "not applicable") instead of showing a hint. */
  optional?: boolean;
  /** Only collected for these providers / at or above this server_version_num. */
  only?: ProviderId[]; minPg?: number;
  sql: (c: Ctx) => string;
}
export const C = (key: string, label: string, kind: ColKind = "text", extra: Partial<Column> = {}): Column => ({ key, label, kind, ...extra });

export const NUMERIC: ColKind[] = ["int", "bytes", "ms", "secs", "pct"];
export const us = (c: Ctx, col: string) => userSchemaSql(c.profile, col);
/** Schema predicate that also admits the extension bookkeeping tables (pg_cron, pg_net) the customer must keep trimmed. */
export const ut = (c: Ctx, schemaCol: string, tableCol: string) => userTableSql(c.profile, schemaCol, tableCol);
/**
 * Statements that read the catalog rather than the customer's data: dashboards (Supabase Studio, pgAdmin), ORMs
 * introspecting the schema, migration tools and monitoring agents. They can dominate pg_stat_statements on a quiet
 * database and say nothing about the application, so the query datasets leave them out.
 */
export const TOOLING_SQL = String.raw`(pg_catalog\.|information_schema\.|\mpg_(timezone_names|available_extensions|extension|namespace|class|proc|policy|policies|type|attribute|attrdef|constraint|index|indexes|roles|authid|auth_members|database|settings|stat_|statio_|description|depend|trigger|rewrite|enum|inherits|tables|views|sequences|locks|replication_slots)\M)`;
export const inDb = "(select oid from pg_database where datname = current_database())";
/** pg_stat_statements rows for this database, excluding provider-internal roles and ourselves. */
export const pgss = (c: Ctx) => `from pg_stat_statements s join pg_roles r on r.oid = s.userid
  where s.dbid = ${inDb} and not ${c.profile.managedRoleSql("r.rolname")} and s.query !~* '${TOOLING_SQL}' and s.query not like '%/* pg-checkup */%'`;
/** Setting names whose values may hold credentials (connection strings, keys, tokens, commands that embed them). */
export const SECRET_NAME = String.raw`(pass|secret|token|conninfo|credential|api_?key|private|_command$|(^|[._])key($|[._]))`;
/** A settings value, hidden when the setting's name suggests it may be secret. */
/** Hides secrets by name, and any value that is a connection address (a provider's internal endpoints, primary_conninfo). */
export const safeValue = (col = "setting", name = "name") => `case when ${name} ~* '${SECRET_NAME}' or ${col} ~ '://|host=' then '(hidden)' else ${col} end`;
/**
 * Masks literals in SQL text. pg_stat_activity is not normalized, so its text carries the application's values:
 * quoted strings and dollar-quoted bodies become '?' and bare numbers become ?. Numbers inside identifiers (t1, $1
 * parameters) are left alone because they follow a letter, digit, underscore or $.
 */
const QUOTED = `'([^']|'')*'`;
const DOLLAR_QUOTED = String.raw`\$([A-Za-z_]*)\$.*?\$\1\$`;
const NUMBER = String.raw`(^|[^\w$.])-?\d+(\.\d+)?(e[+-]?\d+)?\M`;
const KEEP_PREFIX = String.raw`\1`;
export const maskSql = (col: string, n = 400) =>
  `left(regexp_replace(regexp_replace(regexp_replace(${col}, $re$${QUOTED}$re$, $$'?'$$, 'g'), $re$${DOLLAR_QUOTED}$re$, $$'?'$$, 'g'), $re$${NUMBER}$re$, $$${KEEP_PREFIX}?$$, 'g'), ${n})`;
export const setting = (names: string[]) => `select name, ${safeValue()} as setting, coalesce(unit, '') as unit, source from pg_settings where name in (${names.map((n) => `'${n}'`).join(",")}) order by name`;
export const SETTING_COLS = [C("name", "Setting", "mono"), C("setting", "Value", "mono"), C("unit", "Unit"), C("source", "Source")];


/** Errors that mean the connection itself is gone (not "this one query failed"). A scan must abort on these rather than report a hollow all-clear. */
export function isConnectionLost(e: unknown): boolean {
  const x = e as { code?: string; message?: string };
  return /^08/.test(x?.code ?? "") || /^57P0[123]$/.test(x?.code ?? "") || /Connection terminated|connection.*(closed|ended|reset)|ECONNRESET|EPIPE|Client has encountered a connection error|terminating connection/i.test(x?.message ?? "");
}
