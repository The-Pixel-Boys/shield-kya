/**
 * The replay seed, pinned by id (spec G3, G4). Counts alone can hide a deleted replay: one added class and one deleted class
 * leave the count unchanged. A replay file in this list may only be removed by editing this file in the same pull request.
 */
export const SEED_CLASSES: readonly string[] = [
  "class-aws-rds-delete-instance", "class-aws-s3-remove-bucket", "class-docker-volume-prune", "class-fly-volumes-destroy",
  "class-gcloud-sql-delete-instance", "class-gh-repo-delete", "class-git-force-push-main", "class-git-hard-reset-clean",
  "class-kubectl-delete-namespace", "class-mongo-drop-database", "class-prisma-accept-data-loss", "class-prisma-migrate-reset",
  "class-railway-api-volume-delete", "class-railway-cli-volume-delete", "class-redis-flush-remote", "class-rm-git-dir",
  "class-rm-project-wipe", "class-sql-delete-all", "class-sql-truncate-cascade", "class-supabase-reset-linked",
  "class-terraform-destroy", "class-vercel-remove-project",
];

/** The 11 rules that shipped in 0.35.0 (G2), by rule id. */
export const SINCE_0_35_RULES: readonly string[] = [
  "fly-destroy", "gh-repo-delete", "mongo-drop-database", "prisma-accept-data-loss", "prisma-migrate-reset", "redis-flush",
  "rm-git-dir", "rm-project-wipe", "sql-delete-all", "supabase-reset-linked", "vercel-remove",
];

/**
 * The secret-read, secret-write and exfil rule ids: the never-list pair plus the guard pack kinds and network sinks.
 * The guard pack builds these ids at run time (`secret-read-${kind}`), so they are listed here. Each needs a class replay.
 */
export const SECRET_EXFIL_RULES: readonly string[] = [
  "secret-read-shell", "secret-read-file",
  "secret-read-railway", "secret-read-docker", "secret-read-kube", "secret-read-pypirc", "secret-read-gh", "secret-read-azure",
  "secret-read-gcloud", "secret-read-key", "secret-read-environ",
  "secret-write-aws", "secret-write-privkey", "secret-write-github", "secret-write-github-pat", "secret-write-slack", "secret-write-stripe",
  "exfil-curl", "exfil-wget", "exfil-nc", "exfil-ncat", "exfil-socat", "exfil-scp", "exfil-rsync",
];
