// Config → live run path (issue #90, acceptance criterion 1): a
// `.kubic/config.toml` value must measurably change a live behaviour, not
// merely parse. This drives the production headless runner (`kubic run`'s
// own adapter) with the projections the composition root injects and checks
// the journal the run wrote and the lane allowlist it installed.
//
// Faux provider only: zero network, zero paid tokens.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  runtimeLaneDeps,
  runtimeRunDeps,
} from '../../../../apps/kubic/src/config-runtime.js';
import { runHeadlessPrompt } from '../../../../apps/kubic/src/headless-run.js';
import { SOLO_DEFAULTS } from '../../../agents/src/policy.js';
import { NodeExecutionEnv } from '../../../exec/src/env.js';
import { createNodeFileBridge } from '../../../exec/src/file-bridge.js';
import { FileJournalStore } from '../../../exec/src/journal.js';
import { fauxToolUse } from '../../../worker/src/lane/test-harness.js';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '../../../worker/src/pi-boundary.js';
import { runJournalCommand } from '../journal-cli.js';
import { loadRuntimeConfig, type RuntimeConfig } from './runtime.js';
import { NO_PROJECT_TRUST } from './trust-store.js';

const tempDirs: string[] = [];

function tmpRoot(prefix = 'kubic-90-run-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

beforeEach(() => {
  // The solo no-isolation notice goes straight to process.stderr (its text
  // and gating are pinned in limits/solo-warning.test.ts and
  // solo-notice-prod.test.ts); the documented opt-out keeps these runs quiet.
  // Orchestrator-child inputs are cleared so the host shell cannot leak in.
  vi.stubEnv('KUBIC_NO_NOTICE', '1');
  vi.stubEnv('KUBIC_WORKER_ID', undefined);
  vi.stubEnv('KUBIC_APPROVALS_DIR', undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('config feeds the live run path (issue #90)', () => {
  it('projects [journal] retentionDays into a journal bound that prunes on append', () => {
    const root = tmpRoot();
    const runtime = loadRuntimeConfig({
      bridge: createNodeFileBridge(root),
      home: '/nonexistent-home',
      cwd: root,
      enterprisePath: '/nonexistent/config.toml',
      projectTrusted: true,
      env: {},
    });
    expect(runtime.journal.maxAgeMs).toBeUndefined();

    // Retention configured: the store the run creates prunes on append.
    const withRetention = loadRuntimeConfig({
      bridge: {
        exists: (path: string): boolean =>
          path === `${root}/.kubic/config.toml`,
        readTextFile: (): string =>
          '[journal]\nretentionDays = 1\n[approvals]\nroute = "deny"\n',
      },
      home: '/nonexistent-home',
      cwd: root,
      enterprisePath: '/nonexistent/config.toml',
      projectTrusted: true,
      env: {},
    });
    expect(withRetention.journal.maxAgeMs).toBe(86_400_000);

    const store = new FileJournalStore(join(root, 'journal'), {
      maxAgeMs: withRetention.journal.maxAgeMs,
    });
    store.append({
      path: 'stale.txt',
      op: 'write',
      before: null,
      after: 'x',
      bytesDelta: 1,
      sessionId: 's1',
      agentId: 'root',
      toolCallId: null,
      timestamp: Date.now() - 3 * 86_400_000,
    });
    store.append({
      path: 'fresh.txt',
      op: 'write',
      before: null,
      after: 'y',
      bytesDelta: 1,
      sessionId: 's1',
      agentId: 'root',
      toolCallId: null,
      timestamp: Date.now(),
    });
    // Only the entry past the configured day is pruned.
    expect(store.entries().map((entry) => entry.path)).toEqual(['fresh.txt']);
  });

  it('drives a real lane whose allowlist comes from the loaded classes', async () => {
    const root = tmpRoot();
    // Config narrows the lane to read-only tools; the run must honour it.
    const runtime = loadRuntimeConfig({
      bridge: {
        exists: (path: string): boolean =>
          path === `${root}/.kubic/config.toml`,
        readTextFile: (): string =>
          '[permissions]\nfilesystem = "read"\nshell = false\ngit = false\n',
      },
      home: '/nonexistent-home',
      cwd: root,
      enterprisePath: '/nonexistent/config.toml',
      projectTrusted: true,
      env: {},
    });
    expect(runtime.permissions.classes).toEqual({
      ...SOLO_DEFAULTS,
      filesystem: 'read',
      shell: false,
      git: false,
    });

    // The model asks for a shell write; with `shell = false` the lane never
    // installed bash, so the call is refused and the workspace is untouched.
    const workspace = tmpRoot('kubic-90-ws-');
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxToolUse([
        fauxToolCall('bash', { command: 'printf "x\\n" > created.txt' }),
      ]),
      fauxAssistantMessage('done'),
    ]);
    const result = await runHeadlessPrompt(
      'write a file through bash',
      {},
      {
        sessionsRoot: root,
        models,
        env: new NodeExecutionEnv(workspace),
        policyClasses: runtime.permissions.classes,
        journalRetention:
          runtime.journal.maxAgeMs === undefined
            ? {}
            : { maxAgeMs: runtime.journal.maxAgeMs },
      },
    );
    expect(result.terminus).toBe('completed');
    expect(existsSync(join(workspace, 'created.txt'))).toBe(false);
    // The run wrote a real session whose journal exists at the documented
    // location (§E3) — the config did not stop the run, it shaped it.
    const journalDir = join(root, result.sessionId, 'journal');
    expect(existsSync(journalDir)).toBe(true);
    expect(new FileJournalStore(journalDir).entries()).toEqual([]);
  });

  it('excludes a configured out-of-scope directory from the run’s baseline and sweep', async () => {
    // §35/§42.5 end to end (issue #115): the config key must reach the
    // headless lane's reconciliation, not merely parse. `vendor/` is declared
    // out of scope; a change under it during the run is never baselined,
    // never swept, and never shown by `kubic diff`.
    const sessionsRoot = tmpRoot();
    const workspace = tmpRoot('kubic-115-ws-');
    mkdirSync(join(workspace, 'vendor'));
    writeFileSync(join(workspace, 'vendor', 'out.js'), 'gen\n');
    writeFileSync(join(workspace, 'in-scope.txt'), 'v1\n');
    const runtime = loadRuntimeConfig({
      bridge: {
        exists: (path: string): boolean =>
          path === `${sessionsRoot}/.kubic/config.toml`,
        readTextFile: (): string =>
          '[journal]\noutOfScope = ["vendor"]\n[approvals]\nroute = "ask-user"\n',
      },
      home: '/nonexistent-home',
      cwd: sessionsRoot,
      enterprisePath: '/nonexistent/config.toml',
      projectTrusted: true,
      env: {},
    });
    const deps = runtimeRunDeps({
      runtime,
      error: undefined,
      ignoreSplit: { missing: [], checked: [], applicable: false },
      trust: NO_PROJECT_TRUST,
    });
    // The projection the composition root spreads into the runner deps.
    expect(deps.reconcileOutOfScope).toEqual(['vendor']);

    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxToolUse([
        fauxToolCall('bash', {
          command:
            'printf "rebuilt\\n" > vendor/out.js; printf "v2\\n" > in-scope.txt',
        }),
      ]),
      fauxAssistantMessage('mutated'),
    ]);
    const result = await runHeadlessPrompt(
      'mutate a file through bash',
      {},
      {
        sessionsRoot,
        models,
        env: new NodeExecutionEnv(workspace),
        ...deps,
      },
    );
    expect(result.terminus).toBe('completed');
    const store = new FileJournalStore(
      join(sessionsRoot, result.sessionId, 'journal'),
    );
    const paths = store.entries().map((e) => e.path);
    expect(paths).toContain('in-scope.txt');
    expect(paths).not.toContain('vendor/out.js');

    // `kubic diff --session <id>` on the run shows only in-scope changes.
    const diffOut: string[] = [];
    expect(
      await runJournalCommand(
        { command: 'diff', session: result.sessionId },
        {
          root: workspace,
          sessionsRoot,
          out: (line) => diffOut.push(line),
        },
      ),
    ).toBe(0);
    expect(diffOut.join('\n')).toContain('in-scope.txt');
    expect(diffOut.join('\n')).not.toContain('vendor');
  });

  it('leaves the lane on its own defaults when no config value is set', async () => {
    const root = tmpRoot();
    const runtime = loadRuntimeConfig({
      bridge: createNodeFileBridge(root),
      home: '/nonexistent-home',
      cwd: root,
      enterprisePath: '/nonexistent/config.toml',
      projectTrusted: false,
      env: {},
    });
    // §40/§12.1: an absent [permissions] section resolves to the solo
    // defaults — never to the most permissive or restrictive extreme.
    expect(runtime.permissions.classes).toEqual({
      ...SOLO_DEFAULTS,
    });
    expect(runtime.permissions.source).toBe('defaults');
    // The same shell write the narrowed lane refused goes through on the
    // defaults: the refusal above came from the config, not the lane.
    const workspace = tmpRoot('kubic-90-ws-');
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxToolUse([
        fauxToolCall('bash', { command: 'printf "x\\n" > created.txt' }),
      ]),
      fauxAssistantMessage('done'),
    ]);
    const result = await runHeadlessPrompt(
      'write a file through bash',
      {},
      {
        sessionsRoot: root,
        models,
        env: new NodeExecutionEnv(workspace),
        policyClasses: runtime.permissions.classes,
      },
    );
    expect(result.terminus).toBe('completed');
    expect(readFileSync(join(workspace, 'created.txt'), 'utf8')).toBe('x\n');
  });
});

