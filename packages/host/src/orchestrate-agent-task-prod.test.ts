// §67 AgentTask on the PROD orchestrate path (issue #191; §12/§12.1, §11.1).
//
// The manager composes a worker's role from the WORKING TREE, while the child
// used to re-derive it from its own worktree (a checkout of HEAD) — so an
// uncommitted role document gave the parent one tool set and the child
// another. The task now travels with the work: the manager builds and
// validates it, writes it into the worker's session dir, and the child
// registers exactly `task.toolNames`.
//
// Real git, real child processes, faux models only: the fixture child dumps
// its cwd and the KUBIC_TASK_FILE it was handed, and the test then replays
// the REAL child boot in-process with that env against a worktree whose
// committed role document differs from the manager's working tree — the
// registered tool set must be the task's, not the document's.
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runHeadlessPrompt } from '../../../apps/kubic/src/headless-run.js';
import { orchestrateDepsWithDefaults } from '../../../apps/kubic/src/orchestrate-run.js';
import { buildAgentTask } from '../../agents/src/task.js';
import { NodeExecutionEnv } from '../../exec/src/env.js';
import { createNodeFileBridge } from '../../exec/src/file-bridge.js';
import {
  attachSession,
  openSessionStore,
} from '../../worker/src/lane/session-store.js';
import { SOLO_PROMPT_SECTION } from '../../worker/src/lane/solo.js';
import { readSessionEntries } from '../../worker/src/lane/transcript.js';
import { WorkerRegistry } from '../../worker/src/lifecycle/registry.js';
import { workersListFromRepo } from '../../worker/src/lifecycle/rows.js';
import {
  BACKGROUND_CONTEXT,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  SystemEntry,
} from '../../worker/src/pi-boundary.js';
import { runOrchestrateCommand } from './orchestrate-cli.js';

const scratchDirs: string[] = [];

function scratchRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const FIXTURE = `
import { writeFileSync } from 'node:fs';
const argv = process.argv.slice(2);
const prompt = argv[argv.indexOf('-p') + 1] ?? '';
const dumpDir = /DUMPDIR=(\\S+)/.exec(prompt)?.[1];
if (dumpDir !== undefined) {
  const id = process.env.KUBIC_WORKER_ID ?? 'worker';
  writeFileSync(dumpDir + '/' + id + '.json', JSON.stringify({
    cwd: process.cwd(),
    taskFile: process.env.KUBIC_TASK_FILE ?? null,
    argv: process.argv.slice(2),
  }));
}
process.stdout.write('KUBIC_WORKER_READY ' + (process.env.KUBIC_WORKER_ID ?? '') + '\\n');
const a = process.argv;
process.stdout.write(JSON.stringify({ ok: true, exitCode: 0, sessionId: a[a.indexOf('--session') + 1], status: 'completed', result: { summary: 'fixture done' } }) + String.fromCharCode(10));
process.exit(0);
`;

function roleText(name: string, tools: string[], prompt: string): string {
  return [
    '---',
    `role: ${name}`,
    `tools: [${tools.join(', ')}]`,
    'filesystem: workspace-write',
    'shell: true',
    'network: none',
    'git: false',
    'credentials: none',
    '---',
    '',
    `# ${name}`,
    '',
    '## Prompt',
    '',
    prompt,
    '',
  ].join('\n');
}

// A repo whose COMMITTED implementer document grants [read, ls]; the caller
// may then edit the working tree to a different set (uncommitted) — exactly
// the parent-composes-from-the-working-tree case #191 describes.
async function initRepo(committedTools: string[] | null): Promise<string> {
  const root = scratchRoot('kubic-orch-191-');
  execFileSync('git', ['init', '-b', 'main'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'task@kubic.dev'], {
    cwd: root,
  });
  execFileSync('git', ['config', 'user.name', 'kubic task'], { cwd: root });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: root });
  writeFileSync(join(root, 'base.txt'), 'base\n');
  if (committedTools !== null) {
    mkdirSync(join(root, '.kubic', 'roles'), { recursive: true });
    writeFileSync(
      join(root, '.kubic', 'roles', 'implementer.md'),
      roleText('implementer', committedTools, 'You are the implementer.'),
    );
  }
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'base + implementer'], { cwd: root });
  return root;
}

