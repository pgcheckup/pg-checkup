import { openReadOnlySession, TAG } from './collect.js';
import { profileFor, providerIdFromUrl, type ProviderId } from './provider.js';
import { roleSql, roleInfo, requireMonitoringRole } from './role.js';
import { fingerprint } from './fingerprint.js';

export const WINDOW_FORMAT = 'pg-checkup-window';
export interface Counter { key: string; family: string; calls: number; ms: number; rows: number; since?: string | null }
export interface Sample { at: string; reset: string; restart: string; dealloc: number; counters: Counter[] }
export interface WorkloadWindow {
  format: typeof WINDOW_FORMAT; version: 1; target: string; provider: ProviderId; major: number;
  label?: string; representative: boolean; start: Sample; end: Sample;
}
export interface QueryChange { family: string; beforeMs: number; afterMs: number; changePct: number; beforeCalls: number; afterCalls: number; status: 'slower' | 'faster' | 'similar' }
export interface WorkloadComparison { comparable: boolean; reasons: string[]; queries: QueryChange[]; notes: string[] }

// queryid is not stable across a logical migration (catalog OIDs change). Match exact representative SQL hashes
// across hosts, but use queryid/userid/toplevel to subtract counters within one host. No SQL text leaves Postgres.
export const WORKLOAD_SQL = `select s.userid::text || ':' || s.queryid::text || ':' || s.toplevel::text as key,
  md5(s.query) as family, s.calls::text as calls, s.total_exec_time as ms, s.rows::text as rows, to_jsonb(s)->>'stats_since' as since
  from pg_stat_statements s where s.dbid = (select oid from pg_database where datname = current_database())
  and s.queryid is not null and s.query is not null and s.query not like '%/* pg-checkup */%'
  order by s.userid, s.queryid, s.toplevel limit 10001`;
export const WINDOW_META_SQL = `select clock_timestamp() as at, stats_reset as reset, dealloc,
  pg_postmaster_start_time() as restart from pg_stat_statements_info`;

export async function observe(connection: string, opts: { seconds?: number; label?: string; representative?: boolean; provider?: ProviderId; allowPrivilegedRole?: boolean; progress?: (remaining: number) => void; signal?: AbortSignal } = {}): Promise<WorkloadWindow> {
  const seconds = opts.seconds ?? 300;
  if (!Number.isInteger(seconds) || seconds < 10 || seconds > 3600) throw new Error('Observation must last 10–3600 seconds.');
  const { db } = await openReadOnlySession(connection);
  try {
    const provider = opts.provider ?? providerIdFromUrl(connection);
    const q = async (sql: string) => (await db.query(`${TAG} ${sql}`)).rows;
    requireMonitoringRole(roleInfo((await q(roleSql(profileFor(provider))))[0]), opts.allowPrivilegedRole);
    const [{ version }] = await q("select current_setting('server_version_num')::int as version");
    if (version < 140000) throw new Error('Observation needs PostgreSQL 14+ and pg_stat_statements 1.9+ with reset tracking.');
    const sample = async (): Promise<Sample> => {
      const [meta] = await q(WINDOW_META_SQL);
      const counters = (await q(WORKLOAD_SQL)).map((r) => ({ key: String(r.key), family: String(r.family), calls: Number(r.calls), ms: Number(r.ms), rows: Number(r.rows), since: r.since ?? null }));
      const [after] = await q(WINDOW_META_SQL);
      if (new Date(meta.reset).getTime() !== new Date(after.reset).getTime() || Number(meta.dealloc) !== Number(after.dealloc)) throw new Error('Statistics changed while reading counters. Repeat the observation.');
      if (counters.length > 10000) throw new Error('More than 10,000 query entries: observation would be incomplete. Narrow the workload before comparing.');
      if (counters.some((r) => !Number.isSafeInteger(r.calls) || !Number.isSafeInteger(r.rows))) throw new Error('Query counters exceed safe numeric precision; cannot compare this window reliably.');
      return { at: new Date(meta.at).toISOString(), reset: new Date(meta.reset).toISOString(), restart: new Date(meta.restart).toISOString(), dealloc: Number(meta.dealloc), counters };
    };
    const start = await sample();
    const deadline = Date.now() + seconds * 1000;
    while (Date.now() < deadline) {
      if (opts.signal?.aborted) throw new Error('Observation cancelled; no result was written.');
      opts.progress?.(Math.ceil((deadline - Date.now()) / 1000));
      await new Promise((resolve) => setTimeout(resolve, Math.min(1000, deadline - Date.now())));
    }
    return { format: WINDOW_FORMAT, version: 1, target: fingerprint(connection), provider, major: Math.floor(version / 10000), representative: Boolean(opts.representative), ...(opts.label ? { label: opts.label.slice(0, 120) } : {}), start, end: await sample() };
  } catch (e: any) {
    if (e.code === '42P01' || e.code === '42703') throw new Error('Observation needs pg_stat_statements with reset tracking. Ask your database administrator to enable/update it, then retry.');
    throw e;
  } finally { await db.end(); }
}

