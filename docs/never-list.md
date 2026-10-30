# Never-list: shell and file rules (Shield KYA OSS)

Status: **approved** by the owner on 2026-10-29. Changes to the table need owner approval. The 2026-10-29 follow-up adds: `.env` template names by their last suffix, backslash-newline line continuation, the ksh `function NAME { ... }` form, and tool-name verbs that match inside names, except a short list of harmless words. The same text is kept in `sdks/kya/docs/never-list.md` (the public copy); the two files must stay byte-identical. A later follow-up (2026-10-29) narrows the git ref check, adds glob forms of the secret names, denies a download substitution piped into a shell, and adds the ruby and php file reads. No rule id changed.

## What the never-list does

The open source `kya` hooks deny a tool call when it matches the never-list. The hook exits with code 2 and the host shows the deny reason. No config file, environment variable, approval or `--shadow` flag lifts a never-list deny.

Every other call is recorded and allowed. The open source client is advisory and fails open: if kya breaks or times out, the call goes ahead. Enforcement with human approval runs on the hosted service, which fails closed. The package doc `oss-vs-hosted.md` compares the two.

Two kinds of never-list rule exist:

- **Tool-name rules** match the tool name alone, for example `mcp__postgres__drop_table`. A destructive verb inside the name is enough, except inside a harmless word (see below).
- **Input rules** (this page) match the shell command text or the file path of the call.

## Rules

Each row is one rule. The rule id is shown in the deny reason, for example `KYA denied Bash: NEVER_EVENT (rule rm-recursive-home-or-system; never-list rules cannot be overridden)`.

