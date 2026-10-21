// Proxy support for model traffic.
//
// Provider requests go through Node's fetch, which honours HTTP_PROXY,
// HTTPS_PROXY and NO_PROXY only when the process starts with
// NODE_USE_ENV_PROXY=1. When a proxy variable is set and the opt-in is
// absent, bin/kubic.js runs the CLI in a child process that has it. The
// terminal's stdio, the signals and the exit status pass through, so the
// child is the kubic the user sees.
//
// Imported by bin/kubic.js after the Node guard: keep it free of dependencies
// beyond Node's own modules.

import { spawn } from 'node:child_process';

const PROXY_VARIABLES = [
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
];

// Whether to relaunch: a proxy variable is set, the process was not started
// with the opt-in (an explicit NODE_USE_ENV_PROXY, even `0`, is respected),
// and this Node supports it.
export function needsEnvProxyRelaunch(env, allowedNodeFlags) {
  return (
    PROXY_VARIABLES.some((name) => (env[name] ?? '') !== '') &&
    env.NODE_USE_ENV_PROXY === undefined &&
    allowedNodeFlags.has('--use-env-proxy')
  );
}

// The Node options passed on to the child: everything but the options that
// make Node run code of its own instead of `script` (`-e`/`--eval`,
// `-p`/`--print` with their values, and `--input-type`, which only applies to
// them).
function forwardedExecArgv(argv) {
  const out = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (['-e', '--eval', '-p', '--print'].includes(arg)) {
      index += 1;
      continue;
    }
    if (/^--(eval|print|input-type)(=|$)/.test(arg)) continue;
    out.push(arg);
  }
  return out;
}

// Runs `script` with `args` in a child that has the opt-in, and exits with
// the child's status. The terminal sends SIGINT and SIGQUIT to the whole
// foreground process group, child included, so the parent waits for the
// child instead of dying first; a signal sent to the parent alone (SIGTERM,
// SIGHUP) is passed on. Node 22 warns that its proxy agent is experimental;
// the child silences that one warning so it never lands in the TUI.
export function relaunchWithEnvProxy(script, args, io = {}) {
  const spawnChild = io.spawn ?? spawn;
  const exit = io.exit ?? ((code) => process.exit(code));
  const raise = io.raise ?? ((signal) => process.kill(process.pid, signal));
  const child = spawnChild(
    process.execPath,
    [
      ...forwardedExecArgv(process.execArgv),
      '--disable-warning=UNDICI-EHPA',
      script,
      ...args,
    ],
    { stdio: 'inherit', env: { ...process.env, NODE_USE_ENV_PROXY: '1' } },
  );
  const ignore = () => {};
  const forward = (signal) => child.kill(signal);
  for (const signal of ['SIGINT', 'SIGQUIT']) process.on(signal, ignore);
  for (const signal of ['SIGTERM', 'SIGHUP']) process.on(signal, forward);
  const release = () => {
    for (const signal of ['SIGINT', 'SIGQUIT']) process.off(signal, ignore);
    for (const signal of ['SIGTERM', 'SIGHUP']) process.off(signal, forward);
  };
  child.on('error', (error) => {
    release();
    console.error(`kubic: cannot start with proxy support: ${error.message}`);
    exit(1);
  });
  child.on('exit', (code, signal) => {
    release();
    // A child killed by a signal ends the parent the same way, so the
    // caller sees 128 + the signal number.
    if (signal !== null) raise(signal);
    else exit(code ?? 1);
  });
}
