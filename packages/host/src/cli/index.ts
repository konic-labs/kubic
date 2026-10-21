// Shared command plumbing: the output channels and theme every command
// writes through, and project-root discovery.
export type { CliIo } from './cli-io.js';
export { diagnosticsOf, themeOf } from './cli-io.js';
export { csvField } from './csv.js';
export { findProjectRoot } from './project-root.js';
