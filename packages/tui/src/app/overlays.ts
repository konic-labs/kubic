// The overlays the app shows over the screen: one picker seat (the model
// picker, the generic list, the keys overlay) and the confirmation dialog.
// The palette shares the seat's geometry (palette-controller.ts).
import type {
  ApprovalOverlayHandle,
  ApprovalOverlayOptions,
} from '../approval-view.js';
import { approvalOverlayOptions } from '../approval-view.js';
import { keyCap } from '../chrome.js';
import { KEY_ACTIONS, type KeyAction } from '../keybindings.js';
import { sanitizeLaneText } from '../lane-cells.js';
import { PickerView } from '../picker-view.js';
import { tuiTheme } from '../theme.js';
import { type Component, truncateToWidth } from '../tui-boundary.js';
import { leftRight } from '../ui/line.js';
import { formatContextWindow } from '../ui/palette.js';
import type { PickerGroup } from '../ui/picker.js';
import type { AppCore } from './core.js';
import type {
  TuiConfirmOptions,
  TuiModelPickerOptions,
  TuiModelPickerProvider,
  TuiModelPickerRow,
  TuiPickerOptions,
} from './types.js';

// The palette is 80 cells wide, or 70% of a narrower terminal,
// and takes at most 70% of the rows.
const PALETTE_WIDTH = 80;
const PALETTE_WIDTH_PERCENT = 70;
export const PALETTE_HEIGHT_PERCENT = 70;

// Below this the overlay cannot composite (Pi's own visible() gate refuses),
// so the picker stays closed and the loop reports it on the footer.
const MODEL_PICKER_MIN_WIDTH = 60;

// The `?` overlay's groups, by action prefix.
const KEY_GROUPS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['editor', ['app.', 'prompt.', 'help.']],
  ['session', ['session.', 'model.', 'approvals.']],
  ['transcript', ['transcript.', 'view.']],
  ['panels', ['panel.']],
  ['approvals', ['approval.']],
];

// The thinking levels in order, for the picker's thinking row
// (a requested level the model lacks is clamped down to one it has).
const THINKING_ORDER = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

/** @internal */
export function clampThinking(
  level: string,
  supported: readonly string[],
): string {
  if (supported.length === 0 || supported.includes(level)) return level;
  const rank = THINKING_ORDER.indexOf(level);
  const below = supported.filter(
    (candidate) => THINKING_ORDER.indexOf(candidate) <= rank,
  );
  return below.at(-1) ?? supported[0] ?? level;
}

interface OpenPicker {
  readonly view: PickerView;
  // The model picker has its own hint row.
  readonly kind: 'model' | 'list';
  readonly handle: ApprovalOverlayHandle;
  readonly onCancel?: (() => void) | undefined;
}

interface OpenConfirm {
  readonly handle: ApprovalOverlayHandle;
  readonly options: TuiConfirmOptions;
}

export class OverlayController {
  private readonly core: AppCore;
  // The picker seat (at most one picker at a time).
  picker: OpenPicker | undefined;
  confirm: OpenConfirm | undefined;

  constructor(core: AppCore) {
    this.core = core;
  }

  // Pi neither composites nor focuses the overlay below
  // its minimum width, so a picker must not become a modal that swallows
  // keys with nothing on screen. `undefined` terminal (a fake host in the
  // overlay tests) keeps the picker usable.
  fits(): boolean {
    const columns = this.core.overlayHost?.terminal?.columns;
    return columns === undefined || columns >= MODEL_PICKER_MIN_WIDTH;
  }

  // Every "choose one" is a PickerView in the palette's box.
  maxRows(): number {
    return Math.max(
      6,
      Math.floor(
        ((this.core.overlayHost?.terminal?.rows ?? 30) *
          PALETTE_HEIGHT_PERCENT) /
          100,
      ),
    );
  }

  // 80 cells, or 70% of a narrower terminal; read per frame, so a resize
  // re-sizes it.
  paletteOptions(): ApprovalOverlayOptions {
    const core = this.core;
    return {
      get width(): number {
        const columns = core.overlayHost?.terminal?.columns ?? PALETTE_WIDTH;
        return Math.max(
          1,
          Math.min(
            PALETTE_WIDTH,
            Math.floor((columns * PALETTE_WIDTH_PERCENT) / 100),
          ),
        );
      },
      maxHeight: `${PALETTE_HEIGHT_PERCENT}%`,
      anchor: 'center',
      visible: (termWidth: number): boolean =>
        termWidth >= MODEL_PICKER_MIN_WIDTH,
    };
  }

