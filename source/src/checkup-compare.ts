// Pure module: two checkup files side by side. What was fixed, what is new, what is still open, and the numbers that
// changed. Honest about what a pair of snapshots can and cannot show.
import type { Bundle } from "./bundle.js";
import type { Finding, Severity } from "./types.js";
import type { CheckResult, Vital } from "./sections.js";

export const COMPARISON_FORMAT = "pg-checkup-comparison";
export interface Slim { id: string; title: string; severity: Severity }
export interface NumberRow { label: string; before: number | null; after: number | null; kind: Vital["kind"]; /** Which direction is an improvement, when that is clear. */ better: "lower" | "higher" | null }
export interface TableRow { table: string; deadBefore: number | null; deadAfter: number | null; pctBefore: number | null; pctAfter: number | null }
export interface CheckupComparison {
  format: typeof COMPARISON_FORMAT; version: 1;
  /** Both files carry the same database fingerprint; null when either lacks one. */
  sameDatabase: boolean | null;
  before: { collectedAt: string; server: string }; after: { collectedAt: string; server: string };
  hoursBetween: number;
  /** Hours of statistics behind each checkup (since the stats reset, or the server start). */
  windowHours: { before: number | null; after: number | null };
  /** The statistics were reset between the two, so usage counters start over and are not comparable. */
  statsReset: boolean;
  fixed: Slim[]; new: Slim[]; open: Slim[];
  /** Gone from the findings, but the check did not pass either: it was skipped or did not run, so nothing is known. */
  unknown: Slim[];
  /** Open in both, now more severe. */
  worse: Slim[];
  numbers: NumberRow[];
  tables: TableRow[];
  /** A new or worsened warning or critical finding. */
  regression: boolean;
  limits: string[];
}
export interface Checkup { bundle: Bundle; findings: Finding[]; checks: CheckResult[]; vitals: Vital[] }

const SEV: Severity[] = ["critical", "warning", "info"];
const BETTER: Record<string, "lower" | "higher"> = { "Cache hit rate": "higher", Connections: "lower", Deadlocks: "lower" };
/** A change worth calling out: at least half a percent, so rounding noise doesn't become "worse". */
export const moved = (before: number | null, after: number | null) => before !== null && after !== null && after !== before && Math.abs(after - before) >= Math.max(0.005 * Math.abs(before), 1e-9);
const slim = (f: Finding): Slim => ({ id: f.id, title: f.title, severity: f.severity });
const num = (v: unknown): number | null => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const rows = (b: Bundle, id: string) => b.datasets.find((d) => d.id === id)?.rows ?? [];
const hours = (ms: number) => Math.round(ms / 36e4) / 10;

/** Hours of statistics behind a checkup: since the database's stats reset, or since the server started. */
function window(b: Bundle): number | null {
  const at = Date.parse(b.collectedAt);
  const reset = rows(b, "l_db")[0]?.stats_reset;
  if (reset && Date.parse(String(reset))) return hours(at - Date.parse(String(reset)));
  const up = num(b.vitals?.uptime_s);
  return up === null ? null : hours(up * 1000);
}

// Failed or skipped views cannot establish that an absent row has a zero count.
function unavailableOrCapped(b: Bundle): boolean {
  const d = b.datasets.find((d) => d.id === "v_dead");
  return !d || Boolean(d.error || d.note || d.capped);
}

export function compareCheckups(a: Checkup, b: Checkup): CheckupComparison {
  const was = new Map(a.findings.map((f) => [f.id, f])), now = new Map(b.findings.map((f) => [f.id, f]));
  const passed = new Set(b.checks.filter((c) => c.status === "passed").map((c) => c.id));
  const fixed = a.findings.filter((f) => !now.has(f.id) && passed.has(f.id)).map(slim);
  const unknown = a.findings.filter((f) => !now.has(f.id) && !passed.has(f.id)).map(slim);
  const added = b.findings.filter((f) => !was.has(f.id)).map(slim);
  const open = b.findings.filter((f) => was.has(f.id)).map(slim);
  const worse = b.findings.filter((f) => was.has(f.id) && SEV.indexOf(f.severity) < SEV.indexOf(was.get(f.id)!.severity)).map(slim);

  const vb = new Map(a.vitals.map((v) => [v.label, v])), va = new Map(b.vitals.map((v) => [v.label, v]));
  const numbers: NumberRow[] = [...new Set([...vb.keys(), ...va.keys()])].filter((l) => l !== "Uptime").map((label) => {
    const x = vb.get(label), y = va.get(label);
    return { label, before: num(x?.value), after: num(y?.value), kind: (y ?? x)?.kind, better: BETTER[label] ?? null };
  }).filter((n) => n.before !== null || n.after !== null);

  // Dead rows per table: every table a finding named in either checkup, plus the worst in the later one.
  const named = new Set<string>();
  for (const f of [...a.findings, ...b.findings]) for (const e of Array.isArray(f.evidence) ? f.evidence : f.evidence ? [f.evidence] : []) if (typeof e.table === "string") named.add(e.table);
  // The dead-row view lists tables with dead rows, most first, capped. A table missing from an uncapped list has none.
  const deadB = new Map(rows(a.bundle, "v_dead").map((r) => [String(r.table), r])), deadA = new Map(rows(b.bundle, "v_dead").map((r) => [String(r.table), r]));
  const cappedB = unavailableOrCapped(a.bundle), cappedA = unavailableOrCapped(b.bundle);
  const dead = (m: Map<string, Record<string, unknown>>, capped: boolean, t: string, key: string) => (m.has(t) ? num(m.get(t)![key]) : capped ? null : 0);
  const tables: TableRow[] = [...new Set([...named].filter((t) => deadB.has(t) || deadA.has(t)))].map((table) => ({
    table, deadBefore: dead(deadB, cappedB, table, "dead_rows"), deadAfter: dead(deadA, cappedA, table, "dead_rows"), pctBefore: dead(deadB, cappedB, table, "dead_pct"), pctAfter: dead(deadA, cappedA, table, "dead_pct"),
  })).sort((x, y) => (y.deadBefore ?? 0) - (x.deadBefore ?? 0)).slice(0, 10);

  const resetAt = rows(b.bundle, "l_db")[0]?.stats_reset;
  const statsReset = Boolean(resetAt && Date.parse(String(resetAt)) > Date.parse(a.bundle.collectedAt));
  const sameDatabase = a.bundle.target && b.bundle.target ? a.bundle.target === b.bundle.target : null;
  const wh = { before: window(a.bundle), after: window(b.bundle) };
  const limits: string[] = [];
  if (sameDatabase === false) limits.push("These are two different databases, so nothing below is a before-and-after.");
  if (statsReset) limits.push("The statistics were reset between the two checkups, so counters such as calls, scans and dead rows started over and are not comparable.");
  if (wh.after !== null && wh.after < 1) limits.push(`The later checkup has only ${Math.round(wh.after * 60)} minutes of statistics behind it; usage-based findings need real traffic first.`);
  limits.push("Two snapshots show what changed inside the database. They do not show that the application got faster: that needs query timings under comparable traffic, which pg-checkup observe measures on each side.");
  return {
    format: COMPARISON_FORMAT, version: 1, sameDatabase,
    before: { collectedAt: a.bundle.collectedAt, server: a.bundle.server.version.split(" on ")[0].split(",")[0] },
    after: { collectedAt: b.bundle.collectedAt, server: b.bundle.server.version.split(" on ")[0].split(",")[0] },
    hoursBetween: hours(Date.parse(b.bundle.collectedAt) - Date.parse(a.bundle.collectedAt)),
    windowHours: wh, statsReset, fixed, new: added, open, unknown, worse, numbers, tables,
    regression: [...added, ...worse].some((f) => f.severity !== "info"), limits,
  };
}

