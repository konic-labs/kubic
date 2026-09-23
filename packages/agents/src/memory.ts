// Agent memory lifetimes (issue #35; design §28). v1 = session entries +
// bounded task-memory as plain values; workspace/user are documented
// not-supported-in-v1 stubs. Out of scope by design: similarity search
// over stored text, network calls, and automatically learned user traits
// — everything here is explicit JSON through the injected exec
// FileBridge (I/O confinement: this module never touches the filesystem
// directly; tests back it with an in-memory fake).
import type { FileBridge } from '../../exec/src/file-bridge.js';
import type { TaskArtifactRef } from './task.js';

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

export class MemoryUnavailableError extends MemoryError {
  constructor(message: string) {
    super(message);
    this.name = 'MemoryUnavailableError';
  }
}

// Bounds keep task-memory inspectable: entries and values stay small
// enough to dump as plain JSON without paging or truncation.
export const MAX_ENTRY_TEXT_CHARS = 8000;
export const MAX_SESSION_ENTRIES = 2000;
export const MAX_TASK_LIST_ITEMS = 500;
export const MAX_VALUE_CHARS = 8000;

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
  if (text.length > MAX_ENTRY_TEXT_CHARS) {
    throw new MemoryError(
      `session entry text too long: ${text.length} > ${MAX_ENTRY_TEXT_CHARS}`,
    );
  }
  const path = entriesPath(store, sessionId);
  let seq = 1;
  if (store.bridge.exists(path)) {
    const lines = store.bridge.readTextLines(path);
    const count = lines.filter((line) => line.trim() !== '').length;
    if (count >= MAX_SESSION_ENTRIES) {
      throw new MemoryError(
        `too many session entries: ${count} >= ${MAX_SESSION_ENTRIES}`,
      );
    }
    seq = count + 1;
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

// Task memory (§28): the seven value fields plus artifact refs. Artifacts
// reuse the TaskArtifactRef shape from task.ts as a read-only consumer —
// this module never redefines artifact types, it only stores the refs.

export interface TaskMemoryInit {
  objective: string;
  decisions?: string[];
  constraints?: string[];
  files?: string[];
  discoveries?: string[];
  failedAttempts?: string[];
  successfulChanges?: string[];
  artifactIds?: string[];
}

export interface TaskMemoryRecord {
  version: 1;
  taskId: string;
  sessionId: string;
  objective: string;
  decisions: string[];
  constraints: string[];
  files: string[];
  discoveries: string[];
  failedAttempts: string[];
  successfulChanges: string[];
  artifacts: TaskArtifactRef[];
  updatedAt: string;
}

function taskPath(
  store: MemoryStore,
  sessionId: string,
  taskId: string,
): string {
  checkId('session id', sessionId);
  checkId('task id', taskId);
  return `${store.root}/tasks/${sessionId}/${taskId}.json`;
}

function checkStringList(field: string, value: unknown): string[] {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== 'string' || item.trim() === '')
  ) {
    throw new MemoryError(`${field} must be an array of non-empty strings`);
  }
  const list = [...(value as string[])];
  for (const item of list) {
    if (item.length > MAX_VALUE_CHARS) {
      throw new MemoryError(
        `${field} value too long: ${item.length} > ${MAX_VALUE_CHARS}`,
      );
    }
  }
  return list;
}

function checkListBounds(record: TaskMemoryRecord): void {
  const lists: Array<[string, unknown[]]> = [
    ['decisions', record.decisions],
    ['constraints', record.constraints],
    ['files', record.files],
    ['discoveries', record.discoveries],
    ['failedAttempts', record.failedAttempts],
    ['successfulChanges', record.successfulChanges],
    ['artifacts', record.artifacts],
  ];
  for (const [field, list] of lists) {
    if (list.length > MAX_TASK_LIST_ITEMS) {
      throw new MemoryError(
        `too many ${field}: ${list.length} > ${MAX_TASK_LIST_ITEMS}`,
      );
    }
  }
}

function checkRecordShape(value: unknown, taskId: string): TaskMemoryRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new MemoryError(`corrupt task record for ${taskId}`);
  }
  const record = value as Record<string, unknown>;
  const lists: Record<string, string[]> = {};
  for (const field of [
    'decisions',
    'constraints',
    'files',
    'discoveries',
    'failedAttempts',
    'successfulChanges',
  ] as const) {
    lists[field] = checkStringList(field, record[field]);
  }
  const artifactsRaw = record.artifacts;
  let artifacts: TaskArtifactRef[] = [];
  if (artifactsRaw !== undefined) {
    if (
      !Array.isArray(artifactsRaw) ||
      artifactsRaw.some(
        (item) =>
          typeof item !== 'object' ||
          item === null ||
          typeof (item as { artifactId?: unknown }).artifactId !== 'string' ||
          (item as { artifactId: string }).artifactId.trim() === '',
      )
    ) {
      throw new MemoryError('artifacts must be an array of { artifactId }');
    }
    artifacts = (artifactsRaw as TaskArtifactRef[]).map((ref) => ({
      artifactId: ref.artifactId,
    }));
  }
  return {
    version: 1,
    taskId,
    sessionId: record.sessionId as string,
    objective: record.objective as string,
    decisions: lists.decisions ?? [],
    constraints: lists.constraints ?? [],
    files: lists.files ?? [],
    discoveries: lists.discoveries ?? [],
    failedAttempts: lists.failedAttempts ?? [],
    successfulChanges: lists.successfulChanges ?? [],
    artifacts,
    updatedAt: record.updatedAt as string,
  };
}

