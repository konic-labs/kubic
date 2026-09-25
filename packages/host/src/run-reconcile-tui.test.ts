// End-of-run reconciliation on the real TUI composition path (issue #87):
// `bootTuiLane` captures the §42.5 baseline at lane boot and sweeps when the
// session closes (the TUI's run end), so a file mutated outside Kubic's ops
// during an interactive session is journaled as unattributed too.
//
// Lives in host (vitest includes only packages/*): it reaches the real
// composition-root boot as a black-box caller, faux provider only.
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bootTuiLane } from '../../../apps/kubic/src/tui-run.js';
import { NodeExecutionEnv } from '../../exec/src/env.js';
import { FileJournalStore } from '../../exec/src/journal.js';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  type MutableModels,
} from '../../worker/src/pi-boundary.js';
import { runJournalCommand } from './journal-cli.js';

function tmpRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function fauxModels(): MutableModels {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage('ready')]);
  return models;
}

describe('end-of-run reconciliation, tui path (issue #87)', () => {
  it('captures at boot and sweeps a non-tool mutation when the lane closes', async () => {
    const sessionsRoot = tmpRoot('reconcile-tui-');
    const workspace = tmpRoot('ws-tui-');
    writeFileSync(join(workspace, 'stable.txt'), 'stable\n');
    const boot = await bootTuiLane(undefined, {
      sessionsRoot,
      env: new NodeExecutionEnv(workspace),
      models: fauxModels(),
    });
    const id = boot.sessionId;
    const journalDir = join(sessionsRoot, id, 'journal');
    const baselinePath = join(journalDir, `baseline-${id}.json`);
    // Capture happened at boot, before any effect could exist.
    expect(existsSync(baselinePath)).toBe(true);
    const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as Record<
      string,
      string
    >;
    expect(Object.keys(baseline)).toContain('stable.txt');

    // A formatter/build shape: the file moves outside every Kubic op.
    writeFileSync(join(workspace, 'stable.txt'), 'formatted externally\n');
    expect(new FileJournalStore(journalDir).entries()).toEqual([]);

    // Run end: the TUI's close is the sweep point (quit / SIGINT / EOF all
    // route through it), and the entry is visible to the CLI the operator
    // would run next.
    await boot.close?.();
    const entries = new FileJournalStore(journalDir).entries();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.path).toBe('stable.txt');
    expect(entries[0]?.unattributed).toBe(true);
    expect(entries[0]?.sessionId).toBe(id);
    const statusOut: string[] = [];
    expect(
      await runJournalCommand(['status', '--session', id], {
        root: workspace,
        sessionsRoot,
        out: (line) => statusOut.push(line),
      }),
    ).toBe(0);
    expect(statusOut.join('\n')).toContain('unattributed: 1 of 1');
  });

  it('appends nothing on a second close over an unchanged tree', async () => {
    const sessionsRoot = tmpRoot('reconcile-tui-once-');
    const workspace = tmpRoot('ws-tui-once-');
    writeFileSync(join(workspace, 'file.txt'), 'v1\n');
    const boot = await bootTuiLane(undefined, {
      sessionsRoot,
      env: new NodeExecutionEnv(workspace),
      models: fauxModels(),
    });
    const journalDir = join(sessionsRoot, boot.sessionId, 'journal');
    writeFileSync(join(workspace, 'file.txt'), 'v2\n');
    await boot.close?.();
    await boot.close?.();
    expect(new FileJournalStore(journalDir).entries()).toHaveLength(1);
  });

  it('journals nothing when the session ends with no outside change', async () => {
    const sessionsRoot = tmpRoot('reconcile-tui-clean-');
    const workspace = tmpRoot('ws-tui-clean-');
    writeFileSync(join(workspace, 'file.txt'), 'v1\n');
    const boot = await bootTuiLane(undefined, {
      sessionsRoot,
      env: new NodeExecutionEnv(workspace),
      models: fauxModels(),
    });
    await boot.close?.();
    expect(
      new FileJournalStore(
        join(sessionsRoot, boot.sessionId, 'journal'),
      ).entries(),
    ).toEqual([]);
  });
});
