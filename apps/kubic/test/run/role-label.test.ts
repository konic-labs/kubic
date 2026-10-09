// The run's role, as the heading of `kubic run` and the head row of the TUI's
// agent tree name it: the `--role` name when one is selected, otherwise
// `default`. A role name is user-controlled, so a long one is cut to its
// column. Faux provider, zero network.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
} from '@kubic/agent/pi-boundary';
import { createCliTheme } from '@kubic/core/cli/theme';
import { FakeExecutionEnv } from '@kubic/exec/test-support/fake-env';
import { describe, expect, it } from 'vitest';
import { terminalRig } from '../../../../test/fake-terminal.js';
import { tempDir } from '../../../../test/temp-dir.js';
import { runHeadlessPrompt } from '../../src/run/command.js';
import { createRunProgress } from '../../src/run/progress.js';
import { runTuiCommand } from '../../src/tui/run.js';

// The role name is longer than its column (20): it is cut to 19 characters
// and an ellipsis.
const LONG_ROLE = 'performance-regression-checker';
const LONG_LABEL = 'performance-regress…';

// The shape .kubic/roles/*.md use: frontmatter and a `## Prompt` section.
function writeRole(root: string, name: string): void {
  const dir = join(root, '.kubic', 'roles');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${name}.md`),
    `---\nrole: ${name}\ntools: [read, ls, find, grep]\nfilesystem: read\nshell: false\nnetwork: none\ngit: false\ncredentials: none\n---\n\n# ${name}\n\n## Prompt\n\nReview the change.\n`,
  );
}

function fauxModels(): ReturnType<typeof createModels> {
  const faux = fauxProvider({
    provider: 'faux',
    models: [{ id: 'small', contextWindow: 120000 }],
  });
  faux.setResponses([fauxAssistantMessage('reviewed')]);
  const registry = createModels();
  registry.setProvider(faux.provider);
  return registry;
}

// The first settled line of what a terminal ends up showing.
function firstSettledLine(chunks: readonly string[]): string {
  const first = chunks.join('').split('\n')[0] ?? '';
  return stripVTControlCharacters(first.slice(first.lastIndexOf('\r') + 1));
}

// The heading `kubic run` prints for one headless prompt, through the real
// progress sink. The role documents live under `rolesCwd`.
async function headingFor(
  rolesCwd: string,
  role: string | undefined,
): Promise<string> {
  const cwd = tempDir('run-role-cwd-');
  const chunks: string[] = [];
  const progress = createRunProgress(
    { isTTY: true, columns: 100, write: (chunk: string) => chunks.push(chunk) },
    createCliTheme('none'),
    { cwd, now: () => 0, spinner: { onExit: () => () => {} } },
  );
  await runHeadlessPrompt(
    'review the change',
    { progress, ...(role === undefined ? {} : { role }) },
    {
      sessionsRoot: tempDir('run-role-sessions-'),
      models: fauxModels(),
      env: new FakeExecutionEnv({}),
      roles: { cwd: rolesCwd, trusted: true },
    },
  );
  return firstSettledLine(chunks);
}

async function waitFor(condition: () => boolean, ticks = 500): Promise<void> {
  for (let i = 0; i < ticks && !condition(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  expect(condition()).toBe(true);
}

// The frame a `kubic tui` boot draws once the agent tree is shown (Ctrl-T),
// after it has drawn `expected`. The lane boot is injected: no provider call.
async function treeFrameFor(
  role: string | undefined,
  expected: string,
): Promise<string> {
  const rig = terminalRig(100, 30);
  const pending = runTuiCommand(role === undefined ? {} : { role }, {
    out: () => undefined,
    createTerminal: () => rig.terminal,
    colorLevel: 'none',
    bootLane: async (sessionId?: string) => ({
      sessionId: sessionId ?? 's1',
      model: 'faux/test',
    }),
  });
  await waitFor(() => rig.counts.started === 1);
  rig.feed('\x14');
  await waitFor(() => rig.writes.join('').includes(expected));
  const frame = rig.writes.join('');
  rig.feed('\x03');
  rig.feed('\x03');
  expect((await pending).exitCode).toBe(0);
  return frame;
}

describe('the run role in the heading of `kubic run`', () => {
  it('names a run without --role as the default role', async () => {
    const heading = await headingFor(tempDir('run-role-roles-'), undefined);
    expect(heading).toContain('■ kubic run · default · faux/small ·');
  });

  it('names the selected role', async () => {
    const heading = await headingFor(tempDir('run-role-roles-'), 'reviewer');
    expect(heading).toContain('■ kubic run · reviewer · faux/small ·');
    expect(heading).not.toContain('· default ·');
  });

  it('cuts a long role name to its column and keeps the heading within the terminal', async () => {
    const rolesCwd = tempDir('run-role-roles-');
    writeRole(rolesCwd, LONG_ROLE);
    const heading = await headingFor(rolesCwd, LONG_ROLE);
    expect(heading).toContain(`■ kubic run · ${LONG_LABEL} · faux/small ·`);
    expect(heading).not.toContain(LONG_ROLE);
    expect(heading.length).toBeLessThanOrEqual(100);
  });
});

describe('the run role on the head row of the TUI agent tree', () => {
  it('labels the tree with the default role without --role', async () => {
    const frame = await treeFrameFor(undefined, '◌ default');
    expect(frame).toContain('◌ default');
  });

  it('labels the tree with the selected role', async () => {
    const frame = await treeFrameFor('reviewer', '◌ reviewer');
    expect(frame).toContain('◌ reviewer');
  });

  it('cuts a long role name on the tree row to its column', async () => {
    const frame = await treeFrameFor(LONG_ROLE, `◌ ${LONG_LABEL}`);
    expect(frame).toContain(`◌ ${LONG_LABEL}`);
    expect(frame).not.toContain(LONG_ROLE);
  });
});
