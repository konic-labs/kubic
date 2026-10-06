// Shared real-git sandbox for tests (issue #365).
//
// Real-git tests must be isolated from the developer's git configuration
// and from ambient `GIT_*` environment variables: the same result on every
// machine, never touching the Kubic repository itself — even when the suite
// runs inside a git hook or under a tool that exports `GIT_DIR`.
//
// `createGitSandbox` builds a throwaway repo under the OS temp dir with a
// scrubbed env: `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL` pointed at an
// empty file, `HOME`/`XDG_CONFIG_HOME` pointed inside the scratch dir, and
// every other `GIT_*` variable (`GIT_DIR`, `GIT_WORK_TREE`,
// `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY`,
// `GIT_ALTERNATE_OBJECT_DIRECTORIES`, `GIT_CEILING_DIRECTORIES`, …)
// deleted. The repo-local config fixes `user.name`/`user.email`,
// `commit.gpgsign=false` and `core.hooksPath` at an empty dir, so a hostile
// global config (signing on, a failing `pre-commit`, an `init.templateDir`
// hook) cannot shape the sandbox's git.
//
// Two views of the isolation:
// - `sandbox.git(...)` / `sandbox.gitResult(...)` run git with the scrubbed
//   `sandbox.env` — for driving git directly in the test.
// - `new GitSandbox({ injectProcessEnv: true })` (or `sandbox.activate()`)
//   additionally points `process.env` at the sandbox, so production code
//   that spawns git on the inherited environment (`NodeExecutionEnv`,
//   `isGitWorktreeClean`, …) sees the same scrubbed view. `cleanup()`
//   restores every touched variable and removes the scratch dir.
//
// Test files own their cleanup: `afterEach(disposeAllGitSandboxes)` (plus
// an explicit `sandbox.cleanup()` where the test asserts on it).
//
// Test-only scaffolding: never imported by production code.
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface GitSandboxResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface GitSandboxOptions {
  /** Temp-dir prefix; defaults to `kubic-git-sandbox-`. */
  readonly prefix?: string;
  /** Point `process.env` at the sandbox until `cleanup()`. */
  readonly injectProcessEnv?: boolean;
}

export interface GitSandbox {
  /** Scratch root holding home/, xdg/ and repo/; removed on cleanup. */
  readonly parent: string;
  /** Repository work tree, realpath-resolved. */
  readonly path: string;
  /** Empty HOME for this sandbox's git. Lives outside the work tree. */
  readonly home: string;
  /** Empty XDG_CONFIG_HOME, same purpose. */
  readonly xdg: string;
  /** Empty file `GIT_CONFIG_GLOBAL` points at: no global config. */
  readonly globalConfig: string;
  /** Scrubbed env object to pass to `execFileSync`/`spawnSync`. */
  readonly env: NodeJS.ProcessEnv;
  /** Run git in the repo with the scrubbed env; throws on non-zero exit. */
  git(
    args: readonly string[],
    opts?: { readonly cwd?: string; readonly maxBuffer?: number },
  ): string;
  /** Run git, capturing the exit status instead of throwing. */
  gitResult(
    args: readonly string[],
    opts?: { readonly cwd?: string },
  ): GitSandboxResult;
  /** Point `process.env` at the sandbox, recording what it replaces. */
  activate(): void;
  /** Restore `process.env` (when activated) and remove the scratch dir. */
  cleanup(): void;
}

// `GIT_CONFIG_GLOBAL` / `GIT_CONFIG_NOSYSTEM` are the two variables the
// sandbox sets; every other `GIT_*` name is ambient state to delete —
// including `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_*` / `GIT_CONFIG_VALUE_*`,
// which are a config-injection vector of their own.
const SANDBOX_GIT_VARS = new Set(['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM']);

function scrubbedGitEnv(
  home: string,
  xdg: string,
  globalConfig: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_') && !SANDBOX_GIT_VARS.has(key)) delete env[key];
  }
  env.HOME = home;
  env.XDG_CONFIG_HOME = xdg;
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = globalConfig;
  return env;
}

class GitSandboxImpl implements GitSandbox {
  readonly parent: string;
  readonly path: string;
  readonly home: string;
  readonly xdg: string;
  readonly globalConfig: string;
  readonly env: NodeJS.ProcessEnv;
  private savedProcessEnv: Map<string, string | undefined> | undefined;
  private cleaned = false;