export function writeTaskMemory(
  store: MemoryStore,
  sessionId: string,
  taskId: string,
  init: TaskMemoryInit,
): TaskMemoryRecord {
  const path = taskPath(store, sessionId, taskId);
  if (store.bridge.exists(path)) {
    throw new MemoryError(`task record already exists: ${taskId}`);
  }
  if (
    typeof init !== 'object' ||
    init === null ||
    typeof init.objective !== 'string' ||
    init.objective.trim() === ''
  ) {
    throw new MemoryError('task objective must be a non-empty string');
  }
  const record: TaskMemoryRecord = {
    version: 1,
    taskId,
    sessionId,
    objective: init.objective,
    decisions: checkStringList('decisions', init.decisions),
    constraints: checkStringList('constraints', init.constraints),
    files: checkStringList('files', init.files),
    discoveries: checkStringList('discoveries', init.discoveries),
    failedAttempts: checkStringList('failedAttempts', init.failedAttempts),
    successfulChanges: checkStringList(
      'successfulChanges',
      init.successfulChanges,
    ),
    artifacts: checkStringList('artifactIds', init.artifactIds).map(
      (artifactId) => ({ artifactId }),
    ),
    updatedAt: new Date().toISOString(),
  };
  checkListBounds(record);
  store.bridge.writeFile(path, JSON.stringify(record, null, 2));
  return record;
}

export function readTaskMemory(
  store: MemoryStore,
  sessionId: string,
  taskId: string,
): TaskMemoryRecord | undefined {
  const path = taskPath(store, sessionId, taskId);
  if (!store.bridge.exists(path)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(store.bridge.readTextFile(path)) as unknown;
  } catch {
    throw new MemoryError(`corrupt task record for ${taskId}`);
  }
  return checkRecordShape(parsed, taskId);
}

export interface TaskMemoryPatch {
  objective?: string;
  decisions?: string[];
  constraints?: string[];
  files?: string[];
  discoveries?: string[];
  failedAttempts?: string[];
  successfulChanges?: string[];
  artifactIds?: string[];
}

export function updateTaskMemory(
  store: MemoryStore,
  sessionId: string,
  taskId: string,
  patch: TaskMemoryPatch,
): TaskMemoryRecord {
  const current = readTaskMemory(store, sessionId, taskId);
  if (current === undefined) {
    throw new MemoryError(`unknown task: ${taskId}`);
  }
  if (typeof patch !== 'object' || patch === null) {
    throw new MemoryError('task patch must be an object');
  }
  const updated: TaskMemoryRecord = {
    ...current,
    objective:
      patch.objective === undefined ? current.objective : patch.objective,
    decisions: [
      ...current.decisions,
      ...checkStringList('decisions', patch.decisions),
    ],
    constraints: [
      ...current.constraints,
      ...checkStringList('constraints', patch.constraints),
    ],
    files: [...current.files, ...checkStringList('files', patch.files)],
    discoveries: [
      ...current.discoveries,
      ...checkStringList('discoveries', patch.discoveries),
    ],
    failedAttempts: [
      ...current.failedAttempts,
      ...checkStringList('failedAttempts', patch.failedAttempts),
    ],
    successfulChanges: [
      ...current.successfulChanges,
      ...checkStringList('successfulChanges', patch.successfulChanges),
    ],
    artifacts: [
      ...current.artifacts,
      ...checkStringList('artifactIds', patch.artifactIds).map(
        (artifactId) => ({ artifactId }),
      ),
    ],
    updatedAt: new Date().toISOString(),
  };
  if (updated.objective.trim() === '') {
    throw new MemoryError('task objective must be a non-empty string');
  }
  checkListBounds(updated);
  store.bridge.writeFile(
    taskPath(store, sessionId, taskId),
    JSON.stringify(updated, null, 2),
  );
  return updated;
}

export function deleteTaskMemory(
  store: MemoryStore,
  sessionId: string,
  taskId: string,
): void {
  const path = taskPath(store, sessionId, taskId);
  if (!store.bridge.exists(path)) {
    throw new MemoryError(`unknown task: ${taskId}`);
  }
  store.bridge.remove(path);
}

function tasksDir(store: MemoryStore, sessionId: string): string {
  checkId('session id', sessionId);
  return `${store.root}/tasks/${sessionId}`;
}

