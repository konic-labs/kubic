// Roles on the live solo path (issue #99, scope item 1; §12/§12.1, §40.3).
// RED: .kubic/roles/*.md exist and are tracked, but nothing parses them at
// runtime — loadRoleDocuments and roleDoctorChecks have test-only callers,
// and the solo prompt is the hardcoded SOLO_ROLE constant. Every test below
// fails until the composition root loads the documents through the resolver,
// refuses a contradictory role by name, and applies the resolved tool set +
// prompt on a live `--role` path.
//
// Faux provider only (zero network, zero paid tokens).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runHeadlessPrompt } from '../../../apps/kubic/src/headless-run.js';
import { FakeExecutionEnv } from '../../exec/src/env.js';
import { createNodeFileBridge } from '../../exec/src/file-bridge.js';
import {
  attachSession,
  openSessionStore,
} from '../../worker/src/lane/session-store.js';
import { SOLO_PROMPT_SECTION } from '../../worker/src/lane/solo.js';
import { readSessionEntries } from '../../worker/src/lane/transcript.js';
import {
  BACKGROUND_CONTEXT,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  type MutableModels,
  SystemEntry,
} from '../../worker/src/pi-boundary.js';
import { runDoctorCommand } from './doctor.js';
import { rolesDoctorProbe } from './roles/roles-boot.js';
import { runRunCommand } from './run-cli.js';

const roots: string[] = [];

function tmpRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function fauxModels(texts: string[]): MutableModels {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(texts.map((text) => fauxAssistantMessage(text)));
  return models;
}

// The shape .kubic/roles/*.md really use: frontmatter + a `## Prompt`
// section carrying the role text.
function writeRole(
  root: string,
  name: string,
  frontmatter: string,
  prompt: string,
): void {
  const dir = join(root, '.kubic', 'roles');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${name}.md`),
    `---\nrole: ${name}\n${frontmatter}---\n\n# ${name}\n\n## Prompt\n\n${prompt}\n`,
  );
}

// The solo prompt the lane committed for this session (#400's reader): the
// run's own durable record of the bytes the model saw — the harness-spy
// equivalent on the durable lane.
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

