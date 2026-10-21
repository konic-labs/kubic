// Managed configuration: where an organization's device management puts
// Kubic's enterprise and product layers, the signature that proves a managed
// file is the one the organization signed, and the remote policy a managed
// config can point at.
//
// - Paths. macOS reads `/Library/Application Support/Kubic/` before
//   `/etc/kubic/`, Windows `%ProgramData%\Kubic\`, everything else
//   `/etc/kubic/`. Each file (config.toml, product.toml) comes from the first
//   directory holding it.
// - Signatures. A `policy.pub` (an Ed25519 public key, PEM) in the directory a
//   managed file comes from makes the file's detached signature mandatory:
//   `<file>.sig`, the base64 signature of the file's exact bytes. An unsigned
//   or altered file is refused by name and nothing loads — the layer it would
//   have set is the layer a user must not be able to replace.
// - Remote policy. `[managed] url` in the managed config names a TOML policy
//   the organization serves with its signature at `<url>.sig`. It is fetched
//   when the cache is older than `refreshHours`, verified against the same
//   `policy.pub`, and kept in `~/.kubic/managed/` for offline use; every load
//   verifies the cached copy again, so an edited cache is refused too. The
//   remote policy is merged into the enterprise layer above the local file.
//
// Reads go through the injected bridge; the cache is written through the exec
// bridge's locked tmp+rename.

import {
  createPrivateKey,
  createPublicKey,
  type KeyObject,
  sign as signBytes,
  verify as verifyBytes,
} from 'node:crypto';
import { dirname, join, posix, win32 } from 'node:path';
import type { FileBridge } from '@kubic/exec/file-bridge';
import {
  createNodeFileBridge,
  updateFileLocked,
} from '@kubic/exec/file-bridge';
import { tightenStateDir } from '@kubic/exec/lock-file';
import { safeExists } from './bridge-reads.js';
import { parseLayerConfig } from './config.js';
import { ConfigError } from './errors.js';

/** The verifying key's file name, in the managed directory. */
export const MANAGED_KEY_FILE = 'policy.pub';

const DEFAULT_REFRESH_HOURS = 24;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_POLICY_BYTES = 1024 * 1024;

type Bridge = Pick<FileBridge, 'exists' | 'readTextFile'>;

/** The directories a managed file is searched in, in order. */
export function managedConfigDirs(
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
): string[] {
  if (platform === 'win32') {
    return [win32.join(env.ProgramData ?? 'C:\\ProgramData', 'Kubic')];
  }
  const etc = posix.join('/etc', 'kubic');
  return platform === 'darwin'
    ? [posix.join('/Library', 'Application Support', 'Kubic'), etc]
    : [etc];
}

/**
 * The managed file `name`: the first managed directory holding it, else its
 * path in the last directory (absent; the layer reports it as such).
 */
export function managedFilePath(
  bridge: Pick<FileBridge, 'exists'>,
  name: string,
  dirs: readonly string[] = managedConfigDirs(),
): string {
  for (const dir of dirs) {
    const path = join(dir, name);
    if (safeExists(bridge, path)) return path;
  }
  return join(dirs.at(-1) ?? posix.join('/etc', 'kubic'), name);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function publicKeyFrom(pem: string, path: string): KeyObject {
  let key: KeyObject;
  try {
    key = createPublicKey(pem);
  } catch (error) {
    throw new ConfigError(
      `${path} is not a public key in PEM form: ${message(error)}`,
    );
  }
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new ConfigError(
      `${path} is a ${key.asymmetricKeyType ?? 'non-asymmetric'} key — a managed policy is signed with Ed25519`,
    );
  }
  return key;
}

function signatureMatches(
  key: KeyObject,
  text: string,
  signature: string,
): boolean {
  const bytes = Buffer.from(signature.trim(), 'base64');
  if (bytes.byteLength !== 64) return false;
  try {
    return verifyBytes(null, Buffer.from(text, 'utf8'), key, bytes);
  } catch {
    return false;
  }
}

/** The verifying key in force for a managed file, when its directory has one. */
export function managedKeyPath(
  bridge: Pick<FileBridge, 'exists'>,
  path: string,
): string | undefined {
  const keyPath = join(dirname(path), MANAGED_KEY_FILE);
  return safeExists(bridge, keyPath) ? keyPath : undefined;
}

/**
 * Checks `text` (the managed file at `path`, or a copy of a remote policy)
 * against its detached signature and the key at `keyPath`. Refuses by name.
 */
