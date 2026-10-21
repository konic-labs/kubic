import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createNodeFileBridge } from '@kubic/exec/file-bridge';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../../test/temp-dir.js';
import type { OrgAuditRecord } from './audit.js';
import {
  appendChainedAuditLine,
  CHAIN_GENESIS,
  chainHash,
  verifyAuditChain,
} from './chain.js';
import { readAuditLedger } from './ledger.js';

function record(what: string): OrgAuditRecord {
  return {
    version: 1,
    who: 'dev',
    what,
    when: '2026-10-21T10:00:00.000Z',
    agent: { session: 's1', role: 'default' },
    model: { provider: 'faux', id: 'faux-1', thinking: 'off' },
    process: { pid: 42 },
    workspace: { path: '/repo', base: 'none' },
    permission: { permission: 'run:start', approval: 'started' },
    credential: { sentinel: 'none' },
    network: { host: 'none', port: 0, decision: 'deny', bytes: 0 },
    posture: 'approvals',
    result: 'ok',
    reason: 'test',
  };
}

function ledger(...whats: string[]): string {
  const dir = tempDir('audit-chain-');
  const bridge = createNodeFileBridge(dir);
  for (const what of whats) {
    appendChainedAuditLine(bridge, dir, 'audit.jsonl', record(what));
  }
  return join(dir, 'audit.jsonl');
}

function lines(path: string): string[] {
  return readFileSync(path, 'utf8').split('\n').slice(0, -1);
}

describe('the audit chain', () => {
  it('links each record to the one before it and verifies', () => {
    const path = ledger('run:start', 'tool:bash', 'posture:approvals');
    const [first, second] = lines(path).map(
      (line) => JSON.parse(line) as { chain: { prev: string; hash: string } },
    );
    expect(first?.chain.prev).toBe(CHAIN_GENESIS);
    expect(second?.chain.prev).toBe(first?.chain.hash);
    const verified = verifyAuditChain(path);
    expect(verified).toMatchObject({ ok: true, records: 3, unchained: 0 });
    expect(verified.head).toBe(
      (JSON.parse(lines(path)[2] ?? '{}') as { chain: { hash: string } }).chain
        .hash,
    );
    // Readers get the record without its link.
    expect(readAuditLedger(join(path, '..'))[1]).toEqual(record('tool:bash'));
  });

  it('names an edited line', () => {
    const path = ledger('run:start', 'tool:bash', 'posture:approvals');
    const edited = lines(path);
    edited[1] = (edited[1] ?? '').replace('"result":"ok"', '"result":"deny"');
    writeFileSync(path, `${edited.join('\n')}\n`);
    expect(verifyAuditChain(path)).toMatchObject({
      ok: false,
      problem: { line: 2, message: 'was changed after it was written' },
    });
  });

  it('names the line after a removed one', () => {
    const path = ledger('run:start', 'tool:bash', 'posture:approvals');
    const kept = lines(path);
    kept.splice(1, 1);
    writeFileSync(path, `${kept.join('\n')}\n`);
    expect(verifyAuditChain(path)).toMatchObject({
      ok: false,
      problem: {
        line: 2,
        message:
          'does not follow line 1: a record before it was removed, or line 1 changed',
      },
    });
  });

  it('catches records removed from the end, and bytes added after them', () => {
    const path = ledger('run:start', 'tool:bash', 'posture:approvals');
    const original = readFileSync(path, 'utf8');
    writeFileSync(path, `${lines(path).slice(0, 2).join('\n')}\n`);
    expect(verifyAuditChain(path)).toMatchObject({
      ok: false,
      problem: {
        line: 3,
        message: 'is missing: records were removed from the end of the ledger',
      },
    });
    writeFileSync(path, `${original}{"what":"forged"}\n`);
    expect(verifyAuditChain(path)).toMatchObject({
      ok: false,
      problem: { line: 4 },
    });
  });

  it('covers a ledger begun before the chain through its first link', () => {
    const dir = tempDir('audit-chain-');
    const path = join(dir, 'audit.jsonl');
    const legacy = `${JSON.stringify(record('old-1'))}\n${JSON.stringify(record('old-2'))}\n`;
    writeFileSync(path, legacy);
    const bridge = createNodeFileBridge(dir);
    appendChainedAuditLine(bridge, dir, 'audit.jsonl', record('new'));
    expect(verifyAuditChain(path)).toMatchObject({
      ok: true,
      records: 3,
      unchained: 2,
    });
    writeFileSync(
      path,
      readFileSync(path, 'utf8').replace('"what":"old-1"', '"what":"old-X"'),
    );
    expect(verifyAuditChain(path)).toMatchObject({
      ok: false,
      problem: {
        line: 3,
        message:
          'does not follow the records before the chain began: one of them changed or was removed',
      },
    });
  });

  it('closes a torn line instead of writing onto it, and names it', () => {
    const dir = tempDir('audit-chain-');
    const path = join(dir, 'audit.jsonl');
    const bridge = createNodeFileBridge(dir);
    appendChainedAuditLine(bridge, dir, 'audit.jsonl', record('run:start'));
    writeFileSync(path, `${readFileSync(path, 'utf8')}{"what":"tor`);
    appendChainedAuditLine(bridge, dir, 'audit.jsonl', record('tool:bash'));
    const all = lines(path);
    expect(all).toHaveLength(3);
    expect(all[1]).toBe('{"what":"tor');
    expect(JSON.parse(all[2] ?? '{}').what).toBe('tool:bash');
    expect(verifyAuditChain(path)).toMatchObject({
      ok: false,
      problem: { line: 2, message: 'is not a record: a torn or edited line' },
    });
  });

  it('reads a missing ledger as an empty, intact one', () => {
    expect(
      verifyAuditChain(join(tempDir('audit-chain-'), 'audit.jsonl')),
    ).toMatchObject({ ok: true, records: 0 });
    expect(chainHash(CHAIN_GENESIS, '{}')).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
