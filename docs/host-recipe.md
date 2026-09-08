# Host recipe (add a coding host)

KYA OSS should be a **medusa of integrations**, not an island. Each host recipe teaches one editor/CLI how to call `serve-mcp` (or hosted `/mcp`) so tool calls hit evaluate/wrap.

## Checklist

1. **Folder** under the package root, e.g. `opencode/`, `warp/`.
2. **Config example** the user can copy (stdio and/or hosted HTTP).
3. **Env vars** documented: `KYA_HOST`, `KYA_OFFLINE`, `KYA_BASE_URL`, `KYA_API_KEY` as needed.
4. **Smoke**: after wire, `kya wrap --offline --tool-id Write --irreversible --args '{"path":"x.ts","content":"hi"}'` leaves a trail row.
5. **README blurb** (10 lines max) with restart instructions for that host.
6. **PR** using `.github/PULL_REQUEST_TEMPLATE/host-recipe.md`.

## Stdio template

```json
{
  "mcpServers": {
    "shield-kya": {
      "command": "kya",
      "args": ["serve-mcp", "--stdio"],
      "env": {
        "KYA_HOST": "ide",
        "KYA_OFFLINE": "1"
      }
    }
  }
}
```

Prefer `kya` on PATH (after `npm i -g @shield-agent/kya`) over `npx -y` in checked-in configs.

## Hosted template

```toml
# example — adapt to the host’s config dialect
url = "https://shield-agent.com/mcp"
bearer_token_env_var = "KYA_API_KEY"
```

## Listing rule

Merged recipes are linked from https://shield-agent.com/integrations and the homepage host strip. Roadmap hosts stay labeled “soon” until a recipe merges.

## Honesty

KYA only sees tools that go through wrap/MCP. Do not claim the host is “fully governed” if the agent can bypass MCP.
