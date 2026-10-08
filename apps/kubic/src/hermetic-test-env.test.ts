// Hermetic unit-test environment. The solo prod path reads
// the account's skill roots (~/.agents/skills, ~/.pi/agent/skills) through
// homedir() and the project trust opt-in through KUBIC_TRUST_PROJECT, so
// before every system-prompt assertion depended on the developer's
// machine. The vitest setup file (test/vitest-setup.ts) isolates HOME and
// the KUBIC_* env per test file and refuses TCP sockets; these tests pin
// that contract.
//
// Faux provider only (zero network, zero paid tokens).
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { connect, Socket } from 'node:net';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  attachSession,
  openSessionStore,
} from '../../../packages/agent/src/lane/session-store.js';
import { PROMPT_SECTION } from '../../../packages/agent/src/lane/solo.js';
import { readSessionEntries } from '../../../packages/agent/src/lane/transcript.js';
import {
  BACKGROUND_CONTEXT,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  SystemEntry,
} from '../../../packages/agent/src/pi-boundary.js';
import { FakeExecutionEnv } from '../../../packages/exec/src/env.js';
import { createNodeFileBridge } from '../../../packages/exec/src/file-bridge.js';
import { isLoopbackHost, isolateTestEnv } from '../../../test/hermetic-env.js';
import { runHeadlessPrompt } from './headless-run.js';

// The solo prompt the lane committed for this session (the reader).
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
      const prompt = messages?.[0]?.sections?.[PROMPT_SECTION];
      if (typeof prompt === 'string' && prompt !== '') return prompt;
    }
    return '';
  } finally {
    await session.release(BACKGROUND_CONTEXT);
  }
}

const made: string[] = [];

function tmpRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

function writeSkill(root: string, name: string): void {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: Installed on the developer machine\n---\n\nBody.\n`,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe('hermetic unit-test environment', () => {
  // The mutation runner executes vitest with a thread pool, where a worker's
  // process.env is a JS-side copy: setting HOME there never reaches the C
  // environment os.homedir() reads, so the HOME half of these assertions
  // cannot hold there. The KUBIC_* half is JS-only and
  // still asserted; `npm run test:unit` (forks) proves the HOME isolation.
  const homedirIsolated = process.env.STRYKER_MUTATOR_WORKER === undefined;

  it('points HOME at a temp dir and clears the ambient KUBIC_* opt-ins', () => {
    if (homedirIsolated) {
      expect(homedir()).not.toBe(userInfo().homedir);
      expect(existsSync(homedir())).toBe(true);
    }
    const ambient = Object.keys(process.env).filter((key) =>
      key.startsWith('KUBIC_'),
    );
    expect(ambient).toEqual([]);
  });

  // Skipped under the mutation runner: its thread pool cannot isolate HOME
  // (a worker's process.env copy never reaches the C environment
  // os.homedir() reads), so the developer's real skills would leak into the
  // prompt and this would test the runner, not Kubic.
  it.skipIf(!homedirIsolated)(
    "keeps a developer's installed skills and trust opt-in out of the solo prompt",
    async () => {
      // A developer machine: skills in both account roots, trust exported.
      const devHome = tmpRoot('dev-home-');
      writeSkill(join(devHome, '.agents', 'skills'), 'dev-agents-skill');
      writeSkill(join(devHome, '.pi', 'agent', 'skills'), 'dev-pi-skill');
      vi.stubEnv('HOME', devHome);
      vi.stubEnv('KUBIC_TRUST_PROJECT', '1');
      vi.stubEnv('KUBIC_DEBUG', '1');

      const isolated = isolateTestEnv();
      try {
        expect(homedir()).toBe(isolated.home);
        const faux = fauxProvider();
        const models = createModels();
        models.setProvider(faux.provider);
        faux.setResponses([fauxAssistantMessage('done')]);
        const sessionsRoot = tmpRoot('hermetic-sessions-');
        const result = await runHeadlessPrompt(
          'hello',
          {},
          {
            sessionsRoot,
            models,
            env: new FakeExecutionEnv({}),
          },
        );
        expect(result.terminus).toBe('completed');
        const prompt = await committedPrompt(sessionsRoot, result.sessionId);
        expect(prompt).toContain('cwd:');
        expect(prompt).not.toContain('dev-agents-skill');
        expect(prompt).not.toContain('dev-pi-skill');
        // The repo's own skills/ and .agents/skills roots stay out too: the
        // trust opt-in is cleared, so project roots are never traversed.
        expect(prompt).not.toContain('<skills>');
      } finally {
        isolated.restore();
      }
      // Restore puts the caller's environment back and removes the temp HOME.
      expect(process.env.HOME).toBe(devHome);
      expect(process.env.KUBIC_TRUST_PROJECT).toBe('1');
      expect(existsSync(isolated.home)).toBe(false);
    },
  );

  it('refuses non-loopback TCP connects so no test reaches the network', () => {
    expect(() => connect({ host: '10.0.0.1', port: 1 })).toThrow(
      /hermetic test env/,
    );
    expect(() => new Socket().connect(1, '10.0.0.1')).toThrow(
      /hermetic test env/,
    );
    expect(() => new Socket().connect(1, 'provider.example.com')).toThrow(
      /hermetic test env/,
    );
  });

  it('allows a test-owned loopback server', () => {
    for (const host of [
      undefined,
      '',
      'localhost',
      '127.0.0.1',
      '127.9.9.9',
      '::1',
      '[::1]',
      '::ffff:127.0.0.1',
    ])
      expect(isLoopbackHost(host), String(host)).toBe(true);
    for (const host of [
      '10.0.0.1',
      '192.168.1.4',
      'provider.example.com',
      '0.0.0.0',
    ])
      expect(isLoopbackHost(host), host).toBe(false);
  });
});
