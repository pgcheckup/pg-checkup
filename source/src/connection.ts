// Resolves a connection the way psql does, so nobody has to hand-build and percent-encode a URL. A password
// containing @ : / # ? % or spaces silently breaks a hand-written URL.
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ConnArgs { url?: string; host?: string; port?: string; user?: string; database?: string; password?: string; sslmode?: string; service?: string }
export interface Resolved {
  url: string;
  /** true when built from parts (so we may need to ask for a password) */
  structured: boolean;
  needsPassword: boolean;
  database: string;
  /** Where the parts came from, for a one-line "Connecting to" message. */
  parts?: { host: string; port: string; user: string; database: string };
  /** Where the password came from, when it was found without asking. */
  passwordSource?: "url" | "flag" | "PGPASSWORD" | "service" | "pgpass";
}

const enc = encodeURIComponent;

/** One [section] of a libpq service file (PGSERVICEFILE or ~/.pg_service.conf). Returns null when absent. */
export function readService(name: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> | null {
  const file = env.PGSERVICEFILE ?? join(homedir(), ".pg_service.conf");
  let text: string;
  try { text = readFileSync(file, "utf8"); } catch { return null; }
  let current = ""; const out: Record<string, string> = {}; let found = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const sec = /^\[(.+)\]$/.exec(line);
    if (sec) { if (found) break; current = sec[1].trim(); found = current === name; continue; }
    if (!found) continue;
    const eq = line.indexOf("=");
    if (eq > 0) out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return found ? out : null;
}

/**
 * Looks a password up in PGPASSFILE or ~/.pgpass, as libpq does: host:port:database:user:password, `*` matches
 * anything, `\` escapes `:` and `\`, first match wins. On Unix the file is ignored unless its mode is 0600 or stricter.
 */
export function readPgpass(p: { host: string; port: string; database: string; user: string }, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const file = env.PGPASSFILE ?? join(homedir(), ".pgpass");
  let text: string;
  try {
    if (process.platform !== "win32" && (statSync(file).mode & 0o077) !== 0) return undefined;
    text = readFileSync(file, "utf8");
  } catch { return undefined; }
  const wanted = [p.host, p.port, p.database, p.user];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const fields: string[] = []; let cur = "";
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === "\\" && i + 1 < line.length) { cur += line[++i]; continue; }
      if (ch === ":" && fields.length < 4) { fields.push(cur); cur = ""; continue; }
      cur += ch;
    }
    fields.push(cur);
    if (fields.length < 5) continue;
    if (fields.slice(0, 4).every((f, i) => f === "*" || f === wanted[i])) return fields[4];
  }
  return undefined;
}

/** Keys that hold a Postgres URL in the .env files of Prisma, Drizzle, Rails, Django, Supabase and Vercel projects. */
export const ENV_URL_KEYS = ["DATABASE_URL", "POSTGRES_URL", "POSTGRES_PRISMA_URL", "DIRECT_URL", "PG_URL", "PGURL"];
const ENV_FILES = [".env.local", ".env"];

/**
 * A postgres:// URL from a .env file in the current directory, the way Prisma and Drizzle find theirs. Reads only the
 * listed keys, never prints the value, and reports which file and key it came from. Returns null when there is none.
 */
