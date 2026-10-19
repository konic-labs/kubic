// Layered TOML config, precedence, trust gate, example.
import { describe, expect, it } from 'vitest';
import { type BridgePick, fakeBridge } from '../test-support/config-bridge.js';
import { checkRoleModelRef } from './checks.js';
import {
  checkGitignoreSplit,
  defaultLayerPaths,
  GITIGNORE_REQUIRED_ENTRIES,
  mergeLayered,
  parseTomlConfig,
} from './config.js';
import { loadRuntimeConfig } from './runtime.js';
import { McpUnsupportedError } from './stances.js';

// The live loader, given the composition root's inputs for this home and project.
function loadRuntime(
  bridge: BridgePick,
  options: { projectTrusted?: boolean; workspaceRoot?: string } = {},
) {
  return loadRuntimeConfig({
    bridge,
    home: '/home/u',
    cwd: '/repo',
    projectRoot: '/repo',
    env: {},
    ...(options.projectTrusted === undefined
      ? {}
      : { projectTrusted: options.projectTrusted }),
    ...(options.workspaceRoot === undefined
      ? {}
      : { workspaceRoot: options.workspaceRoot }),
  });
}

describe('config validation hardening', () => {
  it('rejects unknown keys per section', () => {
    expect(() => parseTomlConfig('[agent]\nname = "x"\nextra = 1\n')).toThrow(
      /unknown key/,
    );
    expect(() =>
      parseTomlConfig('[approvals]\nroute = "deny"\nturbo = true\n'),
    ).toThrow(/unknown key/);
    // `maxBytes` is a real key; anything else under [journal]
    // is still refused by name.
    expect(() => parseTomlConfig('[journal]\nbogus = 1\n')).toThrow(
      /unknown key 'bogus'/,
    );
  });

  it('rejects non-table sections', () => {
    expect(() => parseTomlConfig('agent = "x"\n')).toThrow(/must be a table/);
    expect(() => parseTomlConfig('approvals = true\n')).toThrow(
      /must be a table/,
    );
    expect(() => parseTomlConfig('[roles.a]\nmodel = 42\n')).toThrow(
      /'roles\.a': 'model' must be 'provider\/id'/,
    );
    // The shape is checked too: a bare provider can never
    // become a selection, so it is refused by name at parse time.
    expect(() => parseTomlConfig('[roles.a]\nmodel = "local"\n')).toThrow(
      /'roles\.a': 'model' must be 'provider\/id'/,
    );
  });

  it('rejects invalid thinking levels and approval shapes', () => {
    expect(() => parseTomlConfig('[model]\nthinking = "ultra"\n')).toThrow(
      /must be one of/,
    );
    expect(() => parseTomlConfig('[approvals]\nroute = "auto"\n')).toThrow(
      /must be 'ask-user' or 'deny'/,
    );
    expect(() => parseTomlConfig('[approvals]\nautoApprove = "all"\n')).toThrow(
      /string array/,
    );
    expect(() => parseTomlConfig('[approvals]\nautoApprove = [1]\n')).toThrow(
      /string array/,
    );
    expect(() =>
      parseTomlConfig('[approvals]\nsessionScoped = "yes"\n'),
    ).toThrow(/must be a boolean/);
  });

  it('parses [roles.<name>] thinking, refusing unknown levels by name', () => {
    expect(
      parseTomlConfig('[roles.a]\nthinking = "high"\n').roles?.a?.thinking,
    ).toBe('high');
    expect(() => parseTomlConfig('[roles.a]\nthinking = "ultra"\n')).toThrow(
      /'roles\.a': 'thinking' must be one of/,
    );
  });

  it('parses [roles.<name>] models, refusing bad entries by name', () => {
    const parsed = parseTomlConfig(
      '[roles.a]\nmodels = ["local/*", { id = "acme/big", thinking = "high" }]\n',
    );
    expect(parsed.roles?.a?.models).toEqual([
      // String entries normalize to { id } tables: one shape downstream.
      { id: 'local/*' },
      { id: 'acme/big', thinking: 'high' },
    ]);
    // An empty set parses (it means all models).
    expect(
      parseTomlConfig('[roles.a]\nmodels = []\n').roles?.a?.models,
    ).toEqual([]);
    expect(() => parseTomlConfig('[roles.a]\nmodels = "local/*"\n')).toThrow(
      /'roles\.a': 'models' must be an array/,
    );
    expect(() => parseTomlConfig('[roles.a]\nmodels = [["x/y"]]\n')).toThrow(
      /nested arrays are unsupported/,
    );
    expect(() => parseTomlConfig('[roles.a]\nmodels = ["noid"]\n')).toThrow(
      /'roles\.a': 'models\[0\]' must be 'provider\/id' or 'provider\/\*'/,
    );
    expect(() => parseTomlConfig('[roles.a]\nmodels = [42]\n')).toThrow(
      /'roles\.a': 'models\[0\]' must be 'provider\/id' or 'provider\/\*'/,
    );
    // Tables land in the string-array validators nowhere else: a table in
    // `tools` is still refused by its own checker, not the parser.
    expect(() =>
      parseTomlConfig('[roles.a]\ntools = ["read", { x = 1 }]\n'),
    ).toThrow(/'roles\.a': 'tools' must be a string array/);
    expect(() =>
      parseTomlConfig('[roles.a]\nmodels = [{ id = "x/y" }]\n'),
    ).not.toThrow();
    expect(() =>
      parseTomlConfig(
        '[roles.a]\nmodels = [{ id = "x/y", thinking = "ultra" }]\n',
      ),
    ).toThrow(/'models\[0\]\.thinking' must be one of/);
    expect(() =>
      parseTomlConfig('[roles.a]\nmodels = [{ thinking = "low" }]\n'),
    ).toThrow(/'roles\.a\.models\[0\]': 'id' must be a non-empty string/);
    expect(() =>
      parseTomlConfig('[roles.a]\nmodels = [{ id = "x/y", bogus = 1 }]\n'),
    ).toThrow(/'roles\.a\.models\[0\]': unknown key 'bogus'/);
  });

  it('parses [model]/[roles.<name>] escalate + maxEscalations', () => {
    const parsed = parseTomlConfig(
      '[model]\nescalate = ["local/a", "acme/big"]\nmaxEscalations = 2\n' +
        '[roles.a]\nescalate = ["local/a", "local/b"]\n',
    );
    expect(parsed.model?.escalate).toEqual(['local/a', 'acme/big']);
    expect(parsed.model?.maxEscalations).toBe(2);
    expect(parsed.roles?.a?.escalate).toEqual(['local/a', 'local/b']);
    // Unset means no ladder, not an empty one.
    expect(
      parseTomlConfig('[model]\nprovider = "x"\n').model?.escalate,
    ).toBeUndefined();
    expect(() => parseTomlConfig('[model]\nescalate = "local/a"\n')).toThrow(
      /'model': 'escalate' must be an array/,
    );
    expect(() => parseTomlConfig('[model]\nescalate = ["noid"]\n')).toThrow(
      /'model': 'escalate\[0\]' must be 'provider\/id'/,
    );
    expect(() => parseTomlConfig('[model]\nescalate = ["local/*"]\n')).toThrow(
      /'model': 'escalate\[0\]' must be 'provider\/id'/,
    );
    expect(() => parseTomlConfig('[model]\nmaxEscalations = -1\n')).toThrow(
      /'model': 'maxEscalations' must be a non-negative integer/,
    );
    expect(() => parseTomlConfig('[model]\nmaxEscalations = 1.5\n')).toThrow(
      /'model': 'maxEscalations' must be a non-negative integer/,
    );
    expect(() => parseTomlConfig('[roles.a]\nescalate = ["noid"]\n')).toThrow(
      /'roles\.a': 'escalate\[0\]' must be 'provider\/id'/,
    );
  });

  it('rejects negative numbers and non-string role tools', () => {
    expect(() => parseTomlConfig('[journal]\nretentionDays = -1\n')).toThrow(
      /non-negative number/,
    );
    expect(() => parseTomlConfig('[roles.a]\ntools = "read"\n')).toThrow(
      /string array/,
    );
    expect(() => parseTomlConfig('[roles]\na = "nope"\n')).toThrow(
      /must be a table/,
    );
  });

  it('parses [journal] maxBytes as a positive integer, refusing anything else', () => {
    // Byte bound: the whole store — index + blobs — is
    // pruned to stay under it. 0 is not "off" (unset is): it is a bound
    // nothing fits, so it is refused by name rather than failing every write.
    expect(parseTomlConfig('[journal]\nmaxBytes = 1048576\n').journal).toEqual({
      maxBytes: 1_048_576,
    });
    expect(
      parseTomlConfig('[journal]\nretentionDays = 7\nmaxBytes = 4096\n')
        .journal,
    ).toEqual({ retentionDays: 7, maxBytes: 4096 });
    for (const bad of ['0', '-1', '1.5', '"1MB"']) {
      expect(() => parseTomlConfig(`[journal]\nmaxBytes = ${bad}\n`)).toThrow(
        /'journal': 'maxBytes' must be a positive integer/,
      );
    }
  });

  it('parses [journal] outOfScope as a path array, refusing empty entries by name', () => {
    expect(
      parseTomlConfig('[journal]\noutOfScope = ["build", "coverage"]\n').journal
        ?.outOfScope,
    ).toEqual(['build', 'coverage']);
    // Unset stays unset: no empty list is invented.
    expect(
      parseTomlConfig('[journal]\nretentionDays = 7\n').journal?.outOfScope,
    ).toBeUndefined();
    // Same array-validation shape as every other string array key.
    expect(() => parseTomlConfig('[journal]\noutOfScope = "build"\n')).toThrow(
      /string array/,
    );
    expect(() => parseTomlConfig('[journal]\noutOfScope = [42]\n')).toThrow(
      /string array/,
    );
    // An empty entry would match nothing (workspace-relative paths never
    // start with '/'), so it is refused by name rather than carried as dead
    // config — fail-closed like every other key.
    expect(() => parseTomlConfig('[journal]\noutOfScope = [""]\n')).toThrow(
      /'journal': 'outOfScope' entry 1 is empty/,
    );
    expect(() =>
      parseTomlConfig('[journal]\noutOfScope = ["build", "  "]\n'),
    ).toThrow(/'journal': 'outOfScope' entry 2 is empty/);
  });

  // An entry is a workspace-relative path the walk compares literally, so
  // `./dist` and `dist/` read as `dist`; one that names the whole workspace
  // would leave the journal recording nothing, and one outside it names
  // nothing the journal walks — both are refused by name.
  it('reads [journal] outOfScope entries as plain paths, refusing the whole workspace', () => {
    expect(
      parseTomlConfig(
        '[journal]\noutOfScope = ["./dist", "build/", "a/./b//c"]\n',
      ).journal?.outOfScope,
    ).toEqual(['dist', 'build', 'a/b/c']);
    for (const entry of ['.', './', 'a/..']) {
      expect(() =>
        parseTomlConfig(`[journal]\noutOfScope = ["${entry}"]\n`),
      ).toThrow(/'journal': 'outOfScope' entry 1 names the whole workspace/);
    }
    for (const entry of ['..', '../x', '/etc']) {
      expect(() =>
        parseTomlConfig(`[journal]\noutOfScope = ["${entry}"]\n`),
      ).toThrow(/'journal': 'outOfScope' entry 1 is outside the workspace/);
    }
  });

  it('rejects empty-string required values', () => {
    expect(() => parseTomlConfig('[agent]\nname = ""\n')).toThrow(
      /non-empty string/,
    );
  });
});

