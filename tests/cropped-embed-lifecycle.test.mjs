import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { transform } from 'esbuild';
import pLimit from 'p-limit';

class Component {
    onload() {}
    onunload() {}
    registerEvent() {}
    register(fn) { (this._cleanup ??= []).push(fn); }
    load() { this.onload(); }
    unload() { this.onunload(); for (const fn of this._cleanup?.splice(0) ?? []) fn(); }
}
const source = await readFile(new URL('../src/pdf-cropped-embed.ts', import.meta.url), 'utf8');
const { code } = await transform(source, { loader: 'ts', format: 'cjs' });
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(overrides = {}, { devicePixelRatio = 1, clientWidth = 0 } = {}) {
    const timers = new Map();
    const lingerTimers = new Map();
    let nextTimer = 0;
    const urls = { created: 0, revoked: [] };
    const module = { exports: {} };
    runInNewContext(code, {
        module, exports: module.exports, AbortController, console,
        window: {
            pdfjsLib: { Util: { normalizeRect: rect => rect } }, devicePixelRatio,
            // The shared-document linger timer uses the main window; kept apart from the image timeout.
            setTimeout: fn => { lingerTimers.set(++nextTimer, fn); return nextTimer; },
            clearTimeout: id => lingerTimers.delete(id),
        },
        activeWindow: { setTimeout: fn => { timers.set(++nextTimer, fn); return nextTimer; }, clearTimeout: id => timers.delete(id) },
        URL: { createObjectURL: () => { const url = `blob:${++urls.created}`; urls.onCreate?.(); return url; }, revokeObjectURL: url => urls.revoked.push(url) },
        require: name => name === 'obsidian' ? { Component, Platform: { isDesktop: true } } : name === 'p-limit' ? pLimit : {},
    });
    const images = [];
    const container = {
        clientWidth,
        style: { setProperty() {} }, addClass() {}, getAttribute() {}, setAttribute() {},
        empty() { images.splice(0); },
        createEl(tag, options, callback) {
            const image = {
                listeners: new Map(), src: null,
                setAttribute(name, value) { if (name === 'src') this.src = value; },
                removeAttribute(name) { if (name === 'src') this.src = null; },
                addEventListener(name, fn) { this.listeners.set(name, fn); },
                removeEventListener(name, fn) { if (this.listeners.get(name) === fn) this.listeners.delete(name); },
                fire(name) { this.listeners.get(name)?.(); },
            };
            images.push(image);
            callback?.(image);
            return image;
        },
    };
    const stats = { destroyed: 0, render: 0, loads: 0, cleanups: 0, resolutions: [] };
    const makeDoc = () => ({ getPage: async () => page, destroy: async () => { stats.destroyed++; } });
    const page = {
        cleanup: () => { stats.cleanups++; return true; },
        getAnnotations: async () => [],
        getViewport: () => ({ width: 600, height: 800, convertToViewportRectangle: ([x1, y1, x2, y2]) => [x1, 800 - y1, x2, 800 - y2] }),
    };
    const doc = makeDoc();
    const plugin = { settings: { rectEmbedResolution: 100 }, lib: {
        loadPDFDocument: async () => { stats.loads++; return doc; },
        pdfPageToImageBlob: async (page, options) => { stats.render++; stats.resolutions.push(options.resolution); return {}; },
        getOptionalRenderParameters: () => ({}),
        getMaxRectImageResolution: () => 7,
        ...overrides,
    } };
    const file = { path: 'sample.pdf', stat: { mtime: 1, size: 10 } };
    const create = (rect = [0, 0, 10, 10], targetFile = file) => new module.exports.PDFCroppedEmbed(plugin, { app: {}, containerEl: container }, targetFile, '', 1, rect);
    const embed = create();
    return { embed, create, doc, makeDoc, page, file, plugin, images, timers, lingerTimers, urls, stats, Embed: module.exports.PDFCroppedEmbed };
}
const fireLinger = (f) => { for (const [id, fn] of [...f.lingerTimers]) { f.lingerTimers.delete(id); fn(); } };

for (const stage of ['getPage', 'getAnnotations', 'render']) {
    test(`a cropped embed destroys its document when ${stage} rejects`, async () => {
        const f = fixture();
        const error = Error(stage);
        if (stage === 'getPage') f.doc.getPage = async () => { throw error; };
        if (stage === 'getAnnotations') {
            f.embed.annotationId = 'annotation';
            f.doc.getPage = async () => ({ ...f.page, getAnnotations: async () => { throw error; } });
        }
        if (stage === 'render') f.embed.lib.pdfPageToImageBlob = async () => { throw error; };
        await assert.rejects(f.embed.computeImageUrl(), value => value === error);
        assert.equal(f.stats.destroyed, 1);
        assert.equal(f.lingerTimers.size, 0, 'a failed document is not kept for reuse');
    });
}

