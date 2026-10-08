// MCP refusal + ACP edge-only stance.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  assertNoMcpConfig,
  MCP_ARRIVAL_REQUIREMENTS,
  McpUnsupportedError,
} from './stances.js';

describe('MCP stance', () => {
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

  it('records the requirements MCP support must meet', () => {
    expect(MCP_ARRIVAL_REQUIREMENTS.length).toBeGreaterThan(0);
    for (const req of MCP_ARRIVAL_REQUIREMENTS) {
      expect(typeof req).toBe('string');
      expect(req.length).toBeGreaterThan(0);
    }
  });
});

describe('MCP arrival requirements', () => {
  it('records the three settled requirements', () => {
    expect(MCP_ARRIVAL_REQUIREMENTS).toHaveLength(3);
    expect(MCP_ARRIVAL_REQUIREMENTS[0]).toMatch(/tool policy/);
    expect(MCP_ARRIVAL_REQUIREMENTS[1]).toMatch(/agent process/);
    expect(MCP_ARRIVAL_REQUIREMENTS[2]).toMatch(/policy conflict/);
  });

  it('names every requirement in the [mcp] refusal', () => {
    let message = '';
    try {
      assertNoMcpConfig({ mcp: {} });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/\[mcp\]/);
    for (const req of MCP_ARRIVAL_REQUIREMENTS) {
      expect(message).toContain(req);
    }
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

// Refusal-path hardening: a surviving "refusal removed" mutant
// is a P0 test bug, so every refusal branch pins exact errors.
describe('MCP refusal hardening', () => {
  it('passes through non-object configs without false positives', () => {
    expect(() => assertNoMcpConfig([])).not.toThrow();
    expect(() => assertNoMcpConfig('mcp')).not.toThrow();
    expect(() => assertNoMcpConfig(42)).not.toThrow();
    expect(() => assertNoMcpConfig(true)).not.toThrow();
    expect(() =>
      assertNoMcpConfig({ agent: { mcp: 'nested-value' } }),
    ).not.toThrow();
  });

  it('pins the McpUnsupportedError name and message', () => {
    try {
      assertNoMcpConfig({ mcp: {} });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(McpUnsupportedError);
      expect((error as Error).name).toBe('McpUnsupportedError');
      expect((error as Error).message).toMatch(/\[mcp\]/);
      expect((error as Error).message).toMatch(/MCP support requires/);
    }
  });

  it('refuses inherited mcp keys only when own (no prototype false-positive)', () => {
    const proto = { mcp: {} };
    const child = Object.create(proto) as Record<string, unknown>;
    child.agent = { name: 'k' };
    expect(() => assertNoMcpConfig(child)).not.toThrow();
    expect(Object.hasOwn(child, 'mcp')).toBe(false);
  });
});