describe('layer merge hardening', () => {
  it('records no attempt when layers agree on a value', () => {
    const merged = mergeLayered([
      { layer: 'global', config: { model: { provider: 'g', id: 'm' } } },
      {
        layer: 'project',
        config: { model: { provider: 'g', id: 'm' } },
        trusted: true,
      },
    ]);
    expect(merged.config.model?.provider).toBe('g');
    expect(merged.overriddenAttempts).toEqual([]);
  });

  it('sorts layers regardless of input order (enterprise still wins)', () => {
    const merged = mergeLayered([
      { layer: 'agent', config: { model: { provider: 'rogue', id: 'm' } } },
      { layer: 'enterprise', config: { model: { provider: 'ent', id: 'm' } } },
    ]);
    expect(merged.config.model?.provider).toBe('ent');
    expect(merged.overriddenAttempts).toEqual(['model.provider']);
  });

  it('lets workspace beat session and session beat agent', () => {
    const merged = mergeLayered([
      { layer: 'agent', config: { model: { provider: 'a', id: 'm' } } },
      { layer: 'session', config: { model: { provider: 's', id: 'm' } } },
      { layer: 'workspace', config: { model: { provider: 'w', id: 'm' } } },
    ]);
    expect(merged.config.model?.provider).toBe('w');
    expect(merged.overriddenAttempts).toEqual(
      expect.arrayContaining(['model.provider']),
    );
  });

  it('accepts an empty untrusted project layer', () => {
    const merged = mergeLayered([{ layer: 'project', config: {} }]);
    expect(merged.config).toEqual({});
  });

  it('treats reordered arrays as changed (order-sensitive compare)', () => {
    const merged = mergeLayered([
      {
        layer: 'global',
        config: { roles: { reviewer: { tools: ['a', 'b'] } } },
      },
      {
        layer: 'project',
        config: { roles: { reviewer: { tools: ['b', 'a'] } } },
        trusted: true,
      },
    ]);
    expect(merged.config.roles?.reviewer?.tools).toEqual(['a', 'b']);
    expect(merged.overriddenAttempts).toEqual(['roles.reviewer.tools']);
  });
});

