// Session storage on pi-durable. One durable Session
// per session directory, one storage per session: sessions live under
// <sessions-root>/<id>/, and the storage's JSONL files sit in that directory
// beside the Kubic state it already held (journal, spans, posture, lock).
//
// Layout, per session:
//   <root>/<id>/main.jsonl          pi-durable JSONL storage (conversations,
//                                   documents, tasks — the session's truth)
//   <root>/<id>/doc-<n>.jsonl       the storage's document sidecars
//   <root>/<id>/session.json        Kubic's LISTING HEADER (see below)
//   <root>/<id>/lock.json           the Kubic session lock
//   <root>/<id>/journal|spans…      the rest of the session's state
//
// Two records hold the session's metadata, and the split is deliberate:
//   - the `kubic.session` document, written in the creating commit, is the
//     session's own metadata: anything that has the session open reads it
//     from the storage (readSessionMetadata).
//   - `<id>/session.json` is the listing header: `listSessions` and
//     `sessionsTouchingWorkspace` run on every `kubic run` boot (the overlap
//     probe) and in `kubic doctor`, and pi-durable states that ONE PROCESS
//     OWNS A STORAGE AT A TIME. Listing must therefore never open a session
//     storage — a live session's would be a second owner, and recovery can
//     truncate a file the live writer is appending to. The header is written
//     once, from the same value as the document, and re-synced from the
//     document on attach.
//
// fsync: OFF (pi-durable's default). A process crash loses nothing (the page
// cache outlives it) and a power loss costs at most the newest commit, which
// recovery drops whole. The change journal is Kubic's fsync'd store — that is
// where "this change can be undone" is guaranteed.
//
// A folder without a storage file is not a session: it is never listed and
// never attachable.

export { forkSession, SessionForkError } from './fork.js';
export { SESSION_ID_PATTERN } from './ids.js';
export { SessionLockError, sessionLockIsLive } from './lock.js';
export type { SessionStore } from './meta.js';
export {
  laneConversationIdOf,
  openSessionStore,
  readSessionMetadata,
} from './meta.js';
export type { SessionHandle } from './store.js';
export {
  attachSession,
  createSession,
  listSessions,
  SessionAttachError,
  sessionsTouchingWorkspace,
} from './store.js';
