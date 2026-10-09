// Request-time secret references ($ENV_VAR, !command, escaped literals), the
// model key resolver, and the redaction of resolved secrets from output and
// files.
export type { ModelKeyResolver } from './secrets.js';
export {
  createModelKeyResolver,
  matchableSecrets,
  parseSecretRef,
  redactBridgeWrites,
  redactingSink,
  redactSecretValues,
  withoutIdentity,
} from './secrets.js';
