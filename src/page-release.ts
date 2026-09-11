/**
 * PDF.js keeps the rendered canvases of the last ten pages of every viewer (a private `PDFPageViewBuffer(10)`),
 * whether or not they are still on screen, and whether or not the viewer itself is shown at all - a PDF in a
 * background tab keeps all ten. The canvases are GPU surfaces: on a 2x display at a zoom of 1.2 to 1.4 they are
 * 20 to 27 MiB each. Two PDF tabs and two pop-out windows kept about 850 MiB of canvases, and the GPU process
 * over 1.1 GiB, almost all of it for pages nobody was looking at.
 *
 * What is released here is what PDF.js would release anyway once a page falls out of that cache, only sooner:
 * - in a shown viewer, pages more than `offscreenPDFPageMargin` pages away from the visible ones, once
 *   scrolling and rendering have settled;
 * - in a viewer that is not shown at all (a background tab, a collapsed sidebar), every page, once it has
 *   been hidden for `releaseHiddenPDFPagesAfterSec` seconds.
 * PDF.js renders a released page again as soon as it becomes visible, exactly like an evicted one.
 */
import { Component, debounce } from 'obsidian';

import PDFPlus from 'main';
import { PDFPlusComponent } from 'lib/component';
import { PDFViewerChild } from 'typings';


/** PDF.js `RenderingStates.FINISHED`. */
const FINISHED = 3;

function isShown(child: PDFViewerChild): boolean {
    return child.containerEl.isShown();
}

/** Pages holding the current text selection keep their text layer, or the selection would be lost. */
function pagesWithSelection(child: PDFViewerChild): Set<number> {
    const pages = new Set<number>();
    const selection = child.containerEl.win.getSelection();
    if (!selection || selection.rangeCount === 0) return pages;
    const range = selection.getRangeAt(0);
    for (const node of [range.startContainer, range.endContainer]) {
        const el = node.instanceOf(HTMLElement) ? node : node.parentElement;
        const pageEl = el?.closest<HTMLElement>('.page[data-page-number]');
        if (pageEl && child.containerEl.contains(pageEl)) pages.add(+pageEl.dataset.pageNumber!);
    }
    return pages;
}

/**
 * @param margin Keep the pages within this many pages of the visible ones; `null` releases every page.
 * @returns The number of pages released.
 */
export function releaseRenderedPages(child: PDFViewerChild, margin: number | null): number {
    const viewer = child.pdfViewer?.pdfViewer;
    const pages = viewer?._pages;
    if (!viewer || !pages?.length) return 0;

    let first = Infinity;
    let last = -Infinity;
    if (margin !== null) {
        const visible = viewer._getVisiblePages().views;
        // Not laid out (yet): nothing to go by.
        if (!visible.length) return 0;
        // PDF.js pre-renders the next page in the scroll direction, and one more in spread modes.
        // Releasing those would only make it render them again.
        const around = Math.max(margin, viewer.spreadMode > 0 ? 2 : 1);
        for (const { id } of visible) {
            first = Math.min(first, id - around);
            last = Math.max(last, id + around);
        }
    }
    const selected = pagesWithSelection(child);

    let released = 0;
    for (const pageView of pages) {
        // A page still being rendered is left alone; it is looked at again the next time.
        if (pageView.renderingState !== FINISHED) continue;
        if ((first <= pageView.id && pageView.id <= last) || selected.has(pageView.id)) continue;
        pageView.destroy();
        released++;
    }
    return released;
}

/** Release the off-screen pages of a shown viewer after scrolling and rendering settle. */
export function registerOffscreenPageRelease(plugin: PDFPlus, child: PDFViewerChild, component: Component) {
    const eventBus = child.pdfViewer?.eventBus;
    if (!eventBus) return;
    const release = debounce(() => {
        const { settings } = plugin;
        if (!settings.releaseOffscreenPDFPages || child.unloaded || !isShown(child)) return;
        releaseRenderedPages(child, settings.offscreenPDFPageMargin);
    }, 1500, true);
    component.register(() => release.cancel());
    plugin.lib.registerPDFEvent('pagerendered', eventBus, component, () => release());
    plugin.lib.registerPDFEvent('updateviewarea', eventBus, component, () => release());
}

/** Release every page of viewers that have not been shown for a while: background tabs, collapsed sidebars. */
export class PDFPageReleaseManager extends PDFPlusComponent {
    private hiddenSince = new WeakMap<PDFViewerChild, number>();
    private released = new WeakSet<PDFViewerChild>();

    constructor(plugin: PDFPlus, private intervalMs = 15_000) {
        super(plugin);
    }

    onload() {
        const check = debounce(() => this.check(), 300, true);
        this.register(() => check.cancel());
        this.registerEvent(this.app.workspace.on('layout-change', check));
        this.registerEvent(this.app.workspace.on('active-leaf-change', check));
        this.registerInterval(window.setInterval(() => this.check(), this.intervalMs));
    }

    check(now = Date.now()) {
        const { settings } = this;
        const delay = settings.releaseHiddenPDFPagesAfterSec * 1000;
        const enabled = settings.releaseOffscreenPDFPages && delay > 0;
        this.lib.workspace.iteratePDFViewerComponents((component) => {
            // Read the child directly: `component.then()` would queue a callback on a viewer that is still loading.
            const child = component.child;
            if (!child || child.unloaded || !child.pdfViewer?.pdfViewer) return;
            if (isShown(child)) {
                this.hiddenSince.delete(child);
                // Shown again: render what is visible now instead of waiting for the next scroll or resize.
                if (this.released.delete(child)) child.pdfViewer.pdfViewer.update();
                return;
            }
            if (!enabled) return;
            const since = this.hiddenSince.get(child);
            if (since === undefined) this.hiddenSince.set(child, now);
            else if (now - since >= delay && releaseRenderedPages(child, null) > 0) this.released.add(child);
        });
    }
}
