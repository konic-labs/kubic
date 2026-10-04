// TUI presentation seam (issue #22).
// JUSTIFICATION:
//   seam: @earendil-works/pi-tui presentation components (VStack layout,
//     Text/ScrollView/Editor slots, TuiAltScreen, Terminal contract, the
//     editor's autocomplete contract of issue #305)
//   used by: packages/tui/src/* (all layout and views)
//   why Pi has no alternative: the terminal renderer, layout engine, and
//     input handling ARE Pi's presentation layer (§16); Kubic owns only
//     the arrangement and the data fed into slots
//   review: issue #22

export type {
  AutocompleteItem,
  AutocompleteProvider,
  AutocompleteSuggestions,
  Component,
  EditorTheme,
  Focusable,
  MarkdownTheme,
  MouseRegionHandler,
  SelectItem,
  SelectListTheme,
  StackEntryOptions,
  Terminal,
  TUI,
} from '@earendil-works/pi-tui';
// JUSTIFICATION:
//   seam: @earendil-works/pi-tui values (Editor, Markdown, ScrollView, Text,
//     VStack, TuiAltScreen, ProcessTerminal, SelectList, key helpers, width
//     helpers)
//   used by: packages/tui/src/* (the rendered views, the `/model` picker
//     overlay of issue #328, and the headless snapshot tests; issue #403
//     re-verifies them on pi-tui 1.0.2)
//   why Pi has no alternative: these are the upstream implementations of the
//     layout and render primitives above; Kubic re-implementing them would
//     fork terminal handling, wrapping and key parsing (§16)
//   review: issue #197 (folded into #391)
export {
  CURSOR_MARKER,
  Editor,
  isKeyRelease,
  isKeyRepeat,
  Markdown,
  MouseRegion,
  matchesKey,
  ProcessTerminal,
  parseKey,
  ScrollView,
  SelectList,
  Text,
  TuiAltScreen,
  truncateToWidth,
  VStack,
  visibleWidth,
  wrapTextWithAnsi,
} from '@earendil-works/pi-tui';
