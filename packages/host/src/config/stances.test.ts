// MCP refusal + ACP edge-only stance (issue #38) — RED first.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ACP_EDGE_OWNER,
  type AcpEdgeEnvelope,
  assertNoMcpConfig,
  createAcpEdgeEnvelope,
  MCP_ARRIVAL_REQUIREMENTS,
  McpUnsupportedError,
} from './stances.js';

describe('MCP stance (issue #38)', () => {
  it('rejects an mcp entry with an unsupported error', () => {
    expect(() => assertNoMcpConfig({ mcp: { servers: [] } })).toThrow(
      McpUnsupportedError,
    );
    expect(() => assertNoMcpConfig({ mcp: { servers: [] } })).toThrow(
      /unsupported/i,
    );
  });

  it('rejects mcp entries nested beside valid config keys', () => {
    expect(() => assertNoMcpConfig({ agent: { name: 'k' }, mcp: {} })).toThrow(
      McpUnsupportedError,
    );
  });

  it('accepts configs without mcp entries', () => {
    expect(() => assertNoMcpConfig({ agent: { name: 'k' } })).not.toThrow();
    expect(() => assertNoMcpConfig(undefined)).not.toThrow();
    expect(() => assertNoMcpConfig(null)).not.toThrow();
    expect(() => assertNoMcpConfig({})).not.toThrow();
  });

  it('records arrival requirements for Phase-4', () => {
    expect(MCP_ARRIVAL_REQUIREMENTS.length).toBeGreaterThan(0);
    for (const req of MCP_ARRIVAL_REQUIREMENTS) {
      expect(typeof req).toBe('string');
      expect(req.length).toBeGreaterThan(0);
    }
  });

  // Arrival requirements stay pending until the Phase-4 epic.
  describe.skip('Phase-4 MCP arrival (pending)', () => {
    it('spawns MCP servers under containment', () => {});
    it('brokers MCP tool credentials per role', () => {});
    it('audits every MCP tool call in the trajectory', () => {});
  });
});

describe('ACP edge-only (issue #38)', () => {
  it('defines ACP types at the host edge', () => {
    const envelope: AcpEdgeEnvelope = createAcpEdgeEnvelope(
      {
        sessionId: 's1',
        status: 'active',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      [{ kind: 'lane-snapshot', payload: { session: 's1' } }],
    );
    expect(envelope.snapshot.sessionId).toBe('s1');
    expect(envelope.messages).toHaveLength(1);
    expect(ACP_EDGE_OWNER).toContain('host');
  });

  it('is not imported outside host + composition root (import-lint)', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    let root = here;
    while (!fileExists(join(root, 'scripts', 'dep-lint.mjs'))) {
      const parent = dirname(root);
      if (parent === root) throw new Error('repo root not found');
      root = parent;
    }
    const violations: string[] = [];
    const owners = readdirSync(join(root, 'packages')).filter((entry) =>
      statSync(join(root, 'packages', entry)).isDirectory(),
    );
    for (const owner of owners) {
      if (owner === 'host') continue;
      for (const file of tsFiles(join(root, 'packages', owner))) {
        const content = readFileSync(file, 'utf8');
        if (/config\/acp(\.js)?['"]/.test(content)) violations.push(file);
      }
    }
    expect(violations).toEqual([]);
  });
});

function fileExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function tsFiles(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) tsFiles(full, out);
    else if (/\.m?[jt]sx?$/.test(entry)) out.push(full);
  }
  return out;
}
