// Agent memory lifetimes (issue #35; design §28). v1 = session entries +
// bounded task-memory as plain values; workspace/user are documented
// not-supported-in-v1 stubs. No vectors, no embeddings, no network, no
// automatic preference learning — everything here is explicit JSON
// through the injected exec FileBridge (I/O confinement: this module
// never touches node:fs; tests back it with an in-memory fake).
import type { FileBridge } from '../../exec/src/file-bridge.js';

export type SessionEntryKind = 'note' | 'decision' | 'discovery' | 'checkpoint';

export interface SessionEntry {
  seq: number;
  kind: SessionEntryKind;
  text: string;
  at: string;
}

export interface MemoryStore {
  root: string;
  bridge: FileBridge;
}

export class MemoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemoryError';
  }
}

export function openMemoryStore(root: string, bridge: FileBridge): MemoryStore {
  if (typeof root !== 'string' || root.trim() === '') {
    throw new MemoryError('memory root must be a non-empty string');
  }
  return { root, bridge };
}

function checkId(kind: string, value: string): void {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 128 ||
    !/^[A-Za-z0-9._-]+$/.test(value)
  ) {
    throw new MemoryError(
      `${kind} must be 1-128 chars of [A-Za-z0-9._-] (no path separators)`,
    );
  }
}

function entriesPath(store: MemoryStore, sessionId: string): string {
  checkId('session id', sessionId);
  return `${store.root}/sessions/${sessionId}/entries.jsonl`;
}

export function appendSessionEntry(
  store: MemoryStore,
  sessionId: string,
  kind: SessionEntryKind,
  text: string,
): SessionEntry {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new MemoryError('session entry text must be a non-empty string');
  }
  const path = entriesPath(store, sessionId);
  let seq = 1;
  if (store.bridge.exists(path)) {
    const lines = store.bridge.readTextLines(path);
    seq = lines.filter((line) => line.trim() !== '').length + 1;
  }
  const entry: SessionEntry = {
    seq,
    kind,
    text,
    at: new Date().toISOString(),
  };
  store.bridge.appendFile(path, `${JSON.stringify(entry)}\n`);
  return entry;
}

export function readSessionEntries(
  store: MemoryStore,
  sessionId: string,
): SessionEntry[] {
  const path = entriesPath(store, sessionId);
  if (!store.bridge.exists(path)) return [];
  const entries: SessionEntry[] = [];
  for (const line of store.bridge.readTextLines(path)) {
    if (line.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      throw new MemoryError(`corrupt session entry in ${sessionId}`);
    }
    entries.push(parsed as SessionEntry);
  }
  return entries;
}
