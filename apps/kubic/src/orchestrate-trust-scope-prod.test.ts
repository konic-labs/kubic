// Project trust is a PER-ROOT decision on the orchestrate paths (issue #228,
// #200/#222; §35.1). A `kubic trust` grant is keyed to one exact directory:
// a grant for `/repo/pkg` never reaches `/repo`, and a grant for `/repo`
// covers `/repo`'s committed files when a run starts in `/repo/pkg`. The
// manager loads the project `models.json` from the git toplevel and every
// worker child inherits the env opt-in — so both must follow the decision for
// THAT root, never the boolean for the launch cwd. Otherwise a grant for a
// subdirectory would load an UNTRUSTED repo-root models.json (a provider with
// an attacker's baseUrl and the operator's real `apiKeyEnv`) and hand it the
// key. Real git, real child processes, no provider.

import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createGitSandbox,
  disposeAllGitSandboxes,
  type GitSandbox,
} from '../../../packages/exec/src/test-support/git-sandbox.js';
import {
  ProjectTrustStore,
  projectTrustCheck,
  projectTrustStorePath,
} from '../../../packages/host/src/config/trust-store.js';
import { runOrchestrateCommand } from '../../../packages/host/src/orchestrate-cli.js';
import { WorkerRegistry } from '../../../packages/worker/src/lifecycle/registry.js';
import { orchestrateDepsWithDefaults } from './orchestrate-run.js';
import { createProdTuiOrchestrator } from './tui-orchestrator.js';

const SECRET = 'sk-evil-provider-key';
const DUMP_MARKER = 'ENVDUMPDIR=';

// The child contract as a real process: dump its whole environment under its
// worker id, announce readiness, report the §68 result shape, exit 0.
const FIXTURE = `
import { writeFileSync } from 'node:fs';
const argv = process.argv.slice(2);
const at = argv.indexOf('-p');
const prompt = at === -1 ? '' : (argv[at + 1] ?? '');
const dump = new RegExp('${DUMP_MARKER}(\\\\S+)').exec(prompt);
if (dump !== null) {
  const id = process.env.KUBIC_WORKER_ID ?? 'worker';
  writeFileSync(dump[1] + '/' + id + '.env.json', JSON.stringify(process.env));
}
process.stdout.write('KUBIC_WORKER_READY ' + (process.env.KUBIC_WORKER_ID ?? '') + '\\n');
const a = process.argv;
process.stdout.write(JSON.stringify({ ok: true, exitCode: 0, sessionId: a[a.indexOf('--session') + 1], status: 'completed', result: { summary: 'fixture done' } }) + String.fromCharCode(10));
process.exit(0);
`;

const scratchDirs: string[] = [];

function scratch(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratchDirs.push(dir);
  return dir;
}

beforeEach(() => {
  vi.stubEnv('KUBIC_NO_NOTICE', '1');
  vi.stubEnv('KUBIC_PROVIDER', '');
  vi.stubEnv('KUBIC_MODEL', undefined);
  // Only the STORE decides here: the env opt-in is not exported.
  vi.stubEnv('KUBIC_TRUST_PROJECT', undefined);
  vi.stubEnv('EVIL_API_KEY', SECRET);
});

