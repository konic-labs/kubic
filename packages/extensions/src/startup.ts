// First-party bundle posture (issue #80; §33 skills). SCOPE: the on-disk
// bundle under skills/budget is probed through the #37 trust gates from
// `kubic doctor` only (the extension:bundle check) — run/tui/orchestrate
// never call this probe and run bare, by design until persistence lands.
// This module is a posture check, not a startup gate: the manifest is
// data (validated, never executed), the factory stays compiled-in
// first-party code. All bundle services provide local-only —
// v1 has no remote extension resolution, so the remote-truthiness gate is
// live on the real registry. Removing the bundle dir fails closed with
// ExtensionStartupError, never a silent no-op. File access is injected
// (a structural subset of the exec FileBridge) — this module never
// imports node:fs (I/O confinement, §9).

import type { BudgetLimits } from './bundles/budget/contract.js';
import { BUDGET_SERVICE } from './bundles/budget/contract.js';
import { BUDGET_MANIFEST, createBudgetBundle } from './bundles/budget/index.js';
import { renderBudgetStatus } from './bundles/budget/tui.js';
import type { ExtensionManifest } from './contract.js';
import { ExtensionRefusedError, FACET_KINDS } from './contract.js';
import { ExtensionLoader } from './loader.js';
import { ServiceRegistry, ServiceRemoteError } from './services.js';
import type { TrustOptions } from './trust.js';
import { assertFirstParty } from './trust.js';

export class ExtensionStartupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExtensionStartupError';
  }
}

// Structural subset of the exec FileBridge: the composition root passes
// the real bridge; tests pass a fake. No node:fs import here.
export interface BundleDirFiles {
  joinPath(parts: string[]): string;
  exists(path: string): boolean;
  fileInfo(path: string): { isDirectory: boolean };
  readTextFile(path: string): string;
}

export interface PostureOptions {
  anchorDir: string;
  files: BundleDirFiles;
  trust: TrustOptions;
  limits?: BudgetLimits;
}

export interface RefusedAttempt {
  attempt: string;
  reason: string;
}

export interface ExtensionPosture {
  ok: boolean;
  loaded: string[];
  refused: RefusedAttempt[];
  detail: string;
}

export const FIRST_PARTY_BUNDLE_NAME = 'kubic/budget';
export const BUNDLE_MANIFEST_FILE = 'manifest.json';
// Upward-walk bound: 4 levels covers both shipped layouts exactly (src:
// packages/extensions/src → root is 3; dist: dist/apps/kubic/src → root
// is 4). Anything further up is outside the repo — fail closed instead
// of escaping toward the filesystem root.
const MAX_ANCHOR_LEVELS = 4;

function startupMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveBundleDir(anchorDir: string, files: BundleDirFiles): string {
  for (let level = 0; level <= MAX_ANCHOR_LEVELS; level += 1) {
    const parts: string[] = [anchorDir];
    for (let up = 0; up < level; up += 1) parts.push('..');
    parts.push('skills', 'budget');
    const candidate = files.joinPath(parts);
    if (!files.exists(candidate)) continue;
    // A non-directory at the bundle path (file, symlink, unreadable)
    // is not the bundle dir — keep walking, fail closed at the end.
    let isDir = false;
    try {
      isDir = files.fileInfo(candidate).isDirectory;
    } catch {
      isDir = false;
    }
    if (isDir) return candidate;
  }
  throw new ExtensionStartupError(
    `extension bundle dir missing: "skills/budget" not found from ${JSON.stringify(anchorDir)} (first-party bundle ${FIRST_PARTY_BUNDLE_NAME} unavailable — failing the doctor posture, never a silent skip)`,
  );
}