describe('layered load hardening', () => {
  it('wraps file errors with the layer name', () => {
    const bridge = fakeBridge({ '/etc/kubic/config.toml': '[bad\n' });
    try {
      loadRuntime(bridge, { projectTrusted: true });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toMatch(/layer 'enterprise'/);
    }
  });

  it('wraps MCP violations with the offending layer', () => {
    const bridge = fakeBridge({
      '/home/u/.kubic/config.toml': '[mcp]\nenabled = true\n',
    });
    try {
      loadRuntime(bridge, { projectTrusted: true });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(McpUnsupportedError);
      expect((error as Error).message).toMatch(/layer 'global'/);
    }
  });

  it('wraps unknown-section violations with the offending layer', () => {
    const bridge = fakeBridge({
      '/home/u/.kubic/config.toml': '[telemetry]\nenabled = true\n',
    });
    expect(() => loadRuntime(bridge)).toThrow(/layer 'global'/);
  });

  it('loads the other layers pre-trust when no project file exists', () => {
    const bridge = fakeBridge({
      '/home/u/.kubic/config.toml': '[model]\nprovider = "g"\nid = "m"\n',
    });
    const merged = loadRuntime(bridge, { projectTrusted: false });
    expect(merged.config.model?.provider).toBe('g');
  });

  it('honors workspace roots and the default enterprise path', () => {
    const paths = defaultLayerPaths({
      home: '/home/u',
      projectRoot: '/repo',
      workspaceRoot: '/ws',
    });
    expect(paths.workspace).toBe('/ws/.kubic/config.toml');
    expect(paths.enterprise).toBe('/etc/kubic/config.toml');
    const bridge = fakeBridge({
      '/ws/.kubic/config.toml': '[ui]\ntheme = "light"\n',
    });
    const merged = loadRuntime(bridge, {
      projectTrusted: true,
      workspaceRoot: '/ws',
    });
    expect(merged.config.ui?.theme).toBe('light');
  });
});

