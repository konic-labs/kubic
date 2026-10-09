// The end-to-end trust flow at the
// composition-root seam: `kubic trust` records, `kubic run` loads the
// project layer with no env var set, `kubic trust --revoke` brings the
// refusal back. The binary drives exactly these two halves (`runTrustCommand`
// and `loadCliConfig`); no process is spawned, no network is touched.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ProjectTrustStore,
  projectTrustStorePath,
  runTrustCommand,
} from '@kubic/host/config';
import { afterEach, describe, expect, it } from 'vitest';
import { loadCliConfig } from './config-runtime.js';

const made: string[] = [];

function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe('kubic trust → kubic run → kubic trust --revoke', () => {
  it('makes a committed .kubic/config.toml usable, then refuses it again', () => {
    const home = tmpDir('kubic-trust-flow-home-');
    const project = tmpDir('kubic-trust-flow-repo-');
    mkdirSync(join(project, '.kubic'), { recursive: true });
    writeFileSync(
      join(project, '.kubic', 'config.toml'),
      '[journal]\nretentionDays = 5\n[model]\nprovider = "faux"\nid = "echo"\n',
    );
    const store = new ProjectTrustStore(projectTrustStorePath(home));
    const lines: string[] = [];
    const deps = {
      out: (line: string) => {
        lines.push(line);
      },
      store,
      cwd: project,
    };

    // Before trust: the project layer is refused by path, naming the
    // remedies — reported, never silently ignored.
    const before = loadCliConfig({ cwd: project, home, env: {} });
    expect(before.runtime).toBeUndefined();
    expect(before.error).toContain('refused pre-trust');
    expect(before.error).toContain('kubic trust');
    expect(before.error).toContain('KUBIC_TRUST_PROJECT=1');
    expect(before.trust.present).toBe(true);
    expect(before.trust.decision).toBe(null);

    // `kubic trust` in the repo…
    expect(runTrustCommand({}, deps).exitCode).toBe(0);
    expect(store.get(project)).toBe(true);

    // …then `kubic run` there loads the project layer with NO env var.
    const after = loadCliConfig({ cwd: project, home, env: {} });
    expect(after.error).toBeUndefined();
    expect(after.runtime?.projectTrusted).toBe(true);
    expect(after.runtime?.journal.retentionDays).toBe(5);
    expect(after.runtime?.model).toEqual({ provider: 'faux', id: 'echo' });
    expect(after.trust.decision).toBe(true);

    // `kubic trust --revoke` brings the refusal back.
    expect(runTrustCommand({ revoke: true }, deps).exitCode).toBe(0);
    const revoked = loadCliConfig({ cwd: project, home, env: {} });
    expect(revoked.runtime).toBeUndefined();
    expect(revoked.error).toContain('refused pre-trust');
    expect(revoked.trust.decision).toBe(null);
  });

  it('trusting one directory never trusts a sibling', () => {
    const home = tmpDir('kubic-trust-flow-home-');
    const root = tmpDir('kubic-trust-flow-root-');
    const a = join(root, 'a');
    const sibling = join(root, 'a-sibling');
    for (const dir of [a, sibling]) {
      mkdirSync(join(dir, '.kubic'), { recursive: true });
      writeFileSync(
        join(dir, '.kubic', 'config.toml'),
        '[journal]\nretentionDays = 5\n',
      );
    }
    const store = new ProjectTrustStore(projectTrustStorePath(home));
    runTrustCommand({ path: a }, { out: () => undefined, store, cwd: root });
    expect(loadCliConfig({ cwd: a, home, env: {} }).error).toBeUndefined();
    const other = loadCliConfig({ cwd: sibling, home, env: {} });
    expect(other.runtime).toBeUndefined();
    expect(other.error).toContain('refused pre-trust');
  });
});
