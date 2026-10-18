# Install Shield KYA in Cline

These steps are for Cline (or any AI agent) setting up the Shield KYA MCP server for a user. A person can follow them too.

What you get: a local stdio MCP server named `shield-kya` with three tools, `kya.policy_evaluate`, `kya.session_ingest` and `kya.request_approval`. It runs offline: no account, no API key, no network calls by default. It is advisory. It records each call made through these tools on a local trail (`~/.kya/trail.jsonl`) and blocks only a small never-list of destructive tool ids. It sees only the calls Cline sends through these MCP tools, not Cline's built-in file edits or terminal commands.

## Requirements

- Node.js 22 or later. Check with `node --version`.
- npm (comes with Node.js).

## Steps

1. Install the CLI globally:

   ```bash
   npm install -g @shield-agent/kya@latest
   ```

   Check it: `npm ls -g @shield-agent/kya` prints `@shield-agent/kya@<version>`.

2. Get two absolute paths. VS Code started from the dock or start menu often does not see the shell `PATH` (nvm, fnm, Volta), so the config uses absolute paths instead of `kya` or `node`:

   ```bash
   node -p "process.execPath"
   npm root -g
   ```

   - `NODE_PATH` = the first output, for example `/usr/local/bin/node`.
   - `KYA_CLI_PATH` = the second output followed by `/@shield-agent/kya/dist/cli.js`, for example `/usr/local/lib/node_modules/@shield-agent/kya/dist/cli.js`.
   - Check that `KYA_CLI_PATH` exists before going on. On Windows, write each `\` as `\\` inside JSON.

3. Open Cline's MCP settings file: in Cline, click the MCP Servers icon, then Configure MCP Servers. This opens `cline_mcp_settings.json`. Add this entry under `mcpServers` with the two paths filled in, and keep every other server that is already there:

   ```json
   {
     "mcpServers": {
       "shield-kya": {
         "command": "NODE_PATH",
         "args": ["KYA_CLI_PATH", "serve-mcp", "--stdio"],
         "env": {
           "KYA_OFFLINE": "1",
           "KYA_HOST": "ide",
           "KYA_SESSION_ID": "mcp:cline"
         },
         "disabled": false,
         "autoApprove": []
       }
     }
   }
   ```

   Leave `autoApprove` empty. Auto-approving these tools skips the human check KYA is there for.

4. Save the file. Cline connects new servers on save; no VS Code restart.

## Verify

1. In Cline's MCP Servers panel, `shield-kya` shows as connected with the three tools listed above.
2. Ask Cline to call `kya.policy_evaluate` with `{"toolId": "org.sample.data.write", "args": {"k": "v"}}`. It returns a verdict (offline sample policy).
3. In a terminal, `kya receipt --open` opens the local activity report with that call on it. Without a browser, the last line of `~/.kya/trail.jsonl` shows the same row (`"toolId":"org.sample.data.write"`).

## Optional: hosted control plane

Only with a Shield Agent account. Replace the `env` block with `"KYA_BASE_URL": "https://shield-agent.com"`, `"KYA_API_KEY": "<your key>"` and `"KYA_HOST": "ide"`. Cline does not expand `${VAR}` in this file, so the key must be the literal value, and the file then holds a secret. Keep the offline block if you are not sure.

## Troubleshooting

- `spawn ... ENOENT`: `NODE_PATH` is wrong. Run step 2 again and paste the exact output.
- `Cannot find module ... cli.js`: `KYA_CLI_PATH` is wrong, or the global install went to another Node version. Run step 2 again with the same Node that ran step 1.
- Node older than 22: install Node 22 or later, then repeat from step 1.
- Server shows red with no error: use the restart button next to `shield-kya` in the MCP Servers panel.

## Uninstall

Remove the `shield-kya` entry from `cline_mcp_settings.json` and save, then `npm uninstall -g @shield-agent/kya`. The local trail in `~/.kya/` stays until you delete it.

More detail: [docs/hosts/cline.md](docs/hosts/cline.md).
