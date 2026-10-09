// Unit tests for the pure parts of scripts/build.mjs: the package name of a
// specifier, the declared-dependency set, and the third-party resolution
// policy the esbuild plugin applies. The bundle itself is proven end to end by
// `npm run test:binary`.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  declaredDependencies,
  packageNameOf,
  thirdPartyExternals,
} from './build.mjs';

describe('packageNameOf', () => {
  it('keeps the scope and the name of a scoped package', () => {
    assert.equal(packageNameOf('@clack/prompts'), '@clack/prompts');
    assert.equal(
      packageNameOf('@earendil-works/pi-ai/models'),
      '@earendil-works/pi-ai',
    );
  });

  it('drops the subpath of an unscoped package', () => {
    assert.equal(packageNameOf('consola/core'), 'consola');
    assert.equal(packageNameOf('commander'), 'commander');
  });
});

describe('declaredDependencies', () => {
  it('unions the runtime dependencies of every manifest', () => {
    const declared = declaredDependencies([
      {
        dependencies: { commander: '15.0.0' },
        devDependencies: { vitest: '5.0.3' },
      },
      { dependencies: { '@earendil-works/pi-tui': '1.0.2' } },
      {},
    ]);
    assert.deepEqual([...declared].sort(), [
      '@earendil-works/pi-tui',
      'commander',
    ]);
  });
});

// The plugin registers exactly one resolver; capture it so the policy can be
// driven without running esbuild.
function resolverFor(declared) {
  let registered = null;
  thirdPartyExternals(declared).setup({
    onResolve(options, callback) {
      registered = { options, callback };
    },
  });
  return registered;
}

describe('thirdPartyExternals', () => {
  const resolver = resolverFor(
    new Set(['commander', '@earendil-works/pi-tui']),
  );
  const resolve = (path) =>
    resolver.callback({
      path,
      importer: '/repo/apps/kubic/src/main.ts',
      resolveDir: '/repo/apps/kubic/src',
      kind: 'import-statement',
    });

  it('leaves @kubic/* to the workspace link and the exports map', () => {
    assert.equal(resolve('@kubic/core/cli/exit-codes'), undefined);
  });

  it('marks Node builtins external, with or without the node: prefix', () => {
    assert.deepEqual(resolve('node:fs'), { path: 'node:fs', external: true });
    assert.deepEqual(resolve('fs/promises'), {
      path: 'fs/promises',
      external: true,
    });
  });

  it('marks declared third-party packages external, subpaths included', () => {
    assert.deepEqual(resolve('commander'), {
      path: 'commander',
      external: true,
    });
    assert.deepEqual(resolve('@earendil-works/pi-tui/keys'), {
      path: '@earendil-works/pi-tui/keys',
      external: true,
    });
  });

  it('fails the build on an undeclared third-party import, naming it', () => {
    const result = resolve('left-pad');
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0].text, /"left-pad" is not a declared/);
  });

  it('matches bare specifiers only, never relative or absolute paths', () => {
    assert.ok(resolver.options.filter.test('commander'));
    assert.ok(resolver.options.filter.test('@kubic/host/doctor'));
    assert.ok(!resolver.options.filter.test('./local.ts'));
    assert.ok(!resolver.options.filter.test('../up.ts'));
    assert.ok(!resolver.options.filter.test('/abs/path.ts'));
  });
});
