import { Component } from 'obsidian';

import { PDFPlusLibSubmodule } from 'lib/submodule';
import { PDFPageView, PDFViewerChild, Rect } from 'typings';


/** Adding text highlight in PDF viewers without writing into files */
export class ViewerHighlightLib extends PDFPlusLibSubmodule {
    private pendingHighlights = new WeakMap<PDFViewerChild, Component>();
    private pendingRectScrolls = new WeakMap<PDFViewerChild, Component>();

    getPDFPlusBacklinkHighlightLayer(pageView: PDFPageView): HTMLElement {
        const pageDiv = pageView.div;
        return pageDiv.querySelector<HTMLElement>('div.pdf-plus-backlink-highlight-layer')
            ?? pageDiv.createDiv('pdf-plus-backlink-highlight-layer', (layerEl) => {
                window.pdfjsLib.setLayerDimensions(layerEl, pageView.viewport);
            });
    }

    placeRectInPage(rect: Rect, page: PDFPageView) {
        const viewBox = page.pdfPage.view;
        const pageX = viewBox[0];
        const pageY = viewBox[1];
        const pageWidth = viewBox[2] - viewBox[0];
        const pageHeight = viewBox[3] - viewBox[1];

        const mirroredRect = window.pdfjsLib.Util.normalizeRect([rect[0], viewBox[3] - rect[1] + viewBox[1], rect[2], viewBox[3] - rect[3] + viewBox[1]]) as [number, number, number, number];
        const layerEl = this.getPDFPlusBacklinkHighlightLayer(page);
        const rectEl = layerEl.createDiv('pdf-plus-backlink');
        rectEl.setCssStyles({
            left: `${100 * (mirroredRect[0] - pageX) / pageWidth}%`,
            top: `${100 * (mirroredRect[1] - pageY) / pageHeight}%`,
            width: `${100 * (mirroredRect[2] - mirroredRect[0]) / pageWidth}%`,
            height: `${100 * (mirroredRect[3] - mirroredRect[1]) / pageHeight}%`,
        });

        return rectEl;
    }

    /**
     * Render highlighting DOM elements for `subpathHighlight` of the given `child`.
     * `subpathHighlight` must be set by `child.applySubpath` before calling this method.
     * 
     * @param child 
     * @param duration The duration in seconds to highlight the subpath. If it's 0, the highlight will not be removed until the user clicks on the page.
     */
    highlightSubpath(child: PDFViewerChild, duration: number) {
        const parent = child.component;
        const previous = this.pendingHighlights.get(child);
        if (previous) parent?.removeChild(previous);
        const highlight = child.subpathHighlight;
        if (!parent || child.unloaded || !highlight) return;

        const owner = parent.addChild(new Component());
        this.pendingHighlights.set(child, owner);
        owner.register(() => {
            if (this.pendingHighlights.get(child) === owner) this.pendingHighlights.delete(child);
        });
        const waiting = owner.addChild(new Component());
        const timerWindow = activeWindow;
        const finish = () => parent.removeChild(owner);
        let registering = true;
        let ready = false;
        let handled = false;
        const onReady = (pageNumber: number) => {
            if (handled) return;
            if (child.unloaded || child.subpathHighlight !== highlight) { finish(); return; }
            if (pageNumber !== highlight.page) return;
            if (highlight.type === 'rect' && !child.getPage(pageNumber)?.div.dataset.loaded) return;
            // The readiness helpers visit existing pages before installing their
            // event listener. Defer disposal until that installation has finished.
            if (registering) { ready = true; return; }
            handled = true;
            owner.removeChild(waiting);
            try {
                let clear: () => void;
                if (highlight.type === 'text') {
                    child.highlightText(highlight.page, highlight.range);
                    clear = () => child.clearTextHighlight();
                } else if (highlight.type === 'annotation') {
                    child.highlightAnnotation(highlight.page, highlight.id);
                    clear = () => child.clearAnnotationHighlight();
                } else {
                    this.highlightRect(child, highlight.page, highlight.rect);
                    clear = () => this.clearRectHighlight(child);
                }
                if (duration > 0 && !child.unloaded) {
                    const timeout = timerWindow.setTimeout(() => {
                        finish();
                        if (!child.unloaded && child.subpathHighlight === highlight) clear();
                    }, duration * 1000);
                    owner.register(() => timerWindow.clearTimeout(timeout));
                } else {
                    finish();
                }
            } catch (error) {
                finish();
                throw error;
            }
        };
        try {
            if (highlight.type === 'text') this.lib.onTextLayerReady(child.pdfViewer, waiting, onReady);
            else if (highlight.type === 'annotation') this.lib.onAnnotationLayerReady(child.pdfViewer, waiting, onReady);
            else this.lib.onPageReady(child.pdfViewer, waiting, onReady);
            registering = false;
            if (ready) onReady(highlight.page);
        } catch (error) {
            finish();
            throw error;
        }
    }

    /** 
     * The counterpart of `PDFViewerChild.prototype.highlightText` and `PDFViewerChild.prototype.highlightAnnotation`
     * for rectangular selections.
     */
    highlightRect(child: PDFViewerChild, page: number, rect: Rect) {
        this.clearRectHighlight(child);

        if (1 <= page && page <= child.pdfViewer.pagesCount) {
            const pageView = child.getPage(page);
            if (pageView?.div.dataset.loaded) {
                child.rectHighlight = this.placeRectInPage(rect, pageView);
                child.rectHighlight.addClass('rect-highlight');

                // If `zoomToFitRect === true`, it will be handled by `PDFViewerChild.prototype.applySubpath` as a FitR destination.
                if (!this.settings.zoomToFitRect) {
                    const parent = child.component;
                    if (!parent || child.unloaded) return;
                    const owner = parent.addChild(new Component());
                    const highlight = child.rectHighlight;
                    const timerWindow = activeWindow;
                    this.pendingRectScrolls.set(child, owner);
                    const timeout = timerWindow.setTimeout(() => {
                        parent.removeChild(owner);
                        if (!child.unloaded && child.rectHighlight === highlight) {
                            window.pdfjsViewer.scrollIntoView(highlight, { top: - this.settings.embedMargin });
                        }
                    });
                    owner.register(() => {
                        timerWindow.clearTimeout(timeout);
                        if (this.pendingRectScrolls.get(child) === owner) this.pendingRectScrolls.delete(child);
                    });
                }
            }
        }
    }

    /** 
     * The counterpart of `PDFViewerChild.prototype.clearTextHighlight` and `PDFViewerChild.prototype.clearAnnotationHighlight`
     * for rectangular selections.
     */
    clearRectHighlight(child: PDFViewerChild) {
        const pending = this.pendingRectScrolls.get(child);
        if (pending) child.component?.removeChild(pending);
        if (child.rectHighlight) {
            child.rectHighlight.detach();
            child.rectHighlight = null;
        }
    }
}