test('closing while document loading is pending prevents rendering and DOM insertion', async () => {
    let resolve;
    const pending = new Promise(r => { resolve = r; });
    const f = fixture({ loadPDFDocument: () => pending });
    const result = f.embed.loadFile();
    await tick();
    f.embed.unload();
    resolve(f.doc);
    await tick();
    f.images[0]?.fire('load');
    await result;
    assert.equal(f.stats.destroyed, 1);
    assert.equal(f.stats.render, 0);
    assert.equal(f.images.length, 0);
});

test('image load completion removes both listeners and the five-second timeout', async () => {
    const f = fixture();
    const result = f.embed.loadFile();
    await tick();
    const image = f.images[0];
    image.fire('load');
    await result;
    assert.equal(image.listeners.size, 0);
    assert.equal(f.timers.size, 0);
});

test('unloading an image wait removes listeners, timer, and image, and revokes the object URL', async () => {
    const f = fixture();
    const result = f.embed.loadFile();
    await tick();
    const image = f.images[0];
    f.embed.unload();
    image.fire('load');
    await result;
    assert.equal(image.listeners.size, 0);
    assert.equal(f.timers.size, 0);
    assert.equal(f.images.length, 0);
    assert.deepEqual(f.urls.revoked, [image.src ?? 'blob:1']);
});

test('a queued embed settles immediately on unload and never starts PDF loading', async () => {
    const f = fixture();
    f.Embed.limit = pLimit(1);
    let release;
    const blocker = f.Embed.limit(() => new Promise(resolve => { release = resolve; }));
    await tick();
    let finished = false;
    const result = f.embed.loadFile().then(() => { finished = true; });
    f.embed.unload();
    await tick();
    const completedWhileBlocked = finished;
    release(); await blocker; await tick();
    f.images[0]?.fire('load');
    await result;
    assert.equal(completedWhileBlocked, true);
    assert.equal(f.stats.render, 0);
    assert.equal(f.stats.loads, 0);
    assert.equal(f.images.length, 0);
});

test('reloading replaces the previous image wait without accumulating its timeout or listeners', async () => {
    const f = fixture();
    const first = f.embed.loadFile();
    await tick();
    const oldImage = f.images[0];
    const second = f.embed.loadFile();
    await tick();
    const oldListenerCount = oldImage.listeners.size;
    oldImage.fire('load');
    f.images[0]?.fire('load');
    await Promise.all([first, second]);
    assert.equal(oldListenerCount, 0);
    assert.equal(f.timers.size, 0);
});

test('a replaced image revokes the previous object URL, and unload revokes the current one', async () => {
    const f = fixture();
    const first = f.embed.loadFile();
    await tick();
    f.images[0].fire('load');
    await first;
    const firstUrl = f.images[0].src;
    const second = f.embed.loadFile();
    await tick();
    f.images[0].fire('load');
    await second;
    const secondUrl = f.images[0].src;
    assert.notEqual(firstUrl, secondUrl);
    assert.deepEqual(f.urls.revoked, [firstUrl]);
    f.embed.unload();
    assert.deepEqual(f.urls.revoked, [firstUrl, secondUrl]);
});

test('an image finished after its embed was closed is revoked instead of leaking', async () => {
    const f = fixture();
    // Close the embed at the last moment: after encoding, while its object URL is being created.
    f.urls.onCreate = () => f.embed.unload();
    await f.embed.loadFile();
    await tick();
    assert.equal(f.urls.created, 1);
    assert.deepEqual(f.urls.revoked, ['blob:1']);
    assert.equal(f.images.length, 0);
});

test('aborting a pending page request destroys the document before the request settles', async () => {
    const f = fixture();
    let rejectPage;
    f.doc.getPage = () => new Promise((resolve, reject) => { rejectPage = reject; });
    f.doc.destroy = async () => { f.stats.destroyed++; rejectPage(Error('page request destroyed')); };
    const controller = new AbortController();
    const result = f.embed.computeImageUrl(controller.signal);
    await tick();
    controller.abort();
    const destroyedOnAbort = f.stats.destroyed;
    rejectPage(Error('settle old implementation'));
    await assert.rejects(result);
    assert.equal(destroyedOnAbort, 1);
    assert.equal(f.stats.destroyed, 1);
});

