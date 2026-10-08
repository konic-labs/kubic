// Ctrl-C / SIGTERM on the headless run, prod path: a signal during the drive
// must not kill the process past its cleanup. Tool children run in detached
// process groups, so a terminal SIGINT never reaches them — without a handler
// the run dies and the `sh` survives as an orphan, no sweep runs, no result
// is printed and the session is never closed. The run must abort, drain the
// kill registry, and settle a mapped result; its listeners never outlive it.
// Real NodeExecutionEnv + real `sh` child; faux provider only: zero network.
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  attachSession,
  createSession,
  openSessionStore,
} from '../../../packages/agent/src/lane/session-store.js';
import {
  entriesToTranscript,
  readSessionEntries,
} from '../../../packages/agent/src/lane/transcript.js';
import {
  BACKGROUND_CONTEXT,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type MutableModels,
} from '../../../packages/agent/src/pi-boundary.js';
import {
  FakeExecutionEnv,
  NodeExecutionEnv,
} from '../../../packages/exec/src/env.js';
import { createNodeFileBridge } from '../../../packages/exec/src/file-bridge.js';
import { mapTerminusToExitCode } from '../../../packages/host/src/run-cli.js';
import { runHeadlessPrompt } from './headless-run.js';

const made: string[] = [];
let observedPid: number | undefined;

function tmpRoot(prefix = 'signal-drain-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

beforeEach(() => {
  vi.stubEnv('KUBIC_NO_NOTICE', '1');
});

afterEach(() => {
  vi.unstubAllEnvs();
  if (observedPid !== undefined) {
    try {
      process.kill(-observedPid, 'SIGKILL');
    } catch {
      // Already gone — the expected case.
    }
    observedPid = undefined;
  }
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function hangingBashModels(pidName: string): MutableModels {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage(
      [fauxToolCall('bash', { command: `echo $$ > ${pidName}; sleep 60` })],
      { stopReason: 'toolUse' },
    ),
  ]);
  return models;
}

function textModels(text: string): MutableModels {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage(text)]);
  return models;
}

function shState(pid: number): 'gone' | 'zombie' | 'alive' {
  try {
    const stat = execFileSync('ps', ['-p', String(pid), '-o', 'stat='], {
      encoding: 'utf8',
    }).trim();
    return stat.startsWith('Z') ? 'zombie' : 'alive';
  } catch {
    return 'gone';
  }
}

async function pollUntil(
  probe: () => boolean,
  deadlineMs: number,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    if (probe()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return probe();
}

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

// A cancelled run keeps the POSIX 128+signo convention
// (`kubic tui` pins the same one).
const SIGNAL_EXIT: Readonly<Record<(typeof SIGNALS)[number], number>> = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143,
};

