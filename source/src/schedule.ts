// Scheduled checkups without handing us a connection string: the schedule runs on the customer's side, with the
// connection string in their own secret store, and only the saved statistics file is uploaded.
export type Every = "daily" | "weekly";

const CRON: Record<Every, string> = { daily: "17 6 * * *", weekly: "17 6 * * 1" };
const WHEN: Record<Every, string> = { daily: "every day at 06:17 UTC", weekly: "every Monday at 06:17 UTC" };

/** A GitHub Actions workflow that runs the checkup and uploads the result to the account that owns the token. */
export function githubWorkflow(every: Every = "weekly"): string {
  return `# Runs pg-checkup ${WHEN[every]} and uploads the statistics file to your pgcheckup.com account.
# Secrets (Settings, Secrets and variables, Actions):
#   DATABASE_URL     a statistics-only login (pg-checkup role prints the SQL to create one)
#   PGCHECKUP_TOKEN  from Settings on pgcheckup.com; it can only add reports to your account
name: pg-checkup
on:
  schedule:
    - cron: "${CRON[every]}"
  workflow_dispatch:
jobs:
  checkup:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - name: Run the checkup and upload it
        env:
          DATABASE_URL: \${{ secrets.DATABASE_URL }}
          PGCHECKUP_TOKEN: \${{ secrets.PGCHECKUP_TOKEN }}
        run: |
          npx --yes pg-checkup --no-input --no-pace --no-color -o checkup.json
          npx --yes pg-checkup upload checkup.json --yes --no-input
`;
}

/** The same schedule with no account: the report lands in the run's summary, and the previous run's file is kept in the cache so the two are compared. */
export function githubSummaryWorkflow(every: Every = "weekly", failOn?: string): string {
  const fail = failOn ? ` --fail-on ${failOn}` : "";
  return `# Runs pg-checkup ${WHEN[every]}. The report appears in the run's summary; nothing is uploaded anywhere.
# One secret (Settings, Secrets and variables, Actions):
#   DATABASE_URL  a statistics-only login (pg-checkup role prints the SQL to create one)
name: pg-checkup
on:
  schedule:
    - cron: "${CRON[every]}"
  workflow_dispatch:
permissions:
  contents: read
jobs:
  checkup:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - name: Restore the previous checkup, to compare
        uses: actions/cache/restore@v4
        with:
          path: .pg-checkup/previous.json
          key: pg-checkup-\${{ github.run_id }}
          restore-keys: pg-checkup-
      - name: Run the checkup
        env:
          DATABASE_URL: \${{ secrets.DATABASE_URL }}
        run: |
          mkdir -p .pg-checkup
          set +e
          npx --yes pg-checkup --no-input --no-pace --no-color${fail} -o .pg-checkup/checkup.json
          code=$?
          set -e
          if [ -f .pg-checkup/checkup.json ]; then
            npx --yes pg-checkup show .pg-checkup/checkup.json --md --no-color >> "$GITHUB_STEP_SUMMARY"
            if [ -f .pg-checkup/previous.json ]; then
              { echo; echo '## Since the last run'; echo; echo '\`\`\`'; npx --yes pg-checkup compare .pg-checkup/previous.json .pg-checkup/checkup.json --no-color || true; echo '\`\`\`'; } >> "$GITHUB_STEP_SUMMARY"
            fi
            cp .pg-checkup/checkup.json .pg-checkup/previous.json
          fi
          exit $code
      - name: Keep this checkup for the next run
        if: always()
        uses: actions/cache/save@v4
        with:
          path: .pg-checkup/previous.json
          key: pg-checkup-\${{ github.run_id }}
`;
}

/** A crontab line for a machine that can reach the database and keeps DATABASE_URL and PGCHECKUP_TOKEN in its environment. */
export function crontabLine(every: Every = "weekly"): string {
  const f = (CRON[every]).split(" ");
  return `${f.join(" ")} cd "$(mktemp -d)" && npx --yes pg-checkup --no-input --no-pace --no-color -o checkup.json && npx --yes pg-checkup upload checkup.json --yes --no-input`;
}

export const SCHEDULE_NOTES = (target: "github" | "cron" | "summary") => target === "summary" ? [
  "Nothing is uploaded. The report appears under the run in the Actions tab, and each run is compared with the one before it (the previous file is kept in the Actions cache, which GitHub clears after 7 days without use).",
  "GitHub-hosted runners have changing IP addresses. If your database only allows listed addresses, use a self-hosted runner inside your network.",
] : [
  `Your connection string stays in ${target === "github" ? "your repository's secrets" : "this machine's environment"}. pgcheckup.com receives only the statistics file, and only through the token.`,
  `Each upload is compared with the previous one for the same database, so the report shows what was fixed, what is new, and what is getting worse.`,
  target === "github"
    ? `GitHub-hosted runners have changing IP addresses. If your database only allows listed addresses, use a self-hosted runner inside your network.`
    : `The machine running this must be able to reach the database.`,
];
