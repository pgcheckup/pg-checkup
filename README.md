# pg-checkup

Read-only checkup of a PostgreSQL database, run on your machine. It reads the statistics and catalog views, runs every check, reads the findings together, and prints what to fix first, why, and how. It does not read table rows, it cannot write, and it makes no network connection except to your database.

```
npx pg-checkup@latest postgres://checkup_reader@db.example.com/app
```

```
Connected to db.example.com:5432/app as checkup_reader: read-only session, TLS
Read 76 statistics views in 1.4 s

PostgreSQL 16.4  82 checks: 1 critical, 4 warning, 7 info

FIX NOW
✗ 1 session has been idle in a transaction for 3 hours  Locks & transactions
    Fix this first. The session idle in a transaction (PID 4821) has held back cleanup for
    1,204,000 transactions, so vacuum can't remove dead rows in public.events.
    Why: An open transaction holds locks and keeps vacuum from removing rows.
    Fix: End it (pg_terminate_backend), then find the code path that forgets to commit.

FIX NEXT
! 2 tables have 20%+ dead rows  Vacuum & bloat
    Caused at least in part by the session idle in a transaction: VACUUM can't remove these
    rows until it ends. End it, then scan again.
    Why: Dead rows slow sequential scans and bloat the table and its indexes.
    Fix: Let autovacuum catch up, or VACUUM the tables; lower autovacuum_vacuum_scale_factor.
! 1 large table is mostly read by sequential scan  Tables
    public.events: 41% of its rows are dead, and sequential scans read dead rows too. Clear
    the dead rows and measure again before adding an index.
    ...

WATCH
· WAL archiving is off  Backups & recovery
    ...

68 checks passed, 2 skipped, 12 not applicable here. -v lists them.
- Tables aren't bloated: Install pgstattuple to measure bloat instead of guessing

Saved pg-checkup-app-2026-10-07T15-29-33-a1b2.json: 410 rows of statistics and catalog
metadata, no SQL text, no table data. Object and role names are in it; read it before sharing.
  every row:                   pg-checkup show pg-checkup-app-2026-10-07T15-29-33-a1b2.json --all
  shareable report, fix SQL:   pg-checkup upload pg-checkup-app-2026-10-07T15-29-33-a1b2.json
```

Install nothing (`npx pg-checkup ...`) or keep it around (`npm install -g pg-checkup`, then `pg-checkup ...`). In a project with `DATABASE_URL` in `.env` or `.env.local`, `npx pg-checkup` alone is enough; it says which file it used. Needs Node 18 or newer and PostgreSQL 12 or newer; CI runs the checkup against PostgreSQL 12 to 17 on every push. Works without `pg_stat_statements`; the query checks are skipped and say so. `-v` lists every check, `--md` writes the report as Markdown, `--json` writes the statistics and findings as JSON, and `--fail-on warning` makes a build fail.
## Connecting

The same ways as `psql`: a `postgres://` URL, `-h HOST -p PORT -U USER -d DBNAME`, `--service NAME`, or the `PGHOST`, `PGPORT`, `PGUSER`, `PGDATABASE`, `PGSERVICE` and `PGSSLMODE` variables. The password is taken from the URL, `PGPASSWORD`, the service file, `~/.pgpass`, or a hidden prompt, in that order. `-W` always prompts, `-w` never does. Nothing about the connection is saved.

```
pg-checkup -h db.example.com -U checkup_reader -d app
PGSERVICE=prod pg-checkup
pg-checkup --json > checkup.json      # JSON on stdout, messages on stderr
```

`pg-checkup doctor` connects, prints the server version, what the login can do and which extensions are present, and stops. Run it first when something is unclear.

### TLS

For a remote host the connection uses TLS and verifies the server's certificate against the system's trusted CAs, plus `PGSSLROOTCERT` if set. When the certificate cannot be verified, which is the case for providers that sign with their own CA, the connection is still encrypted but the output says "certificate not verified" and how to require it: `sslmode=verify-full` in the URL and `PGSSLROOTCERT=path` to the provider's CA file. With `sslmode=verify-full` or `verify-ca` there is no fallback. Plaintext is used only when the server refuses TLS, and is reported.

