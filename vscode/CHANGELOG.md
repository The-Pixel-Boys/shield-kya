# Changelog

## 0.1.1

Listing text now says that kya blocks the never-list and the guard pack (the 0.1.0 listing said it blocks only the never-list). The extension is now published to the VS Code Marketplace and Open VSX by the release pipeline on each `kya-v*` tag.

The Verdicts feed follows kya trail rotation (kya 0.33.5): a new `trail.jsonl` (new inode) reloads the feed, and a small new file is filled from the end of `trail.1.jsonl`.

## 0.1.0

First version. Verdict feed from the local kya trail. Status bar with gate mode and counts. Optional hosted approvals (SecretStorage key). Connect this workspace (`kya connect <host> --project`, with confirmation). MCP server registration through the VS Code or Cursor MCP API. Read-only in Restricted Mode and virtual workspaces.
