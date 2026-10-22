// kshot's own tests are Python (scripts/kshot/test_kshot.py): its scenario,
// colour and screen parsing and its font choice, none of which needs tmux or
// Pillow. This gate runs them wherever python3 is installed.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const python = spawnSync('python3', ['--version']);

it('kshot parses scenarios, colours and screens, and finds a font', {
  skip: python.status === 0 ? false : 'python3 is not installed',
}, () => {
  const result = spawnSync(
    'python3',
    ['-m', 'unittest', 'discover', '-s', 'scripts/kshot', '-p', 'test_*.py'],
    {
      cwd: ROOT,
      encoding: 'utf8',
      // No __pycache__ inside the checkout.
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    },
  );
  assert.equal(result.status, 0, result.stderr);
});
