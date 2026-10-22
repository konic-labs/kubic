// The model and its thinking level: `/model`, `/escalate`, `/thinking`,
// `/scoped-models`, the model picker (Alt+M) and the thinking cycle (Alt+T).
import type { ModelSelection } from '@kubic/agent/model-select';
import { isThinkingLevel } from '@kubic/agent/models-config';
import type { ModelThinkingLevel } from '@kubic/agent/pi-boundary';
import { formatScopedModels } from '../../scoped-models.js';
import type { TuiContext } from '../context.js';
import { notImplemented, refuse, type TuiCommandTable } from './handler.js';
import {
  parseEscalateCommand,
  parseModelCommand,
  parseThinkingCommand,
  type TuiEscalateCommand,
  type TuiModelCommand,
  type TuiThinkingCommand,
} from './parse.js';

export const modelCommands: TuiCommandTable = {
  model: {
    lane: true,
    run(ctx, { prompt, busy }) {
      const command = parseModelCommand(prompt);
      if (command === undefined) return notImplemented(ctx, 'model');
      // A live switch is a conversation.configure: it never races a run.
      if (busy) {
        return refuse(ctx, 'model: finish the current turn before switching');
      }
      handleModelCommand(ctx, command);
      return 'accepted';
    },
  },
  // `/escalate <ref> [reason]` climbs the same
  // ladder as `/model` — the busy guard matches, since the climb is
  // a conversation.configure too.
  escalate: {
    lane: true,
    run(ctx, { prompt, busy }) {
      const command = parseEscalateCommand(prompt);
      if (command === undefined) return notImplemented(ctx, 'escalate');
      if (busy) {
        return refuse(
          ctx,
          'escalation: finish the current turn before climbing',
        );
      }
      handleEscalateCommand(ctx, command);
      return 'accepted';
    },
  },
  // `/thinking <level>` — same busy rule as `/model`: a
  // live switch never races a run.
  thinking: {
    lane: true,
    run(ctx, { prompt, busy }) {
      const command = parseThinkingCommand(prompt);
      if (command === undefined) return notImplemented(ctx, 'thinking');
      if (busy) {
        return refuse(
          ctx,
          'thinking: finish the current turn before switching',
        );
      }
      handleThinkingCommand(ctx, command);
      return 'accepted';
    },
  },
  'scoped-models': {
    run(ctx) {
      // The role's resolved allowed set: a
      // local read like `/session` — the loop reports, nothing is
      // sent, and a bare inspection never mutates the transcript
      // beyond the report row.
      const report = formatScopedModels(
        ctx.boot.scopedModels?.role,
        ctx.boot.scopedModels?.models,
      );
      ctx.app.appendNotice([report]);
      ctx.say(report);
      return 'accepted';
    },
  },
};

// `/model` never reaches the lane as a prompt. The report
// and the refusal are footer lines (the editor row's always-visible
// status surface); a successful switch updates the app's model label
// and leaves a confirmation behind.
function handleModelCommand(ctx: TuiContext, command: TuiModelCommand): void {
  if (ctx.turn === undefined) {
    ctx.say('model switch needs a live lane');
    return;
  }
  // A bare `/model` opens the picker (the way in where
  // Alt+M types `µ`, as macOS Option does).
  if (command.kind === 'pick') {
    openModelPicker(ctx);
    return;
  }
  if (command.kind === 'invalid') {
    ctx.say(`model switch failed: ${command.message}`);
    return;
  }
  switchModelTo(ctx, command.selection);
}

// `/escalate <ref> [reason]` — the explicit
// climb. Same busy guard and switch path as `/model`; the reason
// travels to the loop so the escalation event names it.
function handleEscalateCommand(
  ctx: TuiContext,
  command: TuiEscalateCommand,
): void {
  if (ctx.turn === undefined) {
    ctx.say('model switch needs a live lane');
    return;
  }
  if (command.kind === 'invalid') {
    ctx.say(`escalation failed: ${command.message}`);
    return;
  }
  switchModelTo(ctx, command.selection, command.reason);
}

