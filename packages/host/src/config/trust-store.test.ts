// Persistent project-trust store. The store is the
// durable half of the trust decision: one JSON file under `~/.kubic/`,
// keyed by the canonical project path, holding true (trusted) or false
// (declined) — an absent key is "no decision yet". Trust is exact-path:
// a decision for one directory is never inherited by its children or
// leaked to a sibling (`/a` never trusts `/a-sibling`).

import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../../test/temp-dir.js';
import {
  canonicalTrustPath,
  ProjectTrustStore,
  projectTrustCheck,
  projectTrustReport,
  projectTrustStorePath,
} from './trust-store.js';

function storeFor(home: string): ProjectTrustStore {
  return new ProjectTrustStore(projectTrustStorePath(home));
}

describe('project trust store', () => {
  it('records a trust decision and reads it back', () => {
    const home = tempDir();
    const project = tempDir();
    const store = storeFor(home);
    expect(store.get(project)).toBe(null);
    store.set(project, true);
    expect(store.get(project)).toBe(true);
    expect(store.get(project)).toBe(true); // durable across instances too
    const reread = new ProjectTrustStore(projectTrustStorePath(home));
    expect(reread.get(project)).toBe(true);
  });

  it('records a declined decision as false, distinct from undecided', () => {
    const home = tempDir();
    const project = tempDir();
    const store = storeFor(home);
    store.set(project, false);
    expect(store.get(project)).toBe(false);
  });

  it('revoke removes the recorded decision (the refusal comes back)', () => {
    const home = tempDir();
    const project = tempDir();
    const store = storeFor(home);
    store.set(project, true);
    store.set(project, null);
    expect(store.get(project)).toBe(null);
    expect(store.entries()).toEqual([]);
  });

  it('is exact-path: trusting /a never trusts /a-sibling', () => {
    const home = tempDir();
    const root = tempDir();
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
    const home = tempDir();
    const parent = tempDir();
    const child = join(parent, 'child');
    mkdirSync(child);
    const store = storeFor(home);
    store.set(parent, true);
    expect(store.get(child)).toBe(null);
  });

  it('keys a symlinked path to its canonical target', () => {
    const home = tempDir();
    const root = tempDir();
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
    const home = tempDir();
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
    const home = tempDir();
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
    const home = tempDir();
    const project = tempDir();
    const path = projectTrustStorePath(home);
    mkdirSync(join(home, '.kubic'), { recursive: true });
    writeFileSync(path, 'not json');
    const store = new ProjectTrustStore(path);
    expect(store.get(project)).toBe(null);
    expect(() => store.entries()).toThrow(/trust store/);
    expect(() => store.set(project, true)).toThrow(/trust store/);
  });

  it('refuses an empty or relative home instead of keying the store to the cwd', () => {
    expect(() => projectTrustStorePath('')).toThrow(/absolute home/);
    expect(() => projectTrustStorePath('relative/home')).toThrow(
      /absolute home/,
    );
    expect(() =>
      projectTrustReport({ home: '', cwd: '/repo', env: {} }),
    ).toThrow(/absolute home/);
  });

  it('reads an unreadable store as no decision and names it for the doctor', () => {
    const home = tempDir();
    const path = projectTrustStorePath(home);
    mkdirSync(join(home, '.kubic'), { recursive: true });
    symlinkSync(path, path); // a self-loop: lstat sees a link, readFile ELOOPs
    const store = new ProjectTrustStore(path);
    expect(store.get('/repo')).toBe(null);
    expect(store.entries()).toEqual([]);
    const report = projectTrustReport({ home, cwd: '/repo', env: {} });
    expect(report.trusted).toBe(false);
    expect(report.storeError).toBeDefined();
  });

  it('checks trust for the path the files live in, never the process cwd', () => {
    const home = tempDir();
    const root = tempDir();
    const child = join(root, 'pkg');
    mkdirSync(child);
    const store = storeFor(home);
    store.set(root, true);
    const rootGrant = projectTrustCheck({ home, env: {}, store });
    expect(rootGrant(root)).toBe(true);
    expect(rootGrant(child)).toBe(false);
    store.set(root, null);
    store.set(child, true);
    const childGrant = projectTrustCheck({ home, env: {}, store });
    expect(childGrant(child)).toBe(true);
    expect(childGrant(root)).toBe(false);
  });

  it('serializes a racing writer instead of losing its update', async () => {
    const home = tempDir();
    const project = tempDir();
    const other = tempDir();
    const store = storeFor(home);
    // A racing writer holds the lock and has just committed its own grant;
    // the released writer must read that content after the wait and keep it.
    mkdirSync(join(home, '.kubic'), { recursive: true });
    const lock = `${store.file}.lock`;
    writeFileSync(
      store.file,
      `${JSON.stringify({ [canonicalTrustPath(other)]: true }, null, 2)}\n`,
    );
    const held = openSync(lock, 'wx');
    // The release must come from another thread: the waiting set() blocks
    // this one in Atomics.wait, where a timer could never fire.
    const release = new Worker(
      `const { rmSync } = require('node:fs');
       const { workerData } = require('node:worker_threads');
       setTimeout(() => rmSync(workerData.lock, { force: true }), 25);`,
      { eval: true, workerData: { lock } },
    );
    try {
      store.set(project, true);
    } finally {
      closeSync(held);
      await release.terminate();
    }
    expect(store.get(project)).toBe(true);
    expect(store.get(other)).toBe(true);
  });
});

