import { generateKeyPairSync } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLineLogger } from '@kubic/core/cli/logger';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../../test/temp-dir.js';
import { loadRuntimeConfig } from '../config/index.js';
import { fakeBridge } from '../test-support/config-bridge.js';
import { explainPolicy, renderPolicyExplain } from './explain.js';
import {
  runPolicyExplainCommand,
  runPolicyPullCommand,
  runPolicySignCommand,
} from './policy-manage-cli.js';

function load() {
  return loadRuntimeConfig({
    bridge: fakeBridge({
      '/etc/kubic/config.toml': [
        '[model]',
        'provider = "local"',
        'id = "small"',
        '[policy]',
        'allowed_models = ["local/*"]',
        'denied_tools = ["network_fetch"]',
        'project_policy = "restricted"',
        '[[audit]]',
        'sink = "syslog"',
        'level = "privileged"',
      ].join('\n'),
      '/home/u/.kubic/config.toml':
        '[policy]\ndenied_tools = ["bash"]\n[journal]\nretentionDays = 3\n',
    }),
    home: '/home/u',
    cwd: '/repo',
    projectRoot: '/repo',
    managedDirs: ['/etc/kubic'],
  });
}

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    deps: {
      out: (line: string) => out.push(line),
      logger: createLineLogger((line: string) => err.push(line)),
    },
  };
}

describe('kubic policy explain', () => {
  it('names every [policy] key with the layer behind its value', () => {
    const explanation = explainPolicy(load());
    expect(explanation.policy).toEqual(
      expect.arrayContaining([
        { key: 'allowed_models', value: '["local/*"]', source: 'enterprise' },
        {
          key: 'denied_tools',
          value: '["bash", "network_fetch"]',
          source: 'bash: global, network_fetch: enterprise',
        },
        { key: 'project_policy', value: '"restricted"', source: 'enterprise' },
        { key: 'network_policy', value: '(not set)', source: '-' },
      ]),
    );
    expect(explanation.policy.map((row) => row.key)).toEqual([
      'allowed_models',
      'allowed_providers',
      'allowed_tools',
      'denied_tools',
      'network_policy',
      'allowed_domains',
      'filesystem_policy',
      'data_policy',
      'logging_policy',
      'project_policy',
    ]);
    expect(explanation.audit).toEqual([
      {
        key: 'audit[0]',
        value: '{ sink = "syslog", level = "privileged" }',
        source: 'enterprise',
      },
    ]);
    // The enterprise-set config keys; a global key is not one of them.
    expect(explanation.enforced).toEqual([
      { key: 'model.id', value: '"small"', source: 'enterprise' },
      { key: 'model.provider', value: '"local"', source: 'enterprise' },
    ]);
    expect(explanation.managed).toEqual({
      configPath: '/etc/kubic/config.toml',
      signed: false,
    });
  });

  it('renders one fact per line', () => {
    const lines = renderPolicyExplain(explainPolicy(load()));
    expect(lines[0]).toBe('policy:');
    expect(lines).toContain('  allowed_models     ["local/*"]  (enterprise)');
    expect(lines).toContain('  network_policy     (not set)');
    expect(lines).toContain(
      'managed config: /etc/kubic/config.toml (not signed)',
    );
  });

  it('prints the explanation as one JSON document, and refuses a broken load', async () => {
    const json = io();
    expect(
      (await runPolicyExplainCommand({ json: true }, { ...json.deps, load }))
        .exitCode,
    ).toBe(0);
    expect(JSON.parse(json.out.join('\n')).policy).toHaveLength(10);
    const broken = io();
    expect(
      (
        await runPolicyExplainCommand(
          {},
          {
            ...broken.deps,
            load: () => {
              throw new Error('managed config is not signed');
            },
          },
        )
      ).exitCode,
    ).toBe(1);
    expect(broken.err.join('\n')).toContain('managed config is not signed');
  });
});

describe('kubic policy sign and pull', () => {
  it('signs a file and says whether the directory key accepts it', async () => {
    const dir = tempDir('policy-sign-');
    const pair = generateKeyPairSync('ed25519');
    const keyPath = join(dir, 'policy.key');
    writeFileSync(
      keyPath,
      pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    );
    writeFileSync(
      join(dir, 'policy.pub'),
      pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    );
    const file = join(dir, 'config.toml');
    writeFileSync(file, '[policy]\nallowed_providers = ["local"]\n');
    const signed = io();
    expect(
      (await runPolicySignCommand({ key: keyPath, file }, signed.deps))
        .exitCode,
    ).toBe(0);
    expect(signed.out).toEqual([
      `wrote ${file}.sig`,
      `the signature verifies with ${join(dir, 'policy.pub')}`,
    ]);
    expect(readFileSync(`${file}.sig`, 'utf8')).toMatch(
      /^[A-Za-z0-9+/=]{88}\n$/,
    );
    const missing = io();
    expect(
      (
        await runPolicySignCommand(
          { key: join(dir, 'absent.key'), file },
          missing.deps,
        )
      ).exitCode,
    ).toBe(1);
  });

  it('refuses a pull when the managed config names no remote policy', async () => {
    const dir = tempDir('policy-pull-');
    writeFileSync(
      join(dir, 'config.toml'),
      '[model]\nprovider = "a"\nid = "b"\n',
    );
    const pulled = io();
    expect(
      (
        await runPolicyPullCommand({
          ...pulled.deps,
          home: tempDir('policy-pull-home-'),
          dirs: [dir],
        })
      ).exitCode,
    ).toBe(1);
    expect(pulled.err.join('\n')).toContain(
      `no remote policy to pull: the managed config ${join(dir, 'config.toml')} sets no [managed] url`,
    );
  });
});