export function readEnvFileUrl(cwd = process.cwd()): { url: string; file: string; key: string } | null {
  for (const file of ENV_FILES) {
    let text: string;
    try { text = readFileSync(join(cwd, file), "utf8"); } catch { continue; }
    const vars = new Map<string, string>();
    for (const raw of text.split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(raw);
      if (!m) continue;
      const raw2 = m[2];
      const q = /^(["'])(.*?)\1(?:\s+#.*)?$/.exec(raw2); // quoted, with an optional trailing comment
      vars.set(m[1], q ? q[2] : raw2.replace(/\s+#.*$/, ""));
    }
    for (const key of ENV_URL_KEYS) {
      const v = vars.get(key);
      if (v && /^postgres(ql)?:\/\//.test(v)) return { url: v, file, key };
    }
  }
  return null;
}

/** True when the environment names a database at all (so running with no arguments has something to connect to). */
export const envHasConnection = (env: NodeJS.ProcessEnv = process.env) => Boolean(env.DATABASE_URL || env.PGHOST || env.PGDATABASE || env.PGSERVICE || env.PGUSER);
/** PGSERVICEFILE / PGPASSFILE lookups go through the same rule. */

/**
 * Precedence, as in libpq: a URL, then -h/-p/-U/-d flags, then the service file named by --service or PGSERVICE,
 * then the PG* environment variables, then defaults (localhost, 5432, the OS user). Returns null if nothing was given.
 */
export function resolveConnection(a: ConnArgs, rawEnv: NodeJS.ProcessEnv = process.env): Resolved | null {
  // An empty variable (PGHOST="" in CI, say) means unset, as libpq treats it.
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(rawEnv).filter(([, v]) => v !== undefined && v !== ""));
  if (a.url) {
    let database = "";
    try { database = decodeURIComponent(new URL(a.url).pathname.slice(1)); } catch { /* validated later */ }
    return { url: a.url, structured: false, needsPassword: false, database, passwordSource: /^postgres(ql)?:\/\/[^:@/]*:[^@]*@/.test(a.url) ? "url" : undefined };
  }
  const svcName = a.service ?? env.PGSERVICE;
  const svc = svcName ? readService(svcName, env) ?? {} : {};
  if (svcName && !Object.keys(svc).length) throw new Error(`Service "${svcName}" was not found in ${env.PGSERVICEFILE ?? "~/.pg_service.conf"}.`);
  const given = a.host ?? a.user ?? a.database ?? a.port ?? svcName ?? (envHasConnection(env) ? "env" : undefined);
  if (given === undefined) return null;
  const host = a.host ?? svc.host ?? env.PGHOST ?? "localhost";
  const user = a.user ?? svc.user ?? env.PGUSER ?? env.USER ?? env.USERNAME ?? "postgres";
  const database = a.database ?? svc.dbname ?? env.PGDATABASE ?? user;
  const port = a.port ?? svc.port ?? env.PGPORT ?? "5432";
  const ssl = a.sslmode ?? svc.sslmode ?? env.PGSSLMODE;
  let password = a.password; let passwordSource: Resolved["passwordSource"] = a.password ? "flag" : undefined;
  if (!password && env.PGPASSWORD) { password = env.PGPASSWORD; passwordSource = "PGPASSWORD"; }
  if (!password && svc.password) { password = svc.password; passwordSource = "service"; }
  if (!password) { password = readPgpass({ host, port, database, user }, env); if (password) passwordSource = "pgpass"; }
  const hostPart = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host; // IPv6
  const url = `postgres://${enc(user)}${password ? `:${enc(password)}` : ""}@${hostPart}:${port}/${enc(database)}${ssl ? `?sslmode=${enc(ssl)}` : ""}`;
  return { url, structured: true, needsPassword: !password, database, parts: { host, port, user, database }, passwordSource };
}

/** A folder-safe label: lowercase letters, digits, dot, dash, underscore. */
export function safeName(s: string, fallback = "backup"): string {
  const n = s.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 60);
  return n || fallback;
}

/**
 * Puts a password into a URL that has none (used after a hidden prompt). Encodes it ourselves: the URL object's
 * `password` setter leaves `%` untouched, which corrupts passwords like "100%" or "a%20b".
 */
export function withPassword(url: string, password: string): string {
  const m = /^(postgres(?:ql)?:\/\/)([^:@/]*)(?::[^@]*)?@([\s\S]*)$/.exec(url);
  return m ? `${m[1]}${m[2]}:${encodeURIComponent(password)}@${m[3]}` : url;
}

/** The URL with its password replaced, for messages. */
export function redactUrl(url: string): string {
  return url.replace(/^(postgres(?:ql)?:\/\/[^:@/]*):[^@]*@/, "$1:***@");
}