// The solo no-isolation notice is pinned by solo-notice-prod.test.ts; here it
// is only stderr noise, silenced through its documented opt-out.
beforeEach(() => {
  vi.stubEnv('KUBIC_NO_NOTICE', '1');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('role documents drive a live solo lane (issue #99, §12.1)', () => {
  it("editing .kubic/roles/<name>.md changes the lane's system prompt on --role", async () => {
    const cwd = tmpRoot('roles-cwd-');
    writeRole(
      cwd,
      'planner',
      'tools: [read, ls, find, grep]\nfilesystem: read\nshell: false\nnetwork: none\ngit: false\ncredentials: none\n',
      'You are the planner. Decompose objectives into ordered steps.',
    );
    const root = tmpRoot('roles-sessions-');
    const result = await runHeadlessPrompt(
      'plan the work',
      { role: 'planner' },
      {
        sessionsRoot: root,
        models: fauxModels(['done']),
        env: new FakeExecutionEnv({}),
        roles: { cwd },
      },
    );
    expect(result.terminus).toBe('completed');
    const prompt = await committedPrompt(root, result.sessionId);
    // The document's own prompt text reached the harness, quoted section
    // and all.
    expect(prompt).toContain(
      'You are the planner. Decompose objectives into ordered steps.',
    );
    // Not the hardcoded solo constant.
    expect(prompt).not.toContain(
      'You are a coding agent working in a terminal.',
    );
  });

  it('hands the lane prompt only the role-declared tool set (absence, not approval)', async () => {
    const cwd = tmpRoot('roles-cwd-');
    writeRole(
      cwd,
      'reviewer',
      'tools: [read, ls, find, grep, git_status, git_diff, git_log, git_show]\nfilesystem: read\nshell: false\nnetwork: none\ngit: workspace\ncredentials: none\n',
      'You are the reviewer. Report findings.',
    );
    const root = tmpRoot('roles-sessions-');
    const result = await runHeadlessPrompt(
      'review it',
      { role: 'reviewer' },
      {
        sessionsRoot: root,
        models: fauxModels(['done']),
        env: new FakeExecutionEnv({}),
        roles: { cwd },
      },
    );
    const prompt = await committedPrompt(root, result.sessionId);
    // The `tools:` line carries the resolved allowlist, so the model is
    // told exactly what the lane registered: every role tool is named and
    // no write/edit/bash tool appears.
    const toolsLine = /^tools: (.*)$/m.exec(prompt)?.[1] ?? '';
    const registered = toolsLine.split(',').map((name) => name.trim());
    expect(registered).toContain('read');
    expect(registered).toContain('git_diff');
    expect(registered).not.toContain('write');
    expect(registered).not.toContain('edit');
    expect(registered).not.toContain('bash');
    expect(registered).not.toContain('git_commit');
  });

  it('refuses a role whose declared tool set contradicts its permission classes, naming the reason', async () => {
    const cwd = tmpRoot('roles-cwd-');
    // filesystem: read with a write tool registered — the §40.3
    // contradiction the resolver refuses.
    writeRole(
      cwd,
      'liar',
      'tools: [read, write]\nfilesystem: read\nshell: false\nnetwork: none\ngit: false\ncredentials: none\n',
      'You claim to be read-only.',
    );
    const root = tmpRoot('roles-sessions-');
    const result = await runHeadlessPrompt(
      'do the thing',
      { role: 'liar' },
      {
        sessionsRoot: root,
        models: fauxModels(['done']),
        env: new FakeExecutionEnv({}),
        roles: { cwd },
      },
    );
    // Fail closed, with the resolver's named reason — never a silent
    // fallback to the solo prompt.
    expect(result.terminus).toBe('failed');
    expect(result.summary).toContain("role 'liar'");
    expect(result.summary).toContain(
      "filesystem is 'read' but write tool 'write' is registered",
    );
  });

  it('fails closed when --role names a role with no document', async () => {
    const cwd = tmpRoot('roles-cwd-');
    writeRole(
      cwd,
      'planner',
      'tools: [read]\nfilesystem: read\nshell: false\nnetwork: none\ngit: false\ncredentials: none\n',
      'Plan.',
    );
    const root = tmpRoot('roles-sessions-');
    const result = await runHeadlessPrompt(
      'go',
      { role: 'ghost' },
      {
        sessionsRoot: root,
        models: fauxModels(['done']),
        env: new FakeExecutionEnv({}),
        roles: { cwd },
      },
    );
    expect(result.terminus).toBe('failed');
    expect(result.summary).toContain('ghost');
    expect(result.summary).toMatch(/no role document/i);
  });

  it('parses --role on the run command and passes it to the runner', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const exit = await runRunCommand(
      { prompt: 'hi', role: 'reviewer' },
      {
        out: () => undefined,
        run: (prompt, options) => {
          seen.push({ prompt, ...options });
          return Promise.resolve({
            terminus: 'completed',
            summary: 'ok',
            sessionId: 's',
            journalRef: 'journal:s',
            usageRef: 'usage:s',
            trajectoryRef: 'trajectory:s',
          });
        },
      },
    );
    expect(exit).toBe(0);
    expect(seen[0]?.role).toBe('reviewer');
  });
});

describe('kubic doctor reports every role document (issue #99, §41.4)', () => {
  it('surfaces roleDoctorChecks for the loaded documents, including a contradictory one', () => {
    const cwd = tmpRoot('roles-cwd-');
    writeRole(
      cwd,
      'planner',
      'tools: [read, ls, find, grep]\nfilesystem: read\nshell: false\nnetwork: none\ngit: false\ncredentials: none\n',
      'Plan.',
    );
    writeRole(
      cwd,
      'liar',
      'tools: [read, write]\nfilesystem: read\nshell: false\nnetwork: none\ngit: false\ncredentials: none\n',
      'Lie.',
    );
    const probe = rolesDoctorProbe({
      cwd,
      bridge: createNodeFileBridge(cwd),
    });
    const lines: string[] = [];
    return runDoctorCommand(
      { json: true },
      {
        out: (line) => lines.push(line),
        probeProviders: () => [
          { id: 'faux', reachable: true, dialled: true, models: ['faux-1'] },
        ],
        checkDeps: () => [{ id: 'node', ok: true }],
        loadPolicy: () => ({ route: 'ask-user', autoApprove: [] }),
        probeRoles: () => probe,
      },
    ).then((code) => {
      const report = JSON.parse(lines.join('\n')) as {
        ok: boolean;
        checks: Array<{
          id: string;
          status: string;
          reason: string;
          detail: string;
        }>;
      };
      const planner = report.checks.find(
        (check) => check.id === 'role:planner',
      );
      expect(planner?.status).toBe('pass');
      const liar = report.checks.find((check) => check.id === 'role:liar');
      expect(liar?.status).toBe('fail');
      expect(liar?.reason).toBe('policy-mismatch');
      expect(liar?.detail).toContain("filesystem is 'read' but write tool");
      // A failing role flips the doctor exit code (exit 1).
      expect(code).toBe(1);
      expect(report.ok).toBe(false);
    });
  });
});