### The login it expects

A role that can read statistics and nothing else:

```sql
create role checkup_reader login password 'choose-a-password';
grant pg_monitor to checkup_reader;
```

`pg-checkup role` prints this. For a remote database, if the login can read application tables, or is a superuser, or has `REPLICATION`, `BYPASSRLS`, `CREATEROLE` or `CREATEDB`, the checkup stops before reading anything and says why; `--allow-privileged-role` overrides that. A database on localhost is checked with whatever login you give, with a note. The check covers effective privileges in the connected database, including what `PUBLIC` grants; it is not an audit of security-definer functions or other databases.

## What leaves this machine

Nothing, unless you run `pg-checkup upload FILE`. With `PGCHECKUP_TOKEN` set (a token from Settings on pgcheckup.com) the report is saved to your account; on the plan it is a full report with fix SQL, kept, and compared with your previous checkup of the same database. That command shows what is in the file, asks for confirmation, and sends that file and nothing else to pgcheckup.com, which turns it into a shareable web report with the same findings and every evidence table. The copy-ready SQL for each fix, decision reports and a PDF are a paid add-on there. The server returns the file's SHA-256, which the CLI compares, and a receipt that `pg-checkup delete RECEIPT` uses to remove the report. Free reports are kept for 7 days; anyone with the link can read them. There is no telemetry.

The saved file holds statistics, settings, and schema and role names. It never holds table rows or the connection string. SQL text is left out unless you pass `--include-query-text`, which masks literals but can still leave sensitive comments or identifiers. Files are created with mode 0600 and are never overwritten.

Every query the checkup runs is printed by `pg-checkup sql`. Everything that touches the database or the network ships as readable TypeScript under `source/`, listed in `source-manifest.json`; the checks and triage ship compiled in `dist/`. Source: https://github.com/pgcheckup/pg-checkup

## Before and after a migration

```
pg-checkup baseline -h OLD_HOST -U checkup_reader -d app -o before.json
pg-checkup verify before.json -h NEW_HOST -U checkup_reader -d app
```

`verify` compares schema, security and settings metadata, labels expected provider differences, and uploads nothing. It does not compare row contents, and it does not cover Supabase Auth, Storage, Edge Functions or Realtime. Sequence values need `SELECT` on the sequences; otherwise they are reported as unknown.

For runtime performance, measure equal windows of normal traffic on each side once caches are warm:

```
pg-checkup observe -h OLD_HOST -U checkup_reader -d app --seconds 300 --representative --label before -o before-window.json
pg-checkup observe -h NEW_HOST -U checkup_reader -d app --seconds 300 --representative --label after  -o after-window.json
pg-checkup compare before-window.json after-window.json
```

`observe` runs no load and no `EXPLAIN ANALYZE`; it subtracts `pg_stat_statements` counters across the window. Needs PostgreSQL 14+ and a `pg_stat_statements` version with reset timestamps. A comparison is only reported when the windows are comparable: at least 60 seconds and 100 calls each, durations within 20%, call rates within 25%, query mix within 15%, and no reset, restart or eviction in between. "Slower" means at least 20% and 1 ms per call worse. Query families are matched by a hash of the representative SQL, so reformatted queries will not match.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Completed. A completed scan can still have flagged checks; read the output. |
| 1 | `verify` or `compare` found a regression, `--fail-on` matched, or `--strict` found an unreadable view. |
| 2 | Usage or runtime error. |
| 3 | The login has more access than a checkup needs. |
| 4 | `compare` was inconclusive. |
| 130 | Cancelled with Ctrl+C. |

`--json` prints only JSON on stdout. `NO_COLOR=1`, `--no-color`, `TERM=dumb` or a non-terminal stdout turn colour off. `--no-input` disables every prompt. `--strict` exits 1 when a diagnostic view could not be read, so a CI job notices a permission problem instead of a quieter report; a missing extension is a skip, not an error.

The collector (everything under `source/`) is MIT licensed. The checks and triage are free to use as part of this package; see LICENSE. The hosted report is a separate service.