interface Dump {
  cwd: string;
  taskFile: string | null;
  argv: string[];
}

async function runOne(
  root: string,
  options: { session?: string; agents?: string[]; skills?: string[] } = {},
): Promise<{ dump: Dump; dumpDir: string; code: number; lines: string[] }> {
  const fixture = join(scratchRoot('kubic-orch-191-child-'), 'child.mjs');
  writeFileSync(fixture, FIXTURE);
  const dumpDir = scratchRoot('kubic-orch-191-dump-');
  const lines: string[] = [];
  const deps = await orchestrateDepsWithDefaults({
    out: (line) => lines.push(line),
    err: (line) => lines.push(line),
    cwd: root,
    sessionsRoot: scratchRoot('kubic-orch-191-sessions-'),
    registry: new WorkerRegistry(),
    workerEntry: { cmd: process.execPath, args: [fixture] },
    // Issue #430: the scratch repo stands in for a trusted project.
    projectTrust: () => true,
  });
  const code = await runOrchestrateCommand(
    {
      prompt: `do the thing DUMPDIR=${dumpDir}`,
      agents: options.agents ?? ['alpha'],
      yes: true,
      session: options.session ?? 'task191',
      ...(options.skills === undefined ? {} : { skills: options.skills }),
    },
    deps,
  );
  return {
    dump: JSON.parse(readFileSync(join(dumpDir, 'alpha.json'), 'utf8')) as Dump,
    dumpDir,
    code,
    lines,
  };
}

function toolsLineOf(prompt: string): string[] {
  const line = /^tools: (.*)$/m.exec(prompt)?.[1] ?? '';
  return line.split(',').map((name) => name.trim());
}

async function committedPrompt(
  root: string,
  sessionId: string,
): Promise<string> {
  const store = openSessionStore(root, createNodeFileBridge(root));
  const session = await attachSession(store, sessionId, BACKGROUND_CONTEXT);
  try {
    const entries = await readSessionEntries(
      session.storage,
      BACKGROUND_CONTEXT,
    );
    for (const entry of [...entries].reverse()) {
      if (!SystemEntry.is(entry)) continue;
      const messages = entry.model as unknown as
        | Array<{ sections?: Record<string, string | null> }>
        | undefined;
      const prompt = messages?.[0]?.sections?.[SOLO_PROMPT_SECTION];
      if (typeof prompt === 'string' && prompt !== '') return prompt;
    }
    return '';
  } finally {
    await session.release(BACKGROUND_CONTEXT);
  }
}

function fauxModels(): ReturnType<typeof createModels> {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage('done')]);
  return models;
}

