# Activity record

The longer path, the global activity record, outcomes, the map, sharing and plain-language search. Moved out of the package README. Back to the [README](../README.md).

## Longer path (optional)

```bash
# Offline sample evaluate
kya eval-tool --offline --tool-id org.sample.never.event --irreversible
kya wrap --offline --tool-id Write --irreversible --args '{"path":"src/x.ts","content":"hi"}'
kya receipt --open
# Org Hold: KYA_HOLD=1 kya wrap …
kya dash --once --offline
```



Install hub: [https://shield-agent.com/install](https://shield-agent.com/install)

## Activity record (global)

One record (trail) for all projects: `~/.kya/trail.jsonl` (`KYA_HOME` overrides `~`). `kya receipt --open` from any directory shows activity from every project. Each event carries its project folder name. The report adds a Projects rollup once two or more projects appear, and shows the project on each feed entry. Older per-project `<project>/.kya/trail.jsonl` files are still read and merged; no migration. Reports read only the last 1 MB of the record (oldest events drop out of the view); it is shared across all projects. When `trail.jsonl` reaches 8 MB, KYA renames it to `trail.1.jsonl` and starts a new file; the next rotation replaces that archive. So the record uses about 16 MB on disk at most, and older events are deleted. Imports still check both files for rows they already added.

The report itself is a dashboard. A hero row on top shows the live **Certify** result, the decision mix, an activity sparkline, and showback (cost per agent). Tabbed sections sit below: **Overview** (analytics, sessions, reasons), **Certify** (the full live requirement table: every requirement grouped by domain with status, evidence, and attestation), **Activity** (the filterable event feed), **System** (wired hosts, sandboxes, ORR). Everything is one standalone offline HTML page. The live view adds a single external link: "Star on GitHub". The live daemon from `kya start` re-renders it on every event.

### Outcome of each call

Each record row has two separate facts. `verdict` is the policy opinion (`ALLOW`, `DENY` or `REQUIRE_APPROVE`). `outcome` is what the hook did with the call:

| `outcome` | Meaning |
| --- | --- |
| `ran` | The hook exited 0 and let the call go on, whatever the verdict. The host can still decline the call itself. |
| `blocked` | The hook denied the call (exit 2): a `DENY` verdict, or a fail-closed deny. |
| `held` | The hook stopped the call for approval: `--strict` on a `REQUIRE_APPROVE` verdict, or an approval hold from the hosted plane (`--plane-config`), or a guard ask rule on Claude Code (`GUARD_ASK`: the person answers the permission prompt). |
| `error` | The hook failed or ran with a degraded setup and let the call go on: an internal error on the fail-open path (reason `HOOK_ERROR`), a hosted `--plane-shadow` failure, or an invalid guard config note. |

The report counts and labels by outcome. The headline reads `Ran 11, Blocked 5, Held 0`. A call that ran with a `REQUIRE_APPROVE` verdict shows as **Ran** with the note "would hold in strict mode", and one line under the headline says how to turn strict mode on (add `--strict` to the `kya hook` command). Blocked rows sort above all other rows. Identical consecutive rows collapse into one row ("shell echo, 10 times"). `kya receipt --share` and `kya certify` count by outcome too, so a shared summary never counts a call that ran as a review.

Rows written before this field existed have no `outcome`. They keep their old labels and verdict counts (shown as "Earlier" next to the new counts when both exist), and old records still open.

### Map of agent actions

`kya map` draws a graph of what KYA recorded: the device, the agent sessions, the tools and the target classes. Edges are coloured by verdict. Two heat views show when and where the activity happened. The page is local and offline. It shows what was recorded, not what was enforced. The live report has a Map tab. See [docs/map.md](map.md).

`kya export --format agent-flow` writes the same trail as a JSONL event log for the agent-flow viewer (`--out FILE` writes a new 0600 file; `--force` replaces one). Each line holds the hashed session, the tool, the verdict, the reason code, the target class, the device id and the mode. It holds no arguments, paths or command text. See [docs/map.md](map.md#export).

### Sharing a report

`kya receipt --share` publishes a **redacted summary** of the current window (aggregate decision counts, product and reason-code rollups, and the Certify status; no paths, no tool arguments, no session IDs) to shield-agent.com and prints a public URL (`/r/<id>`) with its expiry date (7 days) that anyone can open, plus a hint to open the link and claim the report and to run `kya login` to connect this computer, and one line suggesting you send the public link to your security lead. The live report has a **Share this report** button that does the same. Every shared page carries the one-line install so readers can audit their own agents, a button to start a hosted workspace for the team, and a form to claim the report: confirm an email address to keep it and get one summary email each week. A report that nobody claims is deleted after 7 days (see [login.md](login.md#claim-a-shared-report)). The Certify status on the page is labelled as self-reported by the CLI, not verified by Shield Agent. With `--json` the command prints only `{"url", "expiresAt"}`. Point it at a different collector with `--share-url <base>` or `KYA_SHARE_URL`.

Sharing is a single attempt by design (storm-proof: no silent retries against the collector). `--share-retries <n>` (max 3) opts into bounded retries on 429/5xx/network failures with exponential backoff plus jitter, and respects the server's `Retry-After`.

### Natural-language search

`kya start` asks once, in a terminal, whether to turn this on (about 400 MB of disk, nothing leaves the machine). Answer yes and it installs the runtime for you before the report opens. A "no" is remembered. Without a terminal it asks nothing: set `KYA_SEMANTIC=on` to install without a question (scripts, images; off a terminal `kya start` also needs `--yes`) or `KYA_SEMANTIC=off` to never ask. The manual command is below.

The **Activity** search box understands plain English. It runs a hybrid of BM25 over tool IDs, summaries, reason codes, decisions, projects, and MCP server labels, plus local MiniLM semantic reranking, which is opt-in. The runtime is not part of the default install. Without it, search stays lexical (BM25) and the live report server writes one line to its log (for `kya start`, the background report daemon log) that names the install command. Install it once:

```bash
# macOS and Linux (bash or zsh)
npm install --prefix "$HOME/.kya/semantic" @shield-agent/fastembed@3.0.0
```

```bat
:: Windows cmd
npm install --prefix "%USERPROFILE%\.kya\semantic" @shield-agent/fastembed@3.0.0
```

```powershell
# Windows PowerShell
npm install --prefix "$env:USERPROFILE\.kya\semantic" @shield-agent/fastembed@3.0.0
```

If `KYA_HOME` is set, the prefix is `$KYA_HOME/.kya/semantic` (`%KYA_HOME%\.kya\semantic` on Windows). A built-in concept glossary maps everyday words to the vocabulary events actually use, so `dangerous` finds rm/kill/delete/sudo calls, `blocked` finds denials, and `held` finds approval requests. You can also type things like `failed stripe transfers`, `files written by grok`, or `approval required production`. Stopwords and stemming are handled automatically, and the same search works across the global record.

- Offline or `KYA_OFFLINE=1` keeps search purely lexical (no model download).
- After you opt in, the live server downloads `BAAI/bge-small-en-v1.5` once into `~/.kya/models` and caches event vectors in `~/.kya/search-index.bin` (1.5 KB for each event). New vectors are added to the end of the file. The file keeps at most 20,000 events (`KYA_SEARCH_INDEX_MAX`); it drops the oldest first and keeps the events of the current report window.
- An older `~/.kya/search-index.json` is converted once. KYA then renames it to `search-index.json.migrated` and does not read it again. KYA does not delete it. You can delete it yourself.
- `KYA_SEARCH_SEMANTIC=off` disables the model while still keeping BM25.

The hosted console uses the same hybrid search on the server side (Postgres full-text + optional OpenAI-compatible embeddings), so queries typed in either place behave the same way.
