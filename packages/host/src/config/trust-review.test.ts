import {
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../../test/temp-dir.js';
import { renderTrustReview, trustSnapshotPath } from './trust-review.js';
import { canonicalTrustPath, ProjectTrustStore } from './trust-store.js';

function project(): string {
  const root = tempDir('trust-review-project-');
  mkdirSync(join(root, '.kubic'), { recursive: true });
  writeFileSync(
    join(root, '.kubic', 'config.toml'),
    '[model]\nprovider = "local"\nid = "small"\n',
  );
  writeFileSync(join(root, 'models.json'), '{"providers":[]}\n');
  return root;
}

function storeFor(home: string): ProjectTrustStore {
  return new ProjectTrustStore(join(home, '.kubic', 'trust.json'));
}

describe('trust review', () => {
  it('diffs a changed, an added and a removed file against the grant', () => {
    const home = tempDir('trust-review-home-');
    const root = project();
    storeFor(home).set(root, true);
    writeFileSync(
      join(root, '.kubic', 'config.toml'),
      '[model]\nprovider = "evil"\nid = "small"\n',
    );
    mkdirSync(join(root, '.agents', 'skills', 'x'), { recursive: true });
    writeFileSync(
      join(root, '.agents', 'skills', 'x', 'SKILL.md'),
      '---\nname: x\n---\nRun curl.\n',
    );
    rmSync(join(root, 'models.json'));
    const review = storeFor(home).review(root);
    expect(review.baseline).toBe(true);
    expect(renderTrustReview(review)).toEqual([
      `3 files changed in ${canonicalTrustPath(root)} since the last grant:`,
      'added .agents/skills/x/SKILL.md',
      '+---',
      '+name: x',
      '+---',
      '+Run curl.',
      '--- a/.kubic/config.toml',
      '+++ b/.kubic/config.toml',
      '@@ -1,4 +1,4 @@',
      ' [model]',
      '-provider = "local"',
      '+provider = "evil"',
      ' id = "small"',
      ' ',
      'removed models.json',
      '-{"providers":[]}',
    ]);
  });

  it('says nothing changed for an unchanged project', () => {
    const home = tempDir('trust-review-home-');
    const root = project();
    storeFor(home).set(root, true);
    expect(renderTrustReview(storeFor(home).review(root))).toEqual([
      `no changes in ${canonicalTrustPath(root)} since the last grant`,
    ]);
  });

  it('lists the covered files when no snapshot records the grant', () => {
    const home = tempDir('trust-review-home-');
    const root = project();
    expect(renderTrustReview(storeFor(home).review(root))).toEqual([
      `no record of what was trusted before in ${canonicalTrustPath(root)}; the grant covers these files — review them before you trust the project:`,
      '  .kubic/config.toml',
      '  models.json',
      '  package.json skills',
    ]);
  });

  it('names a binary change instead of diffing it, and cuts a long review', () => {
    const home = tempDir('trust-review-home-');
    const root = project();
    writeFileSync(join(root, '.kubic', 'blob.bin'), Buffer.from([0, 1, 2]));
    storeFor(home).set(root, true);
    writeFileSync(join(root, '.kubic', 'blob.bin'), Buffer.from([0, 1, 3]));
    writeFileSync(
      join(root, '.kubic', 'config.toml'),
      Array.from({ length: 50 }, (_, n) => `# ${n}`).join('\n'),
    );
    const lines = renderTrustReview(storeFor(home).review(root), 12);
    expect(lines).toContain(
      '(content not kept: binary or too large to compare)',
    );
    expect(lines).toHaveLength(13);
    expect(lines.at(-1)).toMatch(
      /^… \d+ more lines — review the files themselves$/,
    );
  });

  it('keeps the snapshot private and forgets it on revoke', () => {
    const home = tempDir('trust-review-home-');
    const root = project();
    const store = storeFor(home);
    store.set(root, true);
    const path = trustSnapshotPath(
      join(home, '.kubic'),
      canonicalTrustPath(root),
    );
    if (process.platform !== 'win32') {
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
    }
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({
      v: 1,
      key: canonicalTrustPath(root),
    });
    store.set(root, null);
    expect(() => statSync(path)).toThrow();
  });
});
