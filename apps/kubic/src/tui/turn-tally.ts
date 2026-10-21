// One tui turn's own spend and tool errors, from its lane events: reset when
// a run is placed, read when it settles, for the telemetry export. Concurrent
// runs share it, as they share the tool spans.
import type { KubicLaneEvent } from '@kubic/agent/lane/events';

export class TurnTally {
  private startedAt = Date.now();
  private input = 0;
  private output = 0;
  private cacheRead = 0;
  private cacheWrite = 0;
  private costUsd = 0;
  private toolErrors = 0;

  observe(event: KubicLaneEvent): void {
    if (event.type === 'run-start') {
      this.startedAt = Date.now();
      this.input = 0;
      this.output = 0;
      this.cacheRead = 0;
      this.cacheWrite = 0;
      this.costUsd = 0;
      this.toolErrors = 0;
    }
    if (event.type === 'tool-end' && event.isError) this.toolErrors += 1;
    if (event.type === 'usage') {
      const usage = event.row.usage;
      this.input += usage.input;
      this.output += usage.output;
      this.cacheRead += usage.cacheRead;
      this.cacheWrite += usage.cacheWrite;
      this.costUsd += usage.cost?.total ?? 0;
    }
  }

  settled(): {
    startedAt: number;
    usage: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      costUsd: number;
    };
    toolErrors: number;
  } {
    return {
      startedAt: this.startedAt,
      usage: {
        input: this.input,
        output: this.output,
        cacheRead: this.cacheRead,
        cacheWrite: this.cacheWrite,
        costUsd: this.costUsd,
      },
      toolErrors: this.toolErrors,
    };
  }
}
