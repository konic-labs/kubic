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

// Refuse any `mcp` entry: MCP servers arrive in Phase-4 once the three
// settled §33 requirements hold (named in the refusal, so a reader meets
// the requirements at the refusal site instead of a bare section number).
// Until then a config that mentions MCP is misconfigured, not partially
// honored.
export function assertNoMcpConfig(raw: unknown): void {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return;
  if (Object.hasOwn(raw, 'mcp')) {
    throw new McpUnsupportedError(mcpRefusalMessage());
  }
}

// Phase-4 MCP arrival requirements: the three §33 bullets, verbatim in
// spirit — tool-policy mapping, in-worker execution, network conflict
// surfaced as policy or approval. Recorded as data so the boundary is
// explicit, and both [mcp] refusals are built from it.
export const MCP_ARRIVAL_REQUIREMENTS = [
  'map MCP tools into the agent tool policy (allow / deny / approve), not bolted on (§33)',
  'execute MCP tools inside the worker process in orchestrator mode, sharing its lifetime and trajectory (§33)',
  'treat an MCP network need the role disallows as a policy conflict — resolved at role resolution or surfaced as an approval, never silently granted (§33)',
] as const;

// The [mcp] refusal names the settled requirements (issue #254): built
// from the constant, so the refusal and the recorded requirements cannot
// drift apart. Shared with the doctor's policy:enforceability check.
export function mcpRefusalMessage(): string {
  return `config key [mcp] is unsupported in v1 (Phase-4 arrival requires: ${MCP_ARRIVAL_REQUIREMENTS.join('; ')})`;
}

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
