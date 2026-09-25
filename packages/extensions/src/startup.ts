// First-party bundle posture + startup loading (issues #80, #93; §33 skills
// loading, §32 facets/services). SCOPE: the on-disk bundle under skills/budget
// is resolved through the #37 trust gates by ONE loader — loadFirstPartyBundle
// — which backs both surfaces:
//   - the startup gate: `run`, `tui`, and `orchestrate` load it at
//     composition-root boot (solo and manager lanes alike) and refuse to run
//     bare — a missing/unreadable/refused bundle throws
//     ExtensionStartupError, never a silent no-op;
//   - the posture projection: `kubic doctor` reports the SAME object's
//     loaded/refused counts (no second probe, so counts cannot drift).
// The manifest is data (validated, never executed); the factory stays
// compiled-in first-party code. All bundle services provide local-only —
// v1 has no remote extension resolution, so the remote-truthiness gate is
// live on the real registry. File access is injected (a structural subset of
// the exec FileBridge) — this module never imports node:fs (I/O confinement,
// §9).

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

// The full loading result: the posture (what doctor reports) plus the live
// objects the startup gate hands down — the registry holding the loaded
// services, the limits the bundle pinned, and the loader's own registered
// names. ONE loading implementation backs both probeFirstPartyPosture and
// the startup gate (issue #93), so doctor's counts cannot drift from what
// actually loaded.
export interface BundleLoad extends ExtensionPosture {
  registry: ServiceRegistry;
  limits: BudgetLimits;
  /** ExtensionLoader.registered after the load — empty when nothing registered. */
  registered: string[];
  /** Rendered tui-facet status for the loaded limits. */
  statusText: string;
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
    `extension bundle dir missing: "skills/budget" not found from ${JSON.stringify(anchorDir)} (first-party bundle ${FIRST_PARTY_BUNDLE_NAME} unavailable — refusing startup, never a silent skip)`,
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
  const pinnedFacets = [...BUDGET_MANIFEST.facets].sort();
  const onDiskFacets = [...manifest.facets].sort();
  // Strict set equality (sorted element-wise): length + subset alone would
  // accept a same-length array with a duplicated entry masking a missing
  // facet (e.g. ['contract','contract',...] for a 4-facet pin).
  const sameFacets =
    onDiskFacets.length === pinnedFacets.length &&
    onDiskFacets.every((facet, index) => facet === pinnedFacets[index]);
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

// Shared loading core (issue #93): resolve the bundle dir, read+pin-check the
// manifest, gate it through assertFirstParty, register it on a real
// ExtensionLoader, and ACTIVATE it on the loader's documented path
// (activateAll: factory setup → awaited onActivate → the three flush
// stages). Used by BOTH the doctor posture probe and the startup gate — one
// implementation, so reported counts cannot drift from what loaded.
// Never throws: every failure is data.
export async function loadFirstPartyBundle(
  opts: PostureOptions,
): Promise<BundleLoad> {
  const refused: RefusedAttempt[] = [];
  const empty = (detail: string): BundleLoad => ({
    ok: false,
    loaded: [],
    refused,
    detail,
    registry: new ServiceRegistry(),
    limits: opts.limits ?? {},
    registered: [],
    statusText: '',
  });
  let bundleDir: string;
  try {
    bundleDir = resolveBundleDir(opts.anchorDir, opts.files);
  } catch (error) {
    return empty(startupMessage(error));
  }
  let manifest: ExtensionManifest;
  try {
    manifest = readManifest(opts.files, bundleDir);
  } catch (error) {
    return empty(startupMessage(error));
  }
  try {
    assertFirstParty(manifest, opts.trust);
  } catch (error) {
    const reason = startupMessage(error);
    refused.push({ attempt: `manifest:${manifest.name}`, reason });
    return empty(`extension bundle refused: ${reason}`);
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
    return empty(reason);
  }
  const loader = new ExtensionLoader(opts.trust);
  const limits: BudgetLimits = opts.limits ?? {};
  const bundle = createBudgetBundle(limits);
  try {
    loader.register(manifest, bundle.factory);
  } catch (error) {
    const reason = startupMessage(error);
    refused.push({ attempt: `register:${manifest.name}`, reason });
    return empty(`extension bundle refused: ${reason}`);
  }
  const registry = new ServiceRegistry();
  const provided: string[] = [];
  await loader.activateAll({
    use: (name: string) => registry.use(name),
    provide: (name: string, impl: unknown) => {
      registry.provide(name, impl, { local: true });
      provided.push(name);
    },
    flush: (_stage: string) => undefined,
  });
  if (!provided.includes(BUDGET_SERVICE)) {
    return empty(
      `extension bundle ${manifest.name} provided no services — refusing empty activation`,
    );
  }
  let statusText: string;
  try {
    statusText = renderBudgetStatus(
      registry.use(BUDGET_SERVICE) as BudgetLimits,
    );
  } catch (error) {
    return empty(
      `extension bundle ${manifest.name} failed the provide/use round-trip (${startupMessage(error)})`,
    );
  }
  const traversal = `${opts.trust.cwd}/.pi/extensions/../evil.js`;
  try {
    loader.resolve(traversal);
    return empty(
      `extension trust tripwire: owned-path traversal ${JSON.stringify(traversal)} was admitted — refusing startup`,
    );
  } catch (error) {
    if (!(error instanceof ExtensionRefusedError)) {
      return empty(
        `extension trust tripwire: traversal probe failed unexpectedly (${startupMessage(error)})`,
      );
    }
    refused.push({
      attempt: `resolve:${traversal}`,
      reason: startupMessage(error),
    });
  }
  try {
    registry.use(BUDGET_SERVICE, { remote: 1 } as never);
    return empty(
      'extension trust tripwire: truthy remote flag { remote: 1 } was admitted on a local-only service — refusing startup',
    );
  } catch (error) {
    if (!(error instanceof ServiceRemoteError)) {
      return empty(
        `extension trust tripwire: remote-flag probe failed unexpectedly (${startupMessage(error)})`,
      );
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
    return empty(
      `extension trust tripwire: expected 2 refused bypass attempts, recorded ${refused.length} — refusing startup`,
    );
  }
  return {
    ok: true,
    loaded: [manifest.name],
    refused,
    registry,
    limits,
    registered: loader.registered,
    statusText,
    detail: `loaded 1 (${manifest.name}: ${statusText}), refused 2 (owned-path traversal, remote-flag use)`,
  };
}

// Posture probe: the load above, shaped as the doctor posture (issue #80's
// surface). Never throws: every failure is data (ok:false + detail), so
// doctor can report it. A bypass that is unexpectedly ADMITTED fails the
// posture — the #37 hardening regressing must turn doctor red, not silent.
export async function probeFirstPartyPosture(
  opts: PostureOptions,
): Promise<ExtensionPosture> {
  const { registry: _registry, ...posture } = await loadFirstPartyBundle(opts);
  void _registry;
  return posture;
}