| Group | Rule id | Blocks | Examples allowed |
|---|---|---|---|
| a | `rm-recursive-home-or-system` | Recursive `rm` (`-r`, `-R`, `-rf`, `--recursive`) on `/`, `/*`, `~`, `~/*`, `~/.*`, the home directory, another user's home (`/home/<user>`, `/Users/<user>`) or a top-level system directory (`/bin`, `/boot`, `/etc`, `/home`, `/lib`, `/lib64`, `/Library`, `/opt`, `/private`, `/root`, `/sbin`, `/srv`, `/System`, `/usr`, `/var`, `/Users`). Works with `sudo`, `env`, `bash -c`, quotes, extra flags and `$HOME` or `${HOME}`. | `rm -rf node_modules`, `rm -rf ./build`, `rm -rf /tmp/x`, `rm -rf ~/proj/node_modules` |
| a | `find-delete-home-or-system` | `find` on a protected path (home, root, a top-level system dir) with `-delete` or `-exec rm`. Filters do not help: `find ~ -type f -delete` is blocked. | `find . -name '*.log' -delete`, `find ~/Library/Caches -name x -delete` |
| b | `git-force-push-protected-branch` | `git push` with `--force`, `-f` (also inside bundles such as `-fu`), `--force-with-lease` or a `+` refspec, when the destination is `main`, `master`, or starts with `release` or `prod`. The destination can be `HEAD:main` or `refs/heads/main`. | `git push origin feature`, `git push -fu origin feature`, `git push --force-with-lease origin feature`, `git push origin main` (no force) |
| c | `secret-read-shell` | A read or copy of a secret file in a shell command: `cat`, `head`, `tail`, `less`, `sed`, `awk`, `grep`, `cut`, `sort`, `tar`, `zip`, `base64`, `xxd`, `diff`, `jq`, `md5sum` and similar read verbs, `cp`, `scp`, `rsync` and `install` sources, `dd if=`, `< file`, a git ref read (`git show HEAD:.env`, `git cat-file -p HEAD:.env`), a call that names a secret file in a command that runs an interpreter (`python3 -c "open('.env')"`, `ruby -e "File.read('.env')"`, `php -r "file_get_contents('.env')"`), and `curl`/`wget` upload forms (`-d @file`, `-F f=@file`, `-T file`). Secret files: `~/.ssh/id_*` (not `.pub`), `~/.ssh/*`, `~/.aws/credentials`, gcloud credential files, `~/.npmrc`, `~/.netrc`, `~/.git-credentials`, `.env` and `.env.*`, except a name that ends in `.example`, `.sample` or `.template` (`.env.local.example` is a template; `.env.example.local` is secret, because only the last suffix counts). Globs that could match one of these names count too: `.env*`, `.e[n]v`, `.en?`, `.e?v.local`, `*.pem`, `*.key`, `~/.s?h/id_rsa`, `~/.a?s/credentials`, `~/.n?mrc`, and any glob name under `~/.ssh` or `~/.aws`. | `cat README.md`, `cat .env.example`, `cat .env.local.example`, `cp .env.example .env`, `ls ~/.ssh`, `ssh -i ~/.ssh/id_rsa host`, `curl -o .env URL`, `git commit -m "chore: rotate server.key"`, `grep -e server.key notes.md`, `cat *` |
| c | `secret-read-file` | The file path of a tool that reads (Read, view, read_file, and any tool that is not a write or edit tool) names one of the secret files above. | `Read README.md`, `Write .env` (writes are not blocked by this rule) |
| d | `mkfs` | `mkfs` and `mkfs.*`. | none |
| d | `dd-to-block-device` | `dd ... of=/dev/<disk>` (`sd`, `hd`, `vd`, `xvd`, `nvme`, `mmcblk`, `disk`, `rdisk`, `md`, `dm-`, `loop`, `mapper`). | `dd if=in.img of=out.img`, `dd if=/dev/zero of=/dev/null` |
| d | `redirect-to-block-device` | `> /dev/<disk>` or `>> /dev/<disk>`. | `cmd 2>/dev/null` |
| d | `fork-bomb` | A function that pipes itself into a backgrounded copy of itself, such as `:(){ :\|:& };:`. | `echo :` |
| d | `chmod-chown-recursive-root` | `chmod -R 777` on a protected path, and `chown -R` (any owner) on a protected path. Home counts as protected, so `chown -R me ~` is blocked. | `chmod -R 755 ./dist`, `chown -R $USER ./work`, `chmod 777 file.sh` |
| e | `pipe-network-to-shell` | Output of `curl` or `wget` piped, directly or through more pipes, into `sh`, `bash`, `zsh`, `dash` or `ksh`, also through `sudo`. Also a download run through a substitution or process substitution: `sh -c "$(curl ...)"`, `bash <(curl ...)`, `source <(curl ...)`, `eval "$(curl ...)"`, and `bash -c "curl ... \| sh"`. A download substitution whose output is piped into a shell: `echo $(curl ...) \| sh`, `cat <(curl ...) \| sh`, `` echo `curl ...` \| sh ``. | `curl https://x.com \| jq .`, `curl -o a.sh URL && less a.sh`, `echo $(date)`, `echo $(curl -s x) \| jq .`, `bash -c "echo $(curl x)"` |

## How matching works

