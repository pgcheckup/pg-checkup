# pg-checkup

Read-only checkup for PostgreSQL. It reads what the database records about itself and tells you what to fix first, why, and how.

[Features](#features) · [Quick start](#quick-start) · [How it works](#how-it-works) · [Commands](#commands) · [What it will not do](#what-it-will-not-do) · [More](#more)

```
$ npx pg-checkup postgres://checkup_reader@db.example.com/app

PostgreSQL 17.5  5 warning · 7 info
Start here: 1 table has more than 20% dead rows

FIX NEXT
! 1 table has more than 20% dead rows  Vacuum & bloat
    Why: Dead rows waste disk and slow scans; autovacuum isn't keeping up.
    Fix: Remove vacuum blockers, lower autovacuum_vacuum_scale_factor on hot tables,
    run VACUUM (VERBOSE).
! 1 row-level security policy calls a function once per row  Security
    Why: PostgreSQL runs a stable or volatile function in a row filter once for every
    row it checks. Inside a scalar sub-select it runs once per query.
    Fix: Wrap the call: USING (owner_id = (SELECT my_fn())).

WATCH
· 1 table has no primary key  Tables
· WAL archiving is off  Backups & recovery
...
```

`✗` fix now, `!` fix next, `·` watch. Findings are listed in the order to fix them, and a cause comes before its effects.

## Features

- **No score.** Fix now, fix next, watch.
- **Findings read together.** When one problem causes another, the cause is listed first.
- **Read-only and local.** The session cannot write, and table rows are never read.
- **Honest about thin evidence.** A database that just started needs another run under real traffic, and it says so.
- **Before and after.** Compare two checkups: what was fixed, what is new, what changed.
- **PostgreSQL 12 and newer.** Tested on Neon, Supabase and Railway; other hosts are treated as plain PostgreSQL.
- **CI and AI assistants.** `--fail-on warning`, scheduled runs, and an MCP server.

## Quick start

```
npx pg-checkup postgres://checkup_reader@host/db
```

Needs Node 18 or newer. Connect the way you do with `psql`: a URL, `-h -U -d`, the `PG*` variables, or `DATABASE_URL` in `.env`. The password comes from the URL, `PGPASSWORD`, `~/.pgpass`, or a prompt.

Use a login that can read statistics and nothing else (`pg-checkup role` prints this):

```sql
create role checkup_reader login password '...';
grant pg_monitor to checkup_reader;
```

On a remote database, a login with more access than that is refused. Remote connections need TLS with a verified certificate; for a provider with its own CA, set `PGSSLROOTCERT=ca.pem`.

## How it works

```
 your database                your machine                          optional
 -------------                ------------                          --------

 pg_stat_* views --SELECTs--> pg-checkup --> terminal: fix now, fix next, watch
 pg_catalog      (read-only)      |
 (no table rows)                  +--------> checkup.json --upload--> pgcheckup.com
                                             (statistics only)        (shareable report)
```

Nothing leaves your machine unless you run `upload`. The saved file holds statistics, settings, and schema and role names. It never holds table rows or the connection string.

## Commands

```
pg-checkup URL                run a checkup and save it to a file
pg-checkup show FILE          read a saved checkup again (--md, --json, --all)
pg-checkup compare A B        what was fixed, what is new, what changed
pg-checkup doctor URL         test the connection and what the login can do
pg-checkup role               SQL for a statistics-only login
pg-checkup sql                every query it runs
pg-checkup schedule --write   run it weekly on GitHub Actions
pg-checkup upload FILE        optional: a shareable web report
```

Exit code 1 means a `--fail-on` match or a regression. Exit code 3 means the login has too much access.

## What it will not do

- Write to your database, or read your table rows.
- Talk to anything but your database. `upload` is a separate command and asks first.
- Hide what it runs. `pg-checkup sql` prints every query, and everything that touches the database or the network is readable in `source/`.

## More

[Run it on your machine](https://pgcheckup.com/docs/local) · [GitHub & CI](https://pgcheckup.com/docs/ci) · [AI assistants](https://pgcheckup.com/docs/mcp) · [Checks reference](https://pgcheckup.com/docs/checks)

License: see `LICENSE`.
