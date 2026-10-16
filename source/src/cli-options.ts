// The command line, defined with Commander: generated help, per-command options (`pg-checkup scan --help`), choices
// and argument validation. Short letters follow psql (-h -p -U -d -W -w), so --help has no short form.
import { Command, CommanderError, InvalidArgumentError, Option } from 'commander';

export interface Parsed { command: string; positionals: string[]; options: Record<string, string | boolean> }
export class UsageError extends Error {}

const PROVIDERS = ['generic', 'supabase', 'neon'];
const GOALS = ['performance', 'resize', 'readiness', 'incident'];
const SEVERITIES = ['critical', 'warning', 'info'];
const isUrl = (s: string) => /^postgres(ql)?:\/\//.test(s);
const integer = (lo: number, hi: number) => (v: string) => {
  if (!/^\d+$/.test(v) || Number(v) < lo || Number(v) > hi) throw new InvalidArgumentError(`Must be a whole number from ${lo} to ${hi}.`);
  return v;
};

/** Options every command that opens a connection takes, named as in psql. */
function connection(c: Command): Command {
  return c
    .argument('[connection]', 'a postgres:// URL; otherwise the flags, PG* variables or ./.env are used')
    .option('-h, --host <host>', 'database server host')
    .option('-p, --port <port>', 'database server port', integer(1, 65535))
    .option('-U, --user <user>', 'database user name')
    .option('-d, --dbname <dbname>', 'database name')
    .option('--service <name>', 'connection service from ~/.pg_service.conf')
    .option('--sslmode <mode>', 'disable, allow, prefer, require, verify-ca or verify-full')
    .option('-W, --password', 'always prompt for the password')
    .option('-w, --no-password', 'never prompt for the password')
    .addOption(new Option('--provider <provider>', 'override host detection, e.g. behind a tunnel').choices(PROVIDERS))
    .option('--allow-privileged-role', 'proceed on a remote database with a login that can read tables');
}
/** Options for reading a result: on scan and show. */
function reading(c: Command): Command {
  return c
    .option('-v, --verbose', 'also list every check that passed, was skipped or did not apply')
    .option('--md', 'print the report as Markdown on stdout')
    .addOption(new Option('--fail-on <severity>', 'exit 1 when a finding of this severity or worse exists').choices(SEVERITIES));
}

/** Commander's camelCase options, as the kebab-case keys the command bodies read. Negatable pairs become their own keys. */
function toOptions(o: Record<string, unknown>): Record<string, string | boolean> {
  const names: Record<string, string> = { dbname: 'database', failOn: 'fail-on', includeQueryText: 'include-query-text', allowPrivilegedRole: 'allow-privileged-role' };
  const out: Record<string, string | boolean> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined) continue;
    if (k === 'password') { if (v === true) out.password = true; else if (v === false) out['no-password'] = true; continue; }
    if (k === 'upload') { if (v === true) out.upload = true; else if (v === false) out['no-upload'] = true; continue; }
    if (k === 'color') { if (v === false) out['no-color'] = true; continue; }
    if (k === 'input') { if (v === false) out['no-input'] = true; continue; }
    if (k === 'pace') { if (v === false) out['no-pace'] = true; continue; }
    out[names[k] ?? k] = v as string | boolean;
  }
  if (out.md && out.json) throw new UsageError('--md and --json cannot be combined.');
  if (out.json && out.upload) throw new UsageError('--json and --upload cannot be combined; upload the saved file separately.');
  return out;
}

const AFTER = `
Connection: a postgres:// URL, or -h/-p/-U/-d, or --service NAME, or PGHOST PGPORT PGUSER PGDATABASE
  PGSERVICE PGSSLMODE. With none of those, DATABASE_URL is read from ./.env.local or ./.env.
  Password: the URL, PGPASSWORD, the service file, ~/.pgpass, then a hidden prompt.

Examples:
  pg-checkup postgres://checkup_reader@db.example.com/app
  pg-checkup -h db.example.com -U checkup_reader -d app
  pg-checkup show checkup.json --md

Nothing leaves this machine except through "upload", which sends the saved file and nothing else.
Exit codes: 0 completed, 1 regression or --fail-on match, 2 usage or runtime error, 3 remote login
  has more access than needed, 4 comparison inconclusive, 130 cancelled.`;

