// `[mcp.<name>]`: the managed config's allowlist; a server another layer
// names is refused, and a table that is not a usable pin too.
import { describe, expect, it } from 'vitest';
import type { ConfigLayer, KubicConfig } from './config.js';
import { mcpServersOf } from './mcp-config.js';

function layer(
  name: ConfigLayer,
  mcp: NonNullable<KubicConfig['mcp']>,
): { layer: ConfigLayer; config: KubicConfig } {
  return { layer: name, config: { mcp } };
}

describe('mcpServersOf', () => {
  it('reads the servers the enterprise layer allowlists', () => {
    expect(
      mcpServersOf([
        layer('enterprise', {
          github: {
            command: '/opt/mcp/github',
            args: ['stdio'],
            version: '0.9.1',
            tools: ['get_issue', 'create_issue'],
            approve: ['create_issue'],
            env: ['GITHUB_TOKEN'],
          },
        }),
      ]),
    ).toEqual([
      {
        name: 'github',
        command: '/opt/mcp/github',
        args: ['stdio'],
        version: '0.9.1',
        tools: ['get_issue', 'create_issue'],
        approve: ['create_issue'],
        env: ['GITHUB_TOKEN'],
      },
    ]);
  });

  it('refuses a server a user or a project names', () => {
    expect(() =>
      mcpServersOf(
        [layer('project', { mine: { command: '/bin/mine', version: '1' } })],
        '/repo/.kubic/config.toml',
      ),
    ).toThrow(
      "'[mcp.mine]' is read from the enterprise and product layers only — an MCP server runs only when the organization allowlists it; the project layer (/repo/.kubic/config.toml) cannot name one",
    );
  });

  it('refuses a table that is not a usable pin', () => {
    const one = (table: NonNullable<KubicConfig['mcp']>[string]) => () =>
      mcpServersOf([layer('enterprise', { s: table })]);
    expect(one({ command: 'relative/server', version: '1' })).toThrow(
      'must be an absolute path',
    );
    expect(
      one({ command: '/bin/s', url: 'https://x.example', version: '1' }),
    ).toThrow('names exactly one of');
    expect(one({ url: 'http://mcp.example', version: '1' })).toThrow(
      'must use https',
    );
    expect(
      one({ command: '/bin/s', version: '1', tools: ['a'], approve: ['b'] }),
    ).toThrow('approve names "b", which \'tools\' does not offer');
  });
});