  constructor(prefix: string) {
    this.parent = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
    this.home = join(this.parent, 'home');
    this.xdg = join(this.parent, 'xdg');
    this.path = join(this.parent, 'repo');
    mkdirSync(this.home, { recursive: true });
    mkdirSync(this.xdg, { recursive: true });
    mkdirSync(this.path, { recursive: true });
    // An empty file, not `/dev/null`: git reads "no config" from it on
    // every platform without depending on device-file semantics.
    this.globalConfig = join(this.home, 'gitconfig-global');
    writeFileSync(this.globalConfig, '');
    this.env = scrubbedGitEnv(this.home, this.xdg, this.globalConfig);
    liveSandboxes.add(this);
    // Explicit `-b main`: immune to any `init.defaultBranch`. Local
    // identity + signing/hook pins: a hostile global config cannot fail or
    // prompt a commit made through the sandbox. The hooks dir is an empty
    // directory (never `/dev/null`): git lists hooks in it and finds none.
    this.git(['init', '-q', '-b', 'main']);
    this.git(['config', 'user.email', 'kubic-test@local']);
    this.git(['config', 'user.name', 'kubic test']);
    this.git(['config', 'commit.gpgsign', 'false']);
    this.git(['config', 'core.hooksPath', join(this.parent, 'hooks-empty')]);
    mkdirSync(join(this.parent, 'hooks-empty'), { recursive: true });
  }

  git(
    args: readonly string[],
    opts?: { readonly cwd?: string; readonly maxBuffer?: number },
  ): string {
    try {
      return execFileSync('git', [...args], {
        cwd: opts?.cwd ?? this.path,
        encoding: 'utf8',
        env: this.env,
        ...(opts?.maxBuffer === undefined ? {} : { maxBuffer: opts.maxBuffer }),
      });
    } catch (error) {
      const failure = error as {
        status?: number | null;
        stderr?: string | Buffer;
      };
      const stderr =
        typeof failure.stderr === 'string'
          ? failure.stderr
          : String(failure.stderr ?? '');
      throw new Error(
        `git ${args.join(' ')} failed (exit ${String(failure.status)}): ${stderr.trim()}`,
      );
    }
  }

  gitResult(
    args: readonly string[],
    opts?: { readonly cwd?: string },
  ): GitSandboxResult {
    const result = spawnSync('git', [...args], {
      cwd: opts?.cwd ?? this.path,
      encoding: 'utf8',
      env: this.env,
    });
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  activate(): void {
    if (this.savedProcessEnv !== undefined) return;
    const saved = new Map<string, string | undefined>();
    const apply = (key: string, value: string | undefined): void => {
      if (!saved.has(key)) saved.set(key, process.env[key]);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('GIT_') && !SANDBOX_GIT_VARS.has(key)) {
        apply(key, undefined);
      }
    }
    apply('HOME', this.env.HOME);
    apply('XDG_CONFIG_HOME', this.env.XDG_CONFIG_HOME);
    apply('GIT_CONFIG_NOSYSTEM', '1');
    apply('GIT_CONFIG_GLOBAL', this.env.GIT_CONFIG_GLOBAL);
    this.savedProcessEnv = saved;
  }

  cleanup(): void {
    if (this.savedProcessEnv !== undefined) {
      for (const [key, value] of this.savedProcessEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      this.savedProcessEnv = undefined;
    }
    liveSandboxes.delete(this);
    if (!this.cleaned) {
      this.cleaned = true;
      rmSync(this.parent, { recursive: true, force: true });
    }
  }
}

const liveSandboxes = new Set<GitSandboxImpl>();

export function createGitSandbox(options?: GitSandboxOptions): GitSandbox {
  const sandbox = new GitSandboxImpl(options?.prefix ?? 'kubic-git-sandbox-');
  if (options?.injectProcessEnv === true) sandbox.activate();
  return sandbox;
}

/** Remove every live sandbox: the `afterEach` hook test files register. */
export function disposeAllGitSandboxes(): void {
  for (const sandbox of [...liveSandboxes]) sandbox.cleanup();
}