export function parseWindow(value: unknown): WorkloadWindow {
  const w = value as WorkloadWindow;
  if (!w || w.format !== WINDOW_FORMAT || w.version !== 1 || !Number.isInteger(w.major) || typeof w.representative !== 'boolean' || !['generic', 'supabase', 'neon'].includes(w.provider) || !/^[a-f0-9]{24}$/.test(w.target)) throw new Error('Not a supported pg-checkup observation file.');
  for (const s of [w.start, w.end]) {
    if (!s || ![s.at, s.reset, s.restart].every((v) => typeof v === 'string' && Number.isFinite(Date.parse(v))) || !Number.isSafeInteger(s.dealloc) || s.dealloc < 0 || !Array.isArray(s.counters) || s.counters.length > 10000) throw new Error('Invalid observation sample.');
    const keys = new Set<string>();
    for (const r of s.counters) {
      if (!r || typeof r.key !== 'string' || keys.has(r.key) || !/^[a-f0-9]{32}$/.test(r.family) || !Number.isSafeInteger(r.calls) || !Number.isSafeInteger(r.rows) || !Number.isFinite(r.ms) || Math.min(r.calls, r.rows, r.ms) < 0) throw new Error('Invalid or duplicate query counter.');
      keys.add(r.key);
    }
  }
  if (w.label !== undefined && (typeof w.label !== 'string' || w.label.length > 120)) throw new Error('Invalid observation label.');
  if (Date.parse(w.end.at) <= Date.parse(w.start.at)) throw new Error('Observation end must follow its start.');
  return w;
}

function deltas(w: WorkloadWindow) {
  const reasons: string[] = [];
  if (w.start.reset !== w.end.reset || w.start.restart !== w.end.restart) reasons.push('Statistics reset or the server restarted during the observation.');
  if (w.start.dealloc !== w.end.dealloc) reasons.push('Query entries were evicted during the observation.');
  const before = new Map(w.start.counters.map((r) => [r.key, r]));
  const after = new Set(w.end.counters.map((r) => r.key));
  if (w.start.counters.some((r) => !after.has(r.key))) reasons.push('Query counters disappeared during the observation.');
  const families = new Map<string, { calls: number; ms: number; rows: number }>();
  for (const end of w.end.counters) {
    const start = before.get(end.key);
    const calls = end.calls - (start?.calls ?? 0), ms = end.ms - (start?.ms ?? 0), rows = end.rows - (start?.rows ?? 0);
    if (calls < 0 || ms < 0 || rows < 0 || (start && (start.family !== end.family || start.since !== end.since))) { reasons.push('A query counter reset or its representative text changed.'); continue; }
    if (!calls) continue;
    const old = families.get(end.family) ?? { calls: 0, ms: 0, rows: 0 };
    families.set(end.family, { calls: old.calls + calls, ms: old.ms + ms, rows: old.rows + rows });
  }
  return { families, reasons };
}

