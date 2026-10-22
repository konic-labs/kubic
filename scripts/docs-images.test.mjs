// Every image under docs/assets has a generator: a kshot scenario snap (or
// its film) named in SHOTS, or the brand art. So `npm run docs:images` can
// always remake what the README and docs show.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ART, SHOTS } from './docs-images.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCENARIOS = join(ROOT, 'scripts', 'kshot', 'scenarios');

describe('docs images', () => {
  it('takes each file from a scenario step that writes it', () => {
    for (const [scenario, files] of Object.entries(SHOTS)) {
      const text = readFileSync(join(SCENARIOS, `${scenario}.kshot`), 'utf8');
      const snaps = new Set(
        [...text.matchAll(/^snap (\S+)$/gm)].map((m) => `${m[1]}.svg`),
      );
      if (/^frame \d+$/m.test(text)) snaps.add('film.svg');
      for (const from of Object.keys(files)) {
        assert.ok(snaps.has(from), `${scenario}.kshot writes no ${from}`);
      }
    }
  });

  it('has a generator for every image under docs/assets', () => {
    const made = new Set(
      Object.values(SHOTS).flatMap((files) => Object.values(files)),
    );
    for (const folder of readdirSync(join(ROOT, 'docs', 'assets'))) {
      for (const name of readdirSync(join(ROOT, 'docs', 'assets', folder))) {
        const path = `${folder}/${name}`;
        assert.ok(
          made.has(path) || (folder === 'readme' && ART.test(name)),
          `docs/assets/${path} has no generator in scripts/docs-images.mjs`,
        );
      }
    }
  });
});