  openPicker(options: TuiPickerOptions): boolean {
    if (this.core.overlayHost === undefined || !this.fits()) return false;
    const view = new PickerView({
      title: options.title ?? 'Choose',
      groups: [
        {
          id: 'rows',
          rows: options.rows.map((row) => ({
            value: row.value,
            text: sanitizeLaneText(row.label),
            ...(row.description === undefined
              ? {}
              : { right: sanitizeLaneText(row.description) }),
            ...(row.current === true ? { current: true } : {}),
            ...(row.disabled === true ? { disabled: true } : {}),
            ...(row.note === undefined ? {} : { note: row.note }),
          })),
        },
      ],
      maxRows: () => this.maxRows(),
      onSelect: (row) => {
        this.closePicker();
        options.onSelect(row.value);
      },
      onClose: () => this.closePicker(true),
      ...(options.onMove === undefined
        ? {}
        : { onMove: (row) => options.onMove?.(row?.value) }),
    });
    return this.showPicker(view, 'list', options.onCancel);
  }

  // The model picker — one group per provider
  // with where its key comes from, keyless providers greyed with what to
  // set, large providers folded, and the thinking row: ←→ steps the levels
  // the selected model supports, ⏎ takes model and level together.
  openModelPicker(options: TuiModelPickerOptions): boolean {
    if (this.core.overlayHost === undefined || !this.fits()) return false;
    const byValue = new Map<string, TuiModelPickerRow>(
      options.rows.map((row) => [`${row.provider}/${row.id}`, row]),
    );
    const liveThinking = options.thinking ?? 'off';
    let chosen = liveThinking;
    const levelsOf = (value: string | undefined): readonly string[] => {
      const row = value === undefined ? undefined : byValue.get(value);
      return row?.thinking ?? ['off'];
    };
    const view: PickerView = new PickerView({
      title: 'Model',
      groups: modelPickerGroups(options),
      maxRows: () => this.maxRows(),
      onSelect: (row) => {
        const picked = byValue.get(row.value);
        this.closePicker();
        if (picked === undefined) return;
        options.onSelect(picked, clampThinking(chosen, levelsOf(row.value)));
      },
      onClose: () => this.closePicker(true),
      onSide: (direction, row) => {
        const levels = levelsOf(row?.value);
        const at = levels.indexOf(clampThinking(chosen, levels));
        const next =
          levels[Math.min(levels.length - 1, Math.max(0, at + direction))];
        if (next !== undefined) chosen = next;
      },
      footer: (ui, row, width) => {
        const levels = levelsOf(row?.value);
        const shown = clampThinking(chosen, levels);
        const cells = levels.map((level) =>
          level === shown
            ? ui.style({ fg: 'fg0', bg: 'bg3' })(` ${level} `)
            : level === liveThinking
              ? ui.style({ fg: 'accent', bold: true })(level)
              : ui.fg('fg3')(level),
        );
        return [
          leftRight(
            `${ui.fg('fg2')(' thinking  ')}${cells.join('  ')}`,
            `${ui.fg('fg1')('←→')}${ui.fg('fg2')(' change ')}`,
            width,
          ),
        ];
      },
    });
    return this.showPicker(view, 'model', options.onCancel);
  }

  // `?` — every binding of the registry, grouped, with the key
  // it has now (a rebound key shows its own; an unbound one says so), and
  // the alt-screen's own transcript keys.
  openKeys(): boolean {
    const keys = this.core.keys;
    const groups: PickerGroup[] = KEY_GROUPS.map(([id, prefixes]) => ({
      id,
      title: id,
      rows: [
        ...(id === 'transcript'
          ? [
              {
                value: 'pageup',
                text: 'scroll the transcript a page',
                right: 'PgUp/PgDn',
              },
              {
                value: 'home',
                text: 'top / bottom of the transcript',
                right: 'Home/End',
              },
            ]
          : []),
        ...(Object.keys(KEY_ACTIONS) as KeyAction[])
          .filter((action) =>
            prefixes.some((prefix) => action.startsWith(prefix)),
          )
          .map((action) => {
            const cap = keyCap(keys.label(action));
            return {
              value: action,
              text: KEY_ACTIONS[action].description,
              right: cap === '' ? 'unbound' : cap,
            };
          }),
      ],
    }));
    const view = new PickerView({
      title: 'Keys',
      groups,
      maxRows: () => this.maxRows(),
      onSelect: () => this.closePicker(),
      onClose: () => this.closePicker(true),
    });
    return this.showPicker(view, 'list', undefined);
  }

  // The palette and the session list reuse the picker seat; this is the one
  // teardown.
  closePicker(notifyCancel = false): void {
    const open = this.picker;
    this.picker = undefined;
    if (open === undefined) return;
    try {
      open.handle.unfocus({ target: this.core.editor });
      open.handle.hide();
    } catch {
      // A torn-down overlay is already gone; the state above is the truth.
    }
    if (notifyCancel) open.onCancel?.();
  }

