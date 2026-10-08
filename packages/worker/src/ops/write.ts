// Write operation.
// Atomic via tmp+rename over the seam: readers never see a partial file.
// replay:"never" — writes are effects, never re-executed on replay.

import { readPreImage, replaceFile } from './atomic-file.js';
import { displayDiff, writeDisplay } from './display-diff.js';
import { sha256Hex } from './hash.js';
import type { OpContext, Operation, ToolInvocation } from './types.js';
import { OpError } from './types.js';

export interface WriteArgs {
  path: string;
  content: string;
}

export interface WriteResult {
  path: string;
  beforeHash: string | null;
  afterHash: string;
  bytesDelta: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateWriteArgs(raw: unknown): WriteArgs {
  if (!isRecord(raw))
    throw new OpError('invalid_args', 'write args must be an object');
  for (const key of Object.keys(raw)) {
    if (key !== 'path' && key !== 'content') {
      throw new OpError(
        'invalid_args',
        `write: unknown argument "${key}" (strict sampling)`,
      );
    }
  }
  if (typeof raw.path !== 'string' || raw.path.length === 0) {
    throw new OpError('invalid_args', 'write: path must be a non-empty string');
  }
  if (typeof raw.content !== 'string') {
    throw new OpError('invalid_args', 'write: content must be a string');
  }
  return { path: raw.path, content: raw.content };
}

export const writeOperation: Operation<WriteArgs, WriteResult> = {
  name: 'write',
  description:
    'Create or overwrite a file with its complete content, atomically (tmp + rename); returns before/after hashes. Use edit to change part of a file.',
  replay: 'never',
  validateArgs: validateWriteArgs,
  execute: async (_inv: ToolInvocation, args: WriteArgs, ctx: OpContext) => {
    const pre = readPreImage(ctx, args.path);
    const result = {
      path: args.path,
      beforeHash: pre.hash,
      afterHash: sha256Hex(args.content),
      bytesDelta: Buffer.byteLength(args.content, 'utf8') - pre.bytes,
    };
    replaceFile(ctx, 'write', args.path, args.content, pre, {
      op: pre.exists ? 'write' : 'create',
      // Binary pre-image: hash-only (undo reports it non-reversible
      // rather than restoring mangled bytes).
      before: pre.text,
      ...(pre.text === null && pre.hash !== null
        ? { beforeHash: pre.hash, beforeOmitted: true }
        : {}),
      after: args.content,
      bytesDelta: result.bytesDelta,
    });
    // A new file shows its size and first lines; an overwritten
    // text file shows the diff (a binary pre-image cannot).
    if (ctx.display !== undefined) {
      const lf = (text: string): string => text.replace(/\r\n/g, '\n');
      if (pre.exists && pre.text !== null) {
        const diff = displayDiff(lf(pre.text), lf(args.content));
        if (diff !== undefined) ctx.display(diff);
      } else {
        ctx.display(writeDisplay(lf(args.content), !pre.exists));
      }
    }
    return result;
  },
};