describe('prod orchestrate path: the worker gets its §67 task (issue #191)', () => {
  it('carries an uncommitted role edit to the worker and registers its tool set (acceptances 1-2)', async () => {
    const root = await initRepo(['read', 'ls']);
    // The manager's working tree grants more than HEAD does: the task must
    // carry the manager's resolution, and the child's lane must register it
    // even though its own worktree's committed document says [read, ls].
    const workingTools = ['read', 'ls', 'grep', 'write', 'edit', 'bash'];
    const doc = join(root, '.kubic', 'roles', 'implementer.md');
    writeFileSync(
      doc,
      roleText('implementer', workingTools, 'You are the implementer.'),
    );
    // The edit stays UNCOMMITTED (the manager composes from the working
    // tree); assume-unchanged is the fixture's way of holding that difference
    // without tripping the pre-merge clean-tree guard, which refuses a dirty
    // tree by design.
    execFileSync(
      'git',
      ['update-index', '--assume-unchanged', '.kubic/roles/implementer.md'],
      { cwd: root },
    );
    const { dump, code, lines } = await runOne(root);
    expect(code, lines.join('\n')).toBe(0);
    expect(dump.taskFile).not.toBeNull();
    const task = JSON.parse(readFileSync(dump.taskFile as string, 'utf8')) as {
      taskId: string;
      role: string;
      toolNames: string[];
      worktree: string;
    };
    expect(task.role).toBe('implementer');
    // The resolver sorts the resolved set; the grant is the same tools.
    expect([...task.toolNames].sort()).toEqual([...workingTools].sort());
    expect(task.worktree).toBe(dump.cwd);
    // The child's own worktree has the COMMITTED document (the narrower set):
    // the task is what decides, so the replay registers the task's tools.
    expect(
      readFileSync(join(dump.cwd, '.kubic', 'roles', 'implementer.md'), 'utf8'),
    ).toContain('[read, ls]');
    vi.stubEnv('KUBIC_TASK_FILE', dump.taskFile as string);
    vi.stubEnv('KUBIC_WORKER_ID', 'alpha');
    const replayRoot = scratchRoot('kubic-orch-191-replay-');
    const result = await runHeadlessPrompt(
      'do the thing',
      // The real child is spawned with `--role implementer`; the task is what
      // makes that role's TOOL SET the manager's, not the worktree's.
      { role: 'implementer' },
      {
        sessionsRoot: replayRoot,
        models: fauxModels(),
        env: new NodeExecutionEnv(dump.cwd),
        // The real child's cwd IS its worktree: the role document it would
        // otherwise load is the committed (narrow) one.
        roles: { cwd: dump.cwd },
      },
    );
    expect(result.terminus).toBe('completed');
    const prompt = await committedPrompt(replayRoot, result.sessionId);
    const registered = toolsLineOf(prompt);
    for (const tool of workingTools) {
      expect(registered).toContain(tool);
    }
    expect(registered).not.toContain('find');
  });

  it('refuses the spawn when the assignment carries no tool set (acceptance 3)', async () => {
    // `[roles.implementer] tools = []` resolves an assignment with an empty
    // grant: the task cannot validate, so the spawn is refused by name —
    // never silently widened to the full solo set.
    const root = await initRepo(['read', 'ls']);
    mkdirSync(join(root, '.kubic'), { recursive: true });
    writeFileSync(
      join(root, '.kubic', 'config.toml'),
      '[roles.implementer]\ntools = []\n',
    );
    vi.stubEnv('KUBIC_TRUST_PROJECT', '1');
    const fixture = join(scratchRoot('kubic-orch-191-child-'), 'child.mjs');
    writeFileSync(fixture, FIXTURE);
    const dumpDir = scratchRoot('kubic-orch-191-dump-');
    const lines: string[] = [];
    const { loadCliConfig, roleLayersFromConfig } = await import(
      '../../../apps/kubic/src/config-runtime.js'
    );
    const loaded = loadCliConfig({
      cwd: root,
      env: { KUBIC_TRUST_PROJECT: '1' },
      home: scratchRoot('kubic-orch-191-home-'),
    });
    expect(loaded.error).toBeUndefined();
    const deps = await orchestrateDepsWithDefaults({
      out: (line) => lines.push(line),
      err: (line) => lines.push(line),
      cwd: root,
      sessionsRoot: scratchRoot('kubic-orch-191-sessions-'),
      registry: new WorkerRegistry(),
      workerEntry: { cmd: process.execPath, args: [fixture] },
      // Issue #430: the scratch repo stands in for a trusted project.
      projectTrust: () => true,
      roleLayers: roleLayersFromConfig(loaded.runtime as never),
    });
    const code = await runOrchestrateCommand(
      { prompt: `x DUMPDIR=${dumpDir}`, agents: ['alpha'], yes: true },
      deps,
    );
    expect(code).toBe(1);
    expect(lines.join('\n')).toMatch(/code=task_refused/);
    expect(lines.join('\n')).toMatch(/toolNames must be a non-empty/);
  });
});

describe('prod orchestrate path: --skill reaches every worker (issue #170)', () => {
  it('puts the run’s skills in the child argv, absolute, and in the task and the registry row', async () => {
    const root = await initRepo(['read', 'ls']);
    mkdirSync(join(root, 'skills'), { recursive: true });
    writeFileSync(join(root, 'skills', 'house.md'), '# house\n');
    // Committed: an untracked file would trip the pre-merge clean-tree guard.
    execFileSync('git', ['add', '-A'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'add the skill'], { cwd: root });
    const absolute = join(root, 'skills', 'house.md');
    const { dump, code, lines } = await runOne(root, {
      // Relative on purpose: the child runs in its own worktree, so the
      // manager resolves it against ITS cwd before the value travels.
      skills: ['./skills/house.md'],
    });
    expect(code, lines.join('\n')).toBe(0);
    const at = dump.argv.indexOf('--skill');
    expect(at).toBeGreaterThan(-1);
    expect(dump.argv[at + 1]).toBe(absolute);
    // §67 task resources travel with the task…
    const task = JSON.parse(readFileSync(dump.taskFile as string, 'utf8')) as {
      resources?: { skills?: string[] };
    };
    expect(task.resources).toEqual({ skills: [absolute] });
    // …and the registry row is what `kubic workers` reads (the run persists
    // it to <repo>/.kubic/orchestrator/workers.json).
    const rows = workersListFromRepo(root);
    expect(rows[0]?.resources).toEqual({ skills: [absolute] });
  });
});

