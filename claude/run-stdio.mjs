#!/usr/bin/env node
/**
 * MCPB entry stub. Claude Desktop launches via manifest mcp_config (npx).
 * Running this file directly forwards to the published package.
 */
import { spawn } from "node:child_process";

const child = spawn(
  "npx",
  ["-y", "@shield-agent/kya@0.1.14", "serve-mcp", "--stdio"],
  { stdio: "inherit", env: process.env },
);
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