- Only the command word counts. `echo rm -rf ~` and `git commit -m "rm -rf ~"` are allowed.
- Tool-name rule: a tool on a known MCP server is denied when its name contains `drop`, `truncate`, `purge` or `transfer`, in any case and with any separator. So `mcp__postgres__drop_table`, `mcp__postgres__DropDatabase`, `mcp__postgres__droptable` and `mcp__postgres__truncate-table` are denied. A verb inside one of these harmless words is not counted: `dropdown`, `dropdowns`, `dropbox`, `dropboxes`, `droplet`, `droplets`, `dropout`, `dropouts`, `dropzone`, `purgeable`, `transferable`, `transference`, `transferor`. So `mcp__postgres__dropdown_select` is allowed. A verb in another word still counts, so `mcp__postgres__dropdown_drop_table` is denied.
- Shell commands are checked for shell tools: `Bash`, `bash`, `run_shell_command`, `run_terminal_command`, and names that contain `bash`, `shell`, `terminal`, `exec` or `command`.
- File paths are checked for tools that are not write or edit tools.
- A field longer than 64 KB is checked at its first and its last 64 KB. Text in the middle of a longer field is not checked.
- Words are unwrapped before matching: `env`, `sudo` (with its options such as `-u root`), `nice`, `time`, `timeout`, `xargs`, `command`, `eval`, `sh -c`, `bash -c`, braces, `if`/`then`. The ksh form `function NAME { ... }` is checked wherever `function` starts a command: after wrappers (`time`, `time -p`, `coproc`, `sudo`, `env` and the others), assignments, `{`, `!` or control words such as `then`. Repeated headers (`function a function b { ... }`) are all read. Each candidate command word goes through every rule, so a pipe into a shell and a heredoc fed to a shell are seen inside a function body. `coproc NAME` is read as a name only before `{` or a compound keyword (`if`, `while`, `until`, `for`, `case`, `select`). Otherwise `coproc` is a wrapper: `coproc sudo -u root rm -rf /` and `coproc git push --force origin main` are read as the command. `function` or `coproc` as an argument (`echo function`, `git log --grep function`) and a path (`/bin/function`) are not checked.
- A backslash at the end of a line joins that line to the next, as in the shell. So `rm -rf \` followed by a newline and `~` is `rm -rf ~`, and it is denied. A backslash-newline inside double quotes joins too. Inside single quotes it is text. Quotes and backslashes are removed, so `r""m` is `rm`, and `$'\x72m'` is decoded to `rm`.
- Quotes group words. A `;`, `|` or `&&` inside quotes is text, so `git commit -m "a; rm -rf ~"` is allowed. Quoted code given to `sh -c`, `bash -c` or `eval` is scanned as code, so `bash -c "rm -rf ~"` is denied.
- A command word with a substitution is read by its basename with the `$(...)` groups removed: `/bin$(:)/rm -rf ~` is `rm`. A download substitution in a command word (`/bin/$(curl ...)`) is denied, and a word that expands to nothing (`$(:) rm -rf ~`) does not hide the next word.
- A `#` that starts a word begins a comment to the end of the line, so `# don't do this` opens no quote and a command in the comment is not run. A quote with no closing quote is a literal character, so the text after it is still checked.
- `$'...'` words are decoded as one word: their quotes and separators are text. Substitutions skip quoted text when they look for their closing `)` or backtick.
- grep-like tools (`grep`, `egrep`, `fgrep`): the first operand is the search pattern, not a file, unless `-e` or `-f` names the patterns.
- Option values are not files: `scp -i KEY`, `rsync -e "ssh -i KEY"` and `openssl ... -out FILE` do not count as reads. The file that is the source of `scp` still counts.
- Read tools: the path fields `file_path`, `path`, `absolute_path` and the `include` and `paths` lists of read tools (`read_many_files`) are checked.
- A `NAME=value` assignment in the same command is substituted into `$NAME` and `${NAME}`, so `d=~; rm -rf $d` matches.
- Paths are resolved before comparison: `~`, `~root`, `$HOME`, repeated slashes, `/./` and `..` are handled.
- Any parse error, unknown shape or missing input allows the call.
- Rules run in table order. The first match gives the deny reason.
- **Git ref reads.** For every git command, each word that is not an option is checked by the part after each colon. So `git show HEAD:.env`, `git show :0:.env`, `git show HEAD@{1}:.env`, `git log -L10,20:.env` and `git whatchanged HEAD:.env` are denied, whatever the subcommand. A text option skips its value: `-m` and `--message` for commit, tag, merge, revert, notes, stash, am and cherry-pick; `--grep`, `--author`, `-S` and `-G` for log, show and similar commands. So a commit message, a tag message or `git log --grep x:.env` is not a read. Attached forms (`--message=x`, `-mx`) are one option word and are skipped. `-c alias.*` (the key is compared without case), `--config-env alias.*` and the environment forms `GIT_CONFIG_KEY_<n>=alias.*` and `GIT_CONFIG_PARAMETERS` are denied, because an alias can run any command. `-F FILE` (every command) is checked as a file. Only the text options of a known subcommand skip their value. If any option before the subcommand is unknown, no word is exempted, so `git --frobnicate commit -m "x: a.key"` is denied. Known global options that take a value (`-C`, `-c`, `--git-dir`, `--work-tree`, `--namespace`, `--super-prefix`, `--config-env`, `--attr-source`, `--shallow-file`) are skipped for the force-push rule too.
- **Glob names.** A glob in a path follows the shell rule for a leading dot: `*`, `?` and `[...]` do not match a name that starts with a dot, unless the glob starts with a literal `.`. So `cat *`, `cat *.env` and `head */*.csv` are allowed, and `cat .*`, `cat .e[n]v` and `cat ~/.s?h/id_rsa` are denied. A glob counts only when it could match a fixed target: `.env` or `.env.local` (any directory), `.npmrc`, `.netrc` or `.git-credentials` (in the home directory), `id_*` (not `.pub`) under `.ssh`, `credentials` under `.aws`. Any glob name under `.ssh` or `.aws` counts.
- **Interpreter reads.** A command that runs python, node, ruby, perl, php, deno, bun or lua is denied when any call in that command names a secret file. The calls are `open(`, `Path(`, `readFileSync(`, `readFile(`, `read_text(`, `read_bytes(`, `File.read(`, `IO.read(`, `file_get_contents(`, `fopen(` and `readfile(`, with the name as the first argument. The scan reads the whole command text, so `python3 x.py; echo "open('.env')"` is denied. `echo "open('.env')"` is allowed, because echo is not an interpreter.
- **Download into a pipe.** A download substitution (`$(curl ...)`, `<(curl ...)`, a backtick) counts as the output of a download. When that segment is followed by a pipe into a shell, the call is denied. The same substitution as an argument of a shell (`bash -c "echo $(curl x)"`) is allowed.

