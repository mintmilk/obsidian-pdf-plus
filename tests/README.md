# PDF viewer and settings lifecycle regression tests

Run `npm test` after installing the repository's locked development dependencies.
The tests transpile the actual TypeScript modules with esbuild and exercise them with
small Component/EventBus/DOM owners, without requiring a running Obsidian instance.

Covered behavior:

- Persistent PDF.js listeners are removed with their viewer component.
- One-shot listeners are removed before async or reentrant dispatch, including failures.
- Unloading one component leaves other components' listeners intact.
- Link-like DOM handlers are registered on the PDF component instead of the plugin.
- Pending click/hover destination resolution cannot navigate after the PDF closes.
- Hiding a settings tab removes its click listeners before an asynchronous save,
  and completion of that save cannot unload a newly displayed tab.
- A failed settings save still leaves the hidden tab's listeners cleaned up.
- Conditional settings release their update subscriptions with the display component.
- Redisplaying settings preserves the outer container's scroll position.

For an integration regression, use an isolated vault and the same Obsidian installer,
application version, PDF, and settings for both builds. Warm up with two open/close
cycles, then run twenty cycles. Wait for page 1 to actually render before closing the
active PDF tab. At cycles 0/5/10/15/20, allow pending work to settle and collect garbage
before comparing retained JS heap, DOM nodes, listeners, plugin child components,
`update-dom` registrations and toolbar children. RSS alone is not a retained-object test.

Also verify that refreshing the toolbar ten times keeps a single toolbar owner,
disabling/re-enabling the plugin with a PDF open unloads and restores its resources,
and closing a large PDF during loading does not recreate owners later. A canceled
native `openFile` promise may remain pending; inspect live resources after a bounded
settling period rather than using promise settlement as the pass criterion.

For this fork, create a backlink to ordinary text (outside PDF link annotations),
then check drag selection through its highlight, selection-link range generation,
copy-event handling, and single hover/double-click/context-menu forwarding. Preserve
normal annotation hit targets while testing click-through highlights.

For settings integration coverage, open the plugin settings and click the already
active sidebar tab again before using the section icons. Repeat closing/reopening
the settings dialog and redisplaying a setting that rebuilds the page. Verify that
section navigation still scrolls, the display component remains loaded, and event
registrations do not grow across redisplays. Test internal setting links and scroll
position preservation in the same Obsidian version, since these use its settings DOM.