test('embeds of the same PDF share one document, destroyed once after the last one finishes', async () => {
    const f = fixture();
    const others = [f.create(), f.create([0, 0, 50, 50])];
    await Promise.all([f.embed, ...others].map(embed => embed.computeImageUrl()));
    assert.equal(f.stats.loads, 1);
    assert.equal(f.stats.render, 3);
    assert.equal(f.stats.cleanups, 3, 'each render releases its page resources while the document is kept');
    assert.equal(f.stats.destroyed, 0, 'kept briefly for embeds that come into view next');
    const late = f.create();
    await late.computeImageUrl();
    assert.equal(f.stats.loads, 1, 'reused within the linger period');
    fireLinger(f);
    assert.equal(f.stats.destroyed, 1);
    await f.create().computeImageUrl();
    assert.equal(f.stats.loads, 2, 'loaded again once released');
});

test('a modified PDF is not served from the document of its previous version', async () => {
    const f = fixture();
    await f.embed.computeImageUrl();
    const modified = { ...f.file, stat: { mtime: 2, size: 10 } };
    await f.create([0, 0, 10, 10], modified).computeImageUrl();
    assert.equal(f.stats.loads, 2);
});

test('an aborted embed does not destroy a document other embeds are still using', async () => {
    const f = fixture();
    let finishRender;
    f.plugin.lib.pdfPageToImageBlob = () => new Promise(resolve => { finishRender = resolve; });
    const controller = new AbortController();
    const aborted = f.embed.computeImageUrl(controller.signal);
    await tick();
    const other = f.create();
    const renders = [];
    f.plugin.lib.pdfPageToImageBlob = async () => { renders.push(1); return {}; };
    const otherResult = other.computeImageUrl();
    controller.abort();
    finishRender({});
    await assert.rejects(aborted);
    await otherResult;
    assert.equal(f.stats.destroyed, 0);
    assert.equal(renders.length, 1);
    fireLinger(f);
    assert.equal(f.stats.destroyed, 1);
});

test('closeUnusedDocuments releases lingering documents right away', async () => {
    const f = fixture();
    await f.embed.computeImageUrl();
    assert.equal(f.lingerTimers.size, 1);
    f.Embed.closeUnusedDocuments();
    assert.equal(f.stats.destroyed, 1);
    assert.equal(f.lingerTimers.size, 0);
});

test('the render resolution follows the display width, capped by the previous resolution and a pixel budget', async () => {
    // A 560pt wide rectangle shown 700px wide on a 2x display: 700 * 2 / 560 = 2.5 instead of 7.
    let f = fixture({}, { devicePixelRatio: 2, clientWidth: 700 });
    await f.create([20, 100, 580, 600]).computeImageUrl();
    assert.ok(Math.abs(f.stats.resolutions[0] - 2.5) < 1e-9, String(f.stats.resolutions[0]));
    // A small rectangle keeps the previous resolution rather than exceeding it.
    f = fixture({}, { devicePixelRatio: 2, clientWidth: 700 });
    await f.create([79, 432, 251, 531]).computeImageUrl();
    assert.equal(f.stats.resolutions[0], 7);
    // The rendered image never exceeds the pixel budget.
    f = fixture({ getMaxRectImageResolution: () => 1000 }, { devicePixelRatio: 2, clientWidth: 2000 });
    await f.create([0, 0, 600, 800]).computeImageUrl();
    const resolution = f.stats.resolutions[0];
    assert.ok(600 * 800 * resolution * resolution <= 16 * 1024 * 1024 + 1);
});

test('an embed that becomes noticeably wider than its image was rendered for is rendered again', async () => {
    const observers = [];
    const winTimers = [];
    const f = fixture({}, { devicePixelRatio: 2, clientWidth: 700 });
    const embed = f.create([20, 100, 580, 600]);
    embed.containerEl.win = {
        devicePixelRatio: 2,
        ResizeObserver: class { constructor(callback) { this.callback = callback; observers.push(this); } observe(el) { this.el = el; } disconnect() { this.disconnected = true; } },
        setTimeout: (fn) => { winTimers.push(fn); return winTimers.length; },
        clearTimeout: () => {},
    };
    embed.load();
    assert.equal(observers.length, 1);
    const load = embed.loadFile();
    await tick(); f.images[0].fire('load'); await load;
    assert.equal(f.stats.render, 1);

    embed.containerEl.clientWidth = 780; // within 15%: keep the image
    observers[0].callback();
    assert.equal(winTimers.length, 0);
    embed.containerEl.clientWidth = 900;
    observers[0].callback();
    assert.equal(winTimers.length, 1);
    const reload = winTimers.shift()();
    await tick(); f.images[0].fire('load'); await reload;
    assert.equal(f.stats.render, 2);
    assert.ok(Math.abs(f.stats.resolutions[1] - 900 * 2 / 560) < 1e-9);

    embed.unload();
    assert.equal(observers[0].disconnected, true);
});
