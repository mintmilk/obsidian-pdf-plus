import { App, Component, Platform, TFile } from 'obsidian';
import pLimit from 'p-limit';

import PDFPlus from 'main';
import { AnnotationElement, Embed, EmbedContext, Rect } from 'typings';


export class PDFCroppedEmbed extends Component implements Embed {
    // Limit the number of concurrent PDF rendering tasks to avoid running out of memory
    // especially on mobile devices, which will cause the app to crash.
    // https://github.com/RyotaUshio/obsidian-pdf-plus/issues/397
    private static readonly limit = pLimit(Platform.isMobile ? 3 : 10);

    private renderController?: AbortController;
    private unloaded = false;

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

        if (this.plugin.settings.rectFollowAdaptToTheme) {
            this.registerEvent(this.app.workspace.on('css-change', () => {
                this.loadFile();
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
                return await current.computeDataUrl(signal);
            }).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
        });
    }

    async loadFile() {
        if (this.unloaded) return;
        this.renderController?.abort();
        const controller = this.renderController = new AbortController();
        const { signal } = controller;
        try {
            const dataUrl = await PDFCroppedEmbed.render(this, signal);
            signal.throwIfAborted();
            await new Promise<void>((resolve, reject) => {
                this.containerEl.empty();
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
                imgEl.setAttribute('src', dataUrl);
            });
        } catch (error) {
            // Closing or replacing an embed is expected; real load errors remain observable.
            if (!signal.aborted) throw error;
        } finally {
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

    async computeDataUrl(signal?: AbortSignal) {
        const doc = await this.lib.loadPDFDocument(this.file, signal);
        let destruction: Promise<void> | undefined;
        const destroy = () => destruction ??= doc.destroy();
        const abort = () => { void destroy().catch(console.error); };
        signal?.addEventListener('abort', abort, { once: true });
        try {
            signal?.throwIfAborted();
            const page = await doc.getPage(this.pageNumber);
            signal?.throwIfAborted();
            if (this.annotationId) {
                const annotations = await page.getAnnotations();
                signal?.throwIfAborted();
                const annotation: AnnotationElement['data'] = annotations.find((annot) => annot.id === this.annotationId);
                if (annotation && Array.isArray(annotation.rect)) {
                    this.rect = window.pdfjsLib.Util.normalizeRect(annotation.rect);
                }
            }
            return await this.lib.pdfPageToImageDataUrl(page, {
                type: 'image/png',
                cropRect: this.rect,
                renderParams: this.lib.getOptionalRenderParameters(),
            }, signal);
        } finally {
            signal?.removeEventListener('abort', abort);
            await destroy();
        }
    }
}
