import { createHash } from 'node:crypto';
import { redactReason } from '@kubic/agent/lane/interceptors';
import type { ToolDisplay } from '@kubic/agent/ops/display-diff';
import { approvalCommandText, summarizeCommand } from './display.js';
import type { Capability } from './policy.js';

export interface ApprovalRequest {
  key: string;
  capability: Capability;
  toolName: string;
  summary: string;
  // The FULL command a bash call will run — derived from the
  // same args the key hashes, redacted and with hidden characters made
  // visible (approval-display.ts), never truncated. Absent for calls that
  // carry no command (file tools): their summary names the path.
  command?: string;
  justification?: string;
  // An edit or write ask's change against the file on disk (the
  // TUI card's diff preview). Absent when it could not be computed.
  preview?: ToolDisplay;
  // The answers this ask can take beyond allow and deny — the
  // command can be edited before it runs (a shell call), or the edits
  // of the rest of the turn approved at once (an edit/write a role's
  // obligation raised inside the workspace).
  editable?: boolean;
  batchable?: boolean;
}
// The comments and edited commands a seat may send, at most.
const APPROVAL_NOTE_MAX_CHARS = 500;
// The request fields an ask shows: the one-line summary and,
// for a bash call, the full command — both from the call's own args.
export function approvalRequestDisplay(
  toolName: string,
  capability: Capability,
  args: Record<string, unknown>,
): { summary: string; command?: string } {
  const summary = summarizeRequest(toolName, capability, args);
  return toolName === 'bash' && typeof args.command === 'string'
    ? { summary, command: approvalCommandText(args.command) }
    : { summary };
}

// Stable across restarts: the same dangerous op re-proposed after a crash
// maps to the same key, so a stored decision applies and the user is not
// re-asked. Tool-call ids are deliberately excluded — they change per run.
export function approvalKey(
  toolName: string,
  capability: Capability,
  args: Record<string, unknown>,
): string {
  const canonical = JSON.stringify(sortKeys(args));
  return createHash('sha256')
    .update(`${toolName}|${capability}|${canonical}`)
    .digest('hex')
    .slice(0, 16);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function summarizeRequest(
  toolName: string,
  capability: Capability,
  args: Record<string, unknown>,
): string {
  // Summaries reach the TUI and the trajectory: secret-shaped values are
  // redacted exactly like block reasons.
  if (toolName === 'bash' && typeof args.command === 'string') {
    // Never a silent slice — a shortened summary says how much
    // it hid; the full command travels in the request's `command` field.
    return summarizeCommand(capability, args.command);
  }
  if (typeof args.path === 'string') {
    return redactReason(`${capability}: ${toolName} ${args.path}`);
  }
  return `${capability}: ${toolName}`;
}

// How many times one call may be rewritten before it is refused
// (every rewrite is an operator's answer; the bound is a backstop).
export const MAX_APPROVAL_EDITS = 8;

// A seat's free text (a denial comment, a note) as the policy
// records and the model reads it: one line, bounded.
export function boundedNote(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  const max = APPROVAL_NOTE_MAX_CHARS + 64;
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}
