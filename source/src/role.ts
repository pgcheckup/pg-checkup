import type { Profile } from "./provider.js";
import type { RoleInfo } from "./bundle.js";
import { userSchemaSql } from "./provider.js";

/** Predefined roles that reach table data or the server's files. A monitoring role needs none of them. */
const DATA_ROLES = ["pg_read_all_data", "pg_write_all_data", "pg_read_server_files", "pg_write_server_files", "pg_execute_server_program"];

/**
 * What the connected role may do, read from the catalog. Application tables are those outside system and
 * provider-managed schemas that no extension owns (an extension's own views, such as pg_stat_statements, are not data).
 */
export function roleSql(p: Profile): string {
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

export function roleInfo(r: Record<string, any>): RoleInfo {
  return {
    role: String(r.role), superuser: Boolean(r.superuser), monitor: Boolean(r.monitor), bypassrls: Boolean(r.bypassrls), replication: Boolean(r.replication),
    createrole: Boolean(r.createrole), createdb: Boolean(r.createdb), dataRoles: (r.data_roles ?? []).map(String),
    readableTables: Number(r.readable_tables ?? 0), writableTables: Number(r.writable_tables ?? 0), readableSample: (r.readable_sample ?? []).map(String),
  };
}

/**
 * Reasons the role is more powerful than a health check needs. The collector refuses to run while there are any,
 * because a role that can read or change data could, in principle, be made to. Plain sentences, one per reason.
 */
export function roleProblems(r: RoleInfo): string[] {
  const out: string[] = [];
  if (r.superuser) out.push(`${r.role} is a superuser.`);
  if (r.bypassrls) out.push(`${r.role} has BYPASSRLS, so row-level security doesn't apply to it.`);
  if (r.replication) out.push(`${r.role} has REPLICATION, which can stream every row of the database.`);
  if (r.createrole) out.push(`${r.role} has CREATEROLE, which can grant itself other roles.`);
  if (r.createdb) out.push(`${r.role} has CREATEDB, which is unnecessary for inspection.`);
  if (r.dataRoles.length) out.push(`${r.role} is a member of ${r.dataRoles.join(", ")}.`);
  if (r.writableTables) out.push(`${r.role} can write to ${r.writableTables} application ${r.writableTables === 1 ? "table" : "tables"}.`);
  if (r.readableTables) out.push(`${r.role} can read ${r.readableTables} application ${r.readableTables === 1 ? "table" : "tables"}${r.readableSample.length ? ` (${r.readableSample.slice(0, 3).join(", ")}${r.readableTables > 3 ? ", ..." : ""})` : ""}.`);
  return out;
}

export class RoleRefused extends Error {
  constructor(public problems: string[]) { super(problems.join("\n")); this.name = "RoleRefused"; }
}
export function requireMonitoringRole(role: RoleInfo, allowPrivilegedRole = false) {
  const problems = roleProblems(role);
  if (problems.length && !allowPrivilegedRole) throw new RoleRefused(problems);
}

/** The role the collector asks for: statistics only, no table data, no writes. Matches sql/create-monitor-role.sql. */
export const MONITOR_ROLE_SQL = `create role checkup_reader login password 'choose-a-password';
grant pg_monitor to checkup_reader;
-- Nothing else: no table grants, no superuser, no BYPASSRLS, no REPLICATION.`;
