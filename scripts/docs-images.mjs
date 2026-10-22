// Regenerates every image the README and docs/ show, into docs/assets/: the
// TUI's screens, each a snap (or the film) of a kshot scenario, and the brand
// art from scripts/art/art.py. Needs tmux and python3 with Pillow and
// fontTools; the art fetches its two fonts once. PYTHON names another
// interpreter (a virtualenv's, for example).
//
// Usage: node scripts/docs-images.mjs [--only tui|art]

import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = join(ROOT, 'docs', 'assets');

// Scenario -> {file kshot writes: path under docs/assets}.
export const SHOTS = {
  'readme-session': { 'film.svg': 'readme/session.svg' },
  'docs-tour': {
    'first-screen.svg': 'tui/first-screen.svg',
    'session.svg': 'tui/session.svg',
    'diff-panel.svg': 'tui/diff-panel.svg',
    'journal-panel.svg': 'tui/journal-panel.svg',
    'approval-card.svg': 'tui/approval-card.svg',
    'session-tree.svg': 'tui/session-tree.svg',
    'palette.svg': 'tui/palette.svg',
  },
};

// What scripts/art/art.py draws into docs/assets/readme.
export const ART = /^(?:banner|facts|footer|icon-[a-z]+)\.svg$/;

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} exited ${result.status ?? result.signal}`,
    );
  }
}

function screens(python) {
  run(process.execPath, ['scripts/build.mjs']);
  const scratch = mkdtempSync(join(tmpdir(), 'docs-images-'));
  try {
    for (const [scenario, files] of Object.entries(SHOTS)) {
      const out = join(scratch, scenario);
      run(python, ['scripts/kshot/kshot.py', scenario, '--out', out]);
      for (const [from, to] of Object.entries(files)) {
        mkdirSync(dirname(join(ASSETS, to)), { recursive: true });
        copyFileSync(join(out, from), join(ASSETS, to));
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const at = process.argv.indexOf('--only');
  const only = at === -1 ? undefined : process.argv[at + 1];
  const python = process.env.PYTHON ?? 'python3';
  if (only !== 'art') screens(python);
  if (only !== 'tui') run(python, ['scripts/art/art.py']);
  console.log('docs images written to docs/assets/');
}