describe('config serialization hardening', () => {
  it('reports only the missing gitignore entries', () => {
    // Rules an older build wrote do not stand in for the current one.
    const partial = `.kubic/sessions/\n.kubic/journal/\n`;
    expect(checkGitignoreSplit(partial).missing).toEqual(['.kubic/audit/']);
  });

  // The required-entry list is not a second copy of the rule
  // set — it is derived from the module that writes the rules. If the two
  // ever drift, this fails instead of shipping a gate that checks fiction.
  it('derives the required entries from the shipped runtime rules', async () => {
    const shipped = await import('@kubic/exec/runtime-exclude');
    expect([...GITIGNORE_REQUIRED_ENTRIES]).toEqual([
      ...shipped.RUNTIME_EXCLUDE_ENTRIES,
    ]);
    // The writer's own output satisfies this checker: if the two ever
    // diverge, the gate built on `checkGitignoreSplit` would be checking
    // rules nobody ships.
    expect(
      checkGitignoreSplit(shipped.applyRuntimeExcludeBlock('').text).missing,
    ).toEqual([]);
  });
});

describe('[verify] section', () => {
  it('parses the four gate commands and the timeout', () => {
    const text =
      '[verify]\ntests = "npm test"\nbuild = "npm run build"\nlint = "npm run lint"\ntypecheck = "npm run typecheck"\ntimeoutMs = 60000\n';
    const parsed = parseTomlConfig(text);
    expect(parsed.verify).toEqual({
      tests: 'npm test',
      build: 'npm run build',
      lint: 'npm run lint',
      typecheck: 'npm run typecheck',
      timeoutMs: 60000,
    });
  });

  it('refuses an unknown key, a non-string or blank command and a bad timeout by name', () => {
    expect(() => parseTomlConfig('[verify]\nformat = "x"\n')).toThrow(
      "'verify': unknown key 'format'",
    );
    expect(() => parseTomlConfig('[verify]\ntests = 1\n')).toThrow(
      /'verify': 'tests' must be a non-empty command string/,
    );
    expect(() => parseTomlConfig('[verify]\nlint = "  "\n')).toThrow(
      /'verify': 'lint' must be a non-empty command string/,
    );
    for (const bad of ['0', '-5', '1.5', '"10"']) {
      expect(() => parseTomlConfig(`[verify]\ntimeoutMs = ${bad}\n`)).toThrow(
        /'verify': 'timeoutMs' must be a positive integer/,
      );
    }
    expect(() => parseTomlConfig('verify = 1\n')).toThrow(
      "'[verify]' must be a table",
    );
  });
});

describe('checkRoleModelRef', () => {
  it.each(['llama', '/x', 'x/', ''])(
    'refuses %j with the provider/id message',
    (ref) => {
      expect(() => checkRoleModelRef(ref, 'implementer')).toThrow(
        "'roles.implementer': 'model' must be 'provider/id'",
      );
    },
  );

  it('refuses a blank or non-string ref', () => {
    expect(() => checkRoleModelRef('   ', 'implementer')).toThrow(
      "'roles.implementer': 'model' must be 'provider/id'",
    );
    expect(() => checkRoleModelRef(42, 'implementer')).toThrow(
      "'roles.implementer': 'model' must be 'provider/id'",
    );
  });

  it('passes a provider/id ref and undefined through', () => {
    expect(checkRoleModelRef('g/file', 'implementer')).toBe('g/file');
    expect(checkRoleModelRef(undefined, 'implementer')).toBeUndefined();
  });
});
