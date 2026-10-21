// Posting JSON to a collector over https (plain http only to this machine),
// and trusting the system certificate store.
export type { CollectorTls } from './post.js';
export { checkCollectorUrl, postJson, requestJson } from './post.js';
export { trustSystemCertificates } from './system-ca.js';