describe('headless run signal handling (solo lane)', () => {
  for (const signal of SIGNALS) {
    it(`${signal} mid-drive kills the detached bash child and settles a mapped result`, {
      timeout: 10_000,
    }, async () => {
      const sessionsRoot = tmpRoot();
      const workspace = tmpRoot('ws-');
      const pidFile = join(workspace, 'pidmarker.txt');
      const signals = new EventEmitter();
      const pending = runHeadlessPrompt(
        'hang a bash child',
        { timeoutMs: 8_000 },
        {
          sessionsRoot,
          models: hangingBashModels('pidmarker.txt'),
          env: new NodeExecutionEnv(workspace),
          signals,
        },
      );
      expect(await pollUntil(() => existsSync(pidFile), 5_000)).toBe(true);
      const pid = await (async () => {
        let parsed = Number.NaN;
        await pollUntil(() => {
          parsed = Number.parseInt(readFileSync(pidFile, 'utf8').trim(), 10);
          return Number.isFinite(parsed);
        }, 2_000);
        return parsed;
      })();
      observedPid = pid;
      expect(signals.listenerCount(signal)).toBe(1);
      signals.emit(signal, signal);
      const result = await pending;
      expect(result.terminus).toBe('cancelled');
      expect(result.signal).toBe(signal);
      expect(mapTerminusToExitCode(result.terminus, result.signal)).toBe(
        SIGNAL_EXIT[signal],
      );
      expect(result.summary).toContain(`interrupted by ${signal}`);
      expect(await pollUntil(() => shState(pid) !== 'alive', 2_000)).toBe(true);
      for (const name of SIGNALS) expect(signals.listenerCount(name)).toBe(0);
    });
  }

  it('removes its signal listeners after a normal completion', async () => {
    const signals = new EventEmitter();
    const result = await runHeadlessPrompt(
      'hello',
      {},
      {
        sessionsRoot: tmpRoot(),
        models: textModels('hi'),
        env: new FakeExecutionEnv({}),
        signals,
      },
    );
    expect(result.terminus).toBe('completed');
    for (const name of SIGNALS) expect(signals.listenerCount(name)).toBe(0);
  });

  it('defaults to the process and leaves no process listener behind', async () => {
    const before = SIGNALS.map((name) => process.listenerCount(name));
    const result = await runHeadlessPrompt(
      'hello',
      {},
      {
        sessionsRoot: tmpRoot(),
        models: textModels('hi'),
        env: new FakeExecutionEnv({}),
      },
    );
    expect(result.terminus).toBe('completed');
    expect(SIGNALS.map((name) => process.listenerCount(name))).toEqual(before);
  });

  it('keeps the prompt durable when a signal lands after the boot but before the turn', async () => {
    // The lane booted and the turn never submitted. This path must still leave
    // exactly one durable pi.user entry: the fallback write is derived from the
    // transcript, not from a submit flag.
    const root = tmpRoot();
    const signals = new EventEmitter();
    const result = await runHeadlessPrompt(
      'late-prompt',
      { debug: true },
      {
        sessionsRoot: root,
        models: textModels('never answered'),
        env: new FakeExecutionEnv({}),
        signals,
        // 'lane accept start' is emitted after the boot and before the turn.
        debugSink: (line) => {
          if (line.includes('lane accept start')) {
            signals.emit('SIGINT', 'SIGINT');
          }
        },
      },
    );
    expect(result.terminus).toBe('cancelled');
    expect(result.signal).toBe('SIGINT');
    expect(result.summary).toContain('interrupted by SIGINT');
    const store = openSessionStore(root, createNodeFileBridge(root));
    const session = await attachSession(
      store,
      result.sessionId,
      BACKGROUND_CONTEXT,
    );
    let userTexts: string[];
    try {
      userTexts = entriesToTranscript(
        await readSessionEntries(session.storage, BACKGROUND_CONTEXT),
      )
        .filter((item) => item.kind === 'user')
        .map((item) => item.text);
    } finally {
      await session.release(BACKGROUND_CONTEXT);
    }
    expect(userTexts).toEqual(['late-prompt']);
  });

  it('a signal during boot (before admission) cancels the run instead of driving it', async () => {
    const root = tmpRoot();
    const workspace = tmpRoot('ws-');
    // A sibling session makes the boot emit its overlap line on the debug
    // channel — a hook that fires strictly before the lane admits the prompt.
    const store = openSessionStore(root, createNodeFileBridge(root));
    const sibling = await createSession(
      store,
      { cwd: workspace },
      BACKGROUND_CONTEXT,
    );
    await sibling.release(BACKGROUND_CONTEXT);
    const signals = new EventEmitter();
    let drove = false;
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      () => {
        drove = true;
        return fauxAssistantMessage('should never run');
      },
    ]);
    const spanLines: string[] = [];
    const result = await runHeadlessPrompt(
      'hello',
      { debug: true },
      {
        sessionsRoot: root,
        models,
        env: new NodeExecutionEnv(workspace),
        signals,
        debugSink: (line) => spanLines.push(line),
        debug: (line) => {
          if (line.includes('may be live')) signals.emit('SIGINT', 'SIGINT');
        },
      },
    );
    expect(result.terminus).toBe('cancelled');
    expect(result.signal).toBe('SIGINT');
    expect(result.summary).toContain('interrupted by SIGINT');
    expect(drove).toBe(false);
    // Boot stopped: the lane never admitted the prompt.
    expect(spanLines.some((line) => /lane accept/.test(line))).toBe(false);
    for (const name of SIGNALS) expect(signals.listenerCount(name)).toBe(0);
    // The session was closed: its lock is released.
    expect(existsSync(join(root, result.sessionId, 'lock.json'))).toBe(false);
  });
});
