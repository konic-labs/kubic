// Provider credentials on the PROD orchestrate path (issue #200; §36.3,
// §3.8, §58, §59). Real git, real child processes: the fixture child dumps
// its own environment, so the grant claims are read from the child's view —
// not from the spawn call the test could have gotten wrong. The provider is
// a loopback HTTP server owned by the test; the final step replays the
// captured child env through the real `kubic run` boot in-process, so the
// full chain (manager plan → grant → child env → child auth → wire) is
// covered without a build and without network.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NodeExecutionEnv } from '../../../packages/exec/src/env.js';
import {
  createGitSandbox,
  disposeAllGitSandboxes,
  type GitSandbox,
} from '../../../packages/exec/src/test-support/git-sandbox.js';
import { runOrchestrateCommand } from '../../../packages/host/src/orchestrate-cli.js';
import { assertNoSecretMaterial } from '../../../packages/host/src/policy/enterprise.js';
import { WorkerRegistry } from '../../../packages/worker/src/lifecycle/registry.js';
import { runHeadlessPrompt } from './headless-run.js';
import { orchestrateDepsWithDefaults } from './orchestrate-run.js';

const SECRET = 'sk-orch-200-do-not-leak';
const WORKER_ENV_DIR_MARKER = 'ENVDUMPDIR=';

const scratchDirs: string[] = [];
const servers: Server[] = [];

function scratchRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

beforeEach(() => {
  vi.stubEnv('KUBIC_NO_NOTICE', '1');
  vi.stubEnv('KUBIC_PROVIDER', '');
  vi.stubEnv('KUBIC_TRUST_PROJECT', '1');
});

afterEach(async () => {
  driver = undefined;
  disposeAllGitSandboxes();
  vi.unstubAllEnvs();
  for (const server of servers.splice(0)) {
    await new Promise<void>((done) => server.close(() => done()));
  }
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A minimal OpenAI-compatible streaming endpoint. Records each request's
// Authorization header so the test can prove the key really went out.
async function fakeProvider(): Promise<{ url: string; auths: string[] }> {
  const auths: string[] = [];
  const server = createServer((req, res) => {
    auths.push(String(req.headers.authorization ?? ''));
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (body: unknown): void => {
        res.write(`data: ${JSON.stringify(body)}\n\n`);
      };
      const base = {
        id: 'c1',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'm1',
      };
      chunk({
        ...base,
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', content: 'hello' },
            finish_reason: null,
          },
        ],
      });
      chunk({
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      });
      res.end('data: [DONE]\n\n');
    });
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/v1`, auths };
}

// The child contract as a real process: dump its whole environment JSON under
// its worker id, announce readiness, report the §68 result shape, exit 0.
const FIXTURE = `
import { writeFileSync } from 'node:fs';
const argv = process.argv.slice(2);
const index = argv.indexOf('-p');
const prompt = index === -1 ? '' : (argv[index + 1] ?? '');
const dumpDir = new RegExp('${WORKER_ENV_DIR_MARKER}(\\\\S+)').exec(prompt);
if (dumpDir !== null) {
  const id = process.env.KUBIC_WORKER_ID ?? 'worker';
  writeFileSync(dumpDir[1] + '/' + id + '.env.json', JSON.stringify(process.env));
}
process.stdout.write('KUBIC_WORKER_READY ' + (process.env.KUBIC_WORKER_ID ?? '') + '\\n');
const a = process.argv;
process.stdout.write(JSON.stringify({ ok: true, exitCode: 0, sessionId: a[a.indexOf('--session') + 1], status: 'completed', result: { summary: 'fixture done' } }) + String.fromCharCode(10));
process.exit(0);
`;

const PLANNER_FM =
  'tools: [read, ls, find, grep]\nfilesystem: read\nshell: false\nnetwork: none\ngit: false\ncredentials: none\n';

function roleText(name: string, frontmatter: string, prompt: string): string {
  return `---\nrole: ${name}\n${frontmatter}---\n\n# ${name}\n\n## Prompt\n\n${prompt}\n`;
}

// The test's git driver (issue #420): one injected sandbox per test, so
// the setup commits and the production git the run shells share the
// scrubbed view. Repos keep their own scratch dirs; only the env is shared.
let driver: GitSandbox | undefined;

function git(cwd: string, args: string[]): void {
  driver ??= createGitSandbox({ injectProcessEnv: true });
  driver.git(args, { cwd });
}

