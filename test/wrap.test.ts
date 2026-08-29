import { describe, expect, it, vi } from "vitest";
import { KyaHttpClient } from "../src/client.js";
import { clientSafeError, UsageError } from "../src/errors.js";
import { runWrap, verdictExitCode, wrapExitCode } from "../src/commands/wrap.js";
import { runDecide } from "../src/commands/decide.js";
import { runCli, type CliIo } from "../src/cli.js";
import { HttpError } from "../src/errors.js";
import type { ResolvedConfig } from "../src/config.js";

function mockFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  return vi.fn(impl) as unknown as typeof fetch;
}

const base: ResolvedConfig = {
  baseUrl: "http://plane",
  apiKey: "sk",
  host: "ide",
  agentId: "11111111-1111-1111-1111-111111111111",
  mcpPort: 8091,
  tenantHint: undefined,
  cwd: "/tmp",
  configPath: "/tmp/.kya/config.json",
  json: false,
  allowMissingApiKey: false,
  offline: false,
};

describe("wrap", () => {
  it("offline REQUIRE_APPROVE never requests approval or executes", async () => {
    const result = await runWrap(base, {
      toolId: "org.sample.data.write",
      irreversible: true,
      offline: true,
    });
    expect(result.eval.response.verdict).toBe("REQUIRE_APPROVE");
    expect(result.sideEffect).toBe("blocked");
    expect(result.approval).toBeUndefined();
    expect(result.next).toMatch(/live plane/i);
  });

  it("offline DENY stays blocked with no approval", async () => {
    const result = await runWrap(base, {
      toolId: "org.sample.never.event",
      irreversible: true,
      offline: true,
    });
    expect(result.eval.response.verdict).toBe("DENY");
    expect(result.sideEffect).toBe("blocked");
    expect(result.approval).toBeUndefined();
    expect(wrapExitCode(result)).toBe(1);
  });

  it("offline ALLOW still does not execute", async () => {
    const result = await runWrap(base, {
      toolId: "org.sample.safe.read",
      offline: true,
    });
    expect(result.eval.response.verdict).toBe("ALLOW");
    expect(result.sideEffect).toBe("blocked");
    expect(result.approval).toBeUndefined();
    expect(wrapExitCode(result)).toBe(0);
  });

  it("live REQUIRE_APPROVE opens a ticket and still does not execute", async () => {
    const fetchImpl = mockFetch(async (url, init) => {
      if (String(url).includes("/policy/evaluate")) {
        return new Response(
          JSON.stringify({
            verdict: "REQUIRE_APPROVE",
            reasonCode: "HIGH_STAKES_WRITE",
            toolId: "org.sample.data.write",
            argsHash: "abc",
          }),
          { status: 200 },
        );
      }
      expect(String(url)).not.toMatch(/\/approve|\/reject$/);
      expect(init?.method).toBe("POST");
      expect(String(url)).toMatch(/\/api\/v1\/kya\/approvals$/);
      const body = JSON.parse(String(init?.body));
      expect(body.toolId).toBe("org.sample.data.write");
      expect(body.disputeId).toBe("22222222-2222-2222-2222-222222222222");
      expect(body.host).toBe("ide");
      expect(body.argsHash).toBeTruthy();
      expect(body.reasonCode).toBe("HIGH_STAKES_WRITE");
      expect(body.irreversible).toBe(true);
      return new Response(
        JSON.stringify({ id: "appr-9", status: "PENDING" }),
        { status: 201 },
      );
    });
    const client = new KyaHttpClient({
      baseUrl: "http://plane",
      apiKey: "sk",
      host: "ide",
      agentId: base.agentId,
      fetch: fetchImpl,
    });
    const result = await runWrap(
      base,
      {
        toolId: "org.sample.data.write",
        irreversible: true,
        workItemId: "22222222-2222-2222-2222-222222222222",
      },
      client,
    );
    expect(result.sideEffect).toBe("blocked");
    expect(result.approval?.id).toBe("appr-9");
    expect(result.approval?.status).toBe("PENDING");
    expect(result.workItemId).toBe("22222222-2222-2222-2222-222222222222");
    expect(wrapExitCode(result)).toBe(4);
  });

  it("binds ticket disputeId to factory work-item of argsHash", async () => {
    const fetchImpl = mockFetch(async (url, init) => {
      if (String(url).includes("/policy/evaluate")) {
        return new Response(
          JSON.stringify({
            verdict: "REQUIRE_APPROVE",
            reasonCode: "HIGH_STAKES_WRITE",
            toolId: "org.sample.data.write",
            argsHash: "abc",
          }),
          { status: 200 },
        );
      }
      const body = JSON.parse(String(init?.body));
      expect(body.disputeId).toBe("d9ae0e1a-72ee-3eb2-8df2-c512286989dc");
      return new Response(
        JSON.stringify({ id: "appr-bind", status: "PENDING" }),
        { status: 201 },
      );
    });
    const client = new KyaHttpClient({
      baseUrl: "http://plane",
      apiKey: "sk",
      host: "ide",
      agentId: base.agentId,
      fetch: fetchImpl,
    });
    const result = await runWrap(
      base,
      { toolId: "org.sample.data.write", irreversible: true },
      client,
    );
    expect(result.approval?.id).toBe("appr-bind");
    expect(result.workItemId).toBe("d9ae0e1a-72ee-3eb2-8df2-c512286989dc");
    expect(wrapExitCode(result)).toBe(4);
  });

  it("live REQUIRE_APPROVE without agentId is a usage error", async () => {
    const fetchImpl = mockFetch(async (url) => {
      if (String(url).includes("/policy/evaluate")) {
        return new Response(
          JSON.stringify({
            verdict: "REQUIRE_APPROVE",
            reasonCode: "HIGH_STAKES_WRITE",
            toolId: "org.sample.data.write",
          }),
          { status: 200 },
        );
      }
      return new Response("should-not-create-approval", { status: 500 });
    });
    const client = new KyaHttpClient({
      baseUrl: "http://plane",
      apiKey: "sk",
      fetch: fetchImpl,
    });
    await expect(
      runWrap(
        { ...base, agentId: undefined },
        { toolId: "org.sample.data.write", irreversible: true },
        client,
      ),
    ).rejects.toBeInstanceOf(UsageError);
  });
});

