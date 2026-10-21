// Builds the `kubic` CLI into one ES module, dist/kubic.js, which bin/kubic.js
// loads. tsc only typechecks (`npm run typecheck`, noEmit); esbuild does the
// emit.
//
// Kubic's own code is bundled: every `@kubic/*` specifier resolves through the
// workspace link and the package's exports map under the `source` condition,
// so the bundle contains the TypeScript sources of the packages. Third-party
// packages stay external and load from node_modules at runtime, so no
// third-party code is redistributed inside the bundle. The root package.json is
// the manifest npm installs, so a bare import it does not declare under
// `dependencies` is a build error, never a silently bundled module or a
// package missing from a user's install.
//
// Usage: node scripts/build.mjs
import { readFileSync, rmSync, statSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

export const ENTRY = 'apps/kubic/src/main.ts';
export const OUTFILE = 'dist/kubic.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// The package a bare specifier belongs to: '@scope/name' or 'name', with any
// subpath dropped ('consola/core' -> 'consola').
export function packageNameOf(specifier) {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

// The names a manifest declares under `dependencies`. devDependencies are
// never installed for a user, so they never count.
export function declaredDependencies(manifest) {
  return new Set(Object.keys(manifest.dependencies ?? {}));
}

// esbuild plugin: `@kubic/*` is resolved and bundled; Node builtins and
// declared third-party packages are external; any other bare specifier fails
// the build, naming the import. The entry point is a path, never a package,
// even where the filter matches it (a Windows drive path, `D:\…`).
export function thirdPartyExternals(declared) {
  return {
    name: 'third-party-externals',
    setup(esbuildBuild) {
      esbuildBuild.onResolve({ filter: /^[^./]/ }, (args) => {
        if (args.kind === 'entry-point') return undefined;
        if (args.path.startsWith('@kubic/')) return undefined;
        if (isBuiltin(args.path)) return { path: args.path, external: true };
        if (declared.has(packageNameOf(args.path))) {
          return { path: args.path, external: true };
        }
        return {
          errors: [
            {
              text: `"${args.path}" is not a dependency of the root package.json, the manifest npm installs`,
            },
          ],
        };
      });
    },
  };
}

async function buildCli({ root = REPO_ROOT } = {}) {
  const declared = declaredDependencies(
    JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')),
  );
  // Start from an empty dist/: a stale tsc tree from an earlier layout must
  // not sit next to the bundle.
  rmSync(join(root, 'dist'), { recursive: true, force: true });
  await build({
    entryPoints: [join(root, ENTRY)],
    outfile: join(root, OUTFILE),
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22.19',
    conditions: ['source'],
    sourcemap: 'linked',
    sourcesContent: false,
    logLevel: 'warning',
    plugins: [thirdPartyExternals(declared)],
  });
  return join(root, OUTFILE);
}

if (import.meta.main) {
  const out = await buildCli();
  const bytes = statSync(out).size;
  console.log(`built ${OUTFILE} (${bytes} bytes)`);
}
