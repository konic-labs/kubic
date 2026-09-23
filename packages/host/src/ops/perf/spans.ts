// Dedicated worker.start span chain (issue #55; §49.3, §61).
// Opens kubic.agent.run→pi.harness.hook→pi.tool.execute→
// kubic.worker.start→rpc.client→rpc.server with strict parent linkage
// so startup ms is never misattributed to tools. Host-side recorder
// only — reuses the §29 SpanRecorder read-only, never imports worker
// implementation or Pi modules.

import type { SpanRecorder } from '../../spans.js';

export const WORKER_START_CHAIN = [
  'kubic.agent.run',
  'pi.harness.hook',
  'pi.tool.execute',
  'kubic.worker.start',
  'rpc.client',
  'rpc.server',
] as const;

export type WorkerStartSpanName = (typeof WORKER_START_CHAIN)[number];

export interface WorkerStartChainIds {
  run: string;
  hook: string;
  tool: string;
  start: string;
  rpcClient: string;
  rpcServer: string;
}

export function openWorkerStartChain(
  recorder: SpanRecorder,
): WorkerStartChainIds {
  const run = recorder.start('kubic.agent.run');
  const hook = recorder.start('pi.harness.hook', run);
  const tool = recorder.start('pi.tool.execute', hook);
  const start = recorder.start('kubic.worker.start', tool);
  const rpcClient = recorder.start('rpc.client', start);
  const rpcServer = recorder.start('rpc.server', rpcClient);
  return { run, hook, tool, start, rpcClient, rpcServer };
}

export function closeWorkerStartChain(
  recorder: SpanRecorder,
  ids: WorkerStartChainIds,
): void {
  recorder.end(ids.rpcServer);
  recorder.end(ids.rpcClient);
  recorder.end(ids.start);
  recorder.end(ids.tool);
  recorder.end(ids.hook);
  recorder.end(ids.run);
}