function readManifest(
  files: BundleDirFiles,
  bundleDir: string,
): ExtensionManifest {
  const path = files.joinPath([bundleDir, BUNDLE_MANIFEST_FILE]);
  let text: string;
  try {
    text = files.readTextFile(path);
  } catch (error) {
    throw new ExtensionStartupError(
      `extension bundle unreadable: cannot read ${JSON.stringify(path)} (${startupMessage(error)})`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new ExtensionStartupError(
      `extension bundle invalid: ${JSON.stringify(path)} is not JSON (${startupMessage(error)})`,
    );
  }
  if (!isManifestShape(parsed)) {
    throw new ExtensionStartupError(
      `extension bundle invalid: ${JSON.stringify(path)} is not a valid extension manifest (need string name/publisher/version and a facets array)`,
    );
  }
  if (parsed.name !== FIRST_PARTY_BUNDLE_NAME) {
    throw new ExtensionStartupError(
      `extension bundle refused: unknown first-party bundle ${JSON.stringify(parsed.name)} (v1 ships ${FIRST_PARTY_BUNDLE_NAME} only)`,
    );
  }
  return parsed;
}

// Pin resolution: the on-disk manifest must agree with the compiled
// BUDGET_MANIFEST pin (name already checked above; publisher+facets
// here). The #37 trust gates admit any first-party publisher (kubic,
// konic-labs) with an owned sourcePath, so gates alone cannot catch a
// drifted bundle dir (shadow copy, hand edit) — fail closed on drift
// and never fall through to another candidate.
function assertManifestPin(path: string, manifest: ExtensionManifest): void {
  const drifts: string[] = [];
  if (manifest.publisher !== BUDGET_MANIFEST.publisher) {
    drifts.push(
      `publisher: on-disk ${JSON.stringify(manifest.publisher)} vs compiled pin ${JSON.stringify(BUDGET_MANIFEST.publisher)}`,
    );
  }
  const pinnedFacets = [...BUDGET_MANIFEST.facets];
  const onDiskFacets = [...manifest.facets];
  const sameFacets =
    onDiskFacets.length === pinnedFacets.length &&
    onDiskFacets.every((facet) => pinnedFacets.includes(facet));
  if (!sameFacets) {
    drifts.push(
      `facets: on-disk [${onDiskFacets.join(', ')}] vs compiled pin [${pinnedFacets.join(', ')}]`,
    );
  }
  if (drifts.length > 0) {
    throw new ExtensionStartupError(
      `extension bundle drift: on-disk manifest ${JSON.stringify(path)} disagrees with the compiled ${FIRST_PARTY_BUNDLE_NAME} pin (${drifts.join('; ')}) — refusing`,
    );
  }
}

function isManifestShape(value: unknown): value is ExtensionManifest {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.name === 'string' &&
    typeof record.publisher === 'string' &&
    typeof record.version === 'string' &&
    (record.sourcePath === undefined ||
      typeof record.sourcePath === 'string') &&
    Array.isArray(record.facets) &&
    record.facets.every(
      (facet) =>
        typeof facet === 'string' &&
        (FACET_KINDS as readonly string[]).includes(facet),
    )
  );
}

