// A collector sink's durable spool. `write` appends the record to a private
// spool file (fsync'd) and returns — the record is safe from that moment —
// then a drain delivers the spooled records to the collector, oldest first,
// and removes what was delivered. A collector that is down keeps its records
// in the spool; the next record, the end of the command, or `kubic audit
// flush` drains them, so a down collector loses nothing.
//
// Each spool line carries a random id, and a drain removes exactly the ids it
// delivered: two processes draining one spool may deliver a record twice
// (delivery is at least once), but neither can remove a record the other
// appended meanwhile. Files go through the exec bridge; the spool is
// `0600` in a `0700` directory.

import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  createNodeFileBridge,
  updateFileLocked,
} from '@kubic/exec/file-bridge';
import { tightenStateDir } from '@kubic/exec/lock-file';
import type { AuditSink, OrgAuditRecord } from './audit.js';

const BATCH = 100;

interface SpoolDrain {
  readonly delivered: number;
  readonly pending: number;
  readonly error?: string;
}

export interface SpooledSink extends AuditSink {
  /** Delivers what is spooled; resolves once the spool is empty or a try failed. */
  drain(): Promise<SpoolDrain>;
  /** The records waiting in the spool. */
  pending(): number;
}

export interface SpooledSinkOptions {
  readonly name: string;
  readonly kind: AuditSink['kind'];
  // Names the collector: one spool file per identity.
  readonly identity: string;
  readonly spoolDir: string;
  readonly deliver: (records: readonly OrgAuditRecord[]) => Promise<void>;
  // A delivery failure (the record stays spooled).
  readonly onError?: (message: string) => void;
}

interface SpoolEntry {
  readonly id: string;
  readonly record: OrgAuditRecord;
}

/** The spool file of the collector named `identity`. */
function spoolPath(spoolDir: string, identity: string): string {
  return join(
    spoolDir,
    `${createHash('sha256').update(identity).digest('hex').slice(0, 32)}.jsonl`,
  );
}

function entriesOf(text: string): SpoolEntry[] {
  const entries: SpoolEntry[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const parsed = JSON.parse(line) as Partial<SpoolEntry>;
      if (typeof parsed.id === 'string' && typeof parsed.record === 'object') {
        entries.push(parsed as SpoolEntry);
      }
    } catch {
      // A torn line from a crash mid-append: never delivered half.
    }
  }
  return entries;
}

export function createSpooledSink(options: SpooledSinkOptions): SpooledSink {
  const files = createNodeFileBridge('/');
  const path = spoolPath(options.spoolDir, options.identity);
  let draining: Promise<SpoolDrain> | undefined;
  const read = (): SpoolEntry[] => {
    try {
      return entriesOf(files.readTextFile(path));
    } catch {
      return [];
    }
  };
  const remove = (ids: ReadonlySet<string>): void => {
    updateFileLocked(
      path,
      (current) =>
        (current ?? '')
          .split('\n')
          .filter((line) => {
            if (line.trim() === '') return false;
            try {
              return !ids.has((JSON.parse(line) as SpoolEntry).id);
            } catch {
              return true;
            }
          })
          .map((line) => `${line}\n`)
          .join(''),
      { mode: 0o600 },
    );
  };
  const drainOnce = async (): Promise<SpoolDrain> => {
    let delivered = 0;
    for (;;) {
      const batch = read().slice(0, BATCH);
      if (batch.length === 0) return { delivered, pending: 0 };
      try {
        await options.deliver(batch.map((entry) => entry.record));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        options.onError?.(message);
        return { delivered, pending: read().length, error: message };
      }
      remove(new Set(batch.map((entry) => entry.id)));
      delivered += batch.length;
    }
  };
  const drain = (): Promise<SpoolDrain> => {
    draining ??= drainOnce().finally(() => {
      draining = undefined;
    });
    return draining;
  };
  return {
    name: options.name,
    kind: options.kind,
    write: (record: OrgAuditRecord): void => {
      files.createDir(options.spoolDir, true, 0o700);
      tightenStateDir(options.spoolDir);
      const line = `${JSON.stringify({ id: randomUUID(), record })}\n`;
      if (files.appendDurably !== undefined) {
        files.appendDurably(path, line, { mode: 0o600 });
      } else {
        files.appendFile(path, line, { mode: 0o600 });
      }
      // Delivery runs after the synchronous write: the record is already
      // safe, and a failure only leaves it spooled.
      void drain();
    },
    drain,
    pending: () => read().length,
  };
}
