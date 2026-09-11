import { App, Component, Platform, TFile } from 'obsidian';
import { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import pLimit from 'p-limit';

import PDFPlus from 'main';
import { AnnotationElement, Embed, EmbedContext, Rect } from 'typings';


interface SharedDocumentEntry {
    key: string;
    refs: number;
    closed: boolean;
    controller: AbortController;
    promise: Promise<PDFDocumentProxy>;
    doc?: PDFDocumentProxy;
    timer?: number;
}

export interface SharedDocumentLease {
    promise: Promise<PDFDocumentProxy>;
    /** @param discard Close the document right away if this was its last user, instead of keeping it briefly. */
    release(discard?: boolean): void;
}

/**
 * Rectangle embeds of the same PDF render from one shared document. Loading it once per embed meant a
 * separate PDF.js worker and a separate copy of the whole file for each of them, all at the same time
 * when a note with several embeds is opened. A document is kept for `lingerMs` after its last user
 * finishes, so that embeds coming into view one after another do not reload it.
 */
export class SharedPDFDocuments {
    private entries = new Map<string, SharedDocumentEntry>();

    constructor(private lingerMs: number) { }

    acquire(key: string, load: (signal: AbortSignal) => Promise<PDFDocumentProxy>): SharedDocumentLease {
        let entry = this.entries.get(key);
        if (!entry || entry.closed) {
            const controller = new AbortController();
            const created: SharedDocumentEntry = { key, refs: 0, closed: false, controller, promise: load(controller.signal) };
            created.promise.then((doc) => { created.doc = doc; }, () => this.close(created));
            this.entries.set(key, entry = created);
        }
        const current = entry;
        current.refs++;
        if (current.timer !== undefined) {
            window.clearTimeout(current.timer);
            current.timer = undefined;
        }
        let released = false;
        return {
            promise: current.promise,
            release: (discard = false) => {
                if (released) return;
                released = true;
                if (--current.refs > 0 || current.closed) return;
                if (discard || this.lingerMs <= 0) {
                    this.close(current);
                    return;
                }
                // The main window's timer: a pop-out window's timers stop when it closes.
                current.timer = window.setTimeout(() => {
                    current.timer = undefined;
                    if (current.refs === 0) this.close(current);
                }, this.lingerMs);
            },
        };
    }

    /** Close every document nobody is using right now (e.g. when the plugin unloads). */
    closeUnused() {
        for (const entry of [...this.entries.values()]) {
            if (entry.refs === 0) this.close(entry);
        }
    }

    get size() {
        return this.entries.size;
    }

    private close(entry: SharedDocumentEntry) {
        if (entry.closed) return;
        entry.closed = true;
        if (entry.timer !== undefined) window.clearTimeout(entry.timer);
        entry.timer = undefined;
        if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
        // Cancels a load still in progress; a no-op once the document has loaded.
        entry.controller.abort();
        if (entry.doc) void entry.doc.destroy().catch(console.error);
        else entry.promise.then((doc) => doc.destroy(), () => { }).catch(console.error);
    }
}


export class PDFCroppedEmbed extends Component implements Embed {
    // Limit the number of concurrent PDF rendering tasks to avoid running out of memory
    // especially on mobile devices, which will cause the app to crash.
    // https://github.com/RyotaUshio/obsidian-pdf-plus/issues/397
    private static readonly limit = pLimit(Platform.isMobile ? 1 : 2);
    private static readonly documents = new SharedPDFDocuments(1500);
    /**
     * Render at the resolution the embed is displayed at. Every extra pixel costs twice in GPU memory while the
     * image is shown (its decoded copy and the texture uploaded from it), so instead of oversampling, an embed
     * that becomes noticeably wider than it was rendered for is rendered again (see `watchWidth`).
     */
    private static readonly displayOversampling = 1;
    /** Re-render once an embed is this much wider than the width its image was rendered for. */
    private static readonly rerenderWidthRatio = 1.15;
    /** Upper bound of a rendered image, in pixels (the same limit Obsidian gives its PDF viewer's canvases). */
    private static readonly maxPixels = Platform.isMobile ? 4 * 1024 * 1024 : 16 * 1024 * 1024;

    private renderController?: AbortController;
    private unloaded = false;
    /** The object URL of the image currently shown. */
    private imageUrl: string | null = null;
    /** The render parameters (theme adaptation) the current image was rendered with. */
    private renderedParamsKey: string | null = null;
    /** The display width (CSS pixels) the current image was rendered for, or 0 if it was not limited by it. */
    private renderedForWidth = 0;

    app: App;
    containerEl: HTMLElement;

    get lib() {
        return this.plugin.lib;
    }

    constructor(public plugin: PDFPlus, public ctx: EmbedContext, public file: TFile, public subpath: string, public pageNumber: number, public rect: Rect, public width?: number, public annotationId?: string) {
        super();
        this.app = ctx.app;
        this.containerEl = ctx.containerEl;
        this.rect = window.pdfjsLib.Util.normalizeRect(rect);
        this.containerEl.addClass('pdf-cropped-embed');
        this.applyWidth();
    }

    static closeUnusedDocuments() {
        PDFCroppedEmbed.documents.closeUnused();
    }

    onload() {
        super.onload();
        this.unloaded = false;

        if (this.shouldUpdateOnModify()) {
            this.registerEvent(this.app.vault.on('modify', (file) => {
                if (file === this.file) {
                    this.loadFile();
                }
            }));
        }

        this.watchWidth();

        if (this.plugin.settings.rectFollowAdaptToTheme) {
            this.registerEvent(this.app.workspace.on('css-change', () => {
                // 'css-change' fires for any style change (PDF++ itself triggers it whenever its settings are
                // closed); re-rendering is only needed when the theme adaptation actually changed.
                if (this.getRenderParamsKey() !== this.renderedParamsKey) this.loadFile();
            }));
            this.registerEvent(this.plugin.on('adapt-to-theme-change', () => {
                this.loadFile();
            }));
        }
    }

    shouldUpdateOnModify() {
        return typeof this.annotationId === 'string';
    }

    onunload() {
        this.unloaded = true;
        this.renderController?.abort();
        this.renderController = undefined;
        this.containerEl.empty();
        this.revokeImageUrl();
    }

    /** Render again, sharper, when the note gets wider than the image was rendered for. */
    private watchWidth() {
        if (this.getValidWidth()) return; // A fixed width never changes.
        // The embed's own window: pop-out windows have their own ResizeObserver.
        const win = (this.containerEl.win ?? window) as Window & typeof globalThis;
        if (typeof win.ResizeObserver !== 'function') return;
        let timer: number | undefined;
        const observer = new win.ResizeObserver(() => {
            const width = this.containerEl.clientWidth;
            if (!this.renderedForWidth || this.renderController
                || width <= this.renderedForWidth * PDFCroppedEmbed.rerenderWidthRatio) return;
            win.clearTimeout(timer);
            timer = win.setTimeout(() => this.loadFile(), 500);
        });
        observer.observe(this.containerEl);
        this.register(() => {
            observer.disconnect();
            win.clearTimeout(timer);
        });
    }

    private revokeImageUrl() {
        if (this.imageUrl) URL.revokeObjectURL(this.imageUrl);
        this.imageUrl = null;
    }

    // An abandoned queued job must not keep its embed alive until another PDF
    // finishes rendering. Clear the queued reference and settle the caller on abort.
    private static render(embed: PDFCroppedEmbed | undefined, signal: AbortSignal): Promise<string> {
        return new Promise((resolve, reject) => {
            const abort = () => {
                embed = undefined;
                signal.removeEventListener('abort', abort);
                reject(signal.reason);
            };
            signal.addEventListener('abort', abort, { once: true });
            if (signal.aborted) abort();
            void this.limit(async () => {
                signal.throwIfAborted();
                const current = embed!;
                embed = undefined;
                return await current.computeImageUrl(signal);
            }).then((url) => {
                // The caller has gone; nobody will show or revoke this image.
                if (signal.aborted) URL.revokeObjectURL(url);
                else resolve(url);
            }, reject).finally(() => signal.removeEventListener('abort', abort));
        });
    }

    async loadFile() {
        if (this.unloaded) return;
        this.renderController?.abort();
        const controller = this.renderController = new AbortController();
        const { signal } = controller;
        const paramsKey = this.getRenderParamsKey();
        let pendingUrl: string | null = null;
        try {
            pendingUrl = await PDFCroppedEmbed.render(this, signal);
            signal.throwIfAborted();
            const imageUrl = pendingUrl;
            await new Promise<void>((resolve, reject) => {
                this.containerEl.empty();
                // The previous image went with the old <img>; the embed owns the new URL from now on.
                this.revokeImageUrl();
                this.imageUrl = imageUrl;
                pendingUrl = null;
                const imgEl = this.containerEl.createEl('img');
                const cleanup = () => {
                    imgEl.removeEventListener('load', loaded);
                    imgEl.removeEventListener('error', failed);
                    signal.removeEventListener('abort', aborted);
                    activeWindow.clearTimeout(timeout);
                };
                const loaded = () => { cleanup(); resolve(); };
                const failed = (error: unknown) => { cleanup(); reject(error); };
                const aborted = () => {
                    imgEl.removeAttribute('src');
                    failed(signal.reason);
                };
                imgEl.addEventListener('load', loaded);
                imgEl.addEventListener('error', failed);
                signal.addEventListener('abort', aborted, { once: true });
                const timeout = activeWindow.setTimeout(() => failed(new Error('PDF crop image loading timed out')), 5000);
                const height = this.containerEl.getAttribute('height');
                const width = this.getValidWidth();
                if (width) imgEl.setAttribute('width', '' + width);
                if (height) imgEl.setAttribute('height', height);
                imgEl.setAttribute('src', imageUrl);
            });
            this.renderedParamsKey = paramsKey;
        } catch (error) {
            // Closing or replacing an embed is expected; real load errors remain observable.
            if (!signal.aborted) throw error;
        } finally {
            // Rendered, but never handed to an <img>.
            if (pendingUrl) URL.revokeObjectURL(pendingUrl);
            if (this.renderController === controller) this.renderController = undefined;
        }
    }

    getValidWidth() {
        return typeof this.width === 'number' && Number.isFinite(this.width) && this.width > 0 ? this.width : undefined;
    }

    applyWidth() {
        const width = this.getValidWidth();
        if (!width) return;

        this.containerEl.setAttribute('width', '' + width);
        this.containerEl.style.setProperty('--container-pdf-cropped-width', `${width}px`);
    }

    private getRenderParamsKey() {
        return JSON.stringify(this.lib.getOptionalRenderParameters());
    }

    private getDocumentKey() {
        // A modified file is a different document.
        return JSON.stringify([this.file.path, this.file.stat?.mtime, this.file.stat?.size]);
    }

    /** The width (in CSS pixels) the image is going to be displayed at. */
    getDisplayWidth(): number {
        const explicit = this.getValidWidth();
        if (explicit) return explicit;
        const measured = this.containerEl.clientWidth || this.containerEl.parentElement?.clientWidth || 0;
        // Live Preview creates embeds before they are laid out; assume a readable line length then.
        return measured > 0 ? Math.min(measured, 2000) : 800;
    }

    /**
     * Previously every rectangle was rendered at 7x (desktop): a rectangle as wide as an A4 page was nearly 4000
     * pixels across for an image displayed some 700 pixels wide. Match the display instead, never exceeding the
     * old resolution, and keep the image within a pixel budget.
     */
    getRenderResolution(page: PDFPageProxy): number {
        const max = this.lib.getMaxRectImageResolution();
        const viewport = page.getViewport({ scale: 1 });
        const [x1, y1, x2, y2] = viewport.convertToViewportRectangle(this.rect);
        const width = Math.abs(x2 - x1);
        const height = Math.abs(y2 - y1);
        if (!(width > 0) || !(height > 0)) return max;

        const dpr = this.containerEl.win?.devicePixelRatio || window.devicePixelRatio || 1;
        const scale = this.plugin.settings.rectEmbedResolution / 100;
        const displayWidth = this.getDisplayWidth();
        const wanted = displayWidth * dpr * PDFCroppedEmbed.displayOversampling * scale / width;
        let resolution = Math.min(max, wanted);
        const pixels = width * height * resolution * resolution;
        if (pixels > PDFCroppedEmbed.maxPixels) resolution *= Math.sqrt(PDFCroppedEmbed.maxPixels / pixels);
        // Only a resolution chosen for the display width can become too low when the display gets wider.
        this.renderedForWidth = resolution === wanted ? displayWidth : 0;
        return resolution;
    }

    async computeImageUrl(signal?: AbortSignal): Promise<string> {
        const lease = PDFCroppedEmbed.documents.acquire(this.getDocumentKey(), (loadSignal) => this.lib.loadPDFDocument(this.file, loadSignal));
        // Cancel promptly: if this embed was the document's only user, destroying it stops the worker's work.
        const abort = () => lease.release(true);
        signal?.addEventListener('abort', abort, { once: true });
        let failed = false;
        let page: PDFPageProxy | undefined;
        try {
            signal?.throwIfAborted();
            const doc = await lease.promise;
            signal?.throwIfAborted();
            page = await doc.getPage(this.pageNumber);
            signal?.throwIfAborted();
            if (this.annotationId) {
                const annotations = await page.getAnnotations();
                signal?.throwIfAborted();
                const annotation: AnnotationElement['data'] = annotations.find((annot) => annot.id === this.annotationId);
                if (annotation && Array.isArray(annotation.rect)) {
                    this.rect = window.pdfjsLib.Util.normalizeRect(annotation.rect);
                }
            }
            const blob = await this.lib.pdfPageToImageBlob(page, {
                type: 'image/png',
                cropRect: this.rect,
                resolution: this.getRenderResolution(page),
                renderParams: this.lib.getOptionalRenderParameters(),
            }, signal);
            signal?.throwIfAborted();
            return URL.createObjectURL(blob);
        } catch (error) {
            failed = true;
            throw error;
        } finally {
            signal?.removeEventListener('abort', abort);
            // The document may be kept for other embeds, but not this page's decoded images and
            // operator list (PDF.js defers this until other renders of the page have finished).
            page?.cleanup();
            // Do not keep a document around for others after it failed.
            lease.release(failed);
        }
    }
}
