// Real-world command shapes -> the exact capability set the shipped
// trigger context raises. `git push` is matched at any position (`ls; git push`,
// `cd x && git push`, `git -C . push`); INSTALL covers the package managers the
// policy lists; and the destructive-shell arms cover force pushes, `find -delete`
// and the working-tree-discarding git forms. The table uses the PRODUCTION context
// (triggerContextFor), so a green run proves what `kubic run` classifies.
import { describe, expect, it } from 'vitest';
import { SOLO_DEFAULTS } from '../../agents/src/policy.js';
import {
  type Capability,
  detectTriggers,
  triggerContextFor,
} from './approvals.js';

const ctx = triggerContextFor(SOLO_DEFAULTS, '/work', '/home/u');

function raised(command: string): Capability[] {
  return detectTriggers('bash', { command }, ctx).sort();
}

describe('command shapes -> capabilities', () => {
  it.each<[string, Capability[]]>([
    // git push in any segment, after git global options.
    [
      'cd /work && git push --force origin main',
      ['destructive-shell', 'git-push'],
    ],
    ['ls; git push', ['git-push']],
    ['ls\ngit push', ['git-push']],
    ['make || git push origin main', ['git-push']],
    ['(git push)', ['git-push']],
    ['git -C . push', ['git-push']],
    ['git -C /work/sub push origin main', ['git-push']],
    ['git -c x=y push', ['git-push']],
    ['git --git-dir=.git --work-tree=. push', ['git-push']],
    ['git --no-pager push', ['git-push']],
    ['ls && git -C . remote add evil https://x', ['git-push']],
    ['git push', ['git-push']],
    // Force pushes are destructive too.
    ['git push -f', ['destructive-shell', 'git-push']],
    ['git push --force-with-lease', ['destructive-shell', 'git-push']],
    ['git push origin +main', ['destructive-shell', 'git-push']],
    ['git push -uf origin main', ['destructive-shell', 'git-push']],
    // Installs through every common package manager.
    ['pnpm add evil', ['install']],
    ['pnpm install', ['install']],
    ['pnpm dlx create-x', ['install']],
    ['yarn add x', ['install']],
    ['yarn', ['install']],
    ['yarn install', ['install']],
    ['yarn; ls', ['install']],
    ['cd app && yarn && yarn build', ['install']],
    ['yarn dlx x', ['install']],
    ['bun add x', ['install']],
    ['bun install', ['install']],
    ['bunx x', ['install']],
    ['npx some-pkg', ['install']],
    ['npm ci', ['install']],
    ['npm exec x', ['install']],
    ['npm x some-pkg', ['install']],
    ['pipx install x', ['install']],
    ['pipx run x', ['install']],
    ['uv add x', ['install']],
    ['uv pip install x', ['install']],
    ['uv tool install x', ['install']],
    ['uvx x', ['install']],
    ['gem install x', ['install']],
    ['composer require x', ['install']],
    ['composer install', ['install']],
    ['ls && npm i left-pad', ['install']],
    // Destructive shapes.
    ['find / -delete', ['destructive-shell']],
    ['find . -name "*.log" -delete', ['destructive-shell']],
    ['git reset --hard HEAD~5', ['destructive-shell']],
    ['git checkout -- .', ['destructive-shell']],
    ['git checkout .', ['destructive-shell']],
    ['git checkout -f main', ['destructive-shell']],
    ['git restore .', ['destructive-shell']],
    ['git restore src/a.ts', ['destructive-shell']],
    ['git restore --staged --worktree .', ['destructive-shell']],
  ])('%s', (command, expected) => {
    expect(raised(command)).toEqual(expected);
  });

  it.each<[string, Capability[]]>([
    ['git status; git log', []],
    ['npm test', []],
    ['npm run build', []],
    ['yarn build', []],
    ['pnpm test', []],
    ['bun run dev', []],
    ['uv run pytest', []],
    ['git checkout -b feature', []],
    ['git checkout main', []],
    ['git restore --staged a.ts', []],
    ['git reset --soft HEAD~1', []],
    ['find . -name "*.ts"', []],
    ['git log --oneline | grep push', []],
    // A push named only inside a quoted argument still raises: the literal
    // scan cannot see quotes, and an over-trigger is an ask, never a grant.
    ['echo "run git push later"', ['git-push']],
  ])('%s', (command, expected) => {
    expect(raised(command)).toEqual(expected);
  });
});