// A repo whose committed role document is what the worker's worktree checks
// out, plus an UNTRACKED, excluded models.json naming the loopback provider
// (the child reaches it through the manager's KUBIC_MODELS_ROOT, exactly as
// prod — issue #222). The exclude entry keeps the merge guard's clean-tree
// check green; nothing is ever written outside the scratch tree.
async function initRepo(providerUrl: string): Promise<string> {
  const root = scratchRoot('kubic-orch-200-');
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.email', 'creds@kubic.dev']);
  git(root, ['config', 'user.name', 'kubic creds']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(root, 'base.txt'), 'base\n');
  const rolesDir = join(root, '.kubic', 'roles');
  mkdirSync(rolesDir, { recursive: true });
  writeFileSync(
    join(rolesDir, 'planner.md'),
    roleText('planner', PLANNER_FM, 'You are the planner.'),
  );
  writeFileSync(
    join(root, 'models.json'),
    JSON.stringify({
      providers: [
        {
          id: 'gw',
          baseUrl: providerUrl,
          api: 'openai-completions',
          apiKeyEnv: 'GW_API_KEY',
          models: [{ id: 'm1' }],
        },
      ],
    }),
  );
  writeFileSync(join(root, '.git', 'info', 'exclude'), 'models.json\n');
  git(root, ['add', 'base.txt', '.kubic/roles/planner.md']);
  git(root, ['commit', '-m', 'base + roles']);
  return root;
}

// A second provider in the untracked project catalog, so an ambient or
// per-agent pin can name a provider the role's pin does not.
function addOtherProvider(root: string, url: string): void {
  const catalog = JSON.parse(
    readFileSync(join(root, 'models.json'), 'utf8'),
  ) as { providers: Record<string, unknown>[] };
  catalog.providers.push({
    id: 'other',
    baseUrl: url,
    api: 'openai-completions',
    apiKeyEnv: 'OTHER_API_KEY',
    models: [{ id: 'm1' }],
  });
  writeFileSync(join(root, 'models.json'), JSON.stringify(catalog));
}

interface Harness {
  root: string;
  dumpDir: string;
  lines: string[];
  errLines: string[];
  debugLines: string[];
  deps: Awaited<ReturnType<typeof orchestrateDepsWithDefaults>>;
}

async function harness(
  root: string,
  options: {
    requireCredentialBroker?: boolean;
    projectTrust?: (path: string) => boolean;
    modelPinFrozen?: boolean;
    /** The manager's effective model; defaults to the project `gw/m1`. */
    model?: { provider: string; id: string };
    /** The config `[roles.<name>]` layers prod projects from the load. */
    roleLayers?: Array<{
      layer: 'project';
      roles: Record<string, { model?: string; tools?: string[] }>;
    }>;
  } = {},
): Promise<Harness> {
  const sessionsRoot = scratchRoot('kubic-orch-200-sessions-');
  const fixtureDir = scratchRoot('kubic-orch-200-child-');
  const fixture = join(fixtureDir, 'worker-child.mjs');
  writeFileSync(fixture, FIXTURE);
  const lines: string[] = [];
  const errLines: string[] = [];
  const debugLines: string[] = [];
  const deps = await orchestrateDepsWithDefaults({
    out: (line) => lines.push(line),
    err: (line) => errLines.push(line),
    debug: (line) => debugLines.push(line),
    cwd: root,
    sessionsRoot,
    registry: new WorkerRegistry(),
    workerEntry: { cmd: process.execPath, args: [fixture] },
    // The manager's own model pin; the manager of this run resolves `gw`
    // through the project models.json, and every worker inherits it.
    model: options.model ?? { provider: 'gw', id: 'm1' },
    signals: fakeSignals(),
    ...(options.requireCredentialBroker === true
      ? { requireCredentialBroker: true }
      : {}),
    ...(options.modelPinFrozen === true ? { modelPinFrozen: true } : {}),
    ...(options.roleLayers === undefined
      ? {}
      : { roleLayers: options.roleLayers }),
    // What prod passes (`projectTrustFor(cliConfig)`): the persistent
    // store's per-root decision, with the env opt-in NOT exported.
    ...(options.projectTrust === undefined
      ? {}
      : { projectTrust: options.projectTrust }),
  });
  return {
    root,
    dumpDir: scratchRoot('kubic-orch-200-env-'),
    lines,
    errLines,
    debugLines,
    deps,
  };
}

// The orchestrate run installs real process-signal handlers; tests use a
// no-op install so the runner is never signalled (same seam prod uses).
function fakeSignals() {
  return {
    install: () => () => undefined,
    reraise: () => undefined,
  };
}

