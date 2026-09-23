// First-party trust + owned-path gating (issue #37; §31.1, §31.5).
// jiti may load from owned paths ONLY: ~/.pi/agent/extensions,
// .pi/extensions, owned packages, and explicit -e allowlist entries.
// Everything else is refused with an explicit error. No bypass flag exists
// by design — no option on any signature here can admit third-party code.

import { posix as posixPath } from 'node:path';
import { ExtensionRefusedError } from './contract.js';

export const FIRST_PARTY_PUBLISHERS = Object.freeze([
  'kubic',
  'konic-labs',
] as const);

export interface TrustOptions {
  homeDir: string;
  cwd: string;
  allowlist: string[];
}

function stripTrailingSlash(path: string): string {
  return path.endsWith('/') && path.length > 1 ? path.slice(0, -1) : path;
}

function isRemoteSpecifier(spec: string): boolean {
  return (
    spec.startsWith('https://') ||
    spec.startsWith('http://') ||
    spec.startsWith('ftp://')
  );
}

function isOwnedPackageSpecifier(spec: string): boolean {
  return (
    spec === '@kubic' ||
    spec.startsWith('@kubic/') ||
    spec === 'kubic' ||
    spec.startsWith('kubic/')
  );
}

export function isOwnedPath(spec: string, opts: TrustOptions): boolean {
  const trimmed = spec.trim();
  if (trimmed.length === 0) return false;
  // Normalize BEFORE prefix comparison: raw string-prefix matching accepts
  // '<owned>/../evil' (verified live). Normalization collapses '..' so the
  // escaped target no longer carries the owned prefix.
  const candidate = stripTrailingSlash(posixPath.normalize(trimmed));
  if (candidate.length === 0 || candidate === '.') return false;
  // Fail closed on escapes that survive normalization (e.g. '../../evil'):
  // a relative spec climbing above its root is never owned.
  if (candidate.split('/').includes('..')) return false;
  for (const entry of opts.allowlist) {
    if (stripTrailingSlash(posixPath.normalize(entry.trim())) === candidate)
      return true;
  }
  if (isRemoteSpecifier(candidate)) return false;
  if (isOwnedPackageSpecifier(candidate)) return true;
  const home = stripTrailingSlash(posixPath.normalize(opts.homeDir.trim()));
  const cwd = stripTrailingSlash(posixPath.normalize(opts.cwd.trim()));
  if (candidate.startsWith(`${home}/.pi/agent/extensions/`)) return true;
  if (candidate === `${home}/.pi/agent/extensions`) return true;
  if (candidate.startsWith(`${cwd}/.pi/extensions/`)) return true;
  if (candidate === `${cwd}/.pi/extensions`) return true;
  if (
    candidate.startsWith('.pi/extensions/') ||
    candidate === '.pi/extensions'
  ) {
    return true;
  }
  return false;
}

export interface TrustSubject {
  name: string;
  publisher: string;
  sourcePath?: string;
}

export function isFirstParty(
  subject: TrustSubject,
  opts: TrustOptions,
): boolean {
  if (
    !(FIRST_PARTY_PUBLISHERS as readonly string[]).includes(subject.publisher)
  ) {
    return false;
  }
  if (subject.sourcePath !== undefined) {
    return isOwnedPath(subject.sourcePath, opts);
  }
  return true;
}

// NOTE: this signature takes no bypass option. Callers passing unknown
// extra properties (e.g. { allowThirdParty: true }) are still refused:
// unknown properties are ignored, never honored.
export function assertFirstParty(
  subject: TrustSubject,
  opts: TrustOptions,
): void {
  if (
    !(FIRST_PARTY_PUBLISHERS as readonly string[]).includes(subject.publisher)
  ) {
    throw new ExtensionRefusedError(
      `third-party extension refused: publisher ${JSON.stringify(subject.publisher)} is not first-party (v1 ships first-party bundles only)`,
    );
  }
  if (
    subject.sourcePath !== undefined &&
    !isOwnedPath(subject.sourcePath, opts)
  ) {
    throw new ExtensionRefusedError(
      `third-party extension refused: ${JSON.stringify(subject.sourcePath)} is not an owned path (owned: ~/.pi/agent/extensions, .pi/extensions, owned packages, -e allowlist)`,
    );
  }
}
