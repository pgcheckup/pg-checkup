import { createHash } from "node:crypto";

/**
 * Which database a scan was of, as a one-way fingerprint: host, port, database name, and on a shared pooler the
 * project the username points at (Supabase's pooler serves many projects on one host). Never the password, and
 * the connection string can't be recovered from it. Used only to match a re-run with the earlier report.
 */
export function fingerprint(connectionString: string): string {
  const u = new URL(connectionString);
  const host = u.hostname.toLowerCase(), user = decodeURIComponent(u.username);
  const tenant = /pooler\./.test(host) && user.includes(".") ? user.slice(user.indexOf(".") + 1) : "";
  const db = decodeURIComponent(u.pathname.slice(1)) || user;
  return createHash("sha256").update(`pgc-target|${host}|${u.port || "5432"}|${db}|${tenant}`).digest("hex").slice(0, 24);
}
