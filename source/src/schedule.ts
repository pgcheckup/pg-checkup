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

/** A crontab line for a machine that can reach the database and keeps DATABASE_URL and PGCHECKUP_TOKEN in its environment. */
export function crontabLine(every: Every = "weekly"): string {
  const f = (CRON[every]).split(" ");
  return `${f.join(" ")} cd "$(mktemp -d)" && npx --yes pg-checkup --no-input --no-pace --no-color -o checkup.json && npx --yes pg-checkup upload checkup.json --yes --no-input`;
}

export const SCHEDULE_NOTES = (target: "github" | "cron") => [
  `Your connection string stays in ${target === "github" ? "your repository's secrets" : "this machine's environment"}. pgcheckup.com receives only the statistics file, and only through the token.`,
  `Each upload is compared with the previous one for the same database, so the report shows what was fixed, what is new, and what is getting worse.`,
  target === "github"
    ? `GitHub-hosted runners have changing IP addresses. If your database only allows listed addresses, use a self-hosted runner inside your network.`
    : `The machine running this must be able to reach the database.`,
];
