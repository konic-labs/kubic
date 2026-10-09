// The ^P palette. The app builds the command and file rows and owns what
// they do in the editor; models and sessions come from the composition root
// after the palette is up.
import type { ApprovalOverlayHandle } from '../approval-view.js';
import { keyCap } from '../chrome.js';
import { mentionFor } from '../file-mentions.js';
import { sanitizeLaneText } from '../lane-cells.js';
import { PaletteView } from '../palette-view.js';
import {
  findSlashCommand,
  parseKnownSlashCommand,
  SLASH_COMMANDS,
} from '../slash-commands.js';
import {
  formatAge,
  PALETTE_FILES_MAX,
  PALETTE_GROUP_ROWS,
  type PaletteItem,
  paletteModelMeta,
} from '../ui/palette.js';
import type { AppCore } from './core.js';
import { PALETTE_HEIGHT_PERCENT } from './overlays.js';
import type {
  TuiPaletteModel,
  TuiPaletteSession,
  TuiPaletteSources,
} from './types.js';

interface OpenPalette {
  readonly view: PaletteView;
  readonly handle: ApprovalOverlayHandle;
  readonly sources: TuiPaletteSources;
}

export class PaletteController {
  private readonly core: AppCore;
  current: OpenPalette | undefined;
  // The commands this session ran, most recent first — what
  // the palette offers before anything is typed.
  private readonly recentCommands: string[] = [];
  private readonly models = new Map<string, TuiPaletteModel>();

  constructor(core: AppCore) {
    this.core = core;
  }

  noteRecentCommand(prompt: string): void {
    const parsed = parseKnownSlashCommand(prompt);
    if (parsed === undefined) return;
    const recent = this.recentCommands;
    const at = recent.indexOf(parsed.name);
    if (at !== -1) recent.splice(at, 1);
    recent.unshift(parsed.name);
    recent.length = Math.min(recent.length, PALETTE_GROUP_ROWS);
  }

  // False when this boot has no overlay seat or the terminal is too narrow
  // (the loop says so).
  open(sources: TuiPaletteSources): boolean {
    const { core } = this;
    const host = core.overlayHost;
    if (host === undefined || !core.overlays.fits()) return false;
    core.overlays.closePicker();
    this.close();
    let items: PaletteItem[] = this.commandItems();
    const view = new PaletteView({
      items,
      keyLabel: keyCap(core.keys.label('app.palette')),
      maxRows: () =>
        Math.max(
          6,
          Math.floor(
            ((host.terminal?.rows ?? 30) * PALETTE_HEIGHT_PERCENT) / 100,
          ),
        ),
      onRun: (item) => this.run(item, sources),
      onClose: () => this.close(true),
    });
    this.current = {
      view,
      handle: host.showOverlay(view, core.overlays.paletteOptions()),
      sources,
    };
    // The rows that take a read arrive after the first frame: a slow model
    // catalog, session store or file walk never holds the palette up.
    const add = (more: readonly PaletteItem[]): void => {
      if (this.current?.view !== view || more.length === 0) return;
      items = [...items, ...more];
      view.setItems(items);
      host.requestRender?.();
    };
    void sources
      .models?.()
      .then((rows) => add(rows.map((row) => this.modelItem(row))))
      .catch(() => {});
    void sources
      .sessions?.()
      .then((rows) => add(rows.map(sessionItem)))
      .catch(() => {});
    const files = setTimeout(() => add(this.fileItems()), 0);
    files.unref?.();
    host.requestRender?.();
    return true;
  }

  close(notifyCancel = false): void {
    const open = this.current;
    this.current = undefined;
    if (open === undefined) return;
    try {
      open.handle.unfocus({ target: this.core.editor });
      open.handle.hide();
    } catch {
      // A torn-down overlay is already gone; the state above is the truth.
    }
    if (notifyCancel) open.sources.onCancel?.();
    this.core.requestRender();
  }

  // The registry's commands, the recent ones first (in the order they ran),
  // each with the key the registry has bound now.
  private commandItems(): PaletteItem[] {
    const recent = this.recentCommands;
    const keys = this.core.keys;
    const rank = (name: string): number => {
      const at = recent.indexOf(name);
      return at === -1 ? recent.length : at;
    };
    return [...SLASH_COMMANDS]
      .sort((a, b) => rank(a.name) - rank(b.name))
      .map((spec) => {
        const key =
          spec.keyAction === undefined
            ? ''
            : keyCap(keys.label(spec.keyAction));
        return {
          group: 'commands' as const,
          value: `/${spec.name}`,
          text: `/${spec.name}`,
          detail: spec.summary,
          ...(key === '' ? {} : { meta: key }),
          ...(recent.includes(spec.name) ? { recent: true } : {}),
        };
      });
  }

  private modelItem(model: TuiPaletteModel): PaletteItem {
    const value = `${model.provider}/${model.id}`;
    this.models.set(value, model);
    return {
      group: 'models',
      value,
      text: sanitizeLaneText(value),
      ...(model.current ? { current: true } : {}),
      meta: paletteModelMeta(model.contextWindow, model.reasoning),
    };
  }

  private fileItems(): PaletteItem[] {
    return (this.core.seed.listFiles?.() ?? [])
      .slice(0, PALETTE_FILES_MAX)
      .map((path) => ({
        group: 'files',
        value: path,
        text: sanitizeLaneText(path),
        meta: '@ insert',
      }));
  }

  private run(item: PaletteItem, sources: TuiPaletteSources): void {
    const { editor } = this.core;
    this.close();
    switch (item.group) {
      case 'commands': {
        const spec = findSlashCommand(item.value.slice(1));
        // A command that needs its argument goes to the editor to finish
        // (`/image `); the rest run as if typed.
        if (spec !== undefined && /<[^>]+>/u.test(spec.usage)) {
          const head = (spec.usage.split(' ')[0] ?? item.value).replace(
            /<[^>]+>$/u,
            '',
          );
          const draft = editor.getText();
          editor.setText(
            head.endsWith(':') ? `${head}${draft}` : `${head} ${draft}`,
          );
        } else {
          this.noteRecentCommand(item.value);
          sources.runCommand(item.value);
        }
        break;
      }
      case 'models': {
        const model = this.models.get(item.value);
        if (model !== undefined)
          sources.switchModel?.(model.provider, model.id);
        break;
      }
      case 'sessions':
        sources.resumeSession?.(item.value);
        break;
      case 'files':
        editor.insertText(`${mentionFor(item.value)} `);
        break;
    }
    this.core.requestRender();
  }
}

function sessionItem(session: TuiPaletteSession): PaletteItem {
  const created =
    session.createdAt === undefined
      ? Number.NaN
      : Date.parse(session.createdAt);
  const meta = [
    Number.isNaN(created) ? undefined : formatAge(Date.now() - created),
    session.turns === undefined
      ? undefined
      : `${session.turns} turn${session.turns === 1 ? '' : 's'}`,
  ].filter((part): part is string => part !== undefined);
  return {
    group: 'sessions',
    value: session.id,
    text: sanitizeLaneText(session.title ?? session.id),
    ...(meta.length === 0 ? {} : { meta: meta.join(' · ') }),
  };
}
