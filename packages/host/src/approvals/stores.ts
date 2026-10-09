import { join } from 'node:path';
import { createNodeFileBridge } from '@kubic/exec/file-bridge';
import type { ApprovalVerdict } from './policy.js';

export interface ApprovalStore {
  load(): Record<string, ApprovalVerdict>;
  save(decisions: Record<string, ApprovalVerdict>): void;
}

export class MemoryApprovalStore implements ApprovalStore {
  private decisions: Record<string, ApprovalVerdict> = {};
  load(): Record<string, ApprovalVerdict> {
    return { ...this.decisions };
  }
  save(decisions: Record<string, ApprovalVerdict>): void {
    this.decisions = { ...decisions };
  }
}

// File-backed store: decisions + full-access posture live beside the
// session that scoped them, so a fresh session starts safe (no file →
// default deny posture). posture.json sits beside the session for the
// audit/doctor readers coming. Load is corrupt-tolerant;
// saves are atomic tmp+rename (races fail safe to deny on load).
export interface AccessPosture {
  fullAccess: boolean;
  enabledAt?: number;
  enabledBy?: string;
}

// Shape validation for the on-disk state. Load is
// corrupt-tolerant by contract — a file that PARSES but is the wrong shape
// (`null`, `[]`, `"x"`, `3`) must fall back to the documented safe default,
// never be cast and then crash the boot (`Object.entries(null)` in the
// service constructor, `.fullAccess` on null in installedPolicyPosture).
// Malformed INDIVIDUAL entries are dropped, not the whole file: one bad key
// must not erase every decision beside it. Each reader rebuilds the object
// field by field, so unknown keys never ride along.
function verdictFrom(value: unknown): ApprovalVerdict | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (record.approved === true) {
    if (typeof record.by !== 'string') return undefined;
    return {
      approved: true,
      by: record.by,
      // A malformed optional field is dropped, never fabricated: without
      // `justified: true` the service's requireJustification staleness rule
      // re-asks, which is the fail-safe direction.
      ...(typeof record.justified === 'boolean'
        ? { justified: record.justified }
        : {}),
    };
  }
  if (record.approved === false) {
    if (typeof record.reason !== 'string') return undefined;
    return { approved: false, reason: record.reason };
  }
  return undefined;
}

function decisionsFrom(value: unknown): Record<string, ApprovalVerdict> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {};
  }
  const out: Record<string, ApprovalVerdict> = {};
  for (const [key, entry] of Object.entries(value)) {
    const verdict = verdictFrom(entry);
    if (verdict !== undefined) out[key] = verdict;
  }
  return out;
}

function postureFrom(value: unknown): AccessPosture {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { fullAccess: false };
  }
  const record = value as Record<string, unknown>;
  // `true` exactly: `"yes"`, `1` and a missing field are all not a grant.
  if (record.fullAccess !== true) return { fullAccess: false };
  return {
    fullAccess: true,
    ...(typeof record.enabledAt === 'number' &&
    Number.isFinite(record.enabledAt)
      ? { enabledAt: record.enabledAt }
      : {}),
    ...(typeof record.enabledBy === 'string'
      ? { enabledBy: record.enabledBy }
      : {}),
  };
}

export class FileApprovalStore implements ApprovalStore {
  private readonly file: string;
  private readonly postureFile: string;

  constructor(dir: string) {
    this.file = join(dir, 'approvals.json');
    this.postureFile = join(dir, 'posture.json');
  }

  load(): Record<string, ApprovalVerdict> {
    const bridge = createNodeFileBridge('/');
    if (!bridge.exists(this.file)) return {};
    try {
      return decisionsFrom(JSON.parse(bridge.readTextFile(this.file)));
    } catch {
      return {};
    }
  }

  save(decisions: Record<string, ApprovalVerdict>): void {
    const bridge = createNodeFileBridge('/');
    const tmp = `${this.file}.${process.pid}.tmp`;
    // Approval state is private like the rest of the session dir.
    bridge.writeFile(tmp, JSON.stringify(decisions), { mode: 0o600 });
    try {
      bridge.renameFile(tmp, this.file);
    } catch (error) {
      try {
        bridge.remove(tmp, false, true);
      } catch {
        // Best-effort tmp cleanup; the original error is what matters.
      }
      throw error;
    }
  }

  loadPosture(): AccessPosture {
    const bridge = createNodeFileBridge('/');
    if (!bridge.exists(this.postureFile)) return { fullAccess: false };
    try {
      return postureFrom(JSON.parse(bridge.readTextFile(this.postureFile)));
    } catch {
      return { fullAccess: false };
    }
  }

  savePosture(posture: AccessPosture): void {
    const bridge = createNodeFileBridge('/');
    const tmp = `${this.postureFile}.${process.pid}.tmp`;
    // Posture state is private like the rest of the session dir.
    bridge.writeFile(tmp, JSON.stringify(posture), { mode: 0o600 });
    try {
      bridge.renameFile(tmp, this.postureFile);
    } catch (error) {
      // The same cleanup save() has: a failed rename must not
      // strand `posture.json.<pid>.tmp` beside the session.
      try {
        bridge.remove(tmp, false, true);
      } catch {
        // Best-effort tmp cleanup; the original error is what matters.
      }
      throw error;
    }
  }
}
