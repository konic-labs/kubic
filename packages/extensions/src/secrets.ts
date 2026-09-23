// Extension secrets (issue #37; §32). A secret-holding local resolves the
// full value locally but exposes only a narrow non-secret facade; remote
// resolution of a secret-holding local always throws.

export class SecretRemoteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretRemoteError';
  }
}

export interface SecretFacade {
  name: string;
  hasValue: boolean;
}

export class SecretStore {
  private secrets = new Map<string, string>();

  set(name: string, value: string): void {
    this.secrets.set(name, value);
  }

  getLocal(name: string): string {
    const value = this.secrets.get(name);
    if (value === undefined) {
      throw new Error(`secret not found: ${name}`);
    }
    return value;
  }

  facade(name: string): SecretFacade {
    return { name, hasValue: this.secrets.has(name) };
  }

  resolveRemote(name: string): never {
    if (this.secrets.has(name)) {
      throw new SecretRemoteError(
        `secret ${name} is local-only and is never resolvable remotely`,
      );
    }
    throw new Error(`secret not found: ${name}`);
  }
}