export function verifyManagedText(
  bridge: Bridge,
  path: string,
  text: string,
  keyPath: string,
  signaturePath = `${path}.sig`,
): void {
  const key = publicKeyFrom(bridge.readTextFile(keyPath), keyPath);
  if (!safeExists(bridge, signaturePath)) {
    throw new ConfigError(
      `managed config ${path} is not signed: ${signaturePath} is missing, and ${keyPath} requires a signature`,
    );
  }
  if (!signatureMatches(key, text, bridge.readTextFile(signaturePath))) {
    throw new ConfigError(
      `managed config ${path} does not match its signature ${signaturePath} — it changed after it was signed, or was signed with another key than ${keyPath}`,
    );
  }
}

/**
 * The base64 Ed25519 signature of `text` with the private key `pem` — what
 * `kubic policy sign` writes beside a managed file.
 */
export function signManagedText(pem: string, text: string): string {
  let key: KeyObject;
  try {
    key = createPrivateKey(pem);
  } catch (error) {
    throw new ConfigError(`not a private key in PEM form: ${message(error)}`);
  }
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new ConfigError(
      `a ${key.asymmetricKeyType ?? 'non-asymmetric'} key cannot sign a managed policy — use an Ed25519 key`,
    );
  }
  return signBytes(null, Buffer.from(text, 'utf8'), key).toString('base64');
}

// --- The remote policy -------------------------------------------------------

/** `[managed]` as the managed config sets it. */
export interface ManagedRemote {
  readonly url: string;
  readonly refreshHours?: number;
}

interface ManagedCacheSource {
  readonly url: string;
  readonly fetchedAt: string;
}

/** What the load knows about the managed layer, for `kubic policy explain`. */
export interface ManagedReport {
  // The managed config file the enterprise layer came from.
  readonly configPath: string;
  // Its signature verified against the directory's policy.pub.
  readonly signed: boolean;
  readonly remote?: {
    readonly url: string;
    readonly fetchedAt: string;
    readonly cachePath: string;
  };
}

function managedCacheDir(home: string): string {
  return join(home, '.kubic', 'managed');
}

function cachePaths(home: string): {
  policy: string;
  signature: string;
  source: string;
} {
  const dir = managedCacheDir(home);
  return {
    policy: join(dir, 'policy.toml'),
    signature: join(dir, 'policy.toml.sig'),
    source: join(dir, 'source.json'),
  };
}

// https, or plain http to this machine (a local policy server in testing).
function checkPolicyUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ConfigError(`'managed': 'url' is not a URL: ${url}`);
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && local)) {
    throw new ConfigError(
      `'managed': 'url' must use https (plain http only to this machine): ${url}`,
    );
  }
  return parsed;
}

function readCacheSource(
  bridge: Bridge,
  path: string,
): ManagedCacheSource | undefined {
  try {
    const parsed = JSON.parse(bridge.readTextFile(path)) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const record = parsed as Record<string, unknown>;
    return typeof record.url === 'string' &&
      typeof record.fetchedAt === 'string'
      ? { url: record.url, fetchedAt: record.fetchedAt }
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The cached remote policy, verified: its text and when it was fetched.
 * Refuses by name when the managed directory has no key, when nothing was
 * fetched for this URL yet, and when the cached copy does not verify.
 */
export function readManagedRemote(
  bridge: Bridge,
  home: string,
  remote: ManagedRemote,
  keyPath: string | undefined,
): { text: string; fetchedAt: string; cachePath: string } {
  checkPolicyUrl(remote.url);
  if (keyPath === undefined) {
    throw new ConfigError(
      `[managed] url ${remote.url} needs a ${MANAGED_KEY_FILE} beside the managed config: a remote policy applies only when it is signed`,
    );
  }
  const paths = cachePaths(home);
  const source = readCacheSource(bridge, paths.source);
  if (
    source === undefined ||
    source.url !== remote.url ||
    !safeExists(bridge, paths.policy)
  ) {
    throw new ConfigError(
      `the managed policy from ${remote.url} has not been fetched yet — run 'kubic policy pull' while the policy server is reachable`,
    );
  }
  const text = bridge.readTextFile(paths.policy);
  verifyManagedText(bridge, paths.policy, text, keyPath, paths.signature);
  return { text, fetchedAt: source.fetchedAt, cachePath: paths.policy };
}

async function fetchText(
  url: string,
  fetchImpl: typeof fetch,
): Promise<string> {
  const response = await fetchImpl(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    redirect: 'error',
  });
  if (!response.ok) {
    throw new Error(`${url} answered ${response.status}`);
  }
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_POLICY_BYTES) {
    throw new Error(`${url} is larger than ${MAX_POLICY_BYTES} bytes`);
  }
  return text;
}

