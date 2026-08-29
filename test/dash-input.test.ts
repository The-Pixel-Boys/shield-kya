import { describe, expect, it } from "vitest";
import { mapKey } from "../src/dash/input.js";

describe("mapKey", () => {
  it("maps free digits and enterprise letters", () => {
    expect(mapKey("1")).toEqual({ type: "pane", pane: "home" });
    expect(mapKey("4")).toEqual({ type: "pane", pane: "approvals" });
    expect(mapKey("d")).toEqual({ type: "pane", pane: "dashboard" });
    expect(mapKey("c")).toEqual({ type: "pane", pane: "cases" });
  });

  it("maps quit refresh offline", () => {
    expect(mapKey("q").type).toBe("quit");
    expect(mapKey("\u0003").type).toBe("quit");
    expect(mapKey("r").type).toBe("refresh");
    expect(mapKey("O").type).toBe("offline");
    expect(mapKey("o").type).toBe("orr-run");
  });

  it("maps operator keys and never auto-approves", () => {
    expect(mapKey("w").type).toBe("wrap");
    expect(mapKey("k").type).toBe("kill");
    expect(mapKey("a").type).toBe("decide-approve");
    expect(mapKey("x").type).toBe("decide-reject");
    expect(mapKey("j").type).toBe("down");
  });
});
