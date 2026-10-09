// The shared session bootstrap: its refusals, the order of its steps and its
// teardown, over a faux catalog (no network, no paid tokens).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelSelectError } from '@kubic/agent/model-select';
import {
  BACKGROUND_CONTEXT,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
} from '@kubic/agent/pi-boundary';
import { NodeExecutionEnv } from '@kubic/exec/env';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bootTuiLane } from '../tui/boot.js';
import {
  SessionBoot,
  type SessionBootConfig,
  type SessionBootRequest,
} from './bootstrap.js';

const made: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

function catalog() {
  const models = createModels();
  const faux = fauxProvider({
    provider: 'faux',
    models: [{ id: 'big', contextWindow: 200000 }],
  });
  faux.setResponses([fauxAssistantMessage('ok')]);
  models.setProvider(faux.provider);
  return models;
}

function newBoot(
  request: Partial<SessionBootRequest> = {},
  config: SessionBootConfig = {},
) {
  const events: string[] = [];
  const workspace = tmp('bootstrap-ws-');
  const boot = new SessionBoot(
    { command: 'run', context: BACKGROUND_CONTEXT, ...request },
    {
      sessionsRoot: tmp('bootstrap-sessions-'),
      env: new NodeExecutionEnv(workspace),
      models: catalog(),
      modelsCwd: workspace,
      roles: { cwd: workspace },
      skills: {
        cwd: workspace,
        homeDir: tmp('bootstrap-home-'),
        trusted: false,
      },
      ...config,
    },
    {
      debug: (line) => events.push(`debug ${line}`),
      warn: (line) => events.push(`warn ${line}`),
      modelNotice: (line) => events.push(`notice ${line}`),
      skillsWarn: (line) => events.push(`skills ${line}`),
      skillsLog: () => undefined,
    },
  );
  return { boot, events, workspace };
}

describe('session bootstrap refusals', () => {
  it('refuses a path-unsafe session id and a contradictory tool selection before any session exists', () => {
    expect(newBoot({ sessionId: '../x' }).boot.validate()).toEqual({
      kind: 'usage',
      message: 'invalid --session id "../x" (use [A-Za-z0-9_-])',
    });
    expect(newBoot({ tools: ['read'], noTools: true }).boot.validate()).toEqual(
      {
        kind: 'usage',
        message: '--tools and --no-tools are mutually exclusive',
      },
    );
    const unknown = newBoot({ tools: ['teleport'] }).boot.validate();
    expect(unknown?.kind).toBe('usage');
    expect(unknown).toMatchObject({
      message: expect.stringContaining('unknown tool "teleport"'),
    });
    expect(newBoot({ tools: ['read'] }).boot.validate()).toBeUndefined();
  });

  it('refuses an unknown role with the error that refused it', async () => {
    const { boot } = newBoot({ role: 'no-such-role' });
    expect(await boot.open()).toBeUndefined();
    try {
      const refusal = await boot.boot();
      expect(refusal?.kind).toBe('failed');
      expect(refusal).toMatchObject({ cause: expect.any(Error) });
      expect(boot.lane).toBeUndefined();
    } finally {
      await boot.teardown();
    }
  });

  it('refuses a KUBIC_PROVIDER value it does not know as a provider refusal', async () => {
    vi.stubEnv('KUBIC_PROVIDER', 'bogus');
    const { boot } = newBoot();
    await boot.open();
    try {
      const refusal = await boot.boot();
      expect(refusal?.kind).toBe('provider');
      expect(refusal).toMatchObject({
        message: expect.stringContaining('bogus'),
      });
    } finally {
      await boot.teardown();
    }
  });

  it('warns about a refused models.json before refusing a boot with no usable model', async () => {
    const workspace = tmp('bootstrap-models-');
    mkdirSync(join(workspace, '.kubic'), { recursive: true });
    writeFileSync(join(workspace, '.kubic', 'models.json'), '{ not json');
    const { boot, events } = newBoot(
      {},
      { models: undefined, modelsCwd: workspace, trustProject: () => true },
    );
    await boot.open();
    try {
      const refusal = await boot.boot();
      expect(refusal?.kind).toBe('provider');
      expect(
        events.some((line) => line.startsWith('warn models.json ignored')),
      ).toBe(true);
    } finally {
      await boot.teardown();
    }
  });

  it('stops when the boot is cancelled, before the role is resolved', async () => {
    const { boot, events } = newBoot({
      role: 'no-such-role',
      cancelled: () => true,
    });
    await boot.open();
    try {
      expect(await boot.boot()).toEqual({ kind: 'cancelled' });
      expect(events.some((line) => line.includes('[policy]'))).toBe(false);
    } finally {
      await boot.teardown();
    }
  });

  it('stops before the lane when the skills hook refuses', async () => {
    const { boot } = newBoot({
      onSkillsBooted: () => ({ kind: 'failed', message: 'no such skill' }),
    });
    await boot.open();
    try {
      expect(await boot.boot()).toEqual({
        kind: 'failed',
        message: 'no such skill',
      });
      expect(boot.installed).toBeDefined();
      expect(boot.lane).toBeUndefined();
    } finally {
      await boot.teardown();
    }
  });
});

describe('session bootstrap order and teardown', () => {
  it('names the session, resolves the role, installs the policy, boots the skills, then the lane', async () => {
    const order: string[] = [];
    const { boot, events } = newBoot({
      onPolicyInstalled: (booted) => {
        order.push(
          `policy (lane ${booted.lane === undefined ? 'absent' : 'present'})`,
        );
      },
      onSkillsBooted: (booted) => {
        order.push(
          `skills (lane ${booted.lane === undefined ? 'absent' : 'present'})`,
        );
        return undefined;
      },
    });
    expect(await boot.open()).toBeUndefined();
    try {
      expect(await boot.boot()).toBeUndefined();
      expect(order).toEqual(['policy (lane absent)', 'skills (lane absent)']);
      expect(events[0]).toBe(`debug [session] id=${boot.id}`);
      expect(events[1]).toBe('debug [policy] role=default (default)');
      expect(boot.lane).toBeDefined();
      expect(boot.liveModelRef).toBe('faux/big');
      expect(boot.liveThinkingRef).toBe('off');
    } finally {
      await boot.teardown();
    }
  });

  it('releases the session once, however often teardown runs', async () => {
    const { boot } = newBoot();
    await boot.open();
    expect(await boot.boot()).toBeUndefined();
    const release = vi.spyOn(
      boot.session as NonNullable<typeof boot.session>,
      'release',
    );
    await boot.teardown();
    await boot.teardown();
    expect(release).toHaveBeenCalledTimes(1);
    // The lock is free again: the same session attaches.
    const again = newBoot({ sessionId: boot.id }, { sessionsRoot: boot.root });
    expect(await again.boot.open()).toBeUndefined();
    await again.boot.teardown();
  });
});

describe('kubic tui on the shared bootstrap', () => {
  it('maps a refused provider to the provider error the command exits 6 on', async () => {
    vi.stubEnv('KUBIC_PROVIDER', 'bogus');
    const workspace = tmp('bootstrap-tui-ws-');
    await expect(
      bootTuiLane(undefined, {
        sessionsRoot: tmp('bootstrap-tui-sessions-'),
        models: catalog(),
        env: new NodeExecutionEnv(workspace),
      }),
    ).rejects.toBeInstanceOf(ModelSelectError);
  });
});
