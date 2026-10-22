// `kubic sessions export <id>`: one session as a document to share for a
// review or a postmortem — its prompts, answers and tool calls, the audit
// rows the session wrote (approval decisions, posture changes, gate commands)
// and the change journal's summary, as Markdown or as one self-contained HTML
// page.
//
// Everything in the document passes the persisted-text redactor first (key
// shapes, PEM blocks, URL userinfo, authorization values, secret-named
// assignments), and control characters are stripped, so neither a secret a
// tool read nor an escape sequence a model wrote reaches the reader. Long tool
// output is cut with a marker. The session is read without its lock and
// nothing is written; a session a live run holds is refused, like every other
// reader that must not open a storage a running process owns.

import { join } from 'node:path';
import {
  readSessionMetadata,
  SESSION_ID_PATTERN,
  sessionLockIsLive,
} from '@kubic/agent/lane/session-store';
import {
  entriesToTranscript,
  readSessionEntries,
  type TranscriptItem,
} from '@kubic/agent/lane/transcript';
import { BACKGROUND_CONTEXT } from '@kubic/agent/pi-boundary';
import {
  type CommandResult,
  EXIT_FAILED,
  EXIT_OK,
  EXIT_USAGE,
} from '@kubic/core/cli/exit-codes';
import { redactSecrets } from '@kubic/core/secret-shapes';
import { FileJournalStore, type JournalEntry } from '@kubic/exec/journal';
import { FileApprovalStore } from '../approvals/index.js';
import type { OrgAuditRecord } from '../audit/index.js';
import { auditLedgerDirFor, readAuditLedger } from '../audit/index.js';
import { type CliIo, diagnosticsOf } from '../cli/index.js';
import { openReadOnlySessionStorage } from './session-read.js';
import {
  readSessionUsage,
  type SessionUsageTotals,
  totalSessionUsage,
} from './session-usage.js';

export type SessionExportFormat = 'md' | 'html';

// Tool output past these bounds is cut: an export is read by a person.
const OUTPUT_MAX_LINES = 200;
const OUTPUT_MAX_CHARS = 16 * 1024;
const ARGS_MAX_CHARS = 4 * 1024;

export function parseSessionExportFormat(value: string): SessionExportFormat {
  if (value === 'md' || value === 'html') return value;
  throw new Error(`expected md or html, got ${JSON.stringify(value)}`);
}

interface ExportedChange {
  readonly path: string;
  readonly change: string;
  readonly bytes: number;
  readonly by: string;
  readonly contested: boolean;
}

interface ExportedAudit {
  readonly when: string;
  readonly what: string;
  readonly permission: string;
  readonly approval: string;
  readonly result: string;
  readonly reason: string;
}

/** @internal */
export interface SessionDocument {
  readonly id: string;
  readonly workspace: string | undefined;
  readonly createdAt: string | undefined;
  readonly mode: string | undefined;
  readonly posture: string;
  readonly models: readonly string[];
  readonly usage: SessionUsageTotals;
  readonly items: readonly TranscriptItem[];
  readonly audit: readonly ExportedAudit[];
  readonly changes: readonly ExportedChange[];
}

// Terminal control sequences (OSC, CSI in its 7- and 8-bit forms, any other
// escape) and the remaining control characters except tab and newline: a
// model or a tool can write them, and an export is read in a terminal too.
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
const OSC_SEQUENCE = /\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
const CSI_SEQUENCE = /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
const ESC_SEQUENCE = /\u001b[ -/]*[0-~]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

// Redacted and stripped: the one gate every exported string passes.
function clean(text: string): string {
  return redactSecrets(
    text
      .replace(OSC_SEQUENCE, '')
      .replace(CSI_SEQUENCE, '')
      .replace(ESC_SEQUENCE, '')
      .replace(/\r\n/g, '\n')
      .replace(CONTROL, ''),
  );
}

function cut(text: string, maxLines: number, maxChars: number): string {
  const lines = text.split('\n');
  let kept = lines.slice(0, maxLines).join('\n');
  if (kept.length > maxChars) kept = kept.slice(0, maxChars);
  if (kept.length === text.length) return text;
  const left = text.length - kept.length;
  return `${kept}\n[cut: ${left} more character${left === 1 ? '' : 's'}]`;
}

function argsText(args: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(args, null, 2) ?? String(args);
  } catch {
    text = String(args);
  }
  return cut(clean(text), Number.MAX_SAFE_INTEGER, ARGS_MAX_CHARS);
}

