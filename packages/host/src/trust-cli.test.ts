// `kubic trust`: grant, revoke and list the persistent
// project-trust decision.

import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CliUsageError } from '../../core/src/cli/exit-codes.js';
import {
  ProjectTrustStore,
  projectTrustStorePath,
} from './config/trust-store.js';
import { runTrustCommand } from './trust-cli.js';

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

function projectWithConfig(): string {
  const project = tmpDir('kubic-trust-cli-');
  mkdirSync(join(project, '.kubic'), { recursive: true });
  writeFileSync(join(project, '.kubic', 'config.toml'), '[journal]\n');
  return project;
}

function harness(store: ProjectTrustStore, cwd: string) {
  const lines: string[] = [];
  return {
    lines,
    deps: {
      out: (line: string) => {
        lines.push(line);
      },
      store,
      cwd,
    },
  };
}

describe('kubic trust command', () => {
  it('grants trust for the cwd and names the config it unlocks', () => {
    const home = tmpDir('kubic-trust-home-');
    const project = projectWithConfig();
    const store = new ProjectTrustStore(projectTrustStorePath(home));
    const h = harness(store, project);
    expect(runTrustCommand({}, h.deps)).toBe(0);
    expect(store.get(project)).toBe(true);
    expect(h.lines.join('\n')).toContain('trusted project');
    expect(h.lines.join('\n')).toContain('.kubic/config.toml will load');
    expect(h.lines.join('\n')).toContain(projectTrustStorePath(home));
  });

  // One grant unlocks the whole project tree, not just config.toml: the
  // project models.json (a provider URL and the `*_API_KEY` sent to it) and
  // the project skills. The output says so, on the grant and not on revoke.
  it('names everything the grant covers, models.json and skills included', () => {
    const home = tmpDir('kubic-trust-home-');
    const project = projectWithConfig();
    const store = new ProjectTrustStore(projectTrustStorePath(home));
    const granted = harness(store, project);
    expect(runTrustCommand({}, granted.deps)).toBe(0);
    expect(granted.lines).toContain(
      "this grant also covers the project's models.json (provider URLs, sent the key of any *_API_KEY or KUBIC_* variable it names — KUBIC_API_KEY by default) and its project skills",
    );
    const revoked = harness(store, project);
    expect(runTrustCommand({ revoke: true }, revoked.deps)).toBe(0);
    expect(revoked.lines.join('\n')).not.toContain('models.json');
  });

  it('grants for an explicit path operand', () => {
    const home = tmpDir('kubic-trust-home-');
    const project = projectWithConfig();
    const other = projectWithConfig();
    const store = new ProjectTrustStore(projectTrustStorePath(home));
    const h = harness(store, project);
    expect(runTrustCommand({ path: other }, h.deps)).toBe(0);
    expect(store.get(other)).toBe(true);
    expect(store.get(project)).toBe(null);
  });

  it('accepts a relative path operand resolved against the process cwd', () => {
    const home = tmpDir('kubic-trust-home-');
    const project = projectWithConfig();
    const store = new ProjectTrustStore(projectTrustStorePath(home));
    const h = harness(store, tmpDir('kubic-trust-cli-'));
    const rel = relative(process.cwd(), project);
    expect(runTrustCommand({ path: rel }, h.deps)).toBe(0);
    expect(store.get(project)).toBe(true);
  });

  it('notes when no project config exists yet', () => {
    const home = tmpDir('kubic-trust-home-');
    const project = tmpDir('kubic-trust-cli-');
    const store = new ProjectTrustStore(projectTrustStorePath(home));
    const h = harness(store, project);
    expect(runTrustCommand({}, h.deps)).toBe(0);
    expect(store.get(project)).toBe(true);
    expect(h.lines.join('\n')).toContain('no project config at');
  });

  it('revokes: the decision is removed and the refusal named', () => {
    const home = tmpDir('kubic-trust-home-');
    const project = projectWithConfig();
    const store = new ProjectTrustStore(projectTrustStorePath(home));
    store.set(project, true);
    const h = harness(store, project);
    expect(runTrustCommand({ revoke: true }, h.deps)).toBe(0);
    expect(store.get(project)).toBe(null);
    expect(h.lines.join('\n')).toContain('revoked project trust');
    expect(h.lines.join('\n')).toContain('refused again');
  });

  it('lists every recorded decision, sorted', () => {
    const home = tmpDir('kubic-trust-home-');
    const a = join(home, 'aaa');
    const z = join(home, 'zzz');
    mkdirSync(a);
    mkdirSync(z);
    const store = new ProjectTrustStore(projectTrustStorePath(home));
    store.set(z, false);
    store.set(a, true);
    const h = harness(store, join(home, 'elsewhere'));
    expect(runTrustCommand({ list: true }, h.deps)).toBe(0);
    expect(h.lines).toHaveLength(2);
    expect(h.lines[0]).toMatch(/^trusted /);
    expect(h.lines[0]).toContain(a);
    expect(h.lines[1]).toMatch(/^declined /);
    expect(h.lines[1]).toContain(z);
  });

  it('reports an empty store on --list', () => {
    const home = tmpDir('kubic-trust-home-');
    const store = new ProjectTrustStore(projectTrustStorePath(home));
    const h = harness(store, home);
    expect(runTrustCommand({ list: true }, h.deps)).toBe(0);
    expect(h.lines.join('\n')).toContain('no project trust decisions recorded');
  });

  it('refuses --list combined with --revoke or a path (usage, exit 2)', () => {
    const home = tmpDir('kubic-trust-home-');
    const store = new ProjectTrustStore(projectTrustStorePath(home));
    const h = harness(store, home);
    expect(() => runTrustCommand({ list: true, revoke: true }, h.deps)).toThrow(
      CliUsageError,
    );
    expect(() => runTrustCommand({ list: true, path: home }, h.deps)).toThrow(
      CliUsageError,
    );
  });

  it('refuses a path that is not a directory (usage, exit 2)', () => {
    const home = tmpDir('kubic-trust-home-');
    const file = join(home, 'notes.txt');
    writeFileSync(file, 'x');
    const store = new ProjectTrustStore(projectTrustStorePath(home));
    const h = harness(store, home);
    expect(() => runTrustCommand({ path: file }, h.deps)).toThrow(
      /not a directory/,
    );
    expect(() =>
      runTrustCommand({ path: join(home, 'absent') }, h.deps),
    ).toThrow(/no such directory/);
  });

  // The store canonicalises symlinks, so the operand check follows them too: a
  // symlink to a project directory is a project directory. It used to be
  // refused as "not a directory" (lstat).
  describe('a symlink operand', () => {
    it('to a directory is granted, under the canonical (resolved) path', () => {
      const home = tmpDir('kubic-trust-home-');
      const project = projectWithConfig();
      const link = join(home, 'project-link');
      symlinkSync(project, link, 'dir');
      const store = new ProjectTrustStore(projectTrustStorePath(home));
      const h = harness(store, home);
      expect(runTrustCommand({ path: link }, h.deps)).toBe(0);
      expect(store.get(project)).toBe(true);
      expect(store.get(link)).toBe(true);
      expect(store.entries().map((entry) => entry.path)).toEqual([
        realpathSync(project),
      ]);
      expect(h.lines.join('\n')).toContain(
        `trusted project ${realpathSync(project)}`,
      );
    });

    it('to a directory can be revoked', () => {
      const home = tmpDir('kubic-trust-home-');
      const project = projectWithConfig();
      const link = join(home, 'project-link');
      symlinkSync(project, link, 'dir');
      const store = new ProjectTrustStore(projectTrustStorePath(home));
      store.set(project, true);
      const h = harness(store, home);
      expect(runTrustCommand({ path: link, revoke: true }, h.deps)).toBe(0);
      expect(store.get(project)).toBe(null);
    });

    it('to a file is still refused as not a directory', () => {
      const home = tmpDir('kubic-trust-home-');
      const file = join(home, 'notes.txt');
      writeFileSync(file, 'x');
      const link = join(home, 'file-link');
      symlinkSync(file, link);
      const store = new ProjectTrustStore(projectTrustStorePath(home));
      const h = harness(store, home);
      expect(() => runTrustCommand({ path: link }, h.deps)).toThrow(
        /not a directory/,
      );
      expect(store.entries()).toEqual([]);
    });

    it('that dangles is refused as no such directory', () => {
      const home = tmpDir('kubic-trust-home-');
      const link = join(home, 'dangling');
      symlinkSync(join(home, 'gone'), link, 'dir');
      const store = new ProjectTrustStore(projectTrustStorePath(home));
      const h = harness(store, home);
      expect(() => runTrustCommand({ path: link }, h.deps)).toThrow(
        /no such directory/,
      );
      expect(store.entries()).toEqual([]);
    });
  });

  it('fails closed with the named file when the store is corrupt (exit 1)', () => {
    const home = tmpDir('kubic-trust-home-');
    const project = projectWithConfig();
    const path = projectTrustStorePath(home);
    mkdirSync(join(home, '.kubic'), { recursive: true });
    writeFileSync(path, 'garbage');
    const store = new ProjectTrustStore(path);
    const h = harness(store, project);
    expect(runTrustCommand({}, h.deps)).toBe(1);
    expect(h.lines.join('\n')).toContain(path);
    expect(store.get(project)).toBe(null);
  });
});