function dumpOf(h: Harness, agentId: string): Record<string, string> {
  return JSON.parse(
    readFileSync(join(h.dumpDir, `${agentId}.env.json`), 'utf8'),
  ) as Record<string, string>;
}

describe('prod orchestrate worker credentials (issue #200)', () => {
  it('grants the provider of the role pin the child is told, not the ambient KUBIC_MODEL (issue #202)', async () => {
    // The operator's ambient pin names `other`; the committed config layer
    // pins the planner to `gw`. The child's `KUBIC_MODEL` is overwritten
    // with the role pin, so the GRANT must follow the role pin too — the
    // pre-#202 order resolved the credential plan from the ambient pin and
    // handed the worker a key its provider never runs with.
    const provider = await fakeProvider();
    const root = await initRepo(provider.url);
    addOtherProvider(root, provider.url);
    vi.stubEnv('GW_API_KEY', SECRET);
    vi.stubEnv('OTHER_API_KEY', 'sk-other-not-a-real-key');
    vi.stubEnv('KUBIC_MODEL', 'other/m1');
    const h = await harness(root, {
      // prod passes the manager's effective pin (runtimeModelPin) and the
      // config `[roles.<name>]` layers (roleLayersFromConfig).
      model: { provider: 'other', id: 'm1' },
      roleLayers: [
        { layer: 'project', roles: { planner: { model: 'gw/m1' } } },
      ],
    });
    const code = await runOrchestrateCommand(
      {
        prompt: `do the thing ${WORKER_ENV_DIR_MARKER}${h.dumpDir}`,
        agents: ['alpha:planner'],
        yes: true,
        session: 'rolepincreds',
      },
      h.deps,
    );
    expect(code, [...h.errLines, ...h.lines].join('\n')).toBe(0);
    const env = dumpOf(h, 'alpha');
    // The child runs the role pin…
    expect(env.KUBIC_MODEL).toBe('gw/m1');
    // …and holds exactly that provider's key, not the ambient pin's.
    expect(env.KUBIC_ROLE_PLANNER_GW_API_KEY).toBe(SECRET);
    expect(env.KUBIC_ROLE_PLANNER_OTHER_API_KEY).toBeUndefined();
  });

  it('grants the provider of the per-agent --agents pin, not the ambient KUBIC_MODEL (issue #178)', async () => {
    // The highest §38.1 level is the explicit per-agent pin; the ambient
    // operator pin is overwritten in the child, so the GRANT must follow the
    // flag — the pre-fix order resolved (and refused on) the ambient
    // provider's credential instead.
    const provider = await fakeProvider();
    const root = await initRepo(provider.url);
    addOtherProvider(root, provider.url);
    vi.stubEnv('GW_API_KEY', SECRET);
    vi.stubEnv('OTHER_API_KEY', 'sk-other-not-a-real-key');
    vi.stubEnv('KUBIC_MODEL', 'other/m1');
    const h = await harness(root, { model: { provider: 'other', id: 'm1' } });
    const code = await runOrchestrateCommand(
      {
        prompt: `do the thing ${WORKER_ENV_DIR_MARKER}${h.dumpDir}`,
        agents: ['alpha:planner:gw/m1'],
        yes: true,
        session: 'flagpincreds',
      },
      h.deps,
    );
    expect(code, [...h.errLines, ...h.lines].join('\n')).toBe(0);
    const env = dumpOf(h, 'alpha');
    expect(env.KUBIC_MODEL).toBe('gw/m1');
    expect(env.KUBIC_ROLE_PLANNER_GW_API_KEY).toBe(SECRET);
    expect(env.KUBIC_ROLE_PLANNER_OTHER_API_KEY).toBeUndefined();
  });

  it('hands a real child exactly its role provider key under the grant namespace', async () => {
    const provider = await fakeProvider();
    const root = await initRepo(provider.url);
    vi.stubEnv('GW_API_KEY', SECRET);
    vi.stubEnv('KUBIC_MODEL', 'gw/m1');
    // An unrelated operator secret the allowlist must drop regardless.
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'aws-parent-secret');
    const h = await harness(root);
    const code = await runOrchestrateCommand(
      {
        prompt: `do the thing ${WORKER_ENV_DIR_MARKER}${h.dumpDir}`,
        agents: ['alpha:planner'],
        yes: true,
        session: 'credsession',
      },
      h.deps,
    );
    expect(code).toBe(0);
    const env = dumpOf(h, 'alpha');
    // Delivered: the role's provider key, under the grant namespace.
    expect(env.KUBIC_ROLE_PLANNER_GW_API_KEY).toBe(SECRET);
    // Not delivered: the plain name, an unrelated parent secret, or any
    // sibling role's namespace.
    expect(env.GW_API_KEY).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(
      Object.keys(env).some((key) => key.startsWith('KUBIC_ROLE_IMPLEMENTER_')),
    ).toBe(false);
    // The §50 debug lines keep the grant key and never its value.
    const debug = h.debugLines.join('\n');
    expect(debug).toContain('KUBIC_ROLE_PLANNER_GW_API_KEY');
    expect(debug).not.toContain(SECRET);
  });

  it('the captured child env authenticates the real child boot against the provider', async () => {
    const provider = await fakeProvider();
    const root = await initRepo(provider.url);
    vi.stubEnv('GW_API_KEY', SECRET);
    vi.stubEnv('KUBIC_MODEL', 'gw/m1');
    const h = await harness(root);
    const code = await runOrchestrateCommand(
      {
        prompt: `do the thing ${WORKER_ENV_DIR_MARKER}${h.dumpDir}`,
        agents: ['alpha:planner'],
        yes: true,
        session: 'credsession2',
      },
      h.deps,
    );
    expect(code).toBe(0);
    const env = dumpOf(h, 'alpha');
    // Replay the REAL child env through the REAL child boot: this is the
    // `kubic run` half of the worker, driven by the env the manager produced.
    vi.unstubAllEnvs();
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    // Worktrees are session-scoped (issue #144): `.kubic/wt/<session>/<agent>`.
    const sessionDir = readdirSync(join(root, '.kubic', 'wt'))[0] as string;
    const worktree = join(root, '.kubic', 'wt', sessionDir, 'alpha');
    expect(existsSync(worktree)).toBe(true);
    const sessionsRoot = scratchRoot('kubic-orch-200-replay-sessions-');
    const result = await runHeadlessPrompt(
      'say hello',
      { debug: false, role: 'planner' },
      {
        sessionsRoot,
        modelsCwd: root,
        roles: { cwd: worktree },
        skills: { cwd: worktree, homeDir: worktree, trusted: false },
        env: new NodeExecutionEnv(worktree),
      },
    );
    expect(result.terminus).toBe('completed');
    expect(provider.auths).toEqual([`Bearer ${SECRET}`]);
  });

  it('with require_credential_broker the child env holds a sentinel, never material', async () => {
    const provider = await fakeProvider();
    const root = await initRepo(provider.url);
    vi.stubEnv('GW_API_KEY', SECRET);
    vi.stubEnv('KUBIC_MODEL', 'gw/m1');
    const h = await harness(root, { requireCredentialBroker: true });
    const code = await runOrchestrateCommand(
      {
        prompt: `do the thing ${WORKER_ENV_DIR_MARKER}${h.dumpDir}`,
        agents: ['alpha:planner'],
        yes: true,
        session: 'credsession4',
      },
      h.deps,
    );
    expect(code).toBe(0);
    const env = dumpOf(h, 'alpha');
    expect(env.KUBIC_ROLE_PLANNER_GW_API_KEY).toBe('broker:$GW_API_KEY');
    // The §58 backstop: no live value and no secret-shaped material in the
    // whole child env.
    expect(JSON.stringify(env)).not.toContain(SECRET);
    expect(() => assertNoSecretMaterial(env, [SECRET])).not.toThrow();
  });

  it('fails closed with exit 6 naming the provider, with no worktree created', async () => {
    const provider = await fakeProvider();
    const root = await initRepo(provider.url);
    // No GW_API_KEY anywhere: the manager holds the provider's registration
    // but not its key, so the worker credential cannot be delivered.
    vi.stubEnv('KUBIC_MODEL', 'gw/m1');
    const h = await harness(root);
    const code = await runOrchestrateCommand(
      {
        prompt: `do the thing ${WORKER_ENV_DIR_MARKER}${h.dumpDir}`,
        agents: ['alpha:planner'],
        yes: true,
        session: 'credsession3',
      },
      h.deps,
    );
    expect(code).toBe(6);
    const text = h.errLines.join('\n');
    expect(text).toMatch(/code=credential_unavailable/);
    expect(text).toContain("provider 'gw'");
    expect(text).toContain('GW_API_KEY');
    // Nothing was created and nothing spawned.
    expect(existsSync(join(root, '.kubic', 'wt'))).toBe(false);
    expect(readdirSync(h.dumpDir)).toEqual([]);
  });
});

