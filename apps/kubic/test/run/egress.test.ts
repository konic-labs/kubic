// `network_policy = "proxy"` with `allowed_domains` on `kubic run`: the bash
// tool's environment points at the egress proxy the run starts, a request to
// a domain off the list is refused by it, and the refusal is audited. Faux
// provider; the request never leaves the machine.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@kubic/agent/pi-boundary';
import { fauxToolUse } from '@kubic/agent/test-support/lane-harness';
import { NodeExecutionEnv } from '@kubic/exec/env';
import { resolveEffectivePolicy } from '@kubic/host/policy';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tempDir } from '../../../../test/temp-dir.js';
import { runHeadlessPrompt } from '../../src/run/command.js';

beforeEach(() => {
  vi.stubEnv('KUBIC_NO_NOTICE', '1');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('kubic run with the egress proxy', () => {
  it('refuses and audits a request to a domain off the list', async () => {
    const workspace = tempDir('egress-ws-');
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const seen: string[] = [];
    faux.setResponses([
      fauxToolUse([
        fauxToolCall('bash', {
          command:
            'curl -s http://blocked.example/; echo; echo "proxy=$HTTPS_PROXY"',
        }),
      ]),
      (context) => {
        seen.push(JSON.stringify(context.messages.at(-1)));
        return fauxAssistantMessage('done');
      },
    ]);
    const result = await runHeadlessPrompt(
      'fetch it',
      {},
      {
        sessionsRoot: tempDir('egress-sessions-'),
        models,
        env: new NodeExecutionEnv(workspace),
        approvals: { autoApprove: ['network'] },
        modelPolicy: resolveEffectivePolicy([
          {
            layer: 'enterprise',
            policy: { network: { mode: 'allowlist', domains: ['github.com'] } },
          },
        ]).policy,
      },
    );
    expect(result.terminus).toBe('completed');
    const output = seen.join('\n');
    expect(output).toContain('blocked.example is not an allowed domain');
    expect(output).toMatch(/proxy=http:\/\/127\.0\.0\.1:\d+/);
    const rows = readFileSync(
      join(workspace, '.kubic', 'audit', 'audit.jsonl'),
      'utf8',
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((row) => row.what === 'network:egress');
    expect(rows).toMatchObject([
      {
        result: 'deny',
        network: {
          host: 'blocked.example',
          port: 80,
          decision: 'deny',
          bytes: 0,
        },
      },
    ]);
  });
});