const fmtN = (n: number | null, kind?: Vital["kind"]): string => {
  if (n === null) return "–";
  if (kind === "bytes") { const u = ["B", "KB", "MB", "GB", "TB"]; let i = 0, v = n; while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; } return `${v < 10 && i ? v.toFixed(1) : Math.round(v)} ${u[i]}`; }
  if (kind === "pct") return `${Math.round(n * 10) / 10}%`;
  if (kind === "secs") return n < 7200 ? `${Math.round(n / 60)} min` : n < 172_800 ? `${Math.round(n / 3600)} h` : `${Math.round(n / 86_400)} d`;
  return Math.round(n).toLocaleString("en-US");
};
const when = (iso: string) => iso.replace("T", " ").slice(0, 16) + " UTC";
const span = (h: number) => (h < 1 ? `${Math.round(h * 60)} minutes` : h < 48 ? `${Math.round(h)} hours` : `${Math.round(h / 24)} days`);
const windowText = (h: number | null) => (h === null ? "unknown" : span(h));

/** Plain text for the terminal. Marks: ✓ fixed, ! new or worse, · still open, ? unknown. */
export function checkupComparisonText(c: CheckupComparison): string {
  const L: string[] = [];
  L.push(`Before: ${when(c.before.collectedAt)}, ${c.before.server}.  After: ${when(c.after.collectedAt)}, ${c.after.server}.  ${span(c.hoursBetween)} apart${c.sameDatabase === true ? ", same database" : c.sameDatabase === false ? ", DIFFERENT databases" : ""}.`);
  L.push(`Statistics behind each: ${windowText(c.windowHours.before)} before, ${windowText(c.windowHours.after)} after${c.statsReset ? " (reset in between)" : ""}.`);
  const group = (title: string, mark: string, items: Slim[]) => { if (!items.length) return; L.push("", `${title}  ${items.length}`); for (const f of items) L.push(`${mark} ${f.title}  (${f.severity})`); };
  group("FIXED", "✓", c.fixed);
  group("NEW", "!", c.new);
  group("WORSE", "!", c.worse);
  group("STILL OPEN", "·", c.open.filter((f) => !c.worse.some((w) => w.id === f.id)));
  group("UNKNOWN (the check did not run the second time)", "?", c.unknown);
  if (!c.fixed.length && !c.new.length && !c.worse.length && !c.open.length) L.push("", "No findings in either checkup.");
  const w = 28;
  const line = (label: string, before: string, after: string, tail = "") => L.push(`${label.padEnd(w)}${before.padStart(12)}${after.padStart(12)}${tail ? "  " + tail : ""}`);
  if (c.tables.length || c.numbers.length) { L.push("", `${"NUMBERS".padEnd(w)}${"before".padStart(12)}${"after".padStart(12)}`); }
  for (const t of c.tables) {
    const dir = moved(t.deadBefore, t.deadAfter) ? (t.deadAfter! < t.deadBefore! ? "lower" : "higher") : "";
    line(`Dead rows, ${t.table}`.slice(0, w - 1), fmtN(t.deadBefore), fmtN(t.deadAfter), dir);
  }
  for (const n of c.numbers) {
    const changed = moved(n.before, n.after) && fmtN(n.before, n.kind) !== fmtN(n.after, n.kind);
    const dir = changed ? (n.after! < n.before! ? "lower" : "higher") : "";
    const verdict = changed && n.better ? (dir === n.better ? "better" : "worse") : dir;
    line(n.label.slice(0, w - 1), fmtN(n.before, n.kind), fmtN(n.after, n.kind), verdict);
  }
  L.push("");
  for (const l of c.limits) L.push(l);
  return L.join("\n");
}
