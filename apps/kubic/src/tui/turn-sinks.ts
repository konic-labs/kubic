// What a settled TUI turn leaves behind: its spans next to the headless
// artifact, its export to the OpenTelemetry collector, and the run-end hooks
// (a settled turn is the interactive run end). None of them fails a turn.

import { join } from 'node:path';
import { runRunEndHooks } from '@kubic/host/hooks';
import { type SettledTurnSpans, TurnSpans } from '@kubic/host/run';
import {
  approvalCounts,
  exportRunTelemetry,
  type TelemetryTarget,
} from '@kubic/host/telemetry';
import type { SessionBoot } from '../session/bootstrap.js';
import type { TuiRunOptions } from './options.js';
import type { TuiLaneBoot } from './types.js';

// Where a turn's warnings land: the transcript notices.
interface TurnNotices {
  readonly transcript: string[];
}

// Per-turn spans next to the headless artifact — the
// session's spans.jsonl carries one run span per TUI turn plus its
// tool spans. Best-effort: telemetry never fails a turn or a boot.
export function turnSpans(
  boot: SessionBoot,
  id: string,
  options: Pick<TuiRunOptions, 'telemetry' | 'hooks'>,
  notices: TurnNotices,
): TuiLaneBoot['turnSpans'] {
  const { telemetry, hooks } = options;
  return {
    turns: new TurnSpans(id),
    write: (artifact, turn): void => {
      try {
        boot.bridge.appendFile(join(id, 'spans.jsonl'), artifact, {
          mode: 0o600,
        });
      } catch {
        // A failed artifact write is not a turn failure.
      }
      if (telemetry !== undefined && turn !== undefined) {
        void exportTurn(telemetry, boot, id, turn, notices);
      }
      // A settled turn is the interactive run end.
      const workspace = boot.env?.cwd;
      if (
        hooks !== undefined &&
        turn !== undefined &&
        workspace !== undefined
      ) {
        void runRunEndHooks(
          hooks,
          { status: turnFailed(turn) ? 'failed' : 'completed' },
          {
            sessionId: id,
            workspace,
            model: boot.liveModelRef,
            onAuditError: (line) =>
              notices.transcript.push(`warning: audit: ${line}`),
          },
        );
      }
    },
  };
}

function turnFailed(turn: SettledTurnSpans): boolean {
  return turn.spans.some(
    (span) => span.parentId === null && span.error !== undefined,
  );
}

// One settled turn to the OpenTelemetry collector; a collector that does not
// answer is a transcript warning, never a turn failure.
async function exportTurn(
  target: TelemetryTarget,
  boot: SessionBoot,
  id: string,
  turn: SettledTurnSpans,
  notices: TurnNotices,
): Promise<void> {
  const [provider, ...model] = boot.liveModelRef.split('/');
  const failures = await exportRunTelemetry(target, {
    sessionId: id,
    status: turnFailed(turn) ? 'failed' : 'completed',
    ...(provider === undefined || model.length === 0
      ? {}
      : { model: { provider, id: model.join('/') } }),
    spans: turn.spans,
    usage: turn.usage,
    toolErrors: turn.toolErrors,
    approvals: approvalCounts(id, boot.env?.cwd, turn.startedAt),
    startedAt: turn.startedAt,
    endedAt: Date.now(),
  });
  for (const failure of failures) {
    notices.transcript.push(`warning: telemetry: not exported: ${failure}`);
  }
}
