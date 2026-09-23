// Extension services (issue #37; §32). Bundles provide/provideMany and
// consume via env.use(); observe watches for late registration. Services
// marked local:{true} are never resolvable remotely: a remote use() throws.

export interface ServiceOptions {
  local?: boolean;
}

export interface UseOptions {
  remote?: boolean;
}

export interface ServiceEntry {
  name: string;
  impl: unknown;
  opts?: ServiceOptions;
}

export class ServiceRemoteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServiceRemoteError';
  }
}

export class ServiceNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServiceNotFoundError';
  }
}

export class ServiceRegistry {
  private impls = new Map<string, { impl: unknown; local: boolean }>();
  private watchers = new Map<string, Set<(impl: unknown) => void>>();

  provide(name: string, impl: unknown, opts: ServiceOptions = {}): void {
    this.impls.set(name, { impl, local: opts.local ?? false });
    const watchers = this.watchers.get(name);
    if (watchers !== undefined) {
      for (const watcher of [...watchers]) watcher(impl);
    }
  }

  provideMany(entries: ServiceEntry[]): void {
    for (const entry of entries)
      this.provide(entry.name, entry.impl, entry.opts);
  }

  use(name: string, opts: UseOptions = {}): unknown {
    const entry = this.impls.get(name);
    if (entry === undefined) {
      throw new ServiceNotFoundError(`service not found: ${name}`);
    }
    if (entry.local && opts.remote) {
      throw new ServiceRemoteError(
        `service ${name} is local-only and is never resolvable remotely`,
      );
    }
    return entry.impl;
  }

  observe(name: string, watcher: (impl: unknown) => void): () => void {
    let watchers = this.watchers.get(name);
    if (watchers === undefined) {
      watchers = new Set();
      this.watchers.set(name, watchers);
    }
    watchers.add(watcher);
    return () => {
      watchers.delete(watcher);
    };
  }
}

export interface LoaderEnvView {
  use: (name: string, opts?: UseOptions) => unknown;
}

export function createEnv(registry: ServiceRegistry): LoaderEnvView {
  return {
    use: (name: string, opts: UseOptions = {}) => registry.use(name, opts),
  };
}