/** Builds the program. `record` receives what was asked for; nothing runs during parsing. */
export function buildProgram(version: string, record: (p: Parsed) => void, quiet = false): Command {
  const program = new Command('pg-checkup')
    .description('Read-only checkup of a PostgreSQL database, run on your machine.\nRuns every check, reads the findings together, and prints what to fix first, why, and how.')
    .usage('[connection] [options]\n       pg-checkup <command> [options]')
    .version(version, '-V, --version', 'print the version')
    .helpOption('--help', 'show help')
    .helpCommand(false)
    .option('-o, --out <file>', 'where to save the result; an existing file is never overwritten')
    .option('--json', 'the result as JSON on stdout; messages stay on stderr')
    .option('--no-color', 'plain text (NO_COLOR=1 does the same)')
    .option('--no-input', 'never prompt; for scripts and CI')
    .option('--no-pace', 'print all findings at once instead of one at a time')
    .addHelpText('after', AFTER)
    .showHelpAfterError('(run pg-checkup --help)')
    .exitOverride();
  if (quiet) program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  const done = (command: string, positionals: string[], cmd: Command) => record({ command, positionals, options: toOptions(cmd.optsWithGlobals()) });

  reading(connection(program.command('scan', { isDefault: true })
    .description('run the checkup and save the statistics to a file (the default)')))
    .option('--include-query-text', 'keep SQL text in the file, with literals masked')
    .option('--upload', 'upload the saved file afterwards, for a shareable report')
    .addOption(new Option('--no-upload').hideHelp())
    .addOption(new Option('--goal <goal>', 'with --upload: which decision report to open').choices(GOALS))
    .action((conn: string | undefined, _o, cmd: Command) => {
      if (conn !== undefined && !isUrl(conn)) throw new UsageError(`unknown command "${conn}". A connection is a postgres:// URL; run pg-checkup --help for the commands.`);
      done('scan', conn ? [conn] : [], cmd);
    });
  reading(program.command('show').description('run the checkup again on a saved file').argument('<file>'))
    .option('--all', 'also print every collected row')
    .addOption(new Option('--provider <provider>', 'analyse as this provider').choices(PROVIDERS))
    .action((file: string, _o, cmd: Command) => done('show', [file], cmd));
  connection(program.command('doctor').description('say how pg-checkup would connect and what the login can do, then stop'))
    .action((conn: string | undefined, _o, cmd: Command) => done('doctor', conn ? [conn] : [], cmd));
  program.command('role').description('print SQL that creates a statistics-only login').action((_o, cmd: Command) => done('role', [], cmd));
  program.command('sql').description('print every query the checkup runs, in order')
    .addOption(new Option('--provider <provider>', 'the queries as run for this provider').choices(PROVIDERS))
    .action((_o, cmd: Command) => done('sql', [], cmd));
  program.command('upload').description('send a saved file to pgcheckup.com for a shareable report').argument('<file>')
    .addOption(new Option('--goal <goal>', 'which decision report to open').choices(GOALS))
    .option('-y, --yes', 'upload without asking')
    .action((file: string, _o, cmd: Command) => done('upload', [file], cmd));
  program.command('delete').description('remove an uploaded report').argument('<receipt>', 'the receipt file written by upload')
    .action((receipt: string, _o, cmd: Command) => done('delete', [receipt], cmd));
  connection(program.command('baseline').description('save schema, security and settings before a migration'))
    .action((conn: string | undefined, _o, cmd: Command) => done('baseline', conn ? [conn] : [], cmd));
  connection(program.command('verify').description('explain what differs after the migration').argument('<baseline>', 'file written by baseline').argument('[after]', 'a second baseline file'))
    .action((baseline: string, after: string | undefined, conn: string | undefined, cmd: Command) => done('verify', [baseline, ...(after ? [after] : []), ...(conn ? [conn] : [])], cmd));
  program.command('compare').description('compare two observation files, or two baseline files').argument('<before>').argument('<after>')
    .action((before: string, after: string, _o, cmd: Command) => done('compare', [before, after], cmd));
  connection(program.command('observe').description('measure a window of real traffic from pg_stat_statements'))
    .option('--seconds <n>', 'length of the window', integer(10, 3600), '300')
    .option('--label <label>', 'name for the window, e.g. before-release-42')
    .option('--representative', 'attest that this is normal traffic with warm caches')
    .action((conn: string | undefined, _o, cmd: Command) => done('observe', conn ? [conn] : [], cmd));
  return program;
}

/** -h alone means help, as everyone expects; -h followed by a value is the host, as in psql. */
export const normalizeArgv = (argv: string[]) => argv.map((a, i) => (a === '-h' && (argv[i + 1] === undefined || argv[i + 1].startsWith('-')) ? '--help' : a));

/** Parses without running or printing anything. Throws a plain Error with Commander's message on bad input. */
export function parseArgs(argv: string[], version = '0.0.0'): Parsed {
  let parsed: Parsed | undefined;
  const program = buildProgram(version, (p) => { parsed = p; }, true);
  try { program.parse(normalizeArgv(argv), { from: 'user' }); }
  catch (e) {
    if (e instanceof CommanderError) {
      if (e.code === 'commander.helpDisplayed' || e.code === 'commander.help') return { command: 'help', positionals: [], options: { help: true } };
      if (e.code === 'commander.version') return { command: 'help', positionals: [], options: { version: true } };
      throw new Error(e.message.replace(/^error: /, ''));
    }
    throw e;
  }
  if (!parsed) throw new Error('nothing to do');
  return parsed;
}

/** Never render terminal escape sequences supplied by database names, SQL, or imported files. */
export const terminalText = (value: unknown) => String(value).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '').replace(/\r/g, '');
