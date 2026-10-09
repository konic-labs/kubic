// models.json custom/local providers.
// Kubic parses + validates models.json; Pi's createProvider builds the
// provider (streaming, auth, cost stay in Pi's model layer — the registry
// is generated, never hand-edited). Only OpenAI-compatible APIs are
// supported for custom endpoints (Ollama-style local path); anything else
// is refused with a named reason, never silently mapped.

export { parseModelsJson } from './parse.js';
export type { RegisterCustomProvidersOptions } from './register.js';
export {
  refuseBuiltinCollisions,
  registerCustomProviders,
} from './register.js';

export {
  DEFAULT_CONTEXT_WINDOW,
  isThinkingLevel,
  THINKING_LEVELS,
} from './schema.js';
