// Doctor's extension counts come from the STARTUP object (issue #93).
//
// #80's doctor probe was its own load. Now the composition root loads the
// bundle once at startup and doctor projects that same object, so the
// reported counts cannot drift from what the lanes actually loaded. These
// tests pin the projection and the CLI wiring that uses it.
//
// The load runs for real against the repo's own skills/budget bundle
// (FileBridge only, no lane, no provider) — zero network.
import { describe, expect, it } from 'vitest';
import {
  extensionPostureForDoctor,
  loadExtensionStartup,
  prodExtensionStartupOptions,
} from '../../../apps/kubic/src/extension-startup.js';
import { postureFromStartup } from '../../extensions/src/runtime.js';
import type { BundleDirFiles } from '../../extensions/src/startup.js';
import { loadFirstPartyBundle } from '../../extensions/src/startup.js';
import { type DoctorDeps, runDoctorCommand } from './doctor.js';

function missingBundleFiles(): BundleDirFiles {
  return {
    joinPath: (parts: string[]) => parts.join('/'),
    exists: () => false,
    fileInfo: () => {
      throw new Error('ENOENT: no such file');
    },
    readTextFile: () => {
      throw new Error('ENOENT: no such file');
    },
  };
}

describe('doctor counts from the startup object (issue #93)', () => {
  it('projects loaded and refused counts off one startup object, never a second probe', async () => {
    const startup = await loadFirstPartyBundle(
      prodExtensionStartupOptions(process.cwd()),
    );
    const posture = postureFromStartup(startup);
    // The projection IS the startup object's data — same arrays, same count.
    expect(posture.ok).toBe(startup.ok);
    expect(posture.loaded).toEqual(startup.loaded);
    expect(posture.refusedCount).toBe(startup.refused.length);
    expect(posture.detail).toBe(startup.detail);
  });

  it('reports the production counts the doctor surface prints', async () => {
    const posture = await extensionPostureForDoctor();
    expect(posture.ok).toBe(true);
    expect(posture.loaded).toEqual(['kubic/budget']);
    expect(posture.refusedCount).toBe(2);
    expect(posture.detail).toContain(
      'loaded 1 (kubic/budget: budget: none configured)',
    );
  });

  it('prints the startup object counts on the extension:bundle line', async () => {
    const lines: string[] = [];
    const startup = await loadExtensionStartup('doctor', process.cwd());
    if (startup === undefined) throw new Error('doctor must load extensions');
    const deps: DoctorDeps = {
      out: (line: string) => lines.push(line),
      probeProviders: () => [
        { id: 'faux', reachable: true, models: ['faux/test'] },
      ],
      checkDeps: () => [
        {
          id: 'node',
          ok: true,
          detail: `node ${process.versions.node} (need >=22.19)`,
        },
      ],
      loadPolicy: () => ({ route: 'ask-user', autoApprove: [] }),
      probeExtensions: () => postureFromStartup(startup),
    };
    const code = await runDoctorCommand([], deps);
    expect(code).toBe(0);
    const printed = lines.join('\n');
    // The counts on the line are exactly the startup object's.
    expect(printed).toContain(`PASS extension:bundle (ok): ${startup.detail}`);
    expect(startup.loaded.length).toBe(1);
    expect(startup.refused.length).toBe(2);
    expect(printed).toContain('loaded 1');
    expect(printed).toContain('refused 2');
  });

  it('reports a degraded startup object as the same failing line doctor already prints', async () => {
    // The fail-closed startup load, taken as data: doctor must still print
    // the named error (its own exit code is non-zero) while the lanes refuse
    // to boot.
    const posture = await extensionPostureForDoctor({
      options: {
        ...prodExtensionStartupOptions(process.cwd()),
        files: missingBundleFiles(),
      },
    });
    expect(posture.ok).toBe(false);
    expect(posture.loaded).toEqual([]);
    expect(posture.refusedCount).toBe(0);
    expect(posture.detail).toContain('skills/budget');

    const lines: string[] = [];
    const deps: DoctorDeps = {
      out: (line: string) => lines.push(line),
      probeProviders: () => [
        { id: 'faux', reachable: true, models: ['faux/test'] },
      ],
      checkDeps: () => [
        {
          id: 'node',
          ok: true,
          detail: `node ${process.versions.node} (need >=22.19)`,
        },
      ],
      loadPolicy: () => ({ route: 'ask-user', autoApprove: [] }),
      probeExtensions: () => posture,
    };
    const code = await runDoctorCommand([], deps);
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain(
      'FAIL extension:bundle (extension-posture): extension bundle dir missing',
    );
  });
});
