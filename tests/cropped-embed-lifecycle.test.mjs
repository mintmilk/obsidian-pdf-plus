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
    load() { this.onload(); }
    unload() { this.onunload(); }
}
const source = await readFile(new URL('../src/pdf-cropped-embed.ts', import.meta.url), 'utf8');
const { code } = await transform(source, { loader: 'ts', format: 'cjs' });
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(overrides = {}) {
    const timers = new Map();
    let nextTimer = 0;
    const module = { exports: {} };
    runInNewContext(code, {
        module, exports: module.exports, AbortController, console,
        window: { pdfjsLib: { Util: { normalizeRect: rect => rect } } },
        activeWindow: { setTimeout: fn => { timers.set(++nextTimer, fn); return nextTimer; }, clearTimeout: id => timers.delete(id) },
        require: name => name === 'obsidian' ? { Component, Platform: {} } : name === 'p-limit' ? pLimit : {},
    });
    const images = [];
    const container = {
        style: { setProperty() {} }, addClass() {}, getAttribute() {}, setAttribute() {},
        empty() { images.splice(0); },
        createEl(tag, options, callback) {
            const image = {
                listeners: new Map(), setAttribute() {}, removeAttribute() {},
                addEventListener(name, fn) { this.listeners.set(name, fn); },
                removeEventListener(name, fn) { if (this.listeners.get(name) === fn) this.listeners.delete(name); },
                fire(name) { this.listeners.get(name)?.(); },
            };
            images.push(image);
            callback?.(image);
            return image;
        },
    };
    const stats = { destroyed: 0, render: 0 };
    const doc = { getPage: async () => ({ getAnnotations: async () => [] }), destroy: async () => { stats.destroyed++; } };
    const plugin = { settings: {}, lib: {
        loadPDFDocument: async () => doc,
        pdfPageToImageDataUrl: async () => { stats.render++; return 'data:image/png;base64,AA=='; },
        getOptionalRenderParameters: () => ({}),
        ...overrides,
    } };
    const embed = new module.exports.PDFCroppedEmbed(plugin, { app: {}, containerEl: container }, {}, '', 1, [0, 0, 10, 10]);
    return { embed, doc, images, timers, stats, Embed: module.exports.PDFCroppedEmbed };
}

for (const stage of ['getPage', 'getAnnotations', 'render']) {
    test(`a cropped embed destroys its document when ${stage} rejects`, async () => {
        const f = fixture();
        const error = Error(stage);
        if (stage === 'getPage') f.doc.getPage = async () => { throw error; };
        if (stage === 'getAnnotations') {
            f.embed.annotationId = 'annotation';
            f.doc.getPage = async () => ({ getAnnotations: async () => { throw error; } });
        }
        if (stage === 'render') f.embed.lib.pdfPageToImageDataUrl = async () => { throw error; };
        await assert.rejects(f.embed.computeDataUrl(), value => value === error);
        assert.equal(f.stats.destroyed, 1);
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
    // Settle old image waiting so the old implementation can fail without hanging.
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

test('unloading an image wait removes listeners, timer, and image', async () => {
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

test('aborting a pending page request destroys the document before the request settles', async () => {
    const f = fixture();
    let rejectPage;
    f.doc.getPage = () => new Promise((resolve, reject) => { rejectPage = reject; });
    f.doc.destroy = async () => { f.stats.destroyed++; rejectPage(Error('page request destroyed')); };
    const controller = new AbortController();
    const result = f.embed.computeDataUrl(controller.signal);
    await tick();
    controller.abort();
    const destroyedOnAbort = f.stats.destroyed;
    rejectPage(Error('settle old implementation'));
    await assert.rejects(result);
    assert.equal(destroyedOnAbort, 1);
    assert.equal(f.stats.destroyed, 1);
});