## Limits: what an agent can still do

- **HEAD-based force push.** `git push --force` with no branch name is allowed. kya does not read the current branch. Git aliases are not resolved.
- **Seatbelt, not a sandbox.** The matcher reads words and separators. It does not parse shell fully, so a determined agent can still find a way around these rules. Treat the list as a guard for common mistakes.
- **Built at run time.** `$(echo rm) -rf ~`, brace expansion, text read from a file or the network and then run, and code that builds a path from pieces (`open(".e" + "nv")`) are not seen.
- **Middle of a long field.** Text between the first and last 64 KB of a field longer than 64 KB is not checked.
- **Commands that run another command.** Only the wrappers listed above are unwrapped. `watch rm -rf ~`, `ssh host "rm -rf ~"`, `npx`, `make`, `kubectl exec` and `docker run` are not read as running their argument. A download inside them is not checked either.
- **Compound names.** A verb inside a name counts unless it is a listed harmless word, so `postgres__drop_down_list` is denied. Adding a harmless word needs owner approval.
- **Sourced files.** `source script.sh` and `./script.sh` run code that is not read. Only the command text is checked.
- **Other tools.** Hosts other than the ones listed in the package docs get no hook. Cursor has no hook in this package.
- **Stdin targets.** `ls ~ | xargs rm -rf` is not seen: the targets come from stdin.
- **Substitutions as data.** A download inside `$(...)` used as a plain argument is allowed (`docker build --build-arg V=$(curl ...)`, `cp $(curl ...) .`). Only a download run as code (`sh -c`, `bash <(...)`, `source`, `eval`), or a download whose output is piped into a shell (`echo $(curl ...) | sh`), is denied.
- **Key reads by other tools.** `ssh-keygen -y` reads a private key to print the public part. It is not in the list.
- **Run-time commands.** Commands assembled at run time (`$(echo rm)`, base64 decoding, text read from a file or the network and then run, `eval` of text built from pieces) and scripts that the agent writes and then runs are not seen.
- **Other readers.** `git add` of a secret file and `source .env` are not in the read list.
- **False positives you will see.** A heredoc fed to a shell or interpreter (or piped into one) is code, so a line in it that starts with a listed command is blocked. A heredoc fed to `cat` is text. `find ~ -name x -delete` is blocked whatever the filters. A command that runs an interpreter and names a secret file in a read call (`open('.env')`, `readFileSync('.env')`) is blocked, even when the call is in a later part of the command. Text that only names the file, such as `echo "open('.env')"`, is not. `cat .*` and `cat ~/.*rc` are blocked, because the glob can match `.env` or `.npmrc`. `cat ./.npmrc` in a project is allowed, because a home credential is matched only in the home directory. A git word with a colon whose part after the colon ends in a secret name is denied, for example `git clone https://host/x.key` and a `git -c alias.*` setting of any kind.
- **Compound names with a verb.** A verb inside a name counts unless it is in a listed harmless word. So `postgres__drop_down_list` is denied, and `droppable` is denied. Adding a harmless word needs owner approval.
- **Name matches.** `prod*` also matches `production-hotfix`. `*.pem` and `*.key` match by file name, so a public certificate is blocked too.
- **Hosts without a shell hook.** Cursor has no hook in this package (MCP only). The Python SDK does not have the input rules yet.
- **Host key names.** The hook reads the tool input from `tool_input` or `toolInput`. A host that sends the input under another key is not checked.
- **Hosted mode.** The local input rules run before the hosted plane answers, and `--plane-shadow` does not lift them. Other calls follow the hosted policy.

