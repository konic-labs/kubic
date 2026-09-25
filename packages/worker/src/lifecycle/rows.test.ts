// Worker lifecycle rows as a durable record (issue #94; §50, §13).
//
// The registry is in-memory: the process that spawns workers and the
// process that answers `kubic workers` are different invocations, so a
// fresh registry in the CLI could only ever list zero rows (the defect
// this issue names). Every lifecycle transition therefore appends the
// row to `<repo>/.kubic/orchestrator/workers.json` — runtime state §35
// already keeps out of the commit path — and `kubic workers` reads that
// file back. Last write per worker wins; ordering is registration order.
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createNodeFileBridge } from '../../../exec/src/file-bridge.js';
import { WorkerRegistry } from './registry.js';
import {
  readWorkerRows,
  WORKER_ROWS_FILE,
  workerRowsPath,
  workersListFromRepo,
  writeWorkerRows,
} from './rows.js';

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'kubic-worker-rows-'));
}

function seededRegistry(now = 1_000): WorkerRegistry {
  const registry = new WorkerRegistry(() => now);
  registry.register({
    workerId: 'worker-1',
    sessionId: 'orch-1-worker-1',
    generation: 2,
    owner: 'orchestrator',
  });
  registry.updateStatus('worker-1', 'running');
  registry.recordSpawn('worker-1', 4242, 37);
  return registry;
}

describe('worker lifecycle rows on disk (issue #94)', () => {
  it('round-trips the live rows so another process can list them', () => {
    const root = scratch();
    const bridge = createNodeFileBridge(root);
    const registry = seededRegistry();
    const written = writeWorkerRows(bridge, 'workers.json', registry.list());
    expect(written).toBe(1);
    const rows = readWorkerRows(bridge, 'workers.json');
    expect(rows).toEqual([
      {
        workerId: 'worker-1',
        sessionId: 'orch-1-worker-1',
        generation: 2,
        status: 'running',
        startedAtMs: 1_000,
        ageMs: 0,
        owner: 'orchestrator',
        pid: 4242,
        startupMs: 37,
      },
    ]);
  });

  it('keeps the newest row per worker and never duplicates it', () => {
    const root = scratch();
    const bridge = createNodeFileBridge(root);
    const registry = seededRegistry();
    writeWorkerRows(bridge, 'workers.json', registry.list());
    registry.updateStatus('worker-1', 'completed');
    writeWorkerRows(bridge, 'workers.json', registry.list());
    const rows = readWorkerRows(bridge, 'workers.json');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('completed');
  });

  it('reads an absent file as no rows — never an error', () => {
    const root = scratch();
    const bridge = createNodeFileBridge(root);
    expect(existsSync(join(root, 'workers.json'))).toBe(false);
    expect(readWorkerRows(bridge, 'workers.json')).toEqual([]);
  });

  it('reads a torn or hand-edited file as no rows, never a crash', () => {
    const root = scratch();
    const bridge = createNodeFileBridge(root);
    bridge.writeFile('workers.json', '{"not":"an array"');
    expect(readWorkerRows(bridge, 'workers.json')).toEqual([]);
    bridge.writeFile('workers.json', '{"version":9,"rows":[]}');
    expect(readWorkerRows(bridge, 'workers.json')).toEqual([]);
  });

  it('drops malformed rows instead of listing a half-shaped worker', () => {
    const root = scratch();
    const bridge = createNodeFileBridge(root);
    bridge.writeFile(
      'workers.json',
      JSON.stringify({
        version: 1,
        rows: [
          {
            workerId: 'w-1',
            sessionId: 's',
            generation: 1,
            status: 'running',
            startedAtMs: 5,
            owner: 'o',
          },
          { workerId: 42 },
          null,
        ],
      }),
    );
    const rows = readWorkerRows(bridge, 'workers.json');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.workerId).toBe('w-1');
  });

  it('names the rows file under the repo runtime dir (§35, out of git)', () => {
    expect(workerRowsPath('/some/repo')).toBe(
      join('/some/repo', '.kubic', 'orchestrator', 'workers.json'),
    );
  });

  it("reads a repo's rows for `kubic workers` — absent is empty, never a throw", () => {
    const repo = scratch();
    // No `.kubic/` yet (a repo nobody orchestrated in): no rows.
    expect(workersListFromRepo(repo)).toEqual([]);
    const dir = join(repo, '.kubic', 'orchestrator');
    mkdirSync(dir, { recursive: true });
    writeWorkerRows(
      createNodeFileBridge(dir),
      WORKER_ROWS_FILE,
      seededRegistry().list(),
    );
    const rows = workersListFromRepo(repo);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.workerId).toBe('worker-1');
    // The generation is what `kubic workers` reports — the stale-resume
    // guard the orchestrator reads back.
    expect(rows[0]?.generation).toBe(2);
  });
});
