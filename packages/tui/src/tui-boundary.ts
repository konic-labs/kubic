// TUI presentation seam (issue #22).
// JUSTIFICATION:
//   seam: @earendil-works/pi-tui presentation components (VStack layout,
//     Text/ScrollView/Editor slots, TuiAltScreen, Terminal contract)
//   used by: packages/tui/src/* (all layout and views)
//   why Pi has no alternative: the terminal renderer, layout engine, and
//     input handling ARE Pi's presentation layer (§16); Kubic owns only
//     the arrangement and the data fed into slots
//   review: issue #22

export type {
  Component,
  EditorTheme,
  Focusable,
  MarkdownTheme,
  MouseRegionHandler,
  SelectListTheme,
  StackEntryOptions,
  Terminal,
  TUI,
} from '@earendil-works/pi-tui';
export {
  CURSOR_MARKER,
  Editor,
  Markdown,
  MouseRegion,
  matchesKey,
  ProcessTerminal,
  parseKey,
  ScrollView,
  Text,
  TuiAltScreen,
  truncateToWidth,
  VStack,
  visibleWidth,
  wrapTextWithAnsi,
} from '@earendil-works/pi-tui';
