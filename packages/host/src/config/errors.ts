// The config load's refusals.

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export class ProjectUntrustedError extends ConfigError {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectUntrustedError';
  }
}
