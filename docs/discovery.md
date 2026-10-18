# Endpoint discovery

`kya discover` scans the local workstation for AI tooling and produces a snapshot that can be viewed locally or pushed to the hosted Shield console.

## What is scanned

The scanner runs five independent checks and merges the results:

1. **CLI binaries on PATH**
   - Parses `PATH` into directories.
   - Looks for known executable names from the discovery catalog (e.g. `claude`, `codex`, `ollama`, `aider`).
   - On Unix it checks `fs.statSync` mode bits and `fs.constants.X_OK`.
   - On Windows it accepts files with a `.exe` extension.
   - **Never runs the binary**. It only checks that the file exists and is executable.

2. **IDE extensions**
   - VS Code-family global storage directories:
     - macOS: `~/Library/Application Support/{Cursor,Code}/User/globalStorage`
     - Linux: `~/.config/{Cursor,Code}/User/globalStorage`
     - Windows: `%APPDATA%/{Cursor,Code}/User/globalStorage`
   - Looks for extension ids containing known vendor markers (`anthropic`, `claude`, `cursor`, `codex`, `gemini`, `github-copilot`, etc.).
   - Confidence is `medium` or `low` because extension ids are free-form.

3. **Desktop apps**
   - macOS: `/Applications` bundle names.
   - Linux: `/usr/share/applications` and `/usr/local/share/applications` `.desktop` names.
   - Windows: `%ProgramFiles%` and `%ProgramFiles(x86)%` directory names.
   - Matches against known app names from the catalog.

4. **Model runtimes**
   - Looks for `ollama`, `lmstudio`, `llama-server` binaries on PATH.
   - Notes default localhost ports (`ollama` 11434, `lmstudio` 1234) in the evidence.
   - **Does not connect to the ports**. The port is only metadata.

5. **MCP servers**
   - Reads `.mcp.json`, `mcp.json`, and `.cursor/mcp.json` in the current working directory and in the home directory.
   - Lists each configured server name and command.
   - All MCP server findings are reported with category `mcp-server`.

## Snapshot format

Each run writes a JSON snapshot matching the hosted `POST /api/v1/kya/endpoints` contract:

```json
{
  "endpointUid": "sha256 of '<os>:<hostnameHash>:<userHash>'",
  "hostnameHash": "sha256(hostname)",
  "os": "darwin | linux | win32 | unknown",
  "capturedAt": "2026-10-12T...Z",
  "inventory": [
    {
      "id": "claude",
      "name": "Claude Code",
      "vendor": "Anthropic",
      "category": "cli-agent",
      "source": "PATH:/usr/local/bin/claude",
      "confidence": "high",
      "evidence": { "path": "/usr/local/bin/claude" }
    }
  ],
  "coverage": {
    "attempted": ["cli-binaries", "ide-extensions", "desktop-apps", "model-runtimes", "mcp-servers"],
    "unavailable": [],
    "truncated": false
  }
}
```

## Privacy and redaction

- Home-directory prefixes are replaced with `~` in every `evidence.path` and `evidence.configPath`.
- `endpointUid` is a SHA-256 of a stable id that includes the OS, hostname hash, and user hash. The raw hostname and username never leave the machine.
- The scanner never executes binaries, never reads file contents outside config files, and never connects to network ports.

## Local report card

The live activity report and static receipt HTML render a **Discovery** card when `~/.kya/discovery/latest.json` exists:

- Total discovered items.
- Sanctioned (approved) vs review counts, based on the local catalog defaults.
- Top categories as chips.
- A one-line CLI hint to re-run or push.

## Pushing to the hosted console

To sync the local inventory to the hosted console, set `KYA_BASE_URL` and `KYA_API_KEY` and run:

```bash
export KYA_BASE_URL=https://shield-agent.com
export KYA_API_KEY=your-token
kya discover --push
```

The CLI prints the HTTP status. A 202 response means the hosted console accepted the payload. If credentials are missing, `kya discover --push` exits 2 and prints setup instructions.

You can also push an existing snapshot file:

```bash
kya discover --push --json --file ~/.kya/discovery/latest.json
```

## Hosted console

After a successful push, the endpoint appears in the hosted Shield console under the endpoint inventory view:

https://shield-agent.com/install

From the console you can review findings, change sanctions, and set policies per endpoint.