  // The confirmation dialog (the full-access toggle). False when this boot
  // has no overlay seat.
  openConfirm(options: TuiConfirmOptions): boolean {
    const host = this.core.overlayHost;
    if (host === undefined) return false;
    this.closeConfirm('cancel');
    const view: Component = {
      render: (width: number): string[] => renderConfirm(options, width),
      invalidate: (): void => {},
    };
    this.confirm = {
      handle: host.showOverlay(view, approvalOverlayOptions()),
      options,
    };
    host.requestRender?.();
    return true;
  }

  closeConfirm(verdict: 'confirm' | 'cancel'): void {
    const open = this.confirm;
    this.confirm = undefined;
    if (open === undefined) return;
    try {
      open.handle.unfocus({ target: this.core.editor });
      open.handle.hide();
    } catch {
      // A torn-down overlay is already gone; the state above is the truth.
    }
    if (verdict === 'confirm') open.options.onConfirm();
    else open.options.onCancel?.();
  }

  private showPicker(
    view: PickerView,
    kind: 'model' | 'list',
    onCancel: (() => void) | undefined,
  ): boolean {
    const host = this.core.overlayHost;
    if (host === undefined || !this.fits()) return false;
    this.closePicker();
    this.core.palette.close();
    this.picker = {
      view,
      kind,
      handle: host.showOverlay(view, this.paletteOptions()),
      onCancel,
    };
    host.requestRender?.();
    return true;
  }
}

// One group per provider: the live model's provider first, then the usable
// ones, keyless last.
function modelPickerGroups(options: TuiModelPickerOptions): PickerGroup[] {
  const providers: TuiModelPickerProvider[] = [...(options.providers ?? [])];
  for (const row of options.rows) {
    if (!providers.some((provider) => provider.id === row.provider)) {
      providers.push({ id: row.provider, usable: true });
    }
  }
  const live = options.rows.find((row) => row.current === true)?.provider;
  const rank = (provider: TuiModelPickerProvider): number =>
    provider.id === live ? 0 : provider.usable ? 1 : 2;
  const ordered = providers
    .map((provider, index) => ({ provider, index }))
    .sort((a, b) => rank(a.provider) - rank(b.provider) || a.index - b.index)
    .map((entry) => entry.provider);
  const right = (row: TuiModelPickerRow): string | undefined => {
    const parts = [
      row.contextWindow === undefined
        ? undefined
        : `${formatContextWindow(row.contextWindow)} ctx`,
      row.reasoning === true ? 'thinking' : undefined,
    ].filter((part): part is string => part !== undefined);
    return parts.length === 0 ? undefined : parts.join(' · ');
  };
  // Where a provider came from (built-in, models.json …), from its rows.
  const originOf = (provider: string): string | undefined =>
    options.rows.find((row) => row.provider === provider && row.note)?.note;
  return ordered.map((provider) => {
    const keyVar =
      provider.keyVar === undefined
        ? undefined
        : sanitizeLaneText(provider.keyVar);
    return {
      id: provider.id,
      title: sanitizeLaneText(provider.id).replaceAll('-', ' '),
      status: provider.usable
        ? {
            text:
              provider.keySource !== undefined
                ? `● key from ${sanitizeLaneText(provider.keySource)}`
                : `● ${sanitizeLaneText(originOf(provider.id) ?? 'ready')}`,
            ok: true,
          }
        : { text: '○ no key', ok: false },
      ...(provider.usable || keyVar === undefined
        ? {}
        : { right: `set ${keyVar}` }),
      unit: 'models',
      ...(provider.usable ? {} : { disabled: true }),
      rows: options.rows
        .filter((row) => row.provider === provider.id)
        .map((row) => {
          const detail = right(row);
          return {
            value: `${row.provider}/${row.id}`,
            text: sanitizeLaneText(row.id),
            match: sanitizeLaneText(`${row.provider}/${row.id}`),
            ...(row.current === true ? { current: true } : {}),
            ...(detail === undefined ? {} : { right: detail }),
          };
        }),
    };
  });
}

// The confirmation dialog's body. Presentation only — the app
// owns the keys, the loop owns what the verdict does.
function renderConfirm(options: TuiConfirmOptions, width: number): string[] {
  const theme = tuiTheme();
  const w = Math.max(1, width);
  return [
    theme.accentBold(truncateToWidth(options.title, w, '…')),
    ...options.body.map((line) => truncateToWidth(theme.muted(line), w, '…')),
    '',
    theme.dim(`[${options.confirmLabel}] confirm · [Esc] cancel`),
  ];
}
