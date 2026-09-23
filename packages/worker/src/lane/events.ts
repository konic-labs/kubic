// Solo-lane harness event consumer (issue #11, slice B; §15, §15.3).
// Exactly one consumer subscribes to the harness, and only to the §15
// groups Kubic routes: run status, tool status, usage, faults. Everything
// else (message deltas, queue updates, compaction, navigation, config)
// stays inside Pi — Kubic defines no parallel event vocabulary. Events
// from other lanes never reach the sink.

import type {
  AgentLane,
  Context,
  Events,
  HarnessEvent,
  Usage,
  UsageRow,
} from '../pi-boundary.js';

export type KubicLaneEvent =
  | { type: 'run-start'; lane: string; runId: string; startedAt: number }
  | {
      type: 'run-end';
      lane: string;
      runId: string;
      status: 'completed' | 'aborted' | 'failed';
      endedAt: number;
      error?: unknown;
    }
  | {
      type: 'tool-start';
      lane: string;
      runId: string;
      turnId: string;
      toolCallId: string;
      toolName: string;
      args: unknown;
    }
  | {
      type: 'tool-end';
      lane: string;
      runId: string;
      turnId: string;
      toolCallId: string;
      toolName: string;
      isError: boolean;
      terminate: boolean;
    }
  | { type: 'usage'; lane: string; row: UsageRow; totals: Usage }
  | { type: 'fault'; code: string; message: string };

export type LaneEventSink = (event: KubicLaneEvent) => void;

export function toKubicLaneEvent(
  event: HarnessEvent,
  laneName: string,
): KubicLaneEvent | undefined {
  switch (event.type) {
    case 'run_start': {
      if (event.lane !== laneName) return undefined;
      return {
        type: 'run-start',
        lane: event.lane,
        runId: event.runId,
        startedAt: event.startedAt,
      };
    }
    case 'run_end': {
      if (event.lane !== laneName) return undefined;
      return {
        type: 'run-end',
        lane: event.lane,
        runId: event.runId,
        status: event.status,
        endedAt: event.endedAt,
        ...(event.status === 'failed' ? { error: event.error } : {}),
      };
    }
    case 'tool_start': {
      if (event.lane !== laneName) return undefined;
      return {
        type: 'tool-start',
        lane: event.lane,
        runId: event.runId,
        turnId: event.turnId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.args,
      };
    }
    case 'tool_end': {
      if (event.lane !== laneName) return undefined;
      return {
        type: 'tool-end',
        lane: event.lane,
        runId: event.runId,
        turnId: event.turnId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        isError: event.isError,
        terminate: event.terminate,
      };
    }
    case 'usage': {
      if (event.lane !== laneName) return undefined;
      return {
        type: 'usage',
        lane: event.lane,
        row: event.row,
        totals: event.totals,
      };
    }
    case 'fault': {
      return { type: 'fault', code: event.code, message: event.message };
    }
    default: {
      return undefined;
    }
  }
}

export interface EventSource {
  events: Events;
}

const SUBSCRIBED_TYPES = [
  'run_start',
  'run_end',
  'tool_start',
  'tool_end',
  'usage',
  'fault',
] as const;

export function attachLaneEvents(
  source: EventSource,
  laneName: string,
  sink: LaneEventSink,
): () => void {
  const detach: Array<() => void> = [];
  for (const type of SUBSCRIBED_TYPES) {
    detach.push(
      source.events.on(type, (event) => {
        const mapped = toKubicLaneEvent(event, laneName);
        if (mapped !== undefined) sink(mapped);
      }),
    );
  }
  return () => {
    for (const off of detach.splice(0)) off();
  };
}

// Gap-free watch primitive (§9.1): watch captures the lane snapshot;
// resnapshot re-reads it after a drop so a re-watch replays from the
// same snapshot instead of skipping entries.
export function watchLane(lane: Pick<AgentLane, 'watch'>, context: Context) {
  return lane.watch(context);
}
