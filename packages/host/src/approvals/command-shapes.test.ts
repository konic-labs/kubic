// Real-world command shapes -> the exact capability set the shipped
// trigger context raises. `git push` is matched at any position (`ls; git push`,
// `cd x && git push`, `git -C . push`); INSTALL covers the package managers the
// policy lists; and the destructive-shell arms cover force pushes, `find -delete`
// and the working-tree-discarding git forms. The table uses the PRODUCTION context
// (triggerContextFor), so a green run proves what `kubic run` classifies.

import { DEFAULT_PERMISSIONS } from '@kubic/agent/permissions';
import { describe, expect, it } from 'vitest';
import type { Capability } from './policy.js';
import { detectTriggers, triggerContextFor } from './triggers.js';

const ctx = triggerContextFor(DEFAULT_PERMISSIONS, '/work', '/home/u');

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
    // A newline ends a command like `;`, CRLF included, and a payload behind
    // indirection is a script too.
    ['echo hi\nrm -rf /', ['destructive-shell']],
    ['set -e\necho hi\nrm -rf /etc', ['destructive-shell']],
    ['echo hi\r\nrm -rf /\r\n', ['destructive-shell']],
    ['echo $(echo hi\nrm -rf /)', ['destructive-shell']],
    ['cp a /etc/x\necho done', ['outside-write']],
    ['echo x | tee /etc/x\necho done', ['outside-write']],
    ['mv a /etc/x\r\necho done', ['outside-write']],
    // The network clients a coding agent uses, under network = "none".
    ['git fetch origin', ['network']],
    ['git clone https://example.com/r.git', ['network']],
    ['git -C sub pull', ['network']],
    ['gh api /user', ['network']],
    ['docker pull alpine', ['network']],
    ['docker push img', ['deploy', 'network']],
    ['cargo fetch', ['network']],
    // Cloud, cluster, database and deploy clients reach the network too.
    ['aws s3 ls', ['network']],
    ['aws s3 cp secrets.txt s3://bucket/', ['network']],
    ['gsutil cp a gs://bucket/', ['network']],
    ['gcloud compute instances list', ['network']],
    ['az vm list', ['network']],
    ['kubectl get pods', ['network']],
    ['kubectl exec -it pod -- sh', ['network']],
    ['helm list', ['network']],
    ['terraform plan', ['network']],
    ['docker run alpine', ['network']],
    ['docker compose up', ['network']],
    ['psql -h db.prod -c "select 1"', ['network']],
    ['redis-cli -h cache', ['network']],
    ['dig example.com', ['network']],
    ['http GET example.com', ['network']],
    ['rclone copy a remote:bucket', ['network']],
    ['git submodule add https://example.com/r.git', ['network']],
    ['twine upload dist/*', ['network']],
    ['gem push x.gem', ['network']],
    ['mvn clean deploy', ['network']],
    ['./gradlew publish', ['network']],
    ['ollama pull llama3', ['network']],
    // Infrastructure changes deploy; teardown is destructive as well.
    ['kubectl scale deploy/web --replicas=0', ['deploy', 'network']],
    ['helm upgrade web ./chart', ['deploy', 'network']],
    [
      'terraform destroy -auto-approve',
      ['deploy', 'destructive-shell', 'network'],
    ],
    ['pulumi up --yes', ['deploy', 'network']],
    ['flyctl deploy', ['deploy', 'network']],
    ['vercel --prod', ['deploy', 'network']],
    ['gcloud run deploy web', ['deploy', 'network']],
    ['git branch -D feature', ['destructive-shell']],
    ['git stash clear', ['destructive-shell']],
    ['git reset --soft HEAD~1', ['destructive-shell']],
    ['git worktree remove --force ../wt', ['destructive-shell']],
    ['psql -c "DROP TABLE users"', ['destructive-shell', 'network']],
    ['crontab -r', ['destructive-shell']],
    // The package managers beyond npm, pip and cargo install too.
    ['yum install -y httpd', ['install']],
    ['dnf install x', ['install']],
    ['apk add jq', ['install']],
    ['pacman -Syu x', ['install']],
    ['poetry add requests', ['install']],
    ['conda install numpy', ['install']],
    ['bundle install', ['install']],
    ['uv sync', ['install']],
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
    ['git reset -- a.ts', []],
    ['git branch -d feature', []],
    ['git stash list', []],
    ['git rebase --abort', []],
    ['git switch -c feature', []],
    ['kubectl config get-contexts', []],
    ['kubectl version --client', []],
    ['helm template ./chart', []],
    ['terraform fmt', []],
    ['terraform validate', []],
    ['aws --version', []],
    ['aws configure list', []],
    ['gcloud config list', []],
    ['psql --version', []],
    ['sqlite3 app.db "select 1"', []],
    ['docker ps', []],
    ['docker exec web ls', []],
    ['find . -name "*.ts"', []],
    ['git log --oneline | grep push', []],
    ['cp a b\necho /etc/x', []],
    ['git log\necho reset --hard', []],
    ['git diff HEAD', []],
    ['git commit -m "fetch data and pull it"', []],
    ['docker ps', []],
    // A push named only inside a quoted argument still raises: the literal
    // scan cannot see quotes, and an over-trigger is an ask, never a grant.
    ['echo "run git push later"', ['git-push']],
  ])('%s', (command, expected) => {
    expect(raised(command)).toEqual(expected);
  });
});

// The structured git tools raise what their bash spelling raises: an amended
// commit rewrites history whichever way it is asked for, and a merge of a
// local branch is a workspace write the journal records, as `git merge` is.
describe('structured git tools -> capabilities', () => {
  const tool = (name: string, args: Record<string, unknown>) =>
    detectTriggers(name, args, ctx).sort();

  it('raises destructive-shell for an amended commit, in the tool and in bash', () => {
    expect(tool('git_commit', { message: 'x', amend: true })).toEqual([
      'destructive-shell',
    ]);
    expect(raised('git commit --amend -m x')).toEqual(['destructive-shell']);
    expect(raised('git -C sub commit --amend --no-edit')).toEqual([
      'destructive-shell',
    ]);
  });

  it.each<[string, Record<string, unknown>]>([
    ['git_commit', { message: 'x' }],
    ['git_commit', { message: 'x', amend: false }],
    ['git_merge', { branch: 'feature' }],
    ['git_stage', { paths: ['a.ts'] }],
    ['git_status', {}],
    ['git_diff', { staged: true }],
    ['git_log', { max: 5 }],
    ['git_show', { ref: 'HEAD' }],
    ['git_branch', { create: 'feature' }],
    ['git_checkpoint', { message: 'x' }],
    ['git_worktree_list', {}],
  ])('%s %j raises nothing', (name, args) => {
    expect(tool(name, args)).toEqual([]);
  });

  it('keeps a commit message that mentions amend quiet', () => {
    expect(raised('git commit -m "amend the docs"')).toEqual([]);
    expect(raised('git merge feature')).toEqual([]);
  });
});