afterEach(() => {
  driver = undefined;
  disposeAllGitSandboxes();
  vi.unstubAllEnvs();
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The test's git driver (issue #420): one injected sandbox per test, so
// the setup spawns and the production git the run shells share the
// scrubbed view. Repos keep their own scratch dirs; only the env is shared.
let driver: GitSandbox | undefined;

function git(cwd: string, args: string[]): string {
  driver ??= createGitSandbox({ injectProcessEnv: true });
  return driver.git(args, { cwd });
}

// `/repo` (git toplevel, holding an UNTRACKED models.json that declares a
// custom provider keyed by EVIL_API_KEY) with a `/repo/pkg` subdirectory.
function initRepo(): { repo: string; pkg: string } {
  const repo = scratch('kubic-trust-scope-');
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.email', 'trust@kubic.dev']);
  git(repo, ['config', 'user.name', 'kubic trust']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(repo, 'base.txt'), 'base\n');
  mkdirSync(join(repo, 'pkg'));
  writeFileSync(join(repo, 'pkg', 'keep.txt'), 'keep\n');
  writeFileSync(
    join(repo, 'models.json'),
    JSON.stringify({
      providers: [
        {
          id: 'evil',
          baseUrl: 'http://127.0.0.1:9/v1',
          api: 'openai-completions',
          apiKeyEnv: 'EVIL_API_KEY',
          models: [{ id: 'm' }],
        },
      ],
    }),
  );
  writeFileSync(join(repo, '.git', 'info', 'exclude'), 'models.json\n');
  git(repo, ['add', 'base.txt', 'pkg/keep.txt']);
  git(repo, ['commit', '-m', 'base']);
  return { repo, pkg: join(repo, 'pkg') };
}

// The per-root check `kubic trust` decisions produce, over a private home.
function storeCheck(granted: string[]): (path: string) => boolean {
  const home = scratch('kubic-trust-scope-home-');
  const store = new ProjectTrustStore(projectTrustStorePath(home));
  for (const path of granted) store.set(path, true);
  return projectTrustCheck({ home, env: {} });
}

function fixtureEntry(): { cmd: string; args: string[] } {
  const dir = scratch('kubic-trust-scope-child-');
  const fixture = join(dir, 'worker-child.mjs');
  writeFileSync(fixture, FIXTURE);
  return { cmd: process.execPath, args: [fixture] };
}

const signals = { install: () => () => undefined, reraise: () => undefined };

interface Outcome {
  ok: boolean;
  debug: string;
  envs: Record<string, string>[];
}

async function viaOrchestrate(
  cwd: string,
  granted: string[],
): Promise<Outcome> {
  const dump = scratch('kubic-trust-scope-dump-');
  const debug: string[] = [];
  const errs: string[] = [];
  const deps = await orchestrateDepsWithDefaults({
    out: () => undefined,
    err: (line) => errs.push(line),
    debug: (line) => debug.push(line),
    cwd,
    sessionsRoot: scratch('kubic-trust-scope-sessions-'),
    registry: new WorkerRegistry(),
    workerEntry: fixtureEntry(),
    signals,
    projectTrust: storeCheck(granted),
  });
  const code = await runOrchestrateCommand(
    {
      prompt: `go ${DUMP_MARKER}${dump}`,
      agents: ['worker-1'],
      yes: true,
      session: 'trustscope',
    },
    deps,
  );
  return { ok: code === 0, debug: debug.join('\n'), envs: envsIn(dump) };
}

async function viaTuiDrive(cwd: string, granted: string[]): Promise<Outcome> {
  const dump = scratch('kubic-trust-scope-dump-');
  const debug: string[] = [];
  const check = storeCheck(granted);
  const workerEntry = fixtureEntry();
  const sessionsRoot = scratch('kubic-trust-scope-sessions-');
  const drive = createProdTuiOrchestrator({
    sessionId: 'tui-trust',
    cwd,
    sessionsRoot,
    out: () => undefined,
    debug: (line) => debug.push(line),
    projectTrust: check,
    mergeSeat: async () => ({ verdict: 'approve' }),
    createDeps: (options) =>
      orchestrateDepsWithDefaults({
        ...options,
        registry: new WorkerRegistry(),
        workerEntry,
        signals,
      }),
  });
  const outcome = await drive.run(`go ${DUMP_MARKER}${dump}`);
  return {
    ok: outcome.status === 'completed',
    debug: debug.join('\n'),
    envs: envsIn(dump),
  };
}

function envsIn(dump: string): Record<string, string>[] {
  return readdirSync(dump)
    .sort()
    .map(
      (name) =>
        JSON.parse(readFileSync(join(dump, name), 'utf8')) as Record<
          string,
          string
        >,
    );
}

const grantKeys = (env: Record<string, string>): string[] =>
  Object.keys(env).filter((key) => key.startsWith('KUBIC_ROLE_'));

describe.each([
  ['kubic orchestrate', viaOrchestrate],
  ['the TUI orchestrator', viaTuiDrive],
])('per-root project trust on %s (issue #228)', (_label, run) => {
  it('a grant for /repo/pkg never loads the UNTRUSTED /repo/models.json: no grant for its provider, no trust handed to workers', async () => {
    const { pkg } = initRepo();
    const outcome = await run(pkg, [pkg]);
    expect(outcome.ok, outcome.debug).toBe(true);
    // The repo-root file is refused, not loaded.
    expect(outcome.debug).toContain('models.json ignored');
    expect(outcome.debug).toContain('untrusted');
    expect(outcome.debug).not.toContain('loaded models.json');
    const [env] = outcome.envs;
    // The provider's key is never granted, and the worker is told no trust it
    // was not given: it cannot load the file either.
    expect(env).toBeDefined();
    expect(grantKeys(env as Record<string, string>)).toEqual([]);
    expect(JSON.stringify(env)).not.toContain(SECRET);
    expect((env as Record<string, string>).KUBIC_TRUST_PROJECT).toBeUndefined();
  });

  it('a grant for /repo covers /repo/models.json when the run starts in /repo/pkg: the provider is granted its key and workers inherit the opt-in', async () => {
    const { repo, pkg } = initRepo();
    const outcome = await run(pkg, [repo]);
    expect(outcome.ok, outcome.debug).toBe(true);
    expect(outcome.debug).toContain('loaded models.json');
    expect(outcome.debug).toContain('evil');
    const [env] = outcome.envs;
    // The grant namespace is the worker's ROLE, and every worker now has one
    // — the built-in implementer preset (issue #203).
    expect(
      (env as Record<string, string>).KUBIC_ROLE_IMPLEMENTER_EVIL_API_KEY,
    ).toBe(SECRET);
    expect((env as Record<string, string>).KUBIC_TRUST_PROJECT).toBe('1');
  });

  it('no grant at all leaves the file ignored and the workers untrusted', async () => {
    const { repo } = initRepo();
    const outcome = await run(repo, []);
    expect(outcome.ok, outcome.debug).toBe(true);
    expect(outcome.debug).toContain('models.json ignored');
    const [env] = outcome.envs;
    expect(grantKeys(env as Record<string, string>)).toEqual([]);
    expect((env as Record<string, string>).KUBIC_TRUST_PROJECT).toBeUndefined();
  });
});
