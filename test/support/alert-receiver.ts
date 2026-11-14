/**
 * Local HTTP receiver for the alert e2e tests. Its URL carries a random path token, and only requests
 * under that token count as hits. A detached `kya notify-flush` child of another test (or another test
 * file running in parallel) can still be retrying `incident.opened` against a port that this receiver
 * was given later; that stray request is kept in `foreign` and never counted. A resend from the child
 * under test uses the same URL, so it still counts and still fails `toHaveLength(1)`.
 */
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface Hit {
  readonly path: string;
  readonly body: Record<string, any>;
}
export interface Receiver {
  /** Base URL with the path token; append the route, for example `${url}/inc`. */
  readonly url: string;
  /** Requests under the token. */
  readonly hits: Hit[];
  /** Requests on this port with another path. Never counted. */
  readonly foreign: Hit[];
  incidents(): Hit[];
  denies(): Hit[];
}

/** `servers` is the caller's list that its afterEach closes. */
export async function receiver(servers: Server[]): Promise<Receiver> {
  const token = randomBytes(8).toString("hex");
  const hits: Hit[] = [];
  const foreign: Hit[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += String(d)));
    req.on("end", () => {
      try {
        const path = req.url ?? "";
        (path.startsWith(`/${token}/`) ? hits : foreign).push({ path, body: JSON.parse(raw) as Record<string, any> });
      } catch {
        /* not JSON */
      }
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/${token}`,
    hits,
    foreign,
    incidents: () => hits.filter((h) => h.body["event"] === "incident.opened"),
    denies: () => hits.filter((h) => h.body["kind"] === "kya.trail.verdict"),
  };
}
