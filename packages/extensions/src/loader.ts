// jiti loader from owned paths only (issue #37; §31.2–§31.5). Registration
// refuses third-party bundles before any import runs. Activation ordering is
// sync factory setup, then async onActivate, and only then the
// session_start/resources/provider flush — extensions are fully initialized
// before the session observes them.

import type { ExtensionManifest } from './contract.js';
import { ExtensionRefusedError } from './contract.js';
import type { TrustOptions } from './trust.js';
import { assertFirstParty, isOwnedPath } from './trust.js';

export type FlushStage = 'session_start' | 'resources' | 'provider';

export const FLUSH_ORDER: FlushStage[] = [
  'session_start',
  'resources',
  'provider',
];

export interface ActivationEnv {
  use: (name: string) => unknown;
  provide?: (name: string, impl: unknown) => void;
  flush: (stage: FlushStage | string) => void;
}

export interface ActiveHandle {
  onActivate?: () => void | Promise<void>;
}

export type BundleFactory = (env: ActivationEnv) => ActiveHandle | undefined;

interface Registration {
  manifest: ExtensionManifest;
  factory: BundleFactory;
}

export class ExtensionLoader {
  private registrations: Registration[] = [];
  private readonly trust: TrustOptions;

  constructor(trust: TrustOptions) {
    this.trust = trust;
  }

  register(manifest: ExtensionManifest, factory: BundleFactory): void {
    assertFirstParty(manifest, this.trust);
    this.registrations.push({ manifest, factory });
  }

  // Validate a jiti target without importing it. Owned paths and owned
  // package specifiers resolve; everything else throws before any code loads.
  resolve(specifier: string): string {
    if (!isOwnedPath(specifier, this.trust)) {
      throw new ExtensionRefusedError(
        `third-party extension refused: ${JSON.stringify(specifier)} is not an owned path (owned: ~/.pi/agent/extensions, .pi/extensions, owned packages, -e allowlist)`,
      );
    }
    return specifier;
  }

  async activateAll(env: ActivationEnv): Promise<void> {
    const handles: ActiveHandle[] = [];
    for (const registration of this.registrations) {
      const handle = registration.factory(env);
      if (handle !== undefined) handles.push(handle);
    }
    for (const handle of handles) {
      await handle.onActivate?.();
    }
    for (const stage of FLUSH_ORDER) env.flush(stage);
  }

  get registered(): string[] {
    return this.registrations.map((registration) => registration.manifest.name);
  }
}