describe('prod orchestrate path: an inherited task never leaks (issue #191 review)', () => {
  it('replaces an inherited KUBIC_TASK_FILE with the run’s own task', async () => {
    // An outer worker's env carries its own KUBIC_TASK_FILE (the allowlist
    // passes it); the inner run hands its own task (the built-in implementer
    // preset, issue #203), so the child must read THAT file — never the outer
    // one, whose worktree check would fail the inner run.
    const root = await initRepo(null);
    const outer = join(root, 'outer-task.json');
    vi.stubEnv('KUBIC_TASK_FILE', outer);
    const { dump, code, lines } = await runOne(root);
    expect(code, lines.join('\n')).toBe(0);
    const taskFile = dump.taskFile ?? '';
    expect(taskFile).not.toBe('');
    expect(taskFile).not.toBe(outer);
    expect(taskFile.endsWith('agent-task.json')).toBe(true);
  });
});

describe('prod orchestrate path: the child refuses a bad task (issue #191)', () => {
  async function childWithTask(
    taskFile: string | undefined,
    cwd: string,
  ): Promise<{ terminus: string; summary: string }> {
    const sessionsRoot = scratchRoot('kubic-orch-191-bad-');
    if (taskFile === undefined) delete process.env.KUBIC_TASK_FILE;
    else vi.stubEnv('KUBIC_TASK_FILE', taskFile);
    const result = await runHeadlessPrompt(
      'do the thing',
      {},
      {
        sessionsRoot,
        models: fauxModels(),
        env: new NodeExecutionEnv(cwd),
      },
    );
    return { terminus: result.terminus, summary: result.summary };
  }

  it('fails closed on an unreadable, malformed or invalid task file', async () => {
    const cwd = scratchRoot('kubic-orch-191-cwd-');
    const missing = join(cwd, 'nope.json');
    const malformed = join(cwd, 'malformed.json');
    writeFileSync(malformed, '{');
    const invalid = join(cwd, 'invalid.json');
    writeFileSync(
      invalid,
      JSON.stringify({
        taskId: 't1',
        parentSessionId: 'sess',
        role: 'implementer',
        objective: 'ship it',
        worktree: 'relative/path',
        workspaceMode: 'worktree',
        toolNames: ['read'],
        budget: {},
      }),
    );
    const cases: Array<{ path: string; match: RegExp }> = [
      { path: missing, match: /is unreadable/ },
      { path: malformed, match: /is not valid JSON/ },
      { path: invalid, match: /refused: .*worktree must be an absolute path/ },
    ];
    for (const entry of cases) {
      const result = await childWithTask(entry.path, cwd);
      expect(result.terminus, entry.path).toBe('failed');
      expect(result.summary, entry.path).toMatch(entry.match);
    }
  });

  it('fails closed when the task names a different worktree', async () => {
    const cwd = scratchRoot('kubic-orch-191-cwd-');
    const other = scratchRoot('kubic-orch-191-other-');
    const built = buildAgentTask({
      taskId: 'sess:alpha',
      parentSessionId: 'sess',
      role: 'implementer',
      objective: 'ship it',
      worktree: other,
      toolNames: ['read'],
    });
    expect(built.valid).toBe(true);
    const file = join(cwd, 'task.json');
    writeFileSync(file, JSON.stringify(built.valid ? built.task : {}));
    const result = await childWithTask(file, cwd);
    expect(result.terminus).toBe('failed');
    expect(result.summary).toMatch(/names worktree/);
    expect(result.summary).toMatch(/but this run is in/);
  });

  it('treats an empty KUBIC_TASK_FILE as no task (an inner run inherits none)', async () => {
    const cwd = scratchRoot('kubic-orch-191-cwd-');
    const result = await childWithTask('', cwd);
    expect(result.terminus).toBe('completed');
  });
});
