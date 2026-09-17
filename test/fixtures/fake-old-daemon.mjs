/**
 * Test fixture: stands in for a receipt daemon built from an older kya
 * version. Serves the pre-0.4.1 /healthz contract (plain "ok\n") or, when
 * FAKE_VERSION is set, a JSON payload pinned to that foreign version.
 * Env: FAKE_TOKEN (required), FAKE_VERSION (optional). Prints "PORT <n>".
 */
import { createServer } from "node:http";

const token = process.env.FAKE_TOKEN;
const version = process.env.FAKE_VERSION;

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const auth = req.headers.authorization ?? "";
  if (auth !== `Bearer ${token}` && url.searchParams.get("t") !== token) {
    res.writeHead(401, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("unauthorized\n");
    return;
  }
  if (url.pathname === "/healthz") {
    if (version) {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(`${JSON.stringify({ ok: true, version })}\n`);
    } else {
      // Pre-0.4.1 daemon: no version anywhere in the payload.
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("ok\n");
    }
    return;
  }
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("not found\n");
});

process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
});

server.listen(0, "127.0.0.1", () => {
  process.stdout.write(`PORT ${server.address().port}\n`);
});