// Posture probe: performs the synchronous load (manifest → assertFirstParty
// → loader.register → factory setup → local provide → use round-trip) plus
// the two live bypass attempts (owned-path traversal, truthy remote flag).
// Never throws: every failure is data (ok:false + detail), so doctor can
// report it. A bypass that is unexpectedly ADMITTED fails the posture —
// the #37 hardening regressing must turn doctor red, not silent.
export function probeFirstPartyPosture(opts: PostureOptions): ExtensionPosture {
  const refused: RefusedAttempt[] = [];
  let bundleDir: string;
  try {
    bundleDir = resolveBundleDir(opts.anchorDir, opts.files);
  } catch (error) {
    return {
      ok: false,
      loaded: [],
      refused,
      detail: startupMessage(error),
    };
  }
  let manifest: ExtensionManifest;
  try {
    manifest = readManifest(opts.files, bundleDir);
  } catch (error) {
    return {
      ok: false,
      loaded: [],
      refused,
      detail: startupMessage(error),
    };
  }
  try {
    assertFirstParty(manifest, opts.trust);
  } catch (error) {
    const reason = startupMessage(error);
    refused.push({ attempt: `manifest:${manifest.name}`, reason });
    return {
      ok: false,
      loaded: [],
      refused,
      detail: `extension bundle refused: ${reason}`,
    };
  }
  // Pin resolution runs AFTER the trust gates so gate violations keep
  // their gate errors (third-party, owned-path): the pin catches what
  // the gates admit (a drifted publisher/facets on an otherwise
  // first-party manifest). Fail closed, never fall through to another
  // candidate — the walk already committed to the nearest dir.
  try {
    assertManifestPin(
      opts.files.joinPath([bundleDir, BUNDLE_MANIFEST_FILE]),
      manifest,
    );
  } catch (error) {
    const reason = startupMessage(error);
    refused.push({ attempt: `pin:${manifest.name}`, reason });
    return {
      ok: false,
      loaded: [],
      refused,
      detail: reason,
    };
  }
  const loader = new ExtensionLoader(opts.trust);
  const bundle = createBudgetBundle(opts.limits ?? {});
  try {
    loader.register(manifest, bundle.factory);
  } catch (error) {
    const reason = startupMessage(error);
    refused.push({ attempt: `register:${manifest.name}`, reason });
    return {
      ok: false,
      loaded: [],
      refused,
      detail: `extension bundle refused: ${reason}`,
    };
  }
  const registry = new ServiceRegistry();
  const provided: string[] = [];
  const handle = bundle.factory({
    use: (name: string, useOpts?: { remote?: boolean }) =>
      registry.use(name, useOpts ?? {}),
    provide: (name: string, impl: unknown) => {
      registry.provide(name, impl, { local: true });
      provided.push(name);
    },
    flush: (_stage: string) => undefined,
  });
  void handle;
  if (!provided.includes(BUDGET_SERVICE)) {
    return {
      ok: false,
      loaded: [],
      refused,
      detail: `extension bundle ${manifest.name} provided no services — refusing empty activation`,
    };
  }
  let statusText: string;
  try {
    statusText = renderBudgetStatus(
      registry.use(BUDGET_SERVICE) as BudgetLimits,
    );
  } catch (error) {
    return {
      ok: false,
      loaded: [],
      refused,
      detail: `extension bundle ${manifest.name} failed the provide/use round-trip (${startupMessage(error)})`,
    };
  }
  const traversal = `${opts.trust.cwd}/.pi/extensions/../evil.js`;
  try {
    loader.resolve(traversal);
    return {
      ok: false,
      loaded: [],
      refused,
      detail: `extension trust tripwire: owned-path traversal ${JSON.stringify(traversal)} was admitted — refusing startup`,
    };
  } catch (error) {
    if (!(error instanceof ExtensionRefusedError)) {
      return {
        ok: false,
        loaded: [],
        refused,
        detail: `extension trust tripwire: traversal probe failed unexpectedly (${startupMessage(error)})`,
      };
    }
    refused.push({
      attempt: `resolve:${traversal}`,
      reason: startupMessage(error),
    });
  }
  try {
    registry.use(BUDGET_SERVICE, { remote: 1 } as never);
    return {
      ok: false,
      loaded: [],
      refused,
      detail:
        'extension trust tripwire: truthy remote flag { remote: 1 } was admitted on a local-only service — refusing startup',
    };
  } catch (error) {
    if (!(error instanceof ServiceRemoteError)) {
      return {
        ok: false,
        loaded: [],
        refused,
        detail: `extension trust tripwire: remote-flag probe failed unexpectedly (${startupMessage(error)})`,
      };
    }
    refused.push({
      attempt: `use:${BUDGET_SERVICE}:{remote:1}`,
      reason: startupMessage(error),
    });
  }
  // Defense in depth: the ok path must carry proof both live tripwires
  // fired — a future edit that skips a probe must turn the posture red,
  // not silently green.
  if (refused.length < 2) {
    return {
      ok: false,
      loaded: [],
      refused,
      detail: `extension trust tripwire: expected 2 refused bypass attempts, recorded ${refused.length} — refusing startup`,
    };
  }
  return {
    ok: true,
    loaded: [manifest.name],
    refused,
    detail: `loaded 1 (${manifest.name}: ${statusText}), refused 2 (owned-path traversal, remote-flag use)`,
  };
}