// Issue #200/#222: the manager's models trust is the SAME decision the
// workers get. `kubic trust` (the persistent store) grants a project without
// exporting KUBIC_TRUST_PROJECT; prod passes the store's per-root check as
// `projectTrust`, and the decision for the models root is exactly what every
// worker child receives — so the manager must load the project models.json
// under it, or its credential grant is empty while the worker (trusted)
// loads the provider.
describe('prod orchestrate worker credentials under a store trust grant (issue #200)', () => {
  beforeEach(() => {
    // The env opt-in is NOT exported: only the store decision exists.
    vi.stubEnv('KUBIC_TRUST_PROJECT', undefined);
  });

  it('a store-granted project loads its models.json for the manager and grants the worker its key', async () => {
    const provider = await fakeProvider();
    const root = await initRepo(provider.url);
    vi.stubEnv('GW_API_KEY', SECRET);
    vi.stubEnv('KUBIC_MODEL', 'gw/m1');
    const h = await harness(root, {
      // The store keys a grant to the canonical repo root the run loads.
      projectTrust: (path) => realpathSync(path) === realpathSync(root),
    });
    const code = await runOrchestrateCommand(
      {
        prompt: `do the thing ${WORKER_ENV_DIR_MARKER}${h.dumpDir}`,
        agents: ['alpha:planner'],
        yes: true,
        session: 'storetrust1',
      },
      h.deps,
    );
    expect(h.errLines.join('\n')).not.toMatch(/Provider is not configured/);
    expect(h.debugLines.join('\n')).not.toContain('models.json ignored');
    expect(code).toBe(0);
    const env = dumpOf(h, 'alpha');
    expect(env.KUBIC_ROLE_PLANNER_GW_API_KEY).toBe(SECRET);
    // The child is told the manager's decision as the env opt-in.
    expect(env.KUBIC_TRUST_PROJECT).toBe('1');
  });

  it('an undecided project stays untrusted: models.json ignored, no key granted, no trust handed down', async () => {
    const provider = await fakeProvider();
    const root = await initRepo(provider.url);
    vi.stubEnv('GW_API_KEY', SECRET);
    vi.stubEnv('KUBIC_MODEL', 'gw/m1');
    const h = await harness(root, { projectTrust: () => false });
    const code = await runOrchestrateCommand(
      {
        prompt: `do the thing ${WORKER_ENV_DIR_MARKER}${h.dumpDir}`,
        agents: ['alpha:planner'],
        yes: true,
        session: 'storetrust2',
      },
      h.deps,
    );
    // The manager holds no `gw` registration, so it grants nothing (the
    // child's own probe names the provider) — and it tells the child no
    // trust it does not itself hold.
    expect(code).toBe(0);
    expect(h.debugLines.join('\n')).toContain('models.json ignored');
    expect(h.debugLines.join('\n')).toContain('untrusted');
    const env = dumpOf(h, 'alpha');
    expect(env.KUBIC_ROLE_PLANNER_GW_API_KEY).toBeUndefined();
    expect(env.KUBIC_TRUST_PROJECT).toBeUndefined();
  });
});

