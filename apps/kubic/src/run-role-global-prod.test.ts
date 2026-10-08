// Global `~/.kubic/roles` through the real `kubic run --role`: a role defined
// only in the home directory resolves for the lane, and a project document of
// the same name wins. Everything is real except the model (scripted faux via
// KUBIC_PROVIDER=faux: zero network, zero paid tokens): the prod runner, the
// config load, the runtimeLaneDeps home threading, the loader, and the lane.
// Temp dirs and env restored in afterEach. The observable is the role's tool
// set: the objective asks for bash, so a marker file appears in the workspace
// only when the winning document registers bash.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadRuntimeConfig } from '../../../packages/host/src/config/runtime.js';
import { NO_PROJECT_TRUST } from '../../../packages/host/src/config/trust-store.js';
import type { CliConfigResult } from './config-runtime.js';
import { createProdRunners } from './prod-runners.js';

const made: string[] = [];

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

beforeEach(() => {
  vi.stubEnv('KUBIC_NO_NOTICE', '1');
  vi.stubEnv('KUBIC_PROVIDER', 'faux');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function runners(workspace: string) {
  vi.spyOn(process, 'cwd').mockReturnValue(workspace);
  const lines: string[] = [];
  return {
    lines,
    r: createProdRunners({
      out: (line) => lines.push(line),
      debug: () => undefined,
    }),
  };
}

// The config load sees no files (defaults everywhere); trust is the
// KUBIC_TRUST_PROJECT=1 equivalent pointed at the fixture home, so the
// home directory — and only the home directory — supplies role documents.
// A defined runtime matters: runtimeLaneDeps returns {} without one.
function cliConfig(home: string, cwd: string): CliConfigResult {
  const runtime = loadRuntimeConfig({
    bridge: {
      exists: (_path: string): boolean => false,
      readTextFile: (path: string): string => {
        throw new Error(`unexpected read ${path}`);
      },
    },
    home,
    cwd,
    enterprisePath: '/nonexistent/enterprise.toml',
    productPath: '/nonexistent/product.toml',
    projectTrusted: true,
    env: {},
  });
  return {
    runtime,
    error: undefined,
    ignoreSplit: { missing: [], checked: [], applicable: false },
    trust: { ...NO_PROJECT_TRUST, home, envTrust: true, trusted: true },
  };
}

function roleDoc(tools: string, shell: boolean, prompt: string): string {
  return `---\nrole: helper\ntools: [${tools}]\nfilesystem: workspace-write\nshell: ${String(shell)}\nnetwork: none\ngit: false\ncredentials: none\n---\n\n# helper\n\n## Prompt\n\n${prompt}\n`;
}

describe('run --role resolves the global layer', () => {
  it('a role defined only in ~/.kubic/roles runs with its tool set', async () => {
    const home = tmp('kubic-role-global-home-');
    const ws = tmp('kubic-role-global-ws-');
    mkdirSync(join(home, '.kubic', 'roles'), { recursive: true });
    writeFileSync(
      join(home, '.kubic', 'roles', 'helper.md'),
      roleDoc('read, bash', true, 'Do helper things.'),
    );
    const { r } = runners(ws);
    const code = (
      await r.run(
        {
          prompt: 'faux:tool bash {"command":"touch marker"}',
          role: 'helper',
          json: true,
        },
        cliConfig(home, ws),
      )
    ).exitCode;
    expect(code).toBe(0);
    expect(existsSync(join(ws, 'marker'))).toBe(true);
  });

  it('a project document with the same name wins over the global one', async () => {
    const home = tmp('kubic-role-global-home-');
    const ws = tmp('kubic-role-global-ws-');
    mkdirSync(join(home, '.kubic', 'roles'), { recursive: true });
    writeFileSync(
      join(home, '.kubic', 'roles', 'helper.md'),
      roleDoc('read, bash', true, 'Do helper things.'),
    );
    // The project document withholds bash: when it wins, the scripted
    // tool call has no bash tool to land on and no marker appears.
    mkdirSync(join(ws, '.kubic', 'roles'), { recursive: true });
    writeFileSync(
      join(ws, '.kubic', 'roles', 'helper.md'),
      roleDoc('read', false, 'Do project helper things.'),
    );
    const { r } = runners(ws);
    const code = (
      await r.run(
        {
          prompt: 'faux:tool bash {"command":"touch marker"}',
          role: 'helper',
          json: true,
        },
        cliConfig(home, ws),
      )
    ).exitCode;
    expect(code).toBe(0);
    expect(existsSync(join(ws, 'marker'))).toBe(false);
  });
});