describe('project trust report', () => {
  function projectWithConfig(): string {
    const project = tempDir();
    mkdirSync(join(project, '.kubic'), { recursive: true });
    writeFileSync(join(project, '.kubic', 'config.toml'), '[journal]\n');
    return project;
  }

  it('reports a recorded trust decision as the effective gate', () => {
    const home = tempDir();
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
    const home = tempDir();
    const project = projectWithConfig();
    const report = projectTrustReport({ home, cwd: project });
    expect(report.present).toBe(true);
    expect(report.decision).toBe(null);
    expect(report.trusted).toBe(false);
  });

  it('records KUBIC_TRUST_PROJECT=1 as trusted even without a store entry', () => {
    const home = tempDir();
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
    const home = tempDir();
    const project = tempDir();
    const report = projectTrustReport({ home, cwd: project });
    expect(report.present).toBe(false);
    expect(report.trusted).toBe(false);
  });

  it('names a corrupt store in the report without trusting it', () => {
    const home = tempDir();
    mkdirSync(join(home, '.kubic'), { recursive: true });
    writeFileSync(projectTrustStorePath(home), 'not json');
    const report = projectTrustReport({ home, cwd: '/repo', env: {} });
    expect(report.trusted).toBe(false);
    expect(report.storeError).toContain('not valid JSON');
  });
});

// The trust store is Kubic state like the sessions: private whichever command
// creates it first, and a loose state directory is tightened on the next
// write.
describe('trust store permissions', () => {
  it.skipIf(process.platform === 'win32')(
    'creates ~/.kubic 0700 and trust.json 0600 on a fresh home',
    () => {
      const home = tempDir('trust-modes-home-');
      const store = new ProjectTrustStore(projectTrustStorePath(home));
      store.set('/repo', true);
      expect(statSync(join(home, '.kubic')).mode & 0o777).toBe(0o700);
      expect(statSync(store.file).mode & 0o777).toBe(0o600);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'tightens a loose ~/.kubic on the next write, and only a .kubic directory',
    () => {
      const home = tempDir('trust-modes-loose-');
      mkdirSync(join(home, '.kubic'), { mode: 0o755 });
      chmodSync(join(home, '.kubic'), 0o755);
      new ProjectTrustStore(projectTrustStorePath(home)).set('/repo', false);
      expect(statSync(join(home, '.kubic')).mode & 0o777).toBe(0o700);
      const elsewhere = tempDir('trust-modes-elsewhere-');
      chmodSync(elsewhere, 0o755);
      new ProjectTrustStore(join(elsewhere, 'trust.json')).set('/repo', true);
      expect(statSync(elsewhere).mode & 0o777).toBe(0o755);
    },
  );
});