### Known limits (advisory in OSS; the hosted gate enforces)

A static parser cannot resolve shell expansion. The open source check is advisory by design: it blocks the common shapes above and records everything else. The hosted gate is the enforcing layer and fails closed. These shapes are not caught by the OSS rules, and each one is pinned by a test that asserts the current result (allowed), so a change is deliberate:

- **Expansion inside a word.** `r${x}m -rf ~` and `g${x}it push --force origin main` are not evaluated when the variable is not set in the same command.
- **Variable indirection across calls.** `$X -rf ~` is not resolved when `X` was set in an earlier call. A word that starts with `$` keeps the scan going, so the words after it are still checked.
- **eval of generated text.** `eval "$(printf 'rm -rf ~')"`: the text the substitution produces is not analysed.
- **Encoded payloads.** `echo <base64> | base64 -d | sh`: the decoded text is not read.
- **Scripts that run files.** `bash ./clean.sh` and `source x.sh`: the file contents are not read.
- **Aliases.** A command defined with `alias` is not resolved.
- **Glob suffixes of key names.** Only the literal `*.pem` and `*.key` are caught. `cat *.pe?` and `cat *.[pk]ey` are allowed.
- **Globs a shell does not expand.** `cat [.]env` is allowed. A shell does not expand it, so no file is read, but a tool that globs by itself is not checked.
- **Glob names outside the fixed targets.** A gcloud credential path written as a glob (`~/.config/gc*/application_default_credentials.json`) is allowed. The literal path is denied.
- **Ruby and PHP forms without parentheses, or with the name second.** `ruby -e "File.read '.env'"` and `perl -e "open(my $f, '<', '.env')"` are allowed.
- **A download in one call, a pipe in the next.** `x=$(curl ...)` in one call and `echo "$x" | sh` in a later call are allowed. Within one command, the same text is denied.
- **Git config can run commands.** `core.pager`, `core.sshcommand`, `core.fsmonitor`, `diff.external`, `*.textconv`, `credential.helper` and an `alias.*` with `!` can run any command. The static check does not read config files, so a command that sets them in a config file is not seen. `git config alias.s '!cat .env'` is allowed.
- **Git reads without a colon.** `git add .env`, `git log -p -- .env` and `git hash-object .env` read a secret file, but no `REF:PATH` word is seen, so they are allowed. `git show` of a whole tree or blob with a path, such as `git show HEAD -- .env`, is allowed for the same reason.

Advisory everywhere else: every call that does not match this table is recorded and allowed by the open source client.
