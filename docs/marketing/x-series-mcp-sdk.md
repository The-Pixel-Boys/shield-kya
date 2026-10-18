# X mini-series: kya MCP taxonomy / gate / SDK shims / hosted intake

Draft posts for the kya 0.11 to 0.13 + hosted-intake arc. Each ≤280 chars,
plain text. Voice: direct, builder-to-builder, no hashtag spam. Product
language only: "kya gate" / "the kya gateway". Never the upstream gateway
project name.

## (a) Top-20 MCP recognition + Servers facet

Your agent calls mcp__github__merge_pull_request. kya knows what that is.

The CLI recognizes the top-20 MCP servers (GitHub, Playwright, Postgres, Slack, Notion…) and tiers each tool READ / WRITE / ADMIN by name. New Servers facet in the report: what your agents touch.

## (b) kya gate

kya gate: one loopback listener in front of every MCP server you run.

Policy comes from the server taxonomy: drop/truncate/purge and each server's ADMIN tools are denied outright, everything else is recorded in the report. Wire a host with kya connect <host> --gate.

## (c) SDK shims

Building the agent yourself, not wiring a host? One wrapper governs any framework: LangGraph, Vercel AI SDK, Mastra, OpenAI Agents, Claude Agent SDK, plus a Python shim. governed() around the tool: ALLOW runs, DENY never runs, everything lands in the record. Offline by default.

## (d) Hosted intake

The local kya gateway now ships telemetry home. Every MCP tools/call span becomes a gated event on your console: same feed, session record, and server hotspots, now across every machine you run. API-key auth, never-block ingest: a bad span can't 5xx your gateway.