describe('solo-lane projections reach the live path (issue #133)', () => {
  const NO_SPLIT = { missing: [], checked: [], applicable: false };

  function namedRuntime(workspace: string, toml: string): RuntimeConfig {
    return loadRuntimeConfig({
      bridge: {
        exists: (path: string): boolean =>
          path === `${workspace}/.kubic/config.toml`,
        readTextFile: (): string => toml,
      },
      home: '/nonexistent-home',
      cwd: workspace,
      enterprisePath: '/nonexistent/config.toml',
      projectTrusted: true,
      env: {},
    });
  }

  it('names the lane from [agent].name in the journal and the diff filter', async () => {
    const sessionsRoot = tmpRoot();
    const workspace = tmpRoot('kubic-133-agent-');
    writeFileSync(join(workspace, 'note.txt'), 'v1\n');
    const runtime = namedRuntime(
      workspace,
      '[agent]\nname = "kubic-solo"\n[approvals]\nroute = "ask-user"\n',
    );
    expect(runtime.config.agent?.name).toBe('kubic-solo');
    const lane = runtimeLaneDeps({
      runtime,
      error: undefined,
      ignoreSplit: NO_SPLIT,
      trust: NO_PROJECT_TRUST,
    });
    // The composition-root projection `kubic run` spreads into the runner.
    expect(lane.agentId).toBe('kubic-solo');

    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxToolUse([
        fauxToolCall('bash', { command: 'printf "v2\\n" > note.txt' }),
      ]),
      fauxAssistantMessage('mutated'),
    ]);
    const result = await runHeadlessPrompt(
      'mutate note.txt',
      {},
      {
        sessionsRoot,
        models,
        env: new NodeExecutionEnv(workspace),
        ...lane,
      },
    );
    expect(result.terminus).toBe('completed');
    const store = new FileJournalStore(
      join(sessionsRoot, result.sessionId, 'journal'),
    );
    const entries = store.entries();
    expect(entries.length).toBeGreaterThan(0);
    // Every entry the run wrote is attributed to the configured id.
    expect([...new Set(entries.map((entry) => entry.agentId))]).toEqual([
      'kubic-solo',
    ]);

    // `kubic diff --agent` filters by the configured id — and only by it.
    const named: string[] = [];
    expect(
      await runJournalCommand(
        { command: 'diff', agent: 'kubic-solo', session: result.sessionId },
        { root: workspace, sessionsRoot, out: (line) => named.push(line) },
      ),
    ).toBe(0);
    expect(named.join('\n')).toContain('note.txt');
    const asRoot: string[] = [];
    await runJournalCommand(
      { command: 'diff', agent: 'root', session: result.sessionId },
      { root: workspace, sessionsRoot, out: (line) => asRoot.push(line) },
    );
    expect(asRoot.join('\n')).not.toContain('note.txt');

    // Unset: the lane is 'root' — byte-identical to today.
    const bare = loadRuntimeConfig({
      bridge: createNodeFileBridge(workspace),
      home: '/nonexistent-home',
      cwd: workspace,
      enterprisePath: '/nonexistent/config.toml',
      projectTrusted: false,
      env: {},
    });
    const bareLane = runtimeLaneDeps({
      runtime: bare,
      error: undefined,
      ignoreSplit: NO_SPLIT,
      trust: NO_PROJECT_TRUST,
    });
    expect(bareLane.agentId).toBeUndefined();
    const bareFaux = fauxProvider();
    const bareModels = createModels();
    bareModels.setProvider(bareFaux.provider);
    bareFaux.setResponses([
      fauxToolUse([
        fauxToolCall('bash', { command: 'printf "v3\\n" > note.txt' }),
      ]),
      fauxAssistantMessage('mutated'),
    ]);
    const bareRun = await runHeadlessPrompt(
      'mutate again',
      {},
      {
        sessionsRoot,
        models: bareModels,
        env: new NodeExecutionEnv(workspace),
        ...bareLane,
      },
    );
    expect(bareRun.terminus).toBe('completed');
    const bareEntries = new FileJournalStore(
      join(sessionsRoot, bareRun.sessionId, 'journal'),
    ).entries();
    expect([...new Set(bareEntries.map((entry) => entry.agentId))]).toEqual([
      'root',
    ]);
  });

  it('layers [roles.<name>] model + tools under the role document', async () => {
    const sessionsRoot = tmpRoot();
    const workspace = tmpRoot('kubic-133-roles-');
    mkdirSync(join(workspace, '.kubic', 'roles'), { recursive: true });
    writeFileSync(
      join(workspace, '.kubic', 'roles', 'implementer.md'),
      '---\nrole: implementer\ntools: [read, ls, write, bash]\n---\n## Prompt\n\nImplement the step.\n',
    );
    const runtime = namedRuntime(
      workspace,
      '[roles.implementer]\nmodel = "faux-b/faux-1"\ntools = ["read"]\n[approvals]\nroute = "ask-user"\n',
    );
    const lane = runtimeLaneDeps({
      runtime,
      error: undefined,
      ignoreSplit: NO_SPLIT,
      trust: NO_PROJECT_TRUST,
    });
    // The projection carries the config table as a layer input, attributed to
    // the layer that set each leaf — the resolver's own merge consumes it.
    expect(lane.roles?.layers).toEqual([
      {
        layer: 'project',
        roles: { implementer: { model: 'faux-b/faux-1', tools: ['read'] } },
      },
    ]);

    // Two providers: A is the first-available pick, B is the configured role
    // model. Only B is scripted — a run that ignores the config fails here.
    const fauxA = fauxProvider({ provider: 'faux-a' });
    const fauxB = fauxProvider({ provider: 'faux-b' });
    const models = createModels();
    models.setProvider(fauxA.provider);
    models.setProvider(fauxB.provider);
    fauxB.setResponses([fauxAssistantMessage('from-b')]);
    const debug: string[] = [];
    const result = await runHeadlessPrompt(
      'do the step',
      { role: 'implementer' },
      {
        sessionsRoot,
        models,
        env: new NodeExecutionEnv(workspace),
        debug: (line) => debug.push(line),
        ...lane,
      },
    );
    expect(result.terminus).toBe('completed');
    expect(result.summary).toBe('from-b');
    // The tool half of the same layer narrowed the resolved set: the config's
    // `tools = ["read"]` wins over the document's broader list.
    expect(debug.join('\n')).toContain('[policy] role=implementer tools=read');
  });

  it('the wiring itself: every production runner consumes the projection', async () => {
    // One projection, three one-line consumers (`kubic run`, `kubic tui`, and
    // the live `kubic replay` re-execution — issue #272).
    // The defect class this issue closes is "the mechanism exists and
    // nothing populates it", so the composition root's own spreads are
    // pinned: a dropped consumer would silently un-name a lane again.
    const source = readFileSync(
      join(
        import.meta.dirname,
        '..',
        '..',
        '..',
        '..',
        'apps',
        'kubic',
        'src',
        'prod-runners.ts',
      ),
      'utf8',
    );
    expect(
      source.match(/\.\.\.runtimeLaneDeps\(cliConfig\)/g) ?? [],
    ).toHaveLength(3);
  });
});
