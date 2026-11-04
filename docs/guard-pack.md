# Guard pack: default local denies (Shield KYA OSS)

Status: ships in 0.33.1. The guard pack is a separate, default-on layer that runs after the never-list in [never-list](never-list.md). The never-list is unchanged: its rules and rule ids stay, no setting lifts it, and it still runs first. The guard pack adds more destructive shell commands, more credential files, secret-shaped writes and secret exfiltration, and it has the config switches below.

The deny is local, offline and sub-second. Every other call is recorded, not blocked. Local hooks fail open: if kya breaks or times out, the call goes ahead. The hosted hook (`--plane-config`, preview) runs the same guard pack too, with the same rules and reason codes, and keeps its own fail-closed stance; see [Hosted mode](#hosted-mode) below.

## What it blocks by default

A deny exits with code `2` and prints one line on stderr, for example:

```text
KYA denied Bash: NEVER_SHELL (terraform-destroy). Run terraform plan -destroy and ask the user to run the destroy themselves. Ask the user; see docs/guard-pack.md.
```

The line carries the reason code, the rule id and what to do instead. It never carries the command, a path or the matched text. It does not say where the allowlist lives, because the agent reads this text and can write files.

### Shell commands (`NEVER_SHELL`)

Checked on shell tools (`Bash` and the equivalents). Compound commands are split and every part is checked: `&&`, `||`, `;`, pipes, newlines, `$(...)`, backticks, and the code given to `bash -c`, `sh -c`, `zsh -c` and `eval`. `sudo`, `env VAR=x`, `command`, `nohup` and `time` are skipped to find the real command.

| Rule id | What it denies |
|---|---|
| `rm-root-home` | `rm` with recursive and force flags (`-rf`, `-fr`, `-r -f`, `-Rf`, `--recursive --force`) on `/`, `/*`, your home directory, any parent of it, or any parent of the project folder. Relative paths are resolved against the working directory, so `rm -rf ../../*` from `~/work/app` is caught. A recursive `rm` of a parent folder of the project, with a relative path, is denied first by the never-list rule `rm-recursive-home-or-system`, even without `-f`. `guardAllow` cannot allow that case. A variable that is unset or empty in the hook's environment counts too: `rm -rf "$X/"` runs `rm -rf /`. |
| `terraform-destroy` | `terraform destroy` with any flags, `terraform apply -destroy`, `tofu destroy`. |
| `sql-drop` | `DROP TABLE`, `DROP DATABASE`, `DROP SCHEMA` and `TRUNCATE` (any case) inside a `psql`, `mysql`, `mariadb`, `sqlite3`, `mongosh` or `clickhouse-client` command, including `-c`, `-e` and a heredoc. Files are not read. |
| `git-force-push` | `git push` with `--force`, `-f` (also inside `-fu`) or a `+refspec`, to any branch. Not `--force-with-lease` and not `--force-if-includes`, except on `main`, `master`, `release*` and `prod*`, where the never-list (`git-force-push-protected-branch`) denies those too. |
| `git-delete-default-branch` | `git push <remote> --delete main` or `master`, `git push <remote> :main`, `git branch -D main` or `master`. |
| `git-hard-reset-clean` | `git reset --hard` together with `git clean -fdx` (or `-ffdx`) in the same command. |
| `docker-volumes` | `docker volume rm`, `docker volume prune`, `docker system prune` with `--volumes` or `-a`, `docker compose down -v` or `--volumes`, `docker-compose down -v`. |
| `k8s-delete-ns` | `kubectl delete namespace` (or `ns`), and `kubectl delete --all` with `-A` or `--all-namespaces`. |
| `cloud-delete` | `aws ec2 terminate-instances`, `aws s3 rb ... --force`, `aws s3 rm ... --recursive`, `aws rds delete-db-instance` and `delete-db-cluster`, `gcloud projects delete`, `gcloud sql instances delete`, `az group delete`. |
| `railway-volume-delete` | `railway volume delete`, and the text `volumeDelete` in a `curl`, `wget`, `http` or `xh` call. |

### Credential reads (`NEVER_SECRET_READ`)

The never-list already denies reads of `~/.ssh/id_*`, `~/.aws/credentials`, gcloud credential files, `~/.npmrc`, `~/.netrc`, `~/.git-credentials`, `.env` and `.env.*` (not `.env.example`, `.env.sample`, `.env.template`), `*.pem` and `*.key` (rule ids `secret-read-file` and `secret-read-shell`). The guard pack adds these. It applies to the Read tool and to shell reads (`cat`, `less`, `more`, `head`, `tail`, `cp`, `scp`, `rsync`, `base64`, `xxd`, `strings` and similar, and `< file`).

| Rule id | File |
|---|---|
| `secret-read-railway` | `~/.railway/config.json` |
| `secret-read-docker` | `~/.docker/config.json` |
| `secret-read-kube` | `~/.kube/config` |
| `secret-read-pypirc` | `~/.pypirc` |
| `secret-read-gh` | `~/.config/gh/hosts.yml` |
| `secret-read-azure` | anything under `~/.azure/` |
| `secret-read-gcloud` | anything under `~/.config/gcloud/` |
| `secret-read-key` | `id_rsa*`, `id_ed25519*`, `id_ecdsa*`, `id_dsa*` in any folder (not `.pub`) |
| `secret-read-environ` | `/proc/<pid>/environ` |

Public parts stay readable: `~/.ssh/*.pub`, `~/.ssh/known_hosts`, `.env.example`.

### Secret-shaped writes (`NEVER_SECRET_WRITE`)

Checked on the text a Write, Edit or MultiEdit tool puts into a file (the text an edit removes is not checked), and on `echo`, `printf`, `cat` or `tee` that redirects into a file. The rule id names the kind and never the matched text. The trail row for a denied write has no summary and no preview.

| Rule id | Pattern |
|---|---|
| `secret-write-aws` | AWS access key id: `AKIA` or `ASIA` plus 16 upper case letters or digits |
| `secret-write-privkey` | a PEM private key header (`RSA`, `OPENSSH`, `EC`, `DSA` or plain) |
| `secret-write-github` | `ghp_` plus 36 letters or digits |
| `secret-write-github-pat` | `github_pat_` plus 60 or more characters |
| `secret-write-slack` | `xoxa-`, `xoxb-`, `xoxp-`, `xoxr-` plus 10 or more characters |
| `secret-write-stripe` | `sk_live_` plus 20 or more characters |

The string `AKIA` alone, a short `ghp_` prefix and `.env.example` placeholders are fine. Documentation that quotes the AWS example key id will be denied; use `guardAllow` with a `path` for those files.

### Exfiltration (`NEVER_EXFIL`)

A Bash command where `env`, `printenv`, a bare `set`, or a credential file (the lists above and in the never-list) is piped, redirected or passed (`-d @file`, `--data-binary @file`, `-T file`, `-F file=@`) into `curl`, `wget`, `nc`, `ncat`, `socat`, `scp` or `rsync`, to a host that is not loopback. Rule id `exfil-<tool>`, for example `exfil-nc`. Sending to `localhost`, `127.0.0.1` or `::1` is allowed.

## Configuration

Keys in `~/.kya/config.json`, the user-level file in your home directory:

| Key | Default | Effect |
|---|---|---|
| `shellNeverList` | `true` | `false` turns off the shell rules above. |
| `secretsGuard` | `true` | `false` turns off credential reads and secret-shaped writes. |
| `exfilGuard` | `true` | `false` turns off the exfiltration rules. |
| `guardAllow` | `[]` | Entries that skip one rule for one exact case. |

`guardAllow` entries have one of two shapes:

```json
{
  "guardAllow": [
    { "rule": "terraform-destroy", "command": "terraform destroy -target=aws_instance.scratch" },
    { "rule": "secret-write-aws", "path": "~/work/app/docs/fixtures/**" },
    { "rule": "secret-read-railway", "path": "~/.railway/config.json" }
  ]
}
```

- `command` is matched against the whole command, exactly. Another command is still denied.
- `path` is a glob (`*` within a folder, `**` across folders, `?`, `~` for your home). It is matched against the file the rule fired on: the file a tool reads or writes, or the file a shell rule names.
- An entry skips only the rule it names. Other rules still apply to the same call.
- An entry cannot skip a rule of the never-list ([never-list](never-list.md)). No setting does.

**Only the user-level file is read.** A project `.kya/config.json` ships with the repository and an agent can write it, so it can never lift a deny. `KYA_HOME` does not move the file either. The hook error fallback ignores the file entirely and uses the defaults.

A malformed file never breaks the hook: every key you got wrong keeps its default, the rest of the file still applies, and the trail gets one line (`GUARD_CONFIG_INVALID`, at most once an hour) saying the file was ignored.

An agent cannot change this file through its tools: a write to `~/.kya/config.json` or its folder is denied as `guard-config-write`, and neither the switches nor `guardAllow` can turn that rule off. Edit the file yourself, in your own editor.

When a call is denied, the agent is told to ask you. Allowing an exact case is your decision, made in your own file.

## Hosted mode

The fail-closed hosted hook (`kya hook --plane-config <file>`, preview; see [hosted-hook](hosted-hook.md)) evaluates the guard pack locally, before it calls the plane. The rules, rule ids, reason codes, deny text and `guardAllow` semantics are the same as above. What differs:

- **Order.** Never-list, then guard pack, then the plane. A guard deny wins over a plane ALLOW and over a plane failure (unreachable, timeout, bad config): the deny names the guard code and rule, not the plane failure. The plane is still told, so the hosted trail sees the attempt.
- **Shadow.** `--plane-shadow` still blocks a guard hit, like the never-list. Shadow only stops blocking the plane's own denies.
- **Config.** The same user-level `<HOME>/.kya/config.json`, read from the `HOME` the hook runs with. A project `.kya/config.json` and `KYA_HOME` are ignored, as everywhere in hosted mode. Lifting a local rule never lowers the plane's verdict; the plane decides every call the guard lets through.
- **Failure stance.** Hosted fails closed. If the hook crashes after a guard hit, it still exits `2`, in shadow mode too, and names the guard code and rule. An internal error inside a guard rule counts as no match; the plane then decides the call, and a plane failure still denies.
- **Secret-shaped writes.** A denied `NEVER_SECRET_WRITE` call sends no summary, preview or target path to the plane and writes none to the local trail. Only the argument hash goes out, as for every call.

## Where it runs

KYA supports 23 coding tools. Six have native hooks and get the guard on their own shell and file tools: Claude Code, Codex, Grok, Kimi Code, Gemini CLI and Copilot CLI. The other tools connect through the MCP gate or the command wrapper (`kya wrap`). Those paths evaluate the same rules, but only for calls that reach KYA; a tool that runs its own built-in shell without going through KYA is not seen. Cursor, for example, has no hook in this package, so its built-in shell is not guarded.

## What it does not block

- Moves and renames (`mv ./* ../new_folder`), edits, and deletes inside the project folder. They are recorded in the trail.
- Anything an agent does outside the hook's view: a script it writes and then runs, commands built at run time (`$(echo rm) -rf ~`, base64 decoded text), `ssh host "rm -rf ~"`, `make`, `npx`, `kubectl exec`.
- Credential reads through a symlink: the path is checked as written, not after resolving symlinks.
- A SQL file given as `psql -f drop.sql`. Only the command text is read.
- Other destructive tools and flags that are not in the tables (`terragrunt`, `git push --mirror`, `aws s3api delete-bucket`, `docker rm`).
- Edits to `~/.kya/config.json` by means the rules do not see (a script the agent writes and runs, for example). Direct writes by a file tool or a shell redirect, `tee`, `cp`, `mv`, `rm` or `sed -i` are always denied (`guard-config-write`, no switch, no `guardAllow`), but it is the same seatbelt as everything else here. Known gaps: redirect forms the scanner does not split (`>|`, `&>`), a `cd ~/.kya` followed by a relative path, a symlink to the folder, and case-insensitive file systems (`~/.KYA`). If you need the guard settings out of an agent's reach, make the file read-only for the agent's user or keep it root-owned.

## False positives you will see

- `git push -f origin feature` is denied, because a forced push to any branch can destroy a teammate's commits. Use `--force-with-lease`, which is allowed.
- `rm -rf "$X"` where `$X` is empty or unset in the hook's environment. The shell would run `rm -rf ""`, or `rm -rf /` for `"$X/"`. If you set the variable in the same command (`X=/tmp/w; rm -rf "$X/"`) it is substituted and allowed.
- Writing the AWS documentation example key id (`AKIA...EXAMPLE`) into a doc or test fixture. Use `guardAllow` with a `path`.
- `psql -c "SELECT 'drop table'"`: the SQL words are matched as text inside a database client command.
- `docker compose down -v` in a throwaway development stack. Run it yourself, or allow the exact command.

The guard is a seatbelt, not a sandbox. It reads words and separators, it does not run a full shell parser, and a determined agent can get around it. The audit trail records what happened either way. For enforcement with human approval, use the hosted workspace.
