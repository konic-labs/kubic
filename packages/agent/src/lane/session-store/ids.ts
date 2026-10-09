// Session ids: path segments under the sessions root, so their character
// class is a containment rule.
// Session ids are path segments under the sessions root, so the character
// class is a containment rule, not a style: `join(root, id)` must never leave
// the root. Every command that takes a session id validates it with this
// pattern before any path join.
export const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export function isSessionId(id: string): boolean {
  return SESSION_ID_PATTERN.test(id);
}

export class SessionIdError extends Error {
  constructor(id: string) {
    super(`invalid session id: ${id}`);
    this.name = 'SessionIdError';
  }
}