// Issue #200: a built-in whose credential is several process-level vars
// (AWS access keys + region) cannot be handed to a worker through the grant
// namespace, and the worker env allowlist strips the rest — so the run is
// refused up front by provider name (exit 6), not started and then killed by
// the worker's `Provider is not configured`.
describe('prod orchestrate worker credentials for multi-variable providers (issue #200)', () => {
  it('refuses amazon-bedrock with exit 6 naming the provider, before any worktree', async () => {
    const provider = await fakeProvider();
    const root = await initRepo(provider.url);
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'AKIA-orch-200');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'aws-orch-secret-200');
    vi.stubEnv('AWS_REGION', 'us-east-1');
    vi.stubEnv('KUBIC_MODEL', 'amazon-bedrock/anthropic.claude-sonnet-4');
    // The manager's effective model is the ambient pin (prod: runtimeModelPin
    // reads the same env), and the worker inherits it as its fallback level.
    const h = await harness(root, {
      model: { provider: 'amazon-bedrock', id: 'anthropic.claude-sonnet-4' },
    });
    const code = await runOrchestrateCommand(
      {
        prompt: `do the thing ${WORKER_ENV_DIR_MARKER}${h.dumpDir}`,
        agents: ['alpha:planner'],
        yes: true,
        session: 'bedrocksession',
      },
      h.deps,
    );
    expect(code).toBe(6);
    const text = h.errLines.join('\n');
    expect(text).toMatch(/code=credential_unavailable/);
    expect(text).toContain("provider 'amazon-bedrock'");
    expect(text).toContain('AWS_REGION');
    // No secret value in any output, and nothing spawned or created.
    expect(text).not.toContain('aws-orch-secret-200');
    expect(h.debugLines.join('\n')).not.toContain('aws-orch-secret-200');
    expect(existsSync(join(root, '.kubic', 'wt'))).toBe(false);
    expect(readdirSync(h.dumpDir)).toEqual([]);
  });
});

