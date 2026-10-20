#!/usr/bin/env node
import { readFileSync, writeFileSync, statSync, mkdirSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import net from 'node:net';
import { askHidden } from './prompt.js';
import { resolveConnection, withPassword, safeName, readEnvFileUrl, redactUrl } from './connection.js';
import { collect, statements, isLocalHost, openReadOnlySession, COLLECTOR_VERSION } from './collect.js';
import { analyze, CHECKS, type RunResult } from './analyze.js';
import { PRIORITIES, PRIORITY_LABEL } from './triage.js';
import { toMarkdown } from './report.js';
import type { Finding, Severity } from './types.js';
import { requireMonitoringRole, roleProblems, roleSql, roleInfo, RoleRefused, MONITOR_ROLE_SQL } from './role.js';
import { profileFor, providerIdFromUrl } from './provider.js';
import { takeSnapshot, diffSnapshots, diffText, SNAPSHOT_FORMAT, type Snapshot } from './snapshot.js';
import { parseBundle, MAX_BUNDLE_BYTES, BUNDLE_FORMAT, type Bundle } from './bundle.js';
import { compareCheckups, checkupComparisonText } from './checkup-compare.js';
import { buildProgram, normalizeArgv, terminalText, UsageError as OptionError, type Parsed } from './cli-options.js';
import { CommanderError } from 'commander';
import { observe, parseWindow, compareWorkloads, workloadText, WINDOW_FORMAT, WORKLOAD_SQL, WINDOW_META_SQL } from './workload.js';
import type { ProviderId } from './provider.js';
import { githubWorkflow, githubSummaryWorkflow, crontabLine, SCHEDULE_NOTES, type Every } from './schedule.js';

// Commander prints help and usage errors itself; a usage error exits 2, help and --version exit 0.
const parsed: Parsed = (() => {
  let p: Parsed | undefined;
  const program = buildProgram(COLLECTOR_VERSION, (x) => { p = x; });
  try { program.parse(normalizeArgv(process.argv.slice(2)), { from: 'user' }); }
  catch (e) {
    if (e instanceof CommanderError) process.exit(e.code === 'commander.helpDisplayed' || e.code === 'commander.help' || e.code === 'commander.version' ? 0 : 2);
    if (e instanceof OptionError) { process.stderr.write(`pg-checkup: ${e.message}\n`); process.exit(2); }
    throw e;
  }
  if (!p) process.exit(0);
  return p;
})();
const cmd = parsed.command;
const { options, positionals } = parsed;
const flag = (n: string) => options[n] === true;
const opt = (n: string) => typeof options[n] === 'string' ? options[n] as string : undefined;
const tty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
const canPrompt = Boolean(process.stdin.isTTY && process.stderr.isTTY) && !flag('no-input') && !flag('no-password');
const color = Boolean(process.stdout.isTTY) && !flag('no-color') && !process.env.NO_COLOR && process.env.TERM !== 'dumb';
const ink = (n: number, s: string) => color ? `\x1b[${n}m${s}\x1b[0m` : s;
const bold = (s: string) => ink(1, s);
// Result on stdout, everything else on stderr, so `pg-checkup > out.txt` and `--json` keep only the result.
const say = (s = '') => process.stderr.write(terminalText(s) + '\n');
const out = (s = '') => process.stdout.write(terminalText(s) + '\n');
const SITE = (process.env.PGCHECKUP_URL ?? 'https://pgcheckup.com').replace(/\/+$/, '');
const HOST = new URL(SITE).host;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const json = (v: unknown) => JSON.stringify(v, null, 2) + '\n';


const USAGE = `Usage: pg-checkup [postgres://URL | -h HOST -p PORT -U USER -d DBNAME] [options]
       pg-checkup show FILE | role | sql | --help

Examples:
  pg-checkup postgres://checkup_reader@db.example.com/app
  pg-checkup -h db.example.com -U checkup_reader -d app
  PGSERVICE=prod pg-checkup`;



class UsageError extends Error {}
/** Whether something is listening on a local port, in at most 200 ms. Only a TCP connect, no login attempt. */
const listening = (port: number) => new Promise<boolean>((done) => { const s = net.connect({ host: '127.0.0.1', port }); const end = (v: boolean) => { s.destroy(); done(v); }; s.setTimeout(200, () => end(false)); s.once('connect', () => end(true)); s.once('error', () => end(false)); });
/** Suggests the exact command for a Postgres found running on this machine. */
async function localHints(): Promise<string> {
  const [pg, supabase] = await Promise.all([listening(5432), listening(54322)]);
  const hints = [pg ? '\nA Postgres is listening on localhost:5432:  pg-checkup -h localhost' : '', supabase ? '\nSupabase local is listening on 54322:         pg-checkup postgres://postgres:postgres@127.0.0.1:54322/postgres' : ''].filter(Boolean);
  return hints.length ? '\n' + hints.join('') + '\n' : '';
}
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '-' + randomBytes(2).toString('hex');
function save(value: unknown, prefix: string, password = '') {
  const file = opt('out') ?? `${prefix}-${stamp()}.json`;
  const text = json(value);
  // Refuse to write a file that carries the credential: the password next to a user name in a URL, raw or encoded.
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (password && new RegExp(`postgres(?:ql)?://[^\\s"'@/]*:(?:${esc(password)}|${esc(encodeURIComponent(password))})@`).test(text)) throw new Error('The result contains the connection password. Nothing was saved.');
  writeFileSync(file, text, { mode: 0o600, flag: 'wx' });
  return { file, text };
}
function load(file: string | undefined): { text: string; value: any } {
  if (!file) throw new Error(`Missing file. Run pg-checkup --help.`);
  let size: number;
  try { size = statSync(file).size; } catch (e: any) { if (e.code === 'ENOENT') throw new Error(`File not found: ${file}`); throw e; }
  if (size > MAX_BUNDLE_BYTES) throw new Error('File exceeds the 3 MB inspection limit.');
  const text = readFileSync(file, 'utf8');
  try { return { text, value: JSON.parse(text) }; } catch { throw new Error(`${file} is not valid JSON.`); }
}
function parseSnapshot(value: unknown): Snapshot {
  const s = value as Snapshot;
  if (!s || s.format !== SNAPSHOT_FORMAT || s.version !== 1 || !s.server || !s.database || !s.objects || !s.tables || !s.settings || !s.sequenceValues || !['generic', 'supabase', 'neon'].includes(s.provider)) throw new Error('Not a supported migration baseline.');
  for (const o of Object.values(s.objects)) if (!o || typeof o !== 'object' || Object.values(o).some((v) => typeof v !== 'string')) throw new Error('Invalid baseline objects.');
  return s;
}

async function connection() {
  const given = positionals.find((a) => /^postgres(ql)?:\/\//.test(a));
  const url = given ?? (process.env.DATABASE_URL || undefined);
  let r = resolveConnection({ url, host: opt('host'), port: opt('port'), user: opt('user'), database: opt('database'), sslmode: opt('sslmode'), service: opt('service') });
  let source = given ? 'the URL given' : url ? 'DATABASE_URL' : r?.parts ? (opt('host') || opt('user') || opt('database') ? 'the -h/-U/-d flags' : opt('service') || process.env.PGSERVICE ? `service "${opt('service') ?? process.env.PGSERVICE}"` : 'the PG* environment') : '';
  if (!r) {
    // Nothing on the command line or in the environment: the project's own .env file is the next place a developer
    // would look, and it stays on this machine like everything else.
    const env = readEnvFileUrl();
    if (env) { source = `${env.key} in ./${env.file}`; r = resolveConnection({ url: env.url }); }
  }
  if (!r) throw new UsageError(`no database given.\n\n${USAGE}\n\nAlso read: DATABASE_URL in ./.env or ./.env.local.${await localHints()}\nRun pg-checkup --help for everything else.`);
  say(`Read-only: runs SELECTs on pg_catalog and pg_stat views only; never writes, reads no table rows, sends nothing anywhere.`);
  say(`Connecting with ${source}: ${redactUrl(r.url)}`);
  let full = r.url;
  if (r.structured && r.parts) {
    const wantPrompt = flag('password') || (r.needsPassword && canPrompt);
    if (wantPrompt) full = withPassword(full, await askHidden(`Password for ${r.parts.user}@${r.parts.host} (hidden): `, process.stdin, process.stderr));
  }
  return { url: full, database: r.database, password: decodeURIComponent(new URL(full).password) };
}
const provider = opt('provider') as ProviderId | undefined;
const allowPrivilegedRole = flag('allow-privileged-role');
const snapshotOptionsFor = (url: string) => ({ provider, allowPrivilegedRole: allowPrivilegedRole || isLocalHost(url) });

// On a terminal: a dot in the severity's colour, the same marks as the web report. Piped: plain glyphs.
const SEV_MARK: Record<Severity, string> = color ? { critical: ink(31, '●'), warning: ink(33, '●'), info: ink(34, '●') } : { critical: '✗', warning: '!', info: '·' };
const SEV_INK: Record<Severity, number> = { critical: 31, warning: 33, info: 34 };
const GROUP_INK: Record<string, number> = { now: 31, next: 33, watch: 34, ignore: 2 };
// Findings are revealed one at a time, at reading pace, on a terminal. Piped output, --json, --md and --no-pace print at once.
const paced = Boolean(process.stdout.isTTY) && !flag('no-pace');
const pause = (ms: number) => (paced ? new Promise<void>((r) => setTimeout(r, ms)) : Promise.resolve());
const rule = () => dim('─'.repeat(Math.min(WIDTH, 72)));
const dim = (s: string) => ink(2, s);
const WIDTH = Math.min(Math.max(process.stdout.columns ?? 100, 60), 120);
/** Word-wraps `text` to the terminal, every line indented by `pad` spaces. */
function wrap(text: string, pad = 4, first = pad): string[] {
  const words = text.split(/\s+/).filter(Boolean); const lines: string[] = []; let line = ' '.repeat(first); let lead = first;
  for (const w of words) {
    if (line.length > lead && line.length + 1 + w.length > WIDTH) { lines.push(line); line = ' '.repeat(pad); lead = pad; }
    line += (line.length > lead ? ' ' : '') + w;
  }
  if (line.length > lead) lines.push(line);
  return lines;
}
const para = (text: string, pad = 4, first = pad) => wrap(text, pad, first).forEach((l) => out(l));
const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const SEV_RANK: Severity[] = ['critical', 'warning', 'info'];

/** The checkup: findings in the order to fix them, then what passed, then where the file is and what to do with it. */
async function printReport(r: RunResult, b: Bundle, file?: string) {
  const findings = r.findings;
  const count = (s: Severity) => findings.filter((f) => f.severity === s).length;
  const active = r.checks.filter((c) => c.status !== 'na');
  const passed = active.filter((c) => c.status === 'passed');
  const skipped = active.filter((c) => c.status === 'skipped');
  const na = r.checks.length - active.length;
  const version = b.server.version.split(' on ')[0].split(',')[0];
  const sev = SEV_RANK.map((x) => count(x)).some(Boolean) ? SEV_RANK.filter((x) => count(x)).map((x) => ink(SEV_INK[x], `${count(x)} ${x}`)).join(dim(' · ')) : ink(32, 'nothing flagged');
  out(`${bold(version)}${b.hosting ? dim(`  ${b.hosting}`) : ''}  ${sev}`);
  // Enough time to read each finding, but never more than about five seconds in total.
  const step = Math.min(450, Math.round(5000 / Math.max(findings.length, 1)));
  if (findings.length > 1) out(`${dim('Start here:')} ${findings[0].title}`);
  const limited = evidenceWindowHours(b);
  if (limited !== null && limited < 1) out(ink(33, `Statistics cover only ${plural(Math.max(1, Math.round(limited * 60)), 'minute')}. Findings about queries, scans and unused indexes need real traffic; run again after the database has been busy.`));
  await pause(step);
  for (const p of PRIORITIES) {
    const group = findings.filter((f) => (f.priority ?? 'watch') === p);
    if (!group.length) continue;
    out(); out(`${ink(GROUP_INK[p], bold(PRIORITY_LABEL[p].toUpperCase()))}  ${dim(`${group.length}`)}`); out(rule());
    for (const f of group) {
      out(`${SEV_MARK[f.severity]} ${bold(f.title)}  ${dim(f.category)}`);
      if (f.note) para(f.cause ? `${f.confidence === 'likely' ? 'Likely, from the findings together: ' : 'Shown by the statistics: '}${f.note}` : f.note);
      para(`${dim('Why:')} ${f.why}`);
      para(`${dim('Fix:')} ${f.fix}`);
      await pause(step);
    }
  }
  out();
  const tail = [plural(passed.length, 'check') + ' passed', skipped.length ? `${skipped.length} skipped` : '', na ? `${na} not applicable here` : ''].filter(Boolean).join(', ');
  out(`${tail}.${flag('verbose') ? '' : ' -v lists them.'}`);
  if (flag('verbose')) {
    for (const c of passed) out(dim(`${ink(32, '✓')} ${c.title}${c.reason ? ': ' + c.reason : ''}`));
    for (const c of skipped) out(dim(`- ${c.title}: ${firstSentence(c.reason ?? '')}`));
    for (const c of r.checks.filter((x) => x.status === 'na')) out(dim(`  ${c.title}: ${firstSentence(c.reason ?? '')}`));
  } else {
    for (const c of skipped) out(dim(`- ${c.title}: ${firstSentence(c.reason ?? '')}`));
  }
  if (!b.session.monitor) out(dim(`${b.session.role} is not in pg_monitor, so other sessions' activity may be missing.`));
  if (file) {
    const rows = b.datasets.reduce((n, d) => n + d.rows.length, 0);
    out();
    out(`Saved ${file}: ${rows} rows of statistics and catalog metadata, ${b.queryText === 'removed' ? 'no SQL text' : 'SQL text with literals masked'}, no table data. Object and role names are in it; read it before sharing.`);
    out(`  every row:                   pg-checkup show ${quote(file)} --all`);
    out(`  did a fix work:              pg-checkup compare EARLIER.json ${quote(file)}`);
    out(`  shareable report, fix SQL:   pg-checkup upload ${quote(file)}   (sends this file to ${HOST}, nothing else)`);
  }
}
/** Hours of statistics behind the checkup: since the stats reset, or since the server started. Null when unknown. */
function evidenceWindowHours(b: Bundle): number | null {
  const at = Date.parse(b.collectedAt);
  const reset = b.datasets.find((d) => d.id === 'l_db')?.rows[0]?.stats_reset;
  if (reset && Date.parse(String(reset))) return (at - Date.parse(String(reset))) / 36e5;
  const up = Number(b.vitals?.uptime_s);
  return Number.isFinite(up) && up > 0 ? up / 3600 : null;
}
/** Whether any finding is at or above the --fail-on severity. */
const fails = (findings: Finding[]) => { const at = opt('fail-on'); return at ? findings.some((f) => SEV_RANK.indexOf(f.severity) <= SEV_RANK.indexOf(at as Severity)) : false; };
/** --strict: a diagnostic view that could not be read (an error, not a missing extension) is a failure, not a skip. */
function strictFails(b: Bundle): boolean {
  if (!flag('strict')) return false;
  const broken = b.datasets.filter((d) => d.error);
  if (!broken.length) return false;
  say(`--strict: ${broken.length} diagnostic ${broken.length === 1 ? 'view' : 'views'} could not be read:`);
  for (const d of broken) say(`  - ${d.title ?? d.id}: ${firstSentence(d.error!)}`);
  return true;
}
const markdown = (r: RunResult, b: Bundle) => toMarkdown(r.findings, r.datasets, { version: r.serverVersion, provider: r.provider, scannedAt: b.collectedAt, checks: r.checks });
const withAnalysis = (b: Bundle, r: RunResult) => ({ ...b, findings: r.findings, checks: r.checks, skipped: r.skipped });
const firstSentence = (s: string) => (s.match(/^[^.:]*[.:]?/)?.[0] ?? s).replace(/[.:]$/, '').trim();
const quote = (f: string) => /[^\w./-]/.test(f) ? JSON.stringify(f) : f;
function allRows(b: Bundle) {
  const text = b.datasets.map((d) => `${d.id} — ${d.title ?? d.id}\n${d.note ?? d.error ?? ''}\n${json(d.rows)}`).join('\n');
  // A fixed pager avoids treating PAGER as a command; raw control sequences are never passed through.
  if (tty) {
    const result = spawnSync('less', ['-S'], { input: terminalText(text), stdio: ['pipe', 'inherit', 'inherit'] });
    if (!result.error && result.status === 0) return;
  }
  out(text);
}
function validateDestination(url: string) {
  const u = new URL(url);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))) throw new Error('Uploads require HTTPS (HTTP is allowed only on localhost).');
  if (u.username || u.password) throw new Error('Upload destinations cannot contain credentials.');
  return u;
}
async function confirm(q: string): Promise<boolean> {
  if (flag('yes')) return true;
  if (!canPrompt) throw new Error('upload needs confirmation. Add --yes to upload without a prompt.');
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try { return /^y(es)?$/i.test((await rl.question(q)).trim()); } finally { rl.close(); }
}
async function upload(text: string, file: string) {
  validateDestination(SITE);
  // PGCHECKUP_TOKEN (from Settings on the site) saves the report to that account; on the plan it is a full report.
  const token = process.env.PGCHECKUP_TOKEN?.trim();
  const b = parseBundle(JSON.parse(text));
  const rows = b.datasets.reduce((n, d) => n + d.rows.length, 0);
  say(`This sends ${file} (${(Buffer.byteLength(text) / 1024).toFixed(0)} KB: ${rows} rows of statistics, ${b.queryText === 'removed' ? 'no SQL text' : 'masked SQL text'}, no table data) to ${HOST}.`);
  const code = opt('send');
  if (code !== undefined && !/^[a-f0-9]{32}$/.test(code)) throw new Error('--send needs the code shown on pgcheckup.com/scan. Copy the whole command from the page.');
  say(token ? `Saved to your account (PGCHECKUP_TOKEN is set). With Workspace it is a full report: SQL to review, compared with your last checkup of this database, PDF and a share link.` : `You get the findings, why and fix as a web page that only you can open, kept 7 days. "pg-checkup delete" removes it. Workspace adds the SQL to review, comparison after a fix, PDF and a share link.`);
  if (code) say('Sending it because you passed --send; the page that showed the code opens the report.');
  else if (!await confirm('Upload? [y/N] ')) { say('Not uploaded.'); return; }
  say(`Uploading…`);
  const res = await fetch(`${SITE}/api/bundle`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(code ? { 'x-pgcheckup-handoff': code } : {}) }, body: text, signal: AbortSignal.timeout(60000), redirect: 'error' });
  const r = await res.json() as { url?: string; id?: string; key?: string; sha256?: string; error?: string; account?: string; full?: boolean; previous?: string };
  if (!res.ok || !r.url || !r.id || !r.key) throw new Error(`Upload refused: ${r.error ?? res.status}. Your local file is unchanged.`);
  if (new URL(r.url).origin !== new URL(SITE).origin) throw new Error('The server returned a report on a different origin. Check PGCHECKUP_URL.');
  const receipt = `${file.replace(/\.json$/, '')}.${stamp()}.receipt.json`;
  writeFileSync(receipt, json({ report: r.url, id: r.id, deleteKey: r.key, sha256: sha(text), uploadedAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
  if (r.sha256 !== sha(text)) throw new Error(`The server's hash does not match your file. Treat the upload as unverified: pg-checkup delete ${quote(receipt)} removes it.`);
  const report = new URL(r.url);
  if (!r.full) report.hash = `k=${r.key}`; // a free report is private: the key in the fragment lets this browser open it
  if (flag('json')) out(json({ report: String(report), receipt, sha256: r.sha256, ...(r.account ? { account: r.account, full: Boolean(r.full) } : {}) }));
  else {
    out(`Report:  ${report}`);
    if (r.account) out(`Saved to ${r.account}${r.full ? ' as a full report' : ''}${r.previous ? ', compared with your previous checkup of this database' : ''}.`);
    out(`Receipt: ${receipt}  (pg-checkup delete ${quote(receipt)} removes the report)`);
  }
}

async function scan() {
  const c = await connection();
  const local = isLocalHost(c.url);
  const t0 = Date.now();
  let tls = false, verified = false;
  const b = await collect(c.url, {
    provider, queryText: flag('include-query-text') ? 'masked' : 'removed',
    checkRole: (r) => {
      if (allowPrivilegedRole) return;
      if (!local) return requireMonitoringRole(r);
      if (roleProblems(r).length) say(`${r.role} can read tables. Accepted because the database is on this machine; a remote database needs a statistics-only login (pg-checkup role).`);
    },
    progress: (e) => {
      if (e.step === 'connected') { tls = e.tls; verified = e.verified; return; }
      if (process.stderr.isTTY && !flag('json')) process.stderr.write(`\rReading statistics views ${e.done}/${e.total}…\x1b[K`);
    },
  });
  if (process.stderr.isTTY && !flag('json')) process.stderr.write('\r\x1b[K');
  say(`Connected ${tls ? (verified ? 'with TLS, certificate verified' : 'with TLS, certificate not verified') : 'without TLS'}${allowPrivilegedRole ? ', privileged-role check skipped' : ''}; read ${b.datasets.length} statistics views in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  if (tls && !verified && !local) say(`Certificate verification is disabled for this connection. To require verification: sslmode=verify-full in the URL, and PGSSLROOTCERT=path to your provider's CA file.`);
  if (flag('include-query-text')) say('SQL text is kept with literals masked. Comments and identifiers can still be sensitive; read the file before sharing.');
  const saved = save(b, `pg-checkup-${safeName(c.database)}`, c.password);
  const r = await analyze(b, { provider });
  const code = fails(r.findings) || strictFails(b) ? 1 : 0;
  if (flag('json')) { say(`Saved ${saved.file}`); process.stdout.write(json(withAnalysis(b, r))); return code; }
  if (flag('md')) { say(`Saved ${saved.file}`); process.stdout.write(markdown(r, b)); return code; }
  out();
  await printReport(r, b, saved.file);
  if (flag('upload') || opt('send')) { out(); await upload(saved.text, saved.file); }
  return code;
}

async function main(): Promise<number> {
  if (cmd === 'role') { out(MONITOR_ROLE_SQL); return 0; }
  if (cmd === 'schedule') {
    const every = (opt('every') === 'daily' ? 'daily' : 'weekly') as Every;
    if (flag('cron')) { out(crontabLine(every)); for (const n of SCHEDULE_NOTES('cron')) say(n); return 0; }
    const yaml = flag('summary') ? githubSummaryWorkflow(every, opt('fail-on')) : githubWorkflow(every);
    if (flag('write')) {
      const path = '.github/workflows/pg-checkup.yml';
      if (existsSync(path)) throw new Error(`${path} already exists; it was not changed.`);
      mkdirSync('.github/workflows', { recursive: true });
      writeFileSync(path, yaml, { flag: 'wx' });
      say(`Wrote ${path}. Add the two secrets it lists, commit it, and run it once from the Actions tab.`);
    } else out(yaml);
    for (const n of SCHEDULE_NOTES(flag('summary') ? 'summary' : 'github')) say(n);
    return 0;
  }
  if (cmd === 'sql') {
    for (const s of statements(provider)) out(`-- ${s.id}: ${s.title}\n${s.sql};\n`);
    out(`-- Observation metadata and counters (PostgreSQL 14+)\n${WINDOW_META_SQL};\n${WORKLOAD_SQL};`);
    return 0;
  }
  if (cmd === 'doctor') {
    out(`pg-checkup ${COLLECTOR_VERSION}, Node ${process.version} on ${process.platform}`);
    const c = await connection();
    const { db, tls, verified, local } = await openReadOnlySession(c.url);
    try {
      const [{ v, s }] = (await db.query(`select current_setting('server_version_num')::int as v, version() as s`)).rows;
      out(`${tls && !verified && !local ? ink(33, '!') : ink(32, '✓')} Connected: ${String(s).split(' on ')[0].split(',')[0]} (${v}), ${tls ? (verified ? 'TLS, certificate verified' : 'TLS, certificate not verified') : 'no TLS'}, read-only session${local ? ', local' : ''}`);
      if (tls && !verified && !local) out(`    To require verification: sslmode=verify-full in the URL, and PGSSLROOTCERT=path to your provider's CA file.`);
      const role = roleInfo((await db.query(roleSql(profileFor(provider ?? providerIdFromUrl(c.url))))).rows[0] ?? {});
      const problems = roleProblems(role);
      out(`${problems.length ? (local ? ink(33, '!') : ink(31, '✗')) : ink(32, '✓')} Login ${role.role}: ${role.monitor ? 'in pg_monitor' : 'not in pg_monitor (other sessions may be hidden)'}${problems.length ? '' : ', statistics only'}`);
      for (const p of problems) out(`    - ${p}`);
      if (problems.length) out(`    ${local ? 'Accepted for a local database.' : 'A checkup of a remote database stops here. Create a statistics-only login: pg-checkup role'}`);
      const ext = (await db.query(`select extname from pg_extension`)).rows.map((r) => r.extname);
      out(`${ext.includes('pg_stat_statements') ? ink(32, '✓') : ink(33, '!')} pg_stat_statements ${ext.includes('pg_stat_statements') ? 'installed' : 'not installed: query checks will be skipped'}`);
      out(`${ext.includes('pgstattuple') ? ink(32, '✓') : ink(2, '-')} pgstattuple ${ext.includes('pgstattuple') ? 'installed' : 'not installed: bloat is estimated, not measured'}`);
      return problems.length && !local ? 3 : 0;
    } finally { await db.end(); }
  }
  if (cmd === 'show' || cmd === 'upload') {
    const { text, value } = load(positionals[0]); const b = parseBundle(value);
    if (cmd === 'show') {
      const r = await analyze(b, { provider });
      const code = fails(r.findings) || strictFails(b) ? 1 : 0;
      if (flag('json')) { process.stdout.write(json(withAnalysis(b, r))); return code; }
      if (flag('md')) { process.stdout.write(markdown(r, b)); return code; }
      out(dim(`${positionals[0]}, collected ${b.collectedAt.replace('T', ' ').slice(0, 16)} UTC`));
      await printReport(r, b);
      if (flag('all')) { out(); allRows(b); } else out(dim(`\nEvery row: pg-checkup show ${quote(positionals[0])} --all`));
      return code;
    }
    await upload(text, positionals[0]); return 0;
  }
  if (cmd === 'delete') {
    const { value: r } = load(positionals[0]);
    if (!r.report || !/^[a-f0-9]{32}$/.test(r.id) || typeof r.deleteKey !== 'string') throw new Error('Not a deletion receipt.');
    const u = validateDestination(r.report);
    if (u.origin !== new URL(SITE).origin) throw new Error('Receipt belongs to a different server. Set PGCHECKUP_URL to that server to delete from it.');
    const res = await fetch(`${u.origin}/api/report/${r.id}`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: json({ key: r.deleteKey }), signal: AbortSignal.timeout(30000), redirect: 'error' });
    if (res.status !== 204 && res.status !== 404) throw new Error(`Deletion refused (HTTP ${res.status}).`);
    if (flag('json')) out(json({ deleted: true })); else out('Report deleted (or already gone).');
    return 0;
  }
  if (cmd === 'baseline') {
    const c = await connection();
    say('Saving schema, security and settings. Nothing is uploaded.');
    const s = await takeSnapshot(c.url, snapshotOptionsFor(c.url));
    const { file, text } = save(s, `pg-checkup-baseline-${safeName(c.database)}`, c.password);
    if (flag('json')) { say(`Saved ${file}`); process.stdout.write(text); return 0; }
    out(`Saved ${file}: ${Object.values(s.objects).reduce((n, o) => n + Object.keys(o).length, 0)} objects.`);
    out(`After the migration: pg-checkup verify ${quote(file)} -h NEW_HOST -U checkup_reader -d ${safeName(c.database)}`);
    out('Runtime performance is a separate step: pg-checkup observe on each side, then compare.');
    return 0;
  }
  if (cmd === 'observe') {
    const c = await connection();
    const seconds = Number(opt('seconds') ?? 300);
    say(`Observing ${seconds} s of existing traffic. No benchmark queries, nothing uploaded.`);
    const w = await observe(c.url, { ...snapshotOptionsFor(c.url), seconds, representative: flag('representative'), label: opt('label'), progress: (n) => { if (n % 30 === 0) say(`${n} s remaining…`); } });
    const { file, text } = save(w, `pg-checkup-window-${safeName(c.database)}`, c.password);
    if (flag('json')) { say(`Saved ${file}`); process.stdout.write(text); return 0; }
    out(`Saved ${file}.`);
    out(`Compare: pg-checkup compare ${quote(file)} AFTER.json`);
    if (!w.representative) out('This window is exploratory. Pass --representative only after caches are warm and normal traffic has resumed.');
    return 0;
  }
  if (cmd === 'compare' || cmd === 'verify') {
    const before = load(positionals[0]).value;
    const second = positionals.slice(1).find((s) => !/^postgres(ql)?:\/\//.test(s));
    if (before.format === BUNDLE_FORMAT) {
      // Two checkup files: what was fixed, what is new, and the numbers. Both are analysed here, so older files work.
      const [x, y] = [parseBundle(before), parseBundle(load(second).value)];
      const [rx, ry] = [await analyze(x, { provider }), await analyze(y, { provider })];
      const c = compareCheckups({ bundle: x, findings: rx.findings, checks: rx.checks, vitals: rx.vitals }, { bundle: y, findings: ry.findings, checks: ry.checks, vitals: ry.vitals });
      if (flag('json')) process.stdout.write(json(c)); else out(checkupComparisonText(c));
      return c.sameDatabase === false ? 4 : c.regression ? 1 : 0;
    }
    if (before.format === WINDOW_FORMAT) {
      const result = compareWorkloads(parseWindow(before), parseWindow(load(second).value));
      if (flag('json')) process.stdout.write(json(result)); else out(workloadText(result));
      return !result.comparable ? 4 : result.queries.some((q) => q.status === 'slower') ? 1 : 0;
    }
    const a = parseSnapshot(before);
    const after = second ? parseSnapshot(load(second).value) : await (async () => { const c = await connection(); return takeSnapshot(c.url, snapshotOptionsFor(c.url)); })();
    const differences = diffSnapshots(a, after);
    if (flag('json')) process.stdout.write(json(differences)); else out(diffText(differences, a, after));
    return differences.some((d) => d.verdict === 'regression') ? 1 : 0;
  }
  return scan();
}
function failure(e: any) {
  if (e instanceof UsageError) { say(`pg-checkup: ${e.message}`); return 2; }
  if (e instanceof RoleRefused) {
    say(`${ink(31, '✗')} Stopped before reading anything: this login has more access than a checkup needs.`);
    for (const p of e.problems) say(`    - ${p}`);
    say(`\n  Create a statistics-only login (this is also what "pg-checkup role" prints):\n`);
    for (const line of MONITOR_ROLE_SQL.split('\n')) say(`    ${line}`);
    say(`\n  Then run again as checkup_reader. To go ahead with this login anyway: --allow-privileged-role`);
    return 3;
  }
  const messages: Record<string, string> = {
    EEXIST: 'That output file already exists and was kept. Choose another --out path.',
    ENOTFOUND: 'Host not found. Check -h/--host or the hostname in the URL.',
    ECONNREFUSED: 'Connection refused. Is Postgres listening on that host and port? Check -h and -p.',
    ETIMEDOUT: 'Connection timed out. Check the host, port, firewall and VPN.',
    '28P01': 'Password authentication failed. Check -U/--user and the password: a URL, PGPASSWORD, ~/.pgpass, or the prompt when run in a terminal.',
    '28000': 'The server rejected this login (pg_hba.conf). Check the user, database and connection method.',
    '3D000': 'Database not found. Check -d/--dbname.',
    '57P03': 'The server is starting up or shutting down. Try again shortly.',
  };
  // Driver/file errors can echo secrets. Only known safe errors from this CLI retain detail.
  const message = messages[e.code] ?? (e.code ? `Database or system error (${e.code}). Check the connection settings and the role's permissions.` : String(e.message ?? e).replace(/postgres(?:ql)?:\/\/\S+/gi, '[connection hidden]'));
  say(`pg-checkup: ${message}`); return 2;
}
process.on('SIGINT', () => { process.stderr.write('\nCancelled. Files already saved are kept.\n'); process.exit(130); });
main().then((code) => { process.exitCode = code; }).catch((e) => { process.exitCode = failure(e); });
