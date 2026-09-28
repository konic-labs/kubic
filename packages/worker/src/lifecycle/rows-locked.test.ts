// Review fixes: workers.json updates are atomic + serialized, a torn file is
// never overwritten as [], and rows with unsafe pids are rejected on read.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createNodeFileBridge } from '../../../exec/src/file-bridge.js';
import { reconcileWorkerRows } from './orphans.js';
import { readWorkerRows, updateWorkerRowsFile } from './rows.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kubic-rows-'));
  dirs.push(dir);
  return dir;
}
const base = {
  workerId: 'w1',
  sessionId: 's-w1',
  generation: 1,
  status: 'running',
  startedAtMs: 0,
  ageMs: 0,
  owner: 'o',
};

describe('updateWorkerRowsFile', () => {
  it('refuses to overwrite a torn/unparsable file', () => {
    const dir = scratch();
    const file = join(dir, 'workers.json');
    writeFileSync(file, '{"version":1,"rows":[');
    expect(() => updateWorkerRowsFile(file, (rows) => rows)).toThrow(
      /unparsable/,
    );
    expect(readFileSync(file, 'utf8')).toBe('{"version":1,"rows":[');
  });

  it('applies the update to the rows on disk at write time', () => {
    const dir = scratch();
    const file = join(dir, 'workers.json');
    updateWorkerRowsFile(file, () => [{ ...base, pid: 100 } as never]);
    updateWorkerRowsFile(file, (rows) => [
      ...rows,
      { ...base, workerId: 'w2', pid: 101 } as never,
    ]);
    const rows = readWorkerRows(createNodeFileBridge(dir), 'workers.json');
    expect(rows.map((row) => row.workerId)).toEqual(['w1', 'w2']);
  });
});

describe('readWorkerRows rejects unsafe rows', () => {
  it.each([
    ['pid 0', { pid: 0 }],
    ['pid 1', { pid: 1 }],
    ['negative pid', { pid: -5 }],
    ['fractional pid', { pid: 100.5 }],
    ['managerPid 1', { pid: 100, managerPid: 1 }],
    ['empty sessionId', { pid: 100, sessionId: '' }],
  ])('drops a row with %s', (_label, over) => {
    const dir = scratch();
    writeFileSync(
      join(dir, 'workers.json'),
      JSON.stringify({ version: 1, rows: [{ ...base, ...over }] }),
    );
    expect(readWorkerRows(createNodeFileBridge(dir), 'workers.json')).toEqual(
      [],
    );
  });
});

describe('legacy rows without managerPid', () => {
  it('never kills a live worker whose manager is unknown', async () => {
    const killed: number[] = [];
    const out = await reconcileWorkerRows([{ ...base, pid: 100 } as never], {
      alive: (pid) => pid === 100,
      command: async () => 'run --session s-w1',
      killGroup: (pid) => {
        killed.push(pid);
      },
    });
    expect(killed).toEqual([]);
    expect(out.rows[0]?.status).toBe('running');
  });

  it('still marks a dead legacy worker crashed', async () => {
    const out = await reconcileWorkerRows([{ ...base, pid: 100 } as never], {
      alive: () => false,
      killGroup: () => undefined,
    });
    expect(out.rows[0]?.status).toBe('crashed');
  });
});
