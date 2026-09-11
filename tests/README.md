# PDF viewer and settings lifecycle regression tests

Run `npm test` after installing the repository's locked development dependencies.
The tests transpile the actual TypeScript modules with esbuild and exercise them with
small Component/EventBus/DOM owners, without requiring a running Obsidian instance.

Covered behavior:

- Discarding a native annotation layer releases internal/external link handlers,
  hover entry points and child components; retaining it during zoom preserves them.
- Delayed link destinations cannot navigate after their annotation layer is cancelled.
- Repeated annotation-layer rebuilds and backlink redraws keep cleanup ownership bounded.
- Backlink page cleanup matches capture options, isolates other pages and consumes
  callbacks once; repeated metadata updates replace the three PDF render listeners.
- Annotation delete buttons follow the current PDF's edit permissions even when
  the first PDF used to install the prototype patch has different permissions.
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
- Plugin-level one-time events release their owners before dispatch, including
  reentrant callbacks, failures, cancellation and plugin unload.
- Input suggestions remove document scroll listeners with the matching capture
  flag and close with their settings display owner.

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

Also exercise flows beyond opening and closing PDFs: complete paste-tracking events
whose callbacks capture a closed viewer and verify WeakRefs clear after GC. Leave
some events pending, then trigger, cancel or unload them; retaining a cancellation
handle must not retain a completed callback. For suggestions, repeatedly focus an
input and rebuild settings in the same window, checking the input's ownerDocument
rather than the main document. Old inputs and owners must be collected even when
display/hide/display occur before asynchronous descriptions finish rendering.

For scrolling regressions, traverse enough pages to exceed the native PDF.js page
buffer, then scroll back and repeat. Check viewer callbacks and the entire child
component tree after each pass, not only after closing the file. Also exercise links
and hover popups after a zoom that preserves the annotation layer. Compare a core-only
run at the same scale and canvas dimensions before attributing native/GPU memory peaks
to plugin listeners; record settled and post-GC samples separately.

The broader lifecycle audit also covers:

- PDF loading failures, cancellation, owned Blob URLs and temporary render canvases;
  successful borrowed documents and canvases remain owned by their callers.
- Cropped embed replacement, queued/in-flight cancellation, image-load listeners,
  and unloading plugin-owned embeds when the plugin is disabled.
- Per-file event owners on same-viewer reload, annotation Markdown popup owners,
  pending initialization, PageUp/PageDown bindings and page-sync debounce cancellation.
- Native context-menu IPC timeouts, failed/empty menus, and backlink pane load races.
- Modal reopen/close, repeated hover/rectangle selection, toolbar replacement,
  delayed settings rendering, native drag/drop and popout document listeners.
- Bibliography loading, cancelled AnyStyle processes including late spawn errors,
  command-owned temporary PDFs, live selection caches and bounded font verdicts.
- Deferred Dataview/UI results, auto-paste/sidebar waits and disabled or closed Vim
  helpers. These are source regressions, not full integrations of third-party services.
- Deferred static-image exports use weak page references: an unpasted historical
  copy must not keep a closed viewer alive, and a later matching paste can reload
  the PDF, generate the image and destroy its temporary document.
- Clipboard matching retains SHA-256 fingerprints instead of complete copied
  strings, including Base64 image embeds. Immediate and historical paste, line
  ending normalization, hashing failures and out-of-order completion are covered.
- Off-screen page release keeps the visible pages, their neighbours (two in spread
  modes, which PDF.js pre-renders), pages still rendering and pages holding the
  selection; hidden viewers are released only after the delay and re-rendered
  once when shown, and the manager never queues callbacks on loading viewers.
- Rectangle rendering allocates only the rectangle (rotated pages included) and
  keeps the export resolution. Rectangle embeds share one document per file and
  version, destroy it on failure, abort or plugin unload, clean up each page after
  rendering, revoke object URLs on replacement, unload and late completion, choose
  the display resolution within the old cap and a pixel budget, and re-render only
  when noticeably wider.
- Viewer unload removes only the Escape handler registered during its own load.
  The settings tab empties its page on hide.

Some tests use real garbage collection in a subprocess in addition to resource
counts. Keep Component doubles aligned with Obsidian's native unload order:
mark unloaded, unload children, run registered cleanups, then call `onunload`.
Always test the success path as well as cancellation to avoid fixing retention by
silently dropping requested work. Paste-history tracking intentionally retains
fingerprints and deferred tasks until the next paste or plugin unload; preserving
arbitrary clipboard history does not imply that this pending metadata has a fixed
size. It must not retain full copied images or their source PDF viewers.
