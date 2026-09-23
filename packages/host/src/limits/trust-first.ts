// Trust-first docs ordering note (issue #58; §77).
// Limits docs come before features: no reader meets a capability
// before meeting its honest limits. The ordering is data so help
// text and docs render it instead of restating it.
export const TRUST_FIRST_DOC_ORDER: readonly string[] = [
  'honest limits (§59.1)',
  'solo warning: no isolation (§3.7)',
  'approvals: ask-user by default, session-scoped full-access (§41)',
  'change journal: review and undo, not a backup',
  'doctor posture: enforced-or-not, human + machine-readable (§50, §78)',
  'orchestrator mode features',
  'solo mode features',
];

export function formatTrustFirstNote(): string {
  return 'trust-first ordering (§77): limits docs before features — honest limits, solo warning, approvals, journal, doctor posture, then features.';
}