export interface PullManagedPolicyInputs {
  readonly home: string;
  readonly remote: ManagedRemote;
  readonly keyPath: string | undefined;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

/**
 * Fetches the remote policy and its signature, verifies them, and replaces
 * the cache. A policy that does not verify is never cached.
 */
export async function pullManagedPolicy(
  inputs: PullManagedPolicyInputs,
): Promise<{ url: string; fetchedAt: string }> {
  checkPolicyUrl(inputs.remote.url);
  if (inputs.keyPath === undefined) {
    throw new ConfigError(
      `[managed] url ${inputs.remote.url} needs a ${MANAGED_KEY_FILE} beside the managed config: a remote policy applies only when it is signed`,
    );
  }
  const fetchImpl = inputs.fetch ?? fetch;
  const [text, signature] = await Promise.all([
    fetchText(inputs.remote.url, fetchImpl),
    fetchText(`${inputs.remote.url}.sig`, fetchImpl),
  ]);
  const files = createNodeFileBridge('/');
  const key = publicKeyFrom(files.readTextFile(inputs.keyPath), inputs.keyPath);
  if (!signatureMatches(key, text, signature)) {
    throw new ConfigError(
      `the managed policy from ${inputs.remote.url} does not match its signature ${inputs.remote.url}.sig (checked with ${inputs.keyPath}) — it was not cached`,
    );
  }
  const paths = cachePaths(inputs.home);
  const fetchedAt = new Date(inputs.now?.() ?? Date.now()).toISOString();
  files.createDir(managedCacheDir(inputs.home), true, 0o700);
  tightenStateDir(managedCacheDir(inputs.home));
  for (const [path, content] of [
    [paths.policy, text],
    [paths.signature, `${signature.trim()}\n`],
    [
      paths.source,
      `${JSON.stringify({ url: inputs.remote.url, fetchedAt })}\n`,
    ],
  ] as const) {
    updateFileLocked(path, () => content, { mode: 0o600 });
  }
  return { url: inputs.remote.url, fetchedAt };
}

/** Whether the cache for `remote` is missing or older than its refresh. */
function managedPolicyStale(
  bridge: Bridge,
  home: string,
  remote: ManagedRemote,
  now: number = Date.now(),
): boolean {
  const source = readCacheSource(bridge, cachePaths(home).source);
  if (source === undefined || source.url !== remote.url) return true;
  const fetched = Date.parse(source.fetchedAt);
  const hours = remote.refreshHours ?? DEFAULT_REFRESH_HOURS;
  return !Number.isFinite(fetched) || now - fetched >= hours * 3_600_000;
}

/** The `[managed]` remote the managed config at `path` names, if any. */
export function parseManagedRemote(
  bridge: Bridge,
  path: string,
): ManagedRemote | undefined {
  if (!safeExists(bridge, path)) return undefined;
  const managed = parseLayerConfig(
    'enterprise',
    bridge.readTextFile(path),
  ).managed;
  if (managed?.url === undefined) return undefined;
  return {
    url: managed.url,
    ...(managed.refreshHours === undefined
      ? {}
      : { refreshHours: managed.refreshHours }),
  };
}

/**
 * Before a command loads its config: fetches the remote policy when the
 * managed config names one and the cached copy is missing or older than its
 * refresh. Never throws; returns the warnings to print — an unreachable
 * server leaves the last verified copy in force.
 */
export async function refreshManagedPolicy(inputs: {
  readonly home: string;
  readonly dirs?: readonly string[];
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}): Promise<string[]> {
  const files = createNodeFileBridge('/');
  const path = managedFilePath(
    files,
    'config.toml',
    inputs.dirs ?? managedConfigDirs(),
  );
  let remote: ManagedRemote | undefined;
  try {
    remote = parseManagedRemote(files, path);
  } catch {
    // The load names a broken managed config.
    return [];
  }
  if (remote === undefined) return [];
  const now = inputs.now?.() ?? Date.now();
  if (!managedPolicyStale(files, inputs.home, remote, now)) return [];
  try {
    await pullManagedPolicy({
      home: inputs.home,
      remote,
      keyPath: managedKeyPath(files, path),
      ...(inputs.fetch === undefined ? {} : { fetch: inputs.fetch }),
      now: () => now,
    });
    return [];
  } catch (error) {
    return [
      `managed policy: could not refresh it from ${remote.url}: ${message(error)} — the last verified copy stays in force`,
    ];
  }
}
