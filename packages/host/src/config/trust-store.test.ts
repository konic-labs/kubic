// Persistent project-trust store (issue #228; §35.1). The store is the
// durable half of the trust decision: one JSON file under `~/.kubic/`,
// keyed by the canonical project path, holding true (trusted) or false
// (declined) — an absent key is "no decision yet". Trust is exact-path:
// a decision for one directory is never inherited by its children or
// leaked to a sibling (`/a` never trusts `/a-sibling`).
//
// RED first: the module does not exist yet.

import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  canonicalTrustPath,
  ProjectTrustStore,
  projectTrustReport,
  projectTrustStorePath,
} from './trust-store.js';

const made: string[] = [];

function tmpDir(prefix = 'kubic-trust-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function storeFor(home: string): ProjectTrustStore {
  return new ProjectTrustStore(projectTrustStorePath(home));
}

describe('project trust store (issue #228)', () => {
  it('records a trust decision and reads it back', () => {
    const home = tmpDir();
    const project = tmpDir();
    const store = storeFor(home);
    expect(store.get(project)).toBe(null);
    store.set(project, true);
    expect(store.get(project)).toBe(true);
    expect(store.get(project)).toBe(true); // durable across instances too
    const reread = new ProjectTrustStore(projectTrustStorePath(home));
    expect(reread.get(project)).toBe(true);
  });

  it('records a declined decision as false, distinct from undecided', () => {
    const home = tmpDir();
    const project = tmpDir();
    const store = storeFor(home);
    store.set(project, false);
    expect(store.get(project)).toBe(false);
  });

  it('revoke removes the recorded decision (the refusal comes back)', () => {
    const home = tmpDir();
    const project = tmpDir();
    const store = storeFor(home);
    store.set(project, true);
    store.set(project, null);
    expect(store.get(project)).toBe(null);
    expect(store.entries()).toEqual([]);
  });

  it('is exact-path: trusting /a never trusts /a-sibling', () => {
    const home = tmpDir();
    const root = tmpDir();
    const a = join(root, 'a');
    const sibling = join(root, 'a-sibling');
    mkdirSync(a);
    mkdirSync(sibling);
    const store = storeFor(home);
    store.set(a, true);
    expect(store.get(a)).toBe(true);
    expect(store.get(sibling)).toBe(null);
  });

  it('never trusts parent directories implicitly', () => {
    const home = tmpDir();
    const parent = tmpDir();
    const child = join(parent, 'child');
    mkdirSync(child);
    const store = storeFor(home);
    store.set(parent, true);
    expect(store.get(child)).toBe(null);
  });

  it('keys a symlinked path to its canonical target', () => {
    const home = tmpDir();
    const root = tmpDir();
    const real = join(root, 'real');
    const link = join(root, 'link');
    mkdirSync(real);
    symlinkSync(real, link);
    const store = storeFor(home);
    store.set(link, true);
    expect(store.get(real)).toBe(true);
    expect(canonicalTrustPath(link)).toBe(canonicalTrustPath(real));
  });

  it('writes sorted JSON atomically and leaves no lock or tmp residue', () => {
    const home = tmpDir();
    const first = join(home, 'zzz-project');
    const second = join(home, 'aaa-project');
    mkdirSync(first);
    mkdirSync(second);
    const store = storeFor(home);
    store.set(first, true);
    store.set(second, false);
    const text = readFileSync(projectTrustStorePath(home), 'utf8');
    const written = JSON.parse(text) as Record<string, boolean>;
    expect(Object.keys(written)).toEqual(
      Object.keys(written).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    );
    expect(text.endsWith('\n')).toBe(true);
    const leftovers = readdirSync(join(home, '.kubic')).filter(
      (name) => name !== 'trust.json',
    );
    expect(leftovers).toEqual([]);
  });

  it('preserves an own `__proto__` key instead of polluting the prototype', () => {
    const home = tmpDir();
    const path = projectTrustStorePath(home);
    mkdirSync(join(home, '.kubic'), { recursive: true });
    writeFileSync(path, '{"__proto__": true, "/repo": false}');
    const store = new ProjectTrustStore(path);
    expect(store.entries()).toEqual([
      { path: '/repo', decision: false },
      { path: '__proto__', decision: true },
    ]);
    store.set('/other', true);
    const text = readFileSync(path, 'utf8');
    expect(text).toContain('"__proto__"');
  });

  it('keeps reads fail-closed and names the file on a corrupt store', () => {
    const home = tmpDir();
    const project = tmpDir();
    const path = projectTrustStorePath(home);
    mkdirSync(join(home, '.kubic'), { recursive: true });
    writeFileSync(path, 'not json');
    const store = new ProjectTrustStore(path);
    expect(store.get(project)).toBe(null);
    expect(() => store.entries()).toThrow(/trust store/);
    expect(() => store.set(project, true)).toThrow(/trust store/);
  });
});

describe('project trust report (issue #228)', () => {
  function projectWithConfig(): string {
    const project = tmpDir();
    mkdirSync(join(project, '.kubic'), { recursive: true });
    writeFileSync(join(project, '.kubic', 'config.toml'), '[journal]\n');
    return project;
  }

  it('reports a recorded trust decision as the effective gate', () => {
    const home = tmpDir();
    const project = projectWithConfig();
    storeFor(home).set(project, true);
    const report = projectTrustReport({ home, cwd: project });
    expect(report.present).toBe(true);
    expect(report.decision).toBe(true);
    expect(report.envTrust).toBe(false);
    expect(report.trusted).toBe(true);
    expect(report.configPath).toBe(join(project, '.kubic', 'config.toml'));
  });

  it('reports an undecided project with a present config as undecided', () => {
    const home = tmpDir();
    const project = projectWithConfig();
    const report = projectTrustReport({ home, cwd: project });
    expect(report.present).toBe(true);
    expect(report.decision).toBe(null);
    expect(report.trusted).toBe(false);
  });

  it('records KUBIC_TRUST_PROJECT=1 as trusted even without a store entry', () => {
    const home = tmpDir();
    const project = projectWithConfig();
    const report = projectTrustReport({
      home,
      cwd: project,
      env: { KUBIC_TRUST_PROJECT: '1' },
    });
    expect(report.decision).toBe(null);
    expect(report.envTrust).toBe(true);
    expect(report.trusted).toBe(true);
  });

  it('reports an absent project config as not present', () => {
    const home = tmpDir();
    const project = tmpDir();
    const report = projectTrustReport({ home, cwd: project });
    expect(report.present).toBe(false);
    expect(report.trusted).toBe(false);
  });
});