export function compareWorkloads(a: WorkloadWindow, b: WorkloadWindow): WorkloadComparison {
  parseWindow(a); parseWindow(b);
  const x = deltas(a), y = deltas(b);
  const reasons = [...x.reasons.map((s) => `Before: ${s}`), ...y.reasons.map((s) => `After: ${s}`)];
  const duration = (w: WorkloadWindow) => (Date.parse(w.end.at) - Date.parse(w.start.at)) / 1000;
  const da = duration(a), db = duration(b);
  const count = (m: typeof x.families) => [...m.values()].reduce((s, r) => s + r.calls, 0);
  const ca = count(x.families), cb = count(y.families);
  if (!a.representative || !b.representative) reasons.push('Both windows must be marked representative: normal traffic, after warm-up, without a restore or bulk import.');
  if (Math.min(da, db) < 60) reasons.push('Each observation needs at least 60 seconds.');
  if (Math.max(da, db) / Math.min(da, db) > 1.2) reasons.push('Observation durations differ by more than 20%.');
  if (a.major !== b.major) reasons.push('PostgreSQL major versions differ; query matching and planner behavior may differ.');
  if (Math.min(ca, cb) < 100) reasons.push('Each window needs at least 100 query calls.');
  if (Math.min(ca, cb) > 0 && Math.max(ca / da, cb / db) / Math.min(ca / da, cb / db) > 1.25) reasons.push('Traffic rates differ by more than 25%.');
  // Total variation distance: low-volume unmatched statements do not veto a useful comparison.
  const families = new Set([...x.families.keys(), ...y.families.keys()]);
  const variation = [...families].reduce((s, f) => s + Math.abs((x.families.get(f)?.calls ?? 0) / (ca || 1) - (y.families.get(f)?.calls ?? 0) / (cb || 1)), 0) / 2;
  if (variation > 0.15) reasons.push('The query mix changed by more than 15%; compare equivalent traffic.');
  const queries: QueryChange[] = [];
  for (const [family, before] of x.families) {
    const after = y.families.get(family);
    if (!after || Math.min(before.calls, after.calls) < 20 || before.ms <= 0) continue;
    if (Math.max(before.rows / before.calls, after.rows / after.calls) > 1.25 * Math.max(1, Math.min(before.rows / before.calls, after.rows / after.calls))) { reasons.push(`Query ${family.slice(0, 8)} processes a different number of rows per call.`); continue; }
    const beforeMs = before.ms / before.calls, afterMs = after.ms / after.calls, changePct = (afterMs / beforeMs - 1) * 100;
    queries.push({ family, beforeMs, afterMs, changePct, beforeCalls: before.calls, afterCalls: after.calls, status: changePct >= 20 && afterMs - beforeMs >= 1 ? 'slower' : changePct <= -20 && beforeMs - afterMs >= 1 ? 'faster' : 'similar' });
  }
  if (!queries.length) reasons.push('No matching query family has at least 20 calls in both windows.');
  return { comparable: !reasons.length, reasons: [...new Set(reasons)], queries: reasons.length ? [] : queries.sort((a, b) => b.changePct - a.changePct), notes: [
    'Compares mean database execution time, not API, network or pooler latency. This is evidence of a timing change, not proof of its cause.',
    'Targeted counter resets on older PostgreSQL versions may be undetectable if counters regrow during the window. Avoid resetting statistics while observing.',
    'Query families match exact representative SQL hashes; changed formatting or SQL may remain unmatched. No SQL text is saved.',
    ...(a.provider !== b.provider ? ['The hosting provider changed. Check compute size, pooler behavior and provider metrics before attributing a timing change to the migration.'] : []),
  ] };
}

export function workloadText(c: WorkloadComparison): string {
  if (!c.comparable) return ['COMPARISON INCONCLUSIVE', ...c.reasons.map((r) => `  • ${r}`), '', 'Next: observe the same workload for the same duration after traffic and caches settle.'].join('\n');
  return ['WORKLOAD COMPARISON', ...c.queries.map((q) => `  ${q.status.toUpperCase().padEnd(8)} ${q.family.slice(0, 12)}  ${q.beforeMs.toFixed(2)} → ${q.afterMs.toFixed(2)} ms/call (${q.changePct >= 0 ? '+' : ''}${q.changePct.toFixed(1)}%)  ${q.beforeCalls}/${q.afterCalls} calls`), '', ...c.notes].join('\n');
}
