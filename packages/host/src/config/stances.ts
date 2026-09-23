// MCP refusal + ACP edge-only stance (issue #38; design §33, §34).
// MCP is refused in v1: any `mcp` entry is a hard error, never silently
// ignored. Arrival requirements for Phase-4 are recorded as data (plus
// pending tests) so the boundary is explicit. ACP vocabulary lives ONLY
// here at the host edge — core/worker/tui must never import this module
// (enforced by the import-lint test in stances.test.ts and by dep-lint's
// host<-tui ban).

export class McpUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpUnsupportedError';
  }
}

// Refuse any `mcp` entry: MCP servers arrive in Phase-4 with containment,
// per-role credential brokering, and trajectory auditing. Until then a
// config that mentions MCP is misconfigured, not partially honored.
export function assertNoMcpConfig(raw: unknown): void {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return;
  if (Object.hasOwn(raw, 'mcp')) {
    throw new McpUnsupportedError(
      'config key [mcp] is unsupported in v1 (Phase-4 arrival: containment + brokered credentials + audited calls)',
    );
  }
}

// Phase-4 MCP arrival requirements (pending until the Phase-4 epic).
export const MCP_ARRIVAL_REQUIREMENTS = [
  'spawn MCP servers under containment (Phase-4 epic)',
  'broker MCP tool credentials per role via ScopedToken',
  'audit every MCP tool call in the trajectory',
] as const;

// ACP edge-only vocabulary (§34): internal chord + pi-protocol stay inside
// the worker; the only ACP-shaped data that crosses to the host edge is a
// UI LaneSnapshot plus chord envelopes. Standalone structural types — this
// module never imports worker implementation.
export interface AcpLaneSnapshot {
  sessionId: string;
  status: string;
  updatedAt: string;
}

export interface AcpChordMessage {
  kind: string;
  payload: Record<string, string>;
}

export interface AcpEdgeEnvelope {
  snapshot: AcpLaneSnapshot;
  messages: AcpChordMessage[];
}

export const ACP_EDGE_OWNER = '@kubic/host/src/config/acp-edge' as const;

export function createAcpEdgeEnvelope(
  snapshot: AcpLaneSnapshot,
  messages: AcpChordMessage[],
): AcpEdgeEnvelope {
  return { snapshot, messages: [...messages] };
}