// One switch path for `/model <id>`, the picker's Enter and the palette —
// the same footer wording and the same refusal text.
// Adds the reason: `/escalate <id> [reason]` records it
// in the escalation event; `/model` passes none (a silent climb).
// `thinking` is the level the model picker chose with the
// model; it is set once the switch (which re-clamps the old one) lands.
export function switchModelTo(
  ctx: TuiContext,
  selection: ModelSelection,
  reason?: string,
  thinking?: ModelThinkingLevel,
): void {
  const turn = ctx.turn;
  if (turn === undefined) {
    ctx.say('model switch needs a live lane');
    return;
  }
  ctx.say(`switching model to ${selection.provider}/${selection.id}…`);
  void turn
    .switchModel(selection, reason)
    .then(async (label) => {
      if (ctx.stopped) return;
      // The climb just recorded reports its
      // transcript row now — not on the next settled turn. The
      // drain is idempotent, so the turn drain later finds nothing.
      for (const row of ctx.boot.loop?.drainEscalationRows?.() ?? []) {
        ctx.app.appendNotice([row]);
      }
      // The new model may not accept images. The
      // attachments were validated against the OLD model, so they are
      // dropped rather than sent to a model that cannot take them.
      if (ctx.pendingImages.length > 0) {
        const loop = ctx.boot.loop;
        const supported = await loop?.supportsImages?.(loop.context);
        if (ctx.stopped) return;
        if (supported !== true) {
          const dropped = ctx.pendingImages.length;
          ctx.pendingImages = [];
          ctx.app.setPendingImages([]);
          ctx.app.setPendingAttachments(0);
          ctx.app.setEditorFooter(
            `model: ${label} (switched) · dropped ${dropped} attached image${dropped === 1 ? '' : 's'} — ${label} does not accept image input`,
          );
          ctx.screen?.render();
          return;
        }
      }
      ctx.app.setEditorFooter(`model: ${label} (switched)`);
      ctx.screen?.render();
      if (thinking !== undefined) {
        handleThinkingCommand(ctx, { kind: 'switch', level: thinking });
      }
    })
    .catch((error: unknown) => {
      if (ctx.stopped) return;
      ctx.app.setEditorFooter(
        `model switch failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      ctx.screen?.render();
    });
}

// `/thinking <level>` — report, switch (clamped by the lane
// to what the live model supports) or refuse an unknown level by name.
function handleThinkingCommand(
  ctx: TuiContext,
  command: TuiThinkingCommand,
): void {
  const turn = ctx.turn;
  if (turn === undefined) {
    ctx.say('thinking needs a live lane');
    return;
  }
  // A bare `/thinking` picks from the levels the live
  // model supports (Alt+T keeps cycling them).
  if (command.kind === 'pick') {
    openThinkingPicker(ctx);
    return;
  }
  if (command.kind === 'invalid') {
    ctx.say(`thinking: ${command.message}`);
    return;
  }
  const requested = command.level;
  void turn
    .switchThinking(requested)
    .then((effective) => {
      if (ctx.stopped) return;
      ctx.app.setEditorFooter(
        effective === requested
          ? `thinking: ${effective}`
          : `thinking: ${effective} (clamped from ${requested})`,
      );
      ctx.screen?.render();
    })
    .catch((error: unknown) => {
      if (ctx.stopped) return;
      ctx.app.setEditorFooter(
        `thinking switch failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      ctx.screen?.render();
    });
}

function openThinkingPicker(ctx: TuiContext): void {
  const runner = ctx.turn;
  if (runner === undefined) return;
  void Promise.all([runner.supportedThinking(), runner.liveThinking()])
    .then(([levels, live]) => {
      if (ctx.stopped) return;
      const opened = ctx.app.openPicker({
        title: 'Thinking',
        rows: levels.map((level) => ({
          value: level,
          label: level,
          ...(level === live ? { current: true } : {}),
        })),
        onSelect: (value) => {
          if (value !== live && isThinkingLevel(value)) {
            handleThinkingCommand(ctx, { kind: 'switch', level: value });
          } else {
            ctx.app.setEditorFooter(`thinking: ${live}`);
            ctx.screen?.render();
          }
        },
        onCancel: () => {
          if (ctx.stopped) return;
          ctx.app.setEditorFooter(`thinking: ${live} (picker cancelled)`);
          ctx.screen?.render();
        },
      });
      if (!opened) ctx.app.setEditorFooter(`thinking: ${live}`);
      ctx.screen?.render();
    })
    .catch((error: unknown) => {
      if (ctx.stopped) return;
      ctx.app.setEditorFooter(
        `thinking: ${error instanceof Error ? error.message : String(error)}`,
      );
      ctx.screen?.render();
    });
}

// Alt+T cycles the level over what the live model supports
// (thinking.cycle), committing each step through the same path.
export function cycleThinking(ctx: TuiContext): void {
  if (ctx.stopped) return;
  if (ctx.busy()) {
    ctx.app.setEditorFooter(
      'thinking: finish the current turn before switching',
    );
    ctx.screen?.render();
    return;
  }
  const turn = ctx.turn;
  if (turn === undefined) {
    ctx.say('thinking needs a live lane');
    return;
  }
  void (async () => {
    const [current, levels] = await Promise.all([
      turn.liveThinking(),
      turn.supportedThinking(),
    ]);
    if (levels.length === 0) {
      ctx.say('thinking: this model has no thinking levels');
      return;
    }
    const at = levels.indexOf(current);
    const next = levels[(at + 1) % levels.length] ?? levels[0];
    const effective = await turn.switchThinking(next);
    if (ctx.stopped) return;
    ctx.app.setEditorFooter(`thinking: ${effective}`);
    ctx.screen?.render();
  })().catch((error: unknown) => {
    if (ctx.stopped) return;
    ctx.app.setEditorFooter(
      `thinking switch failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    ctx.screen?.render();
  });
}

// Alt+M opens the picker over the usable catalog rows. The
// overlay owns the modal input; a pick goes through `switchModelTo`.
export function openModelPicker(ctx: TuiContext): void {
  if (ctx.stopped) return;
  if (ctx.busy()) {
    ctx.app.setEditorFooter('model: finish the current turn before switching');
    ctx.screen?.render();
    return;
  }
  // Captured: the callbacks below run after a `/new` may have replaced
  // the runner, and they must report the one this picker came from.
  const runner = ctx.turn;
  if (runner === undefined) {
    ctx.say('model switch needs a live lane');
    return;
  }
  void Promise.all([
    runner.listModels(),
    runner.listProviders(),
    runner.liveThinking().catch(() => undefined),
  ])
    .then(([rows, providers, thinking]) => {
      if (ctx.stopped) return;
      const opened = ctx.app.openModelPicker({
        rows: rows.map((row) => ({
          provider: row.provider,
          id: row.id,
          label: `${row.provider}/${row.id}`,
          current: row.current,
          ...(row.note === undefined ? {} : { note: row.note }),
          ...(row.contextWindow === undefined
            ? {}
            : { contextWindow: row.contextWindow }),
          ...(row.reasoning === undefined ? {} : { reasoning: row.reasoning }),
          ...(row.thinking === undefined ? {} : { thinking: row.thinking }),
        })),
        providers,
        ...(thinking === undefined ? {} : { thinking }),
        // Model and thinking level are one decision —
        // the level follows the switch (which re-clamps it), and is
        // set only when the operator moved it.
        onSelect: (row, level) => {
          const moved =
            level !== undefined && level !== thinking && isThinkingLevel(level);
          if (row.current === true) {
            if (moved) handleThinkingCommand(ctx, { kind: 'switch', level });
            else ctx.app.setEditorFooter(`model: ${runner.modelRef}`);
            ctx.render();
            return;
          }
          switchModelTo(
            ctx,
            { provider: row.provider, id: row.id },
            undefined,
            moved ? level : undefined,
          );
        },
        onCancel: () => {
          if (ctx.stopped) return;
          ctx.app.setEditorFooter(
            `model: ${runner.modelRef} (picker cancelled)`,
          );
          ctx.screen?.render();
        },
      });
      if (!opened) {
        ctx.app.setEditorFooter(
          'model picker unavailable on this terminal — use /model <provider/id>',
        );
      }
      ctx.render();
    })
    .catch((error: unknown) => {
      if (ctx.stopped) return;
      ctx.app.setEditorFooter(
        `model picker failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      ctx.screen?.render();
    });
}
