// An orchestrator worker's tool facts (EPIC N, issue #464; docs/ui 04-C,
// 04-D): the child half of the live channel in
// packages/worker/src/lifecycle/facts.ts. Each tool call's start and end
// becomes one stdout line the manager follows — the tool, the one-line
// argument summary the progress lines print, an outcome and, for an edit or
// write, its display diff. Every text passes the worker's own secret
// redactor (the one approval summaries use) before it leaves the process;
// the raw arguments never do.

import type { WorkerToolActivity } from '../../../packages/core/src/presentation.js';
import type { RunToolSink } from '../../../packages/host/src/run-cli.js';
import {
  summarizeToolArguments,
  summarizeToolOutcome,
} from '../../../packages/tui/src/lane-cells.js';
import { redactSecrets } from '../../../packages/worker/src/lane/interceptors.js';
import { factLine } from '../../../packages/worker/src/lifecycle/facts.js';
import { resultDetails } from './run-progress.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface FactDisplay {
  readonly outcome: string;
  readonly diff: NonNullable<WorkerToolActivity['diff']>;
}

// Kubic's edit and write results carry a display record (tools-adapter.ts,
// issue #456): the change as rows `+12 text` / `-12 text` / ` 12 text`, or
// a written file's first rows.
function displayOf(entry: unknown): FactDisplay | undefined {
  const display = resultDetails(entry)?.display;
  if (!isRecord(display)) return undefined;
  if (
    display.kind === 'diff' &&
    typeof display.text === 'string' &&
    typeof display.added === 'number' &&
    typeof display.removed === 'number'
  ) {
    return {
      outcome: `+${display.added} −${display.removed}`,
      diff: {
        text: redactSecrets(display.text),
        ...(typeof display.firstChangedLine === 'number'
          ? { firstChangedLine: display.firstChangedLine }
          : {}),
      },
    };
  }
  if (
    display.kind === 'write' &&
    typeof display.lines === 'number' &&
    typeof display.preview === 'string'
  ) {
    const rows = display.preview === '' ? [] : display.preview.split('\n');
    return {
      outcome: `${display.newFile === true ? 'new file, ' : ''}${display.lines} line${display.lines === 1 ? '' : 's'}`,
      diff: {
        text: redactSecrets(
          rows.map((row, index) => `+${index + 1} ${row}`).join('\n'),
        ),
        firstChangedLine: 1,
      },
    };
  }
  return undefined;
}

export function createWorkerToolFacts(
  write: (line: string) => void,
  now: () => number = Date.now,
): RunToolSink {
  const targets = new Map<string, string>();
  const emit = (fact: WorkerToolActivity): void => {
    write(factLine(fact));
  };
  return {
    toolStart(event) {
      const target = redactSecrets(summarizeToolArguments(event.args));
      if (target !== '') targets.set(event.toolCallId, target);
      emit({
        id: event.toolCallId,
        tool: event.toolName,
        ...(target === '' ? {} : { target }),
        state: 'running',
        at: now(),
      });
    },
    toolEnd(event) {
      const target = targets.get(event.toolCallId);
      targets.delete(event.toolCallId);
      const summary = summarizeToolOutcome(event.entry, event.toolName);
      const failed =
        event.isError || (summary !== undefined && /^exit [1-9]/.test(summary));
      const display = failed ? undefined : displayOf(event.entry);
      const outcome = display?.outcome ?? summary;
      emit({
        id: event.toolCallId,
        tool: event.toolName,
        ...(target === undefined ? {} : { target }),
        state: failed ? 'error' : 'done',
        ...(outcome === undefined ? {} : { outcome: redactSecrets(outcome) }),
        ...(display === undefined ? {} : { diff: display.diff }),
        at: now(),
      });
    },
  };
}
