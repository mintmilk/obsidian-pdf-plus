# Changelog

PDF++ CE continues the version numbering of upstream PDF++, which stopped at `0.40.31`
(2025-08-30). Only changes made in this fork are listed here; for everything before
`0.41.0`, see [upstream's releases](https://github.com/RyotaUshio/obsidian-pdf-plus/releases).

## 0.41.0

First Community Edition release. Based on upstream `0.40.31`.

### Added

- **Lay the text layer out with the PDF's own fonts** (off by default, under Misc). The
  invisible text layer you select is laid out with a generic family — `getTextContent`
  reports `styles[fontName].fontFamily` as `font.fallbackName` — and only each item's total
  width is corrected, with `scaleX`. That pins the two ends of a line fragment and lets
  everything between them drift: on a page of a Nature paper by 5.72pt, close to a character
  and a half, so that dragging across `74.1%` selects `4.1%)`. The link is self-consistent;
  it just quotes text the pointer was never over.

  PDF.js already installs each embedded font as an `@font-face` rule named after its loaded
  name, which is exactly what a text item reports as its `fontName`. Naming that family on
  the node lays the text out in the metrics the page was set in, and leaves the layer
  otherwise untouched — one span, one text node, one line box. Placing the text directly
  from the per-character boxes in `item.chars` measures better still and drags much worse,
  because `.textLayer span { position: absolute }` is a descendant selector: any span added
  inside a node is out of flow, and a dragged pointer needs a line box to walk.

  Which font to use is measured, not assumed. A PDF.js font file is built to be drawn with
  rather than to lay text out with, and one whose character map does not answer to the text
  layer's characters makes things worse — an Elsevier paper's subset fonts left spaces and
  digits with no advance at all. Each font's character widths are compared against the PDF's
  own for the same text, and the PDF's font is used only where it is both under half a point
  out and better than the generic family.

  Mean drift 1.24pt → 0.21pt and mis-hitting characters 2093 → 32 on the Nature paper; the
  Elsevier paper is left exactly as it was. No elements added, one to three milliseconds a
  page. What it cannot correct is the spacing a PDF puts between individual glyphs to
  justify a line, which lives in the content stream rather than in any font.
  Offered upstream as [RyotaUshio/obsidian-pdf-plus#574](https://github.com/RyotaUshio/obsidian-pdf-plus/pull/574).
- A debug command, "Report text layer alignment for this page", which measures the text
  layer against the printed text with the option off and on. Every figure above comes from
  it.

### Fixed

- Rapid PDF scrolling now releases internal/external link handlers and annotation
  hover components when PDF.js discards their annotation layer, instead of keeping
  old page nodes until the whole PDF closes. Zooms that retain the layer keep working.
- Backlink redraws release page-level listeners and cleanup callbacks, avoid duplicate
  handlers on the same highlight, and replace old PDF render subscriptions after
  metadata updates instead of accumulating them for the lifetime of the viewer.
- Annotation deletion checks now use the PDF whose popup is being shown. The
  shared viewer patch no longer captures the first opened PDF after it closes,
  and another document's edit permissions cannot control the delete button.
- Completed one-time events, including paste tracking after copying PDF links, now
  release their callbacks and captured objects immediately. Pending events are also
  released when cancelled or when the plugin unloads.
- Settings input suggestions no longer retain old inputs through a document scroll
  listener on Obsidian 1.13. Suggestions close with their settings display, including
  when settings are rapidly hidden or rebuilt.
- Settings category icons remain clickable after reselecting or reopening the PDF++
  settings tab on Obsidian 1.13. Cleanup now runs before asynchronous saving, so an
  earlier close cannot remove the newly displayed page's listeners. Repeated settings
  refreshes also release old listeners and preserve the current scroll position.
- The settings tab is no longer cut short on Obsidian 1.13. Obsidian 1.13 renamed the
  Page preview plugin's per-source override record from `overrides` to `options`, so
  `requireModKeyForLinkHover()` threw a `TypeError`. Because `PDFPlusSettingTab.display()`
  is `async` and Obsidian does not await it, the failure surfaced only as an unhandled
  promise rejection and rendering stopped silently partway through — leaving just the
  first two section icons and nothing else.
  Fixes [#569](https://github.com/RyotaUshio/obsidian-pdf-plus/issues/569) and
  [#570](https://github.com/RyotaUshio/obsidian-pdf-plus/issues/570).
- Enabling the plugin with the Page preview core plugin turned off no longer throws while
  patching it.
- Links to a text selection no longer record a range wider than what was selected.
  Selecting `cis-h²` in a paper recorded `selection=227,15,231,40` — 15 and 40 being the
  full lengths of items 227 and 231, neither of which was selected — so the highlight
  covered a chunk of surrounding text.

  Two changes were needed. The offset helper located a range boundary by walking the text
  nodes and comparing them against the boundary's container, which assumes the boundary
  sits on a text node; it can just as well sit on an *element*, which is what the browser
  produces when a selection ends on the seam between two text layer nodes (superscripts are
  their own text item, so this is easy to hit) or when text is selected by double-clicking.
  The comparison then never matched, the walk ran to completion, and the function returned
  the node's entire text length. Boundaries are now measured with a range instead.

  That alone changed nothing, because the helper wasn't the one being called: PDF++ only
  overrode Obsidian's `getTextSelectionRangeStr` when the Obsidian version was exactly
  `1.8.0`, so on every other version the link came from Obsidian's own implementation, which
  contains the identical bug. The override is now applied unconditionally.
- Backlink highlights no longer swallow `mousedown`, which broke text selection over
  already-highlighted text. The highlights are now click-through, and the events they need
  (hover preview, backlink pane highlighting, double-click to open, context menu) are
  re-created by hit-testing the pointer position against the highlight rectangles.
  Offered upstream as [RyotaUshio/obsidian-pdf-plus#571](https://github.com/RyotaUshio/obsidian-pdf-plus/pull/571).
- Cropped PDF embeds honour the `width` parameter in Live Preview again, by
  @michalgregor ([#560](https://github.com/RyotaUshio/obsidian-pdf-plus/pull/560)).

### Changed

- A hover preview no longer appears while a mouse button is held down, so it can't pop up in
  the middle of a text-selection drag. (Follows from the fix above.)
- Plugin id is now `pdf-plus-ce` and the display name is `PDF++ CE`, so this installs
  alongside the original rather than replacing it. The settings schema is unchanged, so
  `data.json` can be copied over from `pdf-plus` in either direction.
