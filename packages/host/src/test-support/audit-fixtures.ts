import { AUDIT_RECORD_VERSION, type OrgAuditRecord } from '../policy/audit.js';
// An example record: a fixture for tests and the shape `kubic audit` prints.
export const EXAMPLE_AUDIT_RECORD: OrgAuditRecord = {
  version: AUDIT_RECORD_VERSION,
  who: 'ege@example.com',
  what: 'tool.call',
  when: '2023-11-14T22:13:20.000Z',
  agent: { session: 'sess-1', role: 'implementer' },
  model: { provider: 'local', id: 'llama3', thinking: 'medium' },
  process: { pid: 1234 },
  workspace: { path: '/repo', base: 'a1b2c3d' },
  permission: { permission: 'write', approval: 'approved:tester' },
  credential: { sentinel: 'sentinel:$API_KEY' },
  network: { host: 'example.com', port: 443, decision: 'allow', bytes: 512 },
  posture: 'restricted',
  result: 'ok',
  reason: 'policy allow',
};
