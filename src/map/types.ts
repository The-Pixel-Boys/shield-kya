/** Schema version of the map graph JSON (docs/design/agent-map-schema.md, section 4). */
export const MAP_SCHEMA_VERSION = 1;

/** Verdict buckets (schema section 3). Each event lands in exactly one. */
export interface Verdicts {
  allow: number;
  deny: number;
  hold: number;
  observed: number;
}

export type ToolClass = "kya" | "mcp" | "shell" | "network" | "write" | "read" | "other";

/** One trail row as read from trail.jsonl. Optional fields may be absent on older rows. */
export interface TrailEventLike {
  ts: string;
  sessionId: string;
  host?: string;
  product?: string;
  project?: string;
  toolId: string;
  verdict: string;
  reasonCode: string;
  mode: string;
  neverEvent?: boolean;
  neverRule?: string;
  summary?: string;
  targetPath?: string;
  shadow?: boolean;
  /** Hashed device id (new field). Absent means this machine. */
  deviceId?: string;
  /** Target class written by the hook (new field). Absent means derive it with classifyTarget. */
  targetClass?: string;
}

interface NodeBase {
  id: string;
  /** Human label for the local view. Agent label is the project basename, or null. */
  label: string | null;
  /** Number of events under this node. Grouped nodes hold the sum of their members. */
  count: number;
  verdicts: Verdicts;
  firstTs: string;
  lastTs: string;
  /** Number of members folded into an "other" node. Absent on shown nodes. */
  grouped?: number;
}

export interface DeviceNode extends NodeBase {
  kind: "device";
}

export interface AgentNode extends NodeBase {
  kind: "agent";
  product: string;
  /** Null on grouped "other agents" nodes. */
  sessionHash: string | null;
  legacy: boolean;
}

export interface ToolNode extends NodeBase {
  kind: "tool";
  toolId: string;
  toolClass: ToolClass;
}

export interface TargetNode extends NodeBase {
  kind: "target";
  class: string;
  family: string;
}

export type MapNode = DeviceNode | AgentNode | ToolNode | TargetNode;

export interface MapEdge {
  from: string;
  to: string;
  kind: "runs" | "uses" | "touches";
  /** Tool id on touches edges (the grouped tool label when grouped). */
  tool?: string;
  count: number;
  verdicts: Verdicts;
  firstTs: string;
  lastTs: string;
}

export interface MapView {
  source: "trail";
  rowsRead: number;
  rowsSkipped: number;
  rowsOutOfWindow: number;
  legacyRows: number;
  /** True when any group or edge drop happened to fit the cap. */
  truncated: boolean;
  /** True when always-shown items alone exceed the node cap. */
  capExceeded: boolean;
  /** Number of agents, tools and targets folded into "other" nodes. */
  grouped: { agents: number; tools: number; targets: number };
  /** Number of edges dropped to fit the edge cap. */
  edgesDropped: number;
}

export interface MapGraph {
  schemaVersion: typeof MAP_SCHEMA_VERSION;
  view: MapView;
  nodes: MapNode[];
  edges: MapEdge[];
}
