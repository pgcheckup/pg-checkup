<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/pgcheckup/pg-checkup/main/assets/logo-dark.svg">
    <img src="https://raw.githubusercontent.com/pgcheckup/pg-checkup/main/assets/logo-light.svg" alt="pg-checkup" height="48">
  </picture>
</p>

<p align="center">Read-only checkup for PostgreSQL. It tells you what to fix first, why, and how.</p>

<p align="center">
  <a href="https://pgcheckup.com">Website</a> ·
  <a href="https://pgcheckup.com/docs/local">Docs</a> ·
  <a href="https://pgcheckup.com/docs/checks">Checks</a> ·
  <a href="https://github.com/pgcheckup/pg-checkup/issues">Issues</a>
</p>

<p align="center">
  <a href="https://github.com/pgcheckup/pg-checkup/actions/workflows/ci.yml"><img src="https://github.com/pgcheckup/pg-checkup/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A518-3c873a" alt="Node 18 or newer">
  <img src="https://img.shields.io/badge/PostgreSQL-12%20to%2017-336791" alt="PostgreSQL 12 to 17">
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/pgcheckup/pg-checkup/main/assets/terminal.svg" alt="pg-checkup output: findings listed as fix next and watch, each with why it matters and how to fix it" width="860">
</p>

`✗` fix now · `!` fix next · `·` watch. Findings are listed in the order to fix them, and a cause comes before its effects.

## Highlights

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
-- Some hosts keep extensions in their own schema (Supabase: "extensions"). This grants usage only if that schema exists.
do $$ begin if exists (select 1 from pg_namespace where nspname = 'extensions') then execute 'grant usage on schema extensions to checkup_reader'; end if; end $$;
```

On a remote database, a login with more access than that is refused. Remote connections need TLS with a verified certificate; for a provider with its own CA, set `PGSSLROOTCERT=ca.pem`.

## How it works

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/pgcheckup/pg-checkup/main/assets/how-it-works-dark.svg">
  <img src="https://raw.githubusercontent.com/pgcheckup/pg-checkup/main/assets/how-it-works-light.svg" alt="pg-checkup reads statistics views from your database with read-only SELECTs, runs on your machine, prints findings in your terminal, and uploads a statistics file only if you ask" width="924">
</picture>

The saved file holds statistics, settings, and schema and role names. It never holds table rows or the connection string.

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

[Run it on your machine](https://pgcheckup.com/docs/local) · [GitHub & CI](https://pgcheckup.com/docs/ci) · [AI assistants](https://pgcheckup.com/docs/mcp) · [Checks reference](https://pgcheckup.com/docs/checks) · License: see `LICENSE`.
