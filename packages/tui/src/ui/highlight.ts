// Syntax highlighting for fenced code.
//
// lowlight (highlight.js grammars) parses; this module maps the scopes onto a
// few calm token roles — keywords fg0 bold, strings add, numbers and literals
// warn, comments fg2 italic, titles info, types and attributes fg1 — so code
// reads without turning into a rainbow. It is the only importer of lowlight,
// and it loads it on demand: `loadHighlighter()` at TUI boot (36 ms the CLI's
// other commands never pay). Until then, past the size cap, for an unknown
// language or on any parse error, a block is plain fg1 — highlighting never
// throws into a render.

import type { Style, UiTheme } from '../../../core/src/ui/style.js';

/** Blocks past either bound render plain. */
export const HIGHLIGHT_MAX_LINES = 2000;
export const HIGHLIGHT_MAX_CHARS = 200_000;

interface HastText {
  readonly type: 'text';
  readonly value: string;
}

interface HastElement {
  readonly type: 'element';
  readonly properties?: { readonly className?: unknown };
  readonly children: readonly HastNode[];
}

type HastNode = HastText | HastElement | { readonly type: string };

interface Engine {
  registered(language: string): boolean;
  highlight(
    language: string,
    code: string,
  ): { readonly children: readonly HastNode[] };
}

let engine: Engine | undefined;
let loading: Promise<void> | undefined;

/** Load the grammars (once). Resolves even when they cannot load. */
export function loadHighlighter(): Promise<void> {
  loading ??= import('lowlight').then(
    ({ common, createLowlight }) => {
      engine = createLowlight(common) as unknown as Engine;
    },
    () => {
      // No highlighter: blocks stay plain.
    },
  );
  return loading;
}

export function highlighterReady(): boolean {
  return engine !== undefined;
}

// The innermost scope that names a role wins.
function scopeStyle(ui: UiTheme, classes: readonly string[]): Style {
  for (let index = classes.length - 1; index >= 0; index -= 1) {
    switch (classes[index]) {
      case 'hljs-comment':
      case 'hljs-quote':
        return ui.style({ fg: 'fg2', italic: true });
      case 'hljs-string':
      case 'hljs-regexp':
      case 'hljs-addition':
        return ui.fg('add');
      case 'hljs-deletion':
        return ui.fg('del');
      case 'hljs-number':
      case 'hljs-literal':
      case 'hljs-symbol':
      case 'hljs-bullet':
        return ui.fg('warn');
      case 'hljs-keyword':
      case 'hljs-selector-tag':
      case 'hljs-doctag':
      case 'hljs-section':
        return ui.style({ fg: 'fg0', bold: true });
      case 'hljs-title':
      case 'hljs-function':
        return ui.fg('info');
      case 'hljs-type':
      case 'hljs-built_in':
      case 'hljs-meta':
      case 'hljs-attr':
      case 'hljs-attribute':
      case 'hljs-variable':
      case 'hljs-params':
      case 'hljs-property':
      case 'hljs-tag':
      case 'hljs-name':
        return ui.fg('fg1');
      default:
        break;
    }
  }
  return ui.fg('fg0');
}

function classesOf(node: HastElement): string[] {
  const names = node.properties?.className;
  return Array.isArray(names)
    ? names.filter((name): name is string => typeof name === 'string')
    : [];
}

/** One styled string per source line (never throws). */
export function highlightCode(
  ui: UiTheme,
  code: string,
  language?: string,
): string[] {
  const lines = code.split('\n');
  if (!ui.enabled) return lines;
  const plain = (): string[] => lines.map((line) => ui.fg('fg1')(line));
  const name = (language ?? '').trim().toLowerCase();
  if (
    name === '' ||
    engine === undefined ||
    lines.length > HIGHLIGHT_MAX_LINES ||
    code.length > HIGHLIGHT_MAX_CHARS
  ) {
    return plain();
  }
  try {
    if (!engine.registered(name)) return plain();
    const tree = engine.highlight(name, code);
    const out = [''];
    const walk = (nodes: readonly HastNode[], classes: string[]): void => {
      for (const node of nodes) {
        if (node.type === 'text') {
          const style = scopeStyle(ui, classes);
          (node as HastText).value.split('\n').forEach((piece, index) => {
            if (index > 0) out.push('');
            if (piece !== '') out[out.length - 1] += style(piece);
          });
        } else if (node.type === 'element') {
          const element = node as HastElement;
          walk(element.children, [...classes, ...classesOf(element)]);
        }
      }
    };
    walk(tree.children, []);
    return out;
  } catch {
    return plain();
  }
}
