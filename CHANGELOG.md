# Changelog

PDF++ CE continues the version numbering of upstream PDF++, which stopped at `0.40.31`
(2025-08-30). Only changes made in this fork are listed here; for everything before
`0.41.0`, see [upstream's releases](https://github.com/RyotaUshio/obsidian-pdf-plus/releases).

## 0.41.0

First Community Edition release. Based on upstream `0.40.31`.

### Fixed

- Backlink highlights no longer swallow `mousedown`, which broke text selection over
  already-highlighted text. The highlights are now click-through, and the events they need
  (hover preview, backlink pane highlighting, double-click to open, context menu) are
  re-created by hit-testing the pointer position against the highlight rectangles.
  Offered upstream as [RyotaUshio/obsidian-pdf-plus#571](https://github.com/RyotaUshio/obsidian-pdf-plus/pull/571).

### Changed

- A hover preview no longer appears while a mouse button is held down, so it can't pop up in
  the middle of a text-selection drag. (Follows from the fix above.)
- Plugin id is now `pdf-plus-ce` and the display name is `PDF++ CE`, so this installs
  alongside the original rather than replacing it. The settings schema is unchanged, so
  `data.json` can be copied over from `pdf-plus` in either direction.
