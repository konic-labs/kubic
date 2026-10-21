// MCP refusal + ACP edge-only stance.
// MCP is not supported yet: any `mcp` entry is a hard error, never silently
// ignored. The requirements MCP support must meet are recorded as data so the
// boundary is explicit. ACP vocabulary lives ONLY
// here at the host edge — core/agent/tui must never import this module
// (enforced by the import-lint test in stances.test.ts and by dep-lint's
// host<-tui ban).

export class McpUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpUnsupportedError';
  }
}

// Refuse any `mcp` entry: MCP servers can be supported once the three
// requirements hold (named in the refusal, so a reader meets them at the
// refusal site). Until then a config that mentions MCP is misconfigured, not
// partially honored.
export function assertNoMcpConfig(raw: unknown): void {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return;
  if (Object.hasOwn(raw, 'mcp')) {
    throw new McpUnsupportedError(mcpRefusalMessage());
  }
}

// What MCP support requires: tool-policy mapping, in-process execution, and
// network conflicts surfaced as policy or approval. Recorded as data so the
// boundary is explicit, and both [mcp] refusals are built from it.
export const MCP_ARRIVAL_REQUIREMENTS = [
  'map MCP tools into the agent tool policy (allow / deny / approve), not bolted on',
  'execute MCP tools inside the agent process, sharing its lifetime and trajectory',
  'treat an MCP network need the role disallows as a policy conflict — resolved at role resolution or surfaced as an approval, never silently granted',
] as const;

// The [mcp] refusal names the requirements: built from the constant, so the
// refusal and the recorded requirements cannot drift apart. Shared with the
// doctor's policy:enforceability check.
export function mcpRefusalMessage(): string {
  return `config key [mcp] is unsupported (MCP support requires: ${MCP_ARRIVAL_REQUIREMENTS.join('; ')})`;
}
