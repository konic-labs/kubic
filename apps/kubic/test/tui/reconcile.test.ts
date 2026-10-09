// End-of-run reconciliation on the real TUI composition path:
// `bootTuiLane` captures the baseline at lane boot and sweeps when the
// session closes (the TUI's run end), so a file mutated outside Kubic's ops
// during an interactive session is journaled as unattributed too.
//
// It drives the real composition-root boot as a black-box caller, faux
// provider only.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  type MutableModels,
} from '@kubic/agent/pi-boundary';
import { NodeExecutionEnv } from '@kubic/exec/env';
import { FileJournalStore } from '@kubic/exec/journal';
import { runJournalCommand } from '@kubic/host/journal';
import { afterEach, describe, expect, it } from 'vitest';
import { bootTuiLane } from '../../src/tui/boot.js';

const made: string[] = [];

function tmpRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function fauxModels(): MutableModels {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage('ready')]);
  return models;
}

describe('end-of-run reconciliation, tui path', () => {
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
      (
        await runJournalCommand(
          { command: 'status', session: id },
          {
            root: workspace,
            sessionsRoot,
            out: (line) => statusOut.push(line),
          },
        )
      ).exitCode,
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
    // The close IS the sweep point: an absent close would make this vacuous.
    expect(boot.close).toBeTypeOf('function');
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
    expect(boot.close).toBeTypeOf('function');
    await boot.close?.();
    expect(
      new FileJournalStore(
        join(sessionsRoot, boot.sessionId, 'journal'),
      ).entries(),
    ).toEqual([]);
  });

  it('excludes a configured out-of-scope directory from boot and sweep', async () => {
    // On the interactive path: `[journal] outOfScope` reaches
    // bootTuiLane through the same runtimeRunDeps projection `kubic run`
    // uses, so a declared directory is never baselined and never swept here
    // either.
    const sessionsRoot = tmpRoot('reconcile-tui-oos-');
    const workspace = tmpRoot('ws-tui-oos-');
    mkdirSync(join(workspace, 'vendor'));
    writeFileSync(join(workspace, 'vendor', 'out.js'), 'gen\n');
    writeFileSync(join(workspace, 'in-scope.txt'), 'v1\n');
    const boot = await bootTuiLane(undefined, {
      sessionsRoot,
      env: new NodeExecutionEnv(workspace),
      models: fauxModels(),
      reconcileOutOfScope: ['vendor'],
    });
    const journalDir = join(sessionsRoot, boot.sessionId, 'journal');
    const baseline = JSON.parse(
      readFileSync(join(journalDir, `baseline-${boot.sessionId}.json`), 'utf8'),
    ) as Record<string, string>;
    expect(Object.keys(baseline).sort()).toEqual(['in-scope.txt']);

    // A build/formatter moves both: only the in-scope change is journaled.
    writeFileSync(join(workspace, 'vendor', 'out.js'), 'rebuilt\n');
    writeFileSync(join(workspace, 'in-scope.txt'), 'v2\n');
    await boot.close?.();
    expect(
      new FileJournalStore(journalDir).entries().map((e) => e.path),
    ).toEqual(['in-scope.txt']);
  });
});
