// The provider and model checks: availability, context windows, and the room
// a window leaves after compaction.

import {
  DEFAULT_RESERVE_TOKENS,
  KEEP_RECENT_TOKENS,
  roomAfterCompaction,
} from '@kubic/agent/compaction';
import type {
  ContextRoomProbe,
  DoctorCheck,
  DoctorReason,
  DoctorStatus,
  ModelWindowProbe,
  ProviderProbe,
  RoomModel,
} from '../types.js';

export function providerChecks(probes: ProviderProbe[]): DoctorCheck[] {
  return probes.map((probe) => {
    const count = probe.models?.length ?? 0;
    // Honesty: a provider that was never dialled must not
    // be reported as reachable. The default line states listed-vs-dialled
    // plainly; a probe that supplies its own detail keeps it (that is where
    // a real dial's outcome, or a real failure, is named).
    const listed = probe.dialled === true ? 'dialled' : 'listed, not dialled';
    if (probe.reachable) {
      return {
        id: `provider:${probe.id}`,
        label: `provider ${probe.id}`,
        status: 'pass' as DoctorStatus,
        reason: 'ok' as DoctorReason,
        detail: probe.detail ?? `${listed}, ${count} model(s) registered`,
      };
    }
    return {
      id: `provider:${probe.id}`,
      label: `provider ${probe.id}`,
      status: 'fail' as DoctorStatus,
      reason: 'provider-down' as DoctorReason,
      detail: probe.detail ?? `${listed} — unreachable`,
    };
  });
}

// A model on the fallback window is a warning, never a failure: it runs, but
// the gauge and the compaction threshold use a window the model may not have.
// The detail names the key that declares the real one.
export function modelWindowChecks(
  probes: readonly ModelWindowProbe[],
): DoctorCheck[] {
  return probes.map((probe) => ({
    id: `models-window:${probe.provider}/${probe.model}`,
    label: `model ${probe.provider}/${probe.model} window`,
    status: 'warn' as DoctorStatus,
    reason: 'window-default' as DoctorReason,
    detail: `window ${probe.contextWindow} is the default: set "contextWindow" for ${probe.model} in models.json (the gauge and compaction use it)`,
  }));
}

// The room a compaction leaves below this many estimated tokens means the next
// exchange compacts again: compaction then runs every turn or two.
const MIN_ROOM_AFTER_COMPACTION = 4096;

// One warn-only check for the models the user can configure: the models in
// models.json and the default model the configuration selects. A built-in model
// is never named. A healthy set is one pass line; nothing in scope, no check.
export function roomChecks(probe: ContextRoomProbe): DoctorCheck[] {
  const customKeys = new Set(probe.customModels.map(modelKey));
  const defaultIsCustom =
    probe.defaultModel !== undefined &&
    customKeys.has(modelKey(probe.defaultModel));
  const scope = [
    ...probe.customModels.map((model) => ({ model, custom: true })),
    ...(probe.defaultModel === undefined || defaultIsCustom
      ? []
      : [{ model: probe.defaultModel, custom: false }]),
  ];
  if (scope.length === 0) return [];
  const label = 'context room after a compaction';
  const rooms = scope.map(({ model, custom }) => ({
    name: modelKey(model),
    window: model.contextWindow,
    room: roomAfterCompaction(
      model.contextWindow,
      probe.reserveTokens ?? DEFAULT_RESERVE_TOKENS,
      probe.keepRecentTokens ?? KEEP_RECENT_TOKENS,
    ),
    custom,
  }));
  const short = rooms.filter((room) => room.room < MIN_ROOM_AFTER_COMPACTION);
  if (short.length === 0) {
    return [
      {
        id: 'context-room',
        label,
        status: 'pass' as DoctorStatus,
        reason: 'ok' as DoctorReason,
        detail: `every model you can configure keeps at least ${MIN_ROOM_AFTER_COMPACTION} estimated tokens of room after a compaction`,
      },
    ];
  }
  const names = short
    .map(
      (room) =>
        `${room.name} (window ${room.window}, about ${room.room} tokens of room)`,
    )
    .join('; ');
  const fixes: string[] = [];
  const custom = short.filter((room) => room.custom).map((room) => room.name);
  if (custom.length > 0) {
    fixes.push(
      `set "contextWindow" in models.json for ${custom.join(', ')} to the model's real window`,
    );
  }
  const chosen = short.filter((room) => !room.custom).map((room) => room.name);
  if (chosen.length > 0) {
    fixes.push(
      `for the default model ${chosen.join(', ')}, choose one with a larger window (kubic setup, or [model] in configuration), or offer it fewer tools (\`[policy] denied_tools\`)`,
    );
  }
  return [
    {
      id: 'context-room',
      label,
      status: 'warn' as DoctorStatus,
      reason: 'room-short' as DoctorReason,
      detail: `${names}: below ${MIN_ROOM_AFTER_COMPACTION} tokens, so compaction will run every turn or two. Fix: ${fixes.join('; ')}.`,
    },
  ];
}

function modelKey(model: RoomModel): string {
  return `${model.provider}/${model.model}`;
}

export function probeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
