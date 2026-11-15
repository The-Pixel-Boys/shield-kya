# Incident Replay scoreboard

Generated from the files in [`replays/`](../replays) by `pnpm sync:replays`. Do not edit by hand.

The same data is shown at [shield-agent.com/replays](https://shield-agent.com/replays), and the README badge "incidents stopped" reads it.

Each file rebuilds one dangerous tool call and records whether KYA stops it. The test `test/replays.test.ts` runs every file through the real hook, so the table is a test result and not a claim. A miss stays on the page as "Not stopped yet" until a rule closes it.

- Incidents stopped: **2 of 2**
- Classes stopped: **25 of 25**
- Controls passed: **54 of 54**

A class is a destructive command type with no single incident behind it. A control is an everyday command that must pass, so a false positive shows here too. A result of "Held" means the guard asks the user and does not deny.

## Incidents

| Case | Date | Source | Result | Rule | Version | Credit |
|---|---|---|---|---|---|---|
| Agent deletes a production volume and its backups through the Railway API<br>_Reconstructed from the public account_ | 2026-04-24 | [1](https://incidentdatabase.ai/cite/1469) | Stopped | `railway-volume-delete` | 0.33.0 | - |
| Agent wipes a production database during a code freeze<br>_Reconstructed from the public account_ | 2025-07-18 | [1](https://incidentdatabase.ai/cite/1152) [2](https://www.eweek.com/news/replit-ai-coding-assistant-failure/) [3](https://www.theregister.com/software/2025/07/21/vibe-coding-service-replit-deleted-production-database/719783) | Stopped | `sql-drop` | 0.33.0 | - |

Where a row says "Reconstructed from the public account", the public reports did not publish the exact call. The call in the file is a rebuild and uses placeholder tokens and hosts only.

## Classes

| Case | Date | Source | Result | Rule | Version | Credit |
|---|---|---|---|---|---|---|
| AWS RDS instance deletion | 2026-11-14 | none | Stopped | `cloud-delete` | 0.33.0 | - |
| AWS S3 bucket removal with force | 2026-11-14 | none | Stopped | `cloud-delete` | 0.33.0 | - |
| docker volume prune with all and force | 2026-11-14 | none | Stopped | `docker-volumes` | 0.33.0 | - |
| Fly.io volume destroy | 2026-11-14 | none | Stopped | `fly-destroy` | 0.35.0 | - |
| Google Cloud SQL instance deletion | 2026-11-14 | none | Stopped | `cloud-delete` | 0.33.0 | - |
| GitHub repository deletion | 2026-11-14 | none | Stopped | `gh-repo-delete` | 0.35.0 | - |
| Delete the main branch on the remote | 2026-11-14 | none | Stopped | `git-delete-default-branch` | 0.33.0 | - |
| Force push to a feature branch | 2026-11-14 | none | Stopped | `git-force-push` | 0.33.0 | - |
| Force push to the main branch | 2026-11-14 | none | Stopped | `git-force-push-protected-branch` | 0.32.8 | - |
| git reset --hard followed by git clean -fdx | 2026-11-14 | none | Stopped | `git-hard-reset-clean` | 0.33.0 | - |
| kubectl delete of the production namespace | 2026-11-14 | none | Stopped | `k8s-delete-ns` | 0.33.0 | - |
| mongosh dropDatabase | 2026-11-14 | none | Stopped | `mongo-drop-database` | 0.35.0 | - |
| Prisma db push that accepts data loss | 2026-11-14 | none | Held (asks the user) | `prisma-accept-data-loss` | 0.35.0 | - |
| Prisma migrate reset with force | 2026-11-14 | none | Held (asks the user) | `prisma-migrate-reset` | 0.35.0 | - |
| Railway API volumeDelete mutation over curl | 2026-11-14 | none | Stopped | `railway-volume-delete` | 0.33.0 | - |
| Railway CLI volume delete | 2026-11-14 | none | Stopped | `railway-volume-delete` | 0.33.0 | - |
| redis-cli FLUSHALL against a URL | 2026-11-14 | none | Stopped | `redis-flush` | 0.35.0 | - |
| rm -rf of the project .git folder | 2026-11-14 | none | Stopped | `rm-git-dir` | 0.35.0 | - |
| rm -rf of everything in the project folder | 2026-11-14 | none | Held (asks the user) | `rm-project-wipe` | 0.35.0 | - |
| rm -rf of a path that starts with an unset variable | 2026-11-14 | none | Stopped | `rm-root-home` | 0.33.0 | - |
| DELETE FROM a table with no WHERE clause | 2026-11-14 | none | Held (asks the user) | `sql-delete-all` | 0.35.0 | - |
| TRUNCATE TABLE with CASCADE | 2026-11-14 | none | Stopped | `sql-drop` | 0.33.0 | - |
| Supabase db reset on the linked remote project | 2026-11-14 | none | Stopped | `supabase-reset-linked` | 0.35.0 | - |
| Terraform destroy with auto approve | 2026-11-14 | none | Stopped | `terraform-destroy` | 0.33.0 | - |
| Vercel project removal | 2026-11-14 | none | Stopped | `vercel-remove` | 0.35.0 | - |

## Gap tracking

Every row with "Not stopped yet" has a planned rule id. Each gap points to this section until a public issue is opened for it.

There is no open gap.

## Controls

54 everyday commands (for example `npm test`, `git status`, `prisma migrate dev`) are in the [`replays/`](../replays) folder as files named `control-*.yaml`. Their results are in [`replays/scoreboard.json`](../replays/scoreboard.json).

## Add a replay

1. Copy a file in `replays/` and change the fields. The file name must be the `id` plus `.yaml`.
2. Use placeholder tokens and hosts. The test rejects a file that holds a real secret shape.
3. An incident needs at least one source link that opens. Set `reconstructed: true` when the exact call was not published.
4. Put your GitHub handle (no @) in `credit`. The scoreboard shows it in the Credit column and links it to your profile. Leave it empty for no credit.
5. Run `pnpm test -- replays` and `pnpm sync:replays`. Commit the files that change.

To add a whole guard rule (rule, tests and replay file together), run `pnpm new-rule <id>`. See [CONTRIBUTING.md](../CONTRIBUTING.md#add-a-rule).