/** @internal */
export function cleanItem(item: TranscriptItem): TranscriptItem {
  switch (item.kind) {
    case 'user':
      return { ...item, text: clean(item.text) };
    case 'assistant':
      return {
        ...item,
        text: clean(item.text),
        toolCalls: item.toolCalls.map((call) => ({
          id: call.id,
          name: clean(call.name),
          args: argsText(call.args),
        })),
      };
    case 'tool-result':
      return {
        ...item,
        name: clean(item.name),
        text: cut(clean(item.text), OUTPUT_MAX_LINES, OUTPUT_MAX_CHARS),
      };
    default:
      return item.text === undefined
        ? item
        : { ...item, text: clean(item.text) };
  }
}

// The journal's summary: one row per path, the newest change winning, the
// byte deltas summed. Markers (a moved HEAD) are not file changes.
function changesOf(entries: readonly JournalEntry[]): ExportedChange[] {
  const byPath = new Map<string, ExportedChange>();
  for (const entry of [...entries].sort((a, b) => a.timestamp - b.timestamp)) {
    if (entry.op === 'marker') continue;
    const previous = byPath.get(entry.path);
    byPath.set(entry.path, {
      path: clean(entry.path),
      change: entry.op,
      bytes: (previous?.bytes ?? 0) + entry.bytesDelta,
      by:
        entry.source === 'tool'
          ? (entry.toolName ?? 'tool')
          : entry.source === 'undo'
            ? 'undo'
            : 'found after the run',
      contested:
        (previous?.contested ?? false) || (entry.contested?.length ?? 0) > 0,
    });
  }
  return [...byPath.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
}

function auditOf(
  records: readonly OrgAuditRecord[],
  id: string,
): ExportedAudit[] {
  return records
    .filter((record) => record.agent.session === id)
    .map((record) => ({
      when: record.when,
      what: clean(record.what),
      permission: clean(record.permission.permission),
      approval: clean(record.permission.approval),
      result: record.result,
      reason: clean(record.reason),
    }));
}

function readAudit(workspace: string | undefined): OrgAuditRecord[] {
  if (workspace === undefined) return [];
  try {
    return readAuditLedger(auditLedgerDirFor(workspace));
  } catch {
    return [];
  }
}

async function readSessionDocument(
  sessionsRoot: string,
  id: string,
): Promise<SessionDocument> {
  const storage = await openReadOnlySessionStorage(sessionsRoot, id);
  try {
    const meta = await readSessionMetadata(storage, BACKGROUND_CONTEXT);
    const entries = await readSessionEntries(storage, BACKGROUND_CONTEXT, {
      history: 'all',
    });
    const items = entriesToTranscript(entries)
      .filter((item) => item.kind !== 'system')
      .map(cleanItem);
    const models = [
      ...new Set(
        items.flatMap((item) =>
          item.kind === 'assistant' &&
          item.provider !== undefined &&
          item.model !== undefined
            ? [`${item.provider}/${item.model}`]
            : [],
        ),
      ),
    ];
    const usage = totalSessionUsage(
      await readSessionUsage(storage, BACKGROUND_CONTEXT),
    );
    const workspace = meta?.workspace ?? meta?.cwd;
    const posture = new FileApprovalStore(join(sessionsRoot, id)).loadPosture();
    return {
      id,
      workspace: workspace === undefined ? undefined : clean(workspace),
      createdAt: meta?.createdAt,
      mode: meta?.mode,
      posture: posture.fullAccess ? 'full access' : 'approvals enforced',
      models,
      usage,
      items,
      audit: auditOf(readAudit(workspace), id),
      changes: changesOf(
        new FileJournalStore(join(sessionsRoot, id, 'journal')).entries(),
      ),
    };
  } finally {
    await storage.close(BACKGROUND_CONTEXT);
  }
}

// --- Markdown ---------------------------------------------------------------

// A fence longer than any backtick run inside, so the content cannot close it.
function fenced(text: string, info = ''): string {
  const longest = Math.max(
    2,
    ...[...text.matchAll(/`+/g)].map((run) => run[0].length),
  );
  const fence = '`'.repeat(longest + 1);
  return `${fence}${info}\n${text}\n${fence}`;
}

function mdCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim() || ' ';
}

function usageLine(usage: SessionUsageTotals): string {
  return `${usage.input} input, ${usage.output} output, ${usage.cacheRead} cache-read tokens; $${usage.costUsd.toFixed(4)}`;
}

function mdItem(item: TranscriptItem): string[] {
  switch (item.kind) {
    case 'user':
      return ['### User', '', item.text, ''];
    case 'assistant': {
      const model =
        item.provider === undefined || item.model === undefined
          ? ''
          : ` · ${item.provider}/${item.model}`;
      const lines = [`### Assistant${model}`, ''];
      if (item.text.trim() !== '') lines.push(item.text, '');
      for (const call of item.toolCalls) {
        lines.push(
          `Tool call \`${call.name}\`:`,
          '',
          fenced(String(call.args), 'json'),
          '',
        );
      }
      return lines;
    }
    case 'tool-result':
      return [
        `#### Result of \`${item.name}\`${item.isError ? ' (error)' : ''}`,
        '',
        fenced(item.text),
        '',
      ];
    case 'compaction':
      return [
        '> Context compacted.',
        ...(item.text === undefined ? [] : ['', fenced(item.text)]),
        '',
      ];
    case 'reset':
      return ['> Context reset.', ''];
    case 'system':
      return [];
  }
}

/** @internal */
export function renderSessionMarkdown(doc: SessionDocument): string {
  const lines = [
    `# Kubic session ${doc.id}`,
    '',
    `- Workspace: ${doc.workspace ?? '(unknown)'}`,
    `- Started: ${doc.createdAt ?? '(unknown)'}`,
    ...(doc.mode === undefined ? [] : [`- Mode: ${doc.mode}`]),
    `- Approvals: ${doc.posture}`,
    `- Models: ${doc.models.length === 0 ? '(none)' : doc.models.join(', ')}`,
    `- Usage: ${usageLine(doc.usage)}`,
    '',
    'Secrets are redacted throughout this export.',
    '',
    '## Conversation',
    '',
    ...(doc.items.length === 0
      ? ['No messages.', '']
      : doc.items.flatMap(mdItem)),
    '## Audit',
    '',
  ];
  if (doc.audit.length === 0) {
    lines.push('No audit rows for this session.', '');
  } else {
    lines.push(
      '| When | What | Permission | Approval | Result | Reason |',
      '| --- | --- | --- | --- | --- | --- |',
      ...doc.audit.map(
        (row) =>
          `| ${mdCell(row.when)} | ${mdCell(row.what)} | ${mdCell(row.permission)} | ${mdCell(row.approval)} | ${mdCell(row.result)} | ${mdCell(row.reason)} |`,
      ),
      '',
    );
  }
  lines.push('## Changes', '');
  if (doc.changes.length === 0) {
    lines.push('The change journal recorded no file changes.', '');
  } else {
    lines.push(
      '| File | Change | Bytes | By |',
      '| --- | --- | --- | --- |',
      ...doc.changes.map(
        (row) =>
          `| ${mdCell(row.path)} | ${row.change}${row.contested ? ' (contested)' : ''} | ${row.bytes >= 0 ? '+' : ''}${row.bytes} | ${mdCell(row.by)} |`,
      ),
      '',
      `\`kubic diff --session ${doc.id}\` shows the full diff.`,
      '',
    );
  }
  return `${lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()}\n`;
}

// --- HTML -------------------------------------------------------------------

function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STYLE = `:root{color-scheme:light dark;--bg:#fff;--fg:#1d1d1f;--muted:#6e6e73;--line:#d2d2d7;--card:#f5f5f7;--user:#e8f0fe;--err:#b3261e}
@media (prefers-color-scheme:dark){:root{--bg:#161617;--fg:#f5f5f7;--muted:#a1a1a6;--line:#3a3a3c;--card:#1f1f21;--user:#1c2a40;--err:#f2b8b5}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 system-ui,sans-serif}
main{max-width:920px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:22px}h2{margin-top:36px;border-bottom:1px solid var(--line);padding-bottom:6px}
dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 16px;color:var(--muted)}dd{margin:0;color:var(--fg)}
.msg{border:1px solid var(--line);border-radius:10px;padding:10px 14px;margin:12px 0;background:var(--card)}
.msg.user{background:var(--user)}.role{font-weight:600;font-size:13px;color:var(--muted);margin-bottom:6px}
.text{white-space:pre-wrap;overflow-wrap:anywhere}
pre{background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:10px;overflow-x:auto;font:12.5px/1.45 ui-monospace,monospace;white-space:pre-wrap;overflow-wrap:anywhere}
.error .role{color:var(--err)}
table{border-collapse:collapse;width:100%;font-size:13px;display:block;overflow-x:auto}
th,td{border:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}
.note{color:var(--muted)}`;

function htmlItem(item: TranscriptItem): string {
  switch (item.kind) {
    case 'user':
      return `<div class="msg user"><div class="role">User</div><div class="text">${esc(item.text)}</div></div>`;
    case 'assistant': {
      const model =
        item.provider === undefined || item.model === undefined
          ? ''
          : ` · ${esc(`${item.provider}/${item.model}`)}`;
      const calls = item.toolCalls
        .map(
          (call) =>
            `<div class="role">Tool call <code>${esc(call.name)}</code></div><pre>${esc(String(call.args))}</pre>`,
        )
        .join('');
      const text =
        item.text.trim() === ''
          ? ''
          : `<div class="text">${esc(item.text)}</div>`;
      return `<div class="msg"><div class="role">Assistant${model}</div>${text}${calls}</div>`;
    }
    case 'tool-result':
      return `<div class="msg${item.isError ? ' error' : ''}"><div class="role">Result of <code>${esc(item.name)}</code>${item.isError ? ' (error)' : ''}</div><pre>${esc(item.text)}</pre></div>`;
    case 'compaction':
      return `<p class="note">Context compacted.</p>${item.text === undefined ? '' : `<pre>${esc(item.text)}</pre>`}`;
    case 'reset':
      return '<p class="note">Context reset.</p>';
    case 'system':
      return '';
  }
}

function htmlTable(
  headers: readonly string[],
  rows: readonly string[][],
): string {
  return `<table><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows
    .map(
      (row) =>
        `<tr>${row.map((cell) => `<td>${esc(cell)}</td>`).join('')}</tr>`,
    )
    .join('')}</tbody></table>`;
}

/** @internal */
export function renderSessionHtml(doc: SessionDocument): string {
  const facts: Array<[string, string]> = [
    ['Workspace', doc.workspace ?? '(unknown)'],
    ['Started', doc.createdAt ?? '(unknown)'],
    ...(doc.mode === undefined ? [] : [['Mode', doc.mode] as [string, string]]),
    ['Approvals', doc.posture],
    ['Models', doc.models.length === 0 ? '(none)' : doc.models.join(', ')],
    ['Usage', usageLine(doc.usage)],
  ];
  const audit =
    doc.audit.length === 0
      ? '<p class="note">No audit rows for this session.</p>'
      : htmlTable(
          ['When', 'What', 'Permission', 'Approval', 'Result', 'Reason'],
          doc.audit.map((row) => [
            row.when,
            row.what,
            row.permission,
            row.approval,
            row.result,
            row.reason,
          ]),
        );
  const changes =
    doc.changes.length === 0
      ? '<p class="note">The change journal recorded no file changes.</p>'
      : `${htmlTable(
          ['File', 'Change', 'Bytes', 'By'],
          doc.changes.map((row) => [
            row.path,
            `${row.change}${row.contested ? ' (contested)' : ''}`,
            `${row.bytes >= 0 ? '+' : ''}${row.bytes}`,
            row.by,
          ]),
        )}<p class="note"><code>kubic diff --session ${esc(doc.id)}</code> shows the full diff.</p>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kubic session ${esc(doc.id)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>Kubic session ${esc(doc.id)}</h1>
<dl>${facts.map(([key, value]) => `<dt>${esc(key)}</dt><dd>${esc(value)}</dd>`).join('')}</dl>
<p class="note">Secrets are redacted throughout this export.</p>
<h2>Conversation</h2>
${doc.items.length === 0 ? '<p class="note">No messages.</p>' : doc.items.map(htmlItem).join('\n')}
<h2>Audit</h2>
${audit}
<h2>Changes</h2>
${changes}
</main>
</body>
</html>
`;
}

// --- The command --------------------------------------------------------------

export async function runSessionExportCommand(
  invocation: { readonly id: string; readonly format?: SessionExportFormat },
  deps: CliIo,
  sessionsRoot: string,
): Promise<CommandResult> {
  const log = diagnosticsOf(deps);
  const { id } = invocation;
  if (!SESSION_ID_PATTERN.test(id)) {
    log.error('invalid session id');
    return { exitCode: EXIT_USAGE };
  }
  const holder = sessionLockIsLive(join(sessionsRoot, id));
  if (holder !== undefined) {
    log.error(
      `session ${id} is in use by a live run (pid ${holder.pid}) — export it once the run ends`,
    );
    return { exitCode: EXIT_FAILED };
  }
  let doc: SessionDocument;
  try {
    doc = await readSessionDocument(sessionsRoot, id);
  } catch (error) {
    log.error(error instanceof Error ? error.message : String(error));
    return { exitCode: EXIT_FAILED };
  }
  deps.out(
    (invocation.format ?? 'md') === 'html'
      ? renderSessionHtml(doc).trimEnd()
      : renderSessionMarkdown(doc).trimEnd(),
  );
  return { exitCode: EXIT_OK };
}