// Issue #295 (§35.1): a frozen enterprise `[model]` binds every worker child —
// the child's own config load drops KUBIC_MODEL (the operator's or the
// manager's injected role default) in favour of the enterprise pin. So the
// manager must neither inject a pin the child will drop (each child would
// print a confusing "ignored" note on its first stderr line) nor resolve the
// credential preflight from a pin the child never runs: the provider that
// needs a key is the enterprise model's.
describe('prod orchestrate under a frozen enterprise model (issue #295)', () => {
  async function run(
    options: { modelPinFrozen: boolean },
    operatorModel: string | undefined,
  ): Promise<{ env: Record<string, string>; code: number }> {
    const provider = await fakeProvider();
    const root = await initRepo(provider.url);
    vi.stubEnv('GW_API_KEY', SECRET);
    vi.stubEnv('KUBIC_MODEL', operatorModel);
    const h = await harness(root, options);
    const code = await runOrchestrateCommand(
      {
        prompt: `do the thing ${WORKER_ENV_DIR_MARKER}${h.dumpDir}`,
        agents: ['alpha:planner'],
        yes: true,
        session: 'frozenmodel',
      },
      h.deps,
    );
    return { env: dumpOf(h, 'alpha'), code };
  }

  it('injects no role-default KUBIC_MODEL and grants the enterprise model provider its key', async () => {
    const { env, code } = await run({ modelPinFrozen: true }, undefined);
    expect(code).toBe(0);
    expect(env.KUBIC_MODEL).toBeUndefined();
    expect(env.KUBIC_ROLE_PLANNER_GW_API_KEY).toBe(SECRET);
  });

  it('drops an operator KUBIC_MODEL from the child env and ignores it for the credential grant', async () => {
    const { env, code } = await run({ modelPinFrozen: true }, 'other/m1');
    expect(code).toBe(0);
    expect(env.KUBIC_MODEL).toBeUndefined();
    expect(env.KUBIC_ROLE_PLANNER_GW_API_KEY).toBe(SECRET);
  });

  it('hands the manager model to the worker without a freeze (control)', async () => {
    // §38.1 (#202): no role pin, so the manager's effective model is what the
    // child is told — the role preset no longer invents `local/llama3`.
    const unpinned = await run({ modelPinFrozen: false }, undefined);
    expect(unpinned.env.KUBIC_MODEL).toBe('gw/m1');
    // The operator's own pin travels as it always did (in prod the same
    // config load feeds the manager model and `KUBIC_MODEL`).
    const pinned = await run({ modelPinFrozen: false }, 'gw/m1');
    expect(pinned.env.KUBIC_MODEL).toBe('gw/m1');
    expect(pinned.env.KUBIC_ROLE_PLANNER_GW_API_KEY).toBe(SECRET);
  });
  it('lets google-vertex through on GOOGLE_CLOUD_API_KEY: the key rides the role grant', async () => {
    const provider = await fakeProvider();
    const root = await initRepo(provider.url);
    vi.stubEnv('GOOGLE_CLOUD_API_KEY', 'vertex-orch-key-200');
    vi.stubEnv('KUBIC_MODEL', 'google-vertex/gemini-2.5-pro');
    const h = await harness(root, {
      model: { provider: 'google-vertex', id: 'gemini-2.5-pro' },
    });
    const code = await runOrchestrateCommand(
      {
        prompt: `do the thing ${WORKER_ENV_DIR_MARKER}${h.dumpDir}`,
        agents: ['alpha:planner'],
        yes: true,
        session: 'vertexsession',
      },
      h.deps,
    );
    expect(code, h.errLines.join('\n')).toBe(0);
    const env = dumpOf(h, 'alpha');
    expect(env.KUBIC_ROLE_PLANNER_GOOGLE_CLOUD_API_KEY).toBe(
      'vertex-orch-key-200',
    );
    expect(env.GOOGLE_CLOUD_API_KEY).toBeUndefined();
  });
});
