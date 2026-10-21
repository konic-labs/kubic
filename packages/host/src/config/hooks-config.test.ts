// The admin hooks in force: the enterprise, product and global layers, the
// organization's first; a project layer declaring hooks is refused by name.
import { describe, expect, it } from 'vitest';
import type { ConfigLayer, KubicConfig } from './config.js';
import { ConfigError } from './errors.js';
import { adminHooksOf } from './hooks-config.js';

function layer(
  name: ConfigLayer,
  command: string,
): {
  layer: ConfigLayer;
  config: KubicConfig;
} {
  return {
    layer: name,
    config: { hooks: [{ event: 'beforeTool', command }] } as KubicConfig,
  };
}

describe('adminHooksOf', () => {
  it('reads the enterprise, product and global hooks, the enterprise first', () => {
    const hooks = adminHooksOf([
      layer('product', 'product-check'),
      layer('global', 'user-check'),
      layer('enterprise', 'org-check'),
    ]);
    expect(hooks.map((hook) => [hook.layer, hook.command])).toEqual([
      ['enterprise', 'org-check'],
      ['product', 'product-check'],
      ['global', 'user-check'],
    ]);
    expect(hooks[0]?.timeoutMs).toBe(5_000);
  });

  it('keeps the tools and the bound a table names', () => {
    const [hook] = adminHooksOf([
      {
        layer: 'global',
        config: {
          hooks: [
            {
              event: 'afterTool',
              command: 'log',
              tools: ['bash'],
              timeoutMs: 250,
            },
          ],
        } as KubicConfig,
      },
    ]);
    expect(hook).toEqual({
      event: 'afterTool',
      command: 'log',
      tools: ['bash'],
      timeoutMs: 250,
      layer: 'global',
    });
  });

  it('refuses hooks declared by the project layer, naming the file', () => {
    const read = () =>
      adminHooksOf(
        [layer('global', 'user-check'), layer('project', 'repo-check')],
        '/repo/.kubic/config.toml',
      );
    expect(read).toThrow(ConfigError);
    expect(read).toThrow(
      'the project layer (/repo/.kubic/config.toml) cannot declare hooks',
    );
  });
});