function listTaskIds(store: MemoryStore, sessionId: string): string[] {
  const dir = tasksDir(store, sessionId);
  if (!store.bridge.exists(dir)) return [];
  const ids: string[] = [];
  for (const info of store.bridge.listDir(dir)) {
    if (!info.name.endsWith('.json')) continue;
    ids.push(info.name.slice(0, -'.json'.length));
  }
  return ids.sort();
}

export interface ForkSummary {
  entries: number;
  tasks: string[];
}

// Fork duplicates one session's memory into a fresh session id: entries
// carry over verbatim (sequence and timestamps preserved) and each task
// record is re-homed to the new session. The source is untouched; the
// target must have no memory yet.
export function forkSessionMemory(
  store: MemoryStore,
  fromSessionId: string,
  toSessionId: string,
): ForkSummary {
  checkId('session id', fromSessionId);
  checkId('session id', toSessionId);
  if (fromSessionId === toSessionId) {
    throw new MemoryError('fork source and target session ids must differ');
  }
  const fromEntries = readSessionEntries(store, fromSessionId);
  const fromTasks = listTaskIds(store, fromSessionId);
  if (fromEntries.length === 0 && fromTasks.length === 0) {
    throw new MemoryError(`unknown session: ${fromSessionId}`);
  }
  if (
    store.bridge.exists(entriesPath(store, toSessionId)) ||
    listTaskIds(store, toSessionId).length > 0
  ) {
    throw new MemoryError(`fork target already has memory: ${toSessionId}`);
  }
  if (fromEntries.length > 0) {
    store.bridge.writeFile(
      entriesPath(store, toSessionId),
      store.bridge.readTextFile(entriesPath(store, fromSessionId)),
    );
  }
  for (const taskId of fromTasks) {
    const record = readTaskMemory(store, fromSessionId, taskId);
    if (record === undefined) continue;
    writeTaskMemory(store, toSessionId, taskId, {
      objective: record.objective,
      decisions: record.decisions,
      constraints: record.constraints,
      files: record.files,
      discoveries: record.discoveries,
      failedAttempts: record.failedAttempts,
      successfulChanges: record.successfulChanges,
      artifactIds: record.artifacts.map((ref) => ref.artifactId),
    });
  }
  return { entries: fromEntries.length, tasks: fromTasks };
}

export interface MemoryDump {
  sessionId: string;
  entries: SessionEntry[];
  tasks: TaskMemoryRecord[];
}

// Inspectable dump: plain JSON values only — entries plus task records,
// no opaque blobs. What JSON.stringify produces is the whole state.
export function dumpMemory(store: MemoryStore, sessionId: string): MemoryDump {
  checkId('session id', sessionId);
  const tasks: TaskMemoryRecord[] = [];
  for (const taskId of listTaskIds(store, sessionId)) {
    const record = readTaskMemory(store, sessionId, taskId);
    if (record !== undefined) tasks.push(record);
  }
  return {
    sessionId,
    entries: readSessionEntries(store, sessionId),
    tasks,
  };
}

export interface SoloMemory {
  sessionId: string;
  appendEntry(kind: SessionEntryKind, text: string): SessionEntry;
  entries(): SessionEntry[];
  writeTask(taskId: string, init: TaskMemoryInit): TaskMemoryRecord;
  readTask(taskId: string): TaskMemoryRecord | undefined;
  updateTask(taskId: string, patch: TaskMemoryPatch): TaskMemoryRecord;
  deleteTask(taskId: string): void;
  dump(): MemoryDump;
}

// Solo reduction (§28): solo mode is continuity plus in-conversation
// state — a single session with no fork or share paths. The facade pins
// one session id and exposes no multi-agent function, so solo code
// cannot reach fork even by accident.
export function openSoloMemory(
  store: MemoryStore,
  sessionId: string,
): SoloMemory {
  checkId('session id', sessionId);
  return {
    sessionId,
    appendEntry: (kind: SessionEntryKind, text: string): SessionEntry =>
      appendSessionEntry(store, sessionId, kind, text),
    entries: (): SessionEntry[] => readSessionEntries(store, sessionId),
    writeTask: (taskId: string, init: TaskMemoryInit): TaskMemoryRecord =>
      writeTaskMemory(store, sessionId, taskId, init),
    readTask: (taskId: string): TaskMemoryRecord | undefined =>
      readTaskMemory(store, sessionId, taskId),
    updateTask: (taskId: string, patch: TaskMemoryPatch): TaskMemoryRecord =>
      updateTaskMemory(store, sessionId, taskId, patch),
    deleteTask: (taskId: string): void =>
      deleteTaskMemory(store, sessionId, taskId),
    dump: (): MemoryDump => dumpMemory(store, sessionId),
  };
}

// Workspace and user lifetimes are documented not-supported-in-v1 stubs
// (§28): calling them fails explicitly instead of silently degrading.
export function openWorkspaceMemory(): never {
  throw new MemoryUnavailableError(
    'workspace memory is not supported in v1 (§28)',
  );
}

export function openUserMemory(): never {
  throw new MemoryUnavailableError('user memory is not supported in v1 (§28)');
}