describe("decide", () => {
  it("POSTs approve then reject", async () => {
    const fetchImpl = mockFetch(async (url) => {
      const status = String(url).endsWith("/approve") ? "APPROVED" : "REJECTED";
      return new Response(JSON.stringify({ id: "appr-1", status }), { status: 200 });
    });
    const client = new KyaHttpClient({
      baseUrl: "http://plane",
      apiKey: "sk",
      fetch: fetchImpl,
    });
    const ok = await runDecide(base, { id: "appr-1", decision: "approve" }, client);
    expect(ok.status).toBe("APPROVED");
    const no = await runDecide(base, { id: "appr-1", decision: "reject" }, client);
    expect(no.status).toBe("REJECTED");
  });

  it("rejects decide responses without id/status", async () => {
    const fetchImpl = mockFetch(async () => new Response("{}", { status: 200 }));
    const client = new KyaHttpClient({
      baseUrl: "http://plane",
      apiKey: "sk",
      fetch: fetchImpl,
    });
    await expect(
      runDecide(base, { id: "appr-1", decision: "approve" }, client),
    ).rejects.toBeInstanceOf(HttpError);
  });
});

describe("clientSafeError", () => {
  it("does not forward unknown Error.message", () => {
    expect(clientSafeError(new Error("ENOENT /etc/passwd"))).toBe("request failed");
    expect(clientSafeError(new UsageError("eval-tool requires --tool-id"))).toContain(
      "eval-tool",
    );
    expect(clientSafeError(new HttpError(502, "upstream exploded"))).toBe(
      "control plane HTTP 502",
    );
  });
});

describe("verdictExitCode", () => {
  it("ALLOW 0, REQUIRE_APPROVE 4, DENY/unknown 1", () => {
    expect(verdictExitCode("ALLOW")).toBe(0);
    expect(verdictExitCode("REQUIRE_APPROVE")).toBe(4);
    expect(verdictExitCode("DENY")).toBe(1);
    expect(verdictExitCode("")).toBe(1);
    expect(verdictExitCode(undefined)).toBe(1);
  });
});

describe("wrap CLI exit", () => {
  it("offline DENY is non-zero so wrap && side_effect fails closed", async () => {
    const logs: string[] = [];
    const io: CliIo = {
      log: (m) => logs.push(m),
      error: () => undefined,
      exit: () => undefined,
    };
    const code = await runCli(
      [
        "wrap",
        "--offline",
        "--tool-id",
        "org.sample.never.event",
        "--irreversible",
      ],
      io,
      {},
      "/tmp",
    );
    expect(code).toBe(1);
    expect(logs.join("\n")).toMatch(/DENY/);
    expect(logs.join("\n")).toMatch(/blocked/);
  });
});
