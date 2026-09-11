import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { transform } from 'esbuild';

class Component {
    _loaded = false; _children = []; _events = [];
    load() { if (!this._loaded) { this._loaded = true; this.onload?.(); } }
    register(fn) { this._events.push(fn); }
    registerEvent(ref) { this.register(() => ref.off()); }
    registerInterval(id) { this.register(() => intervals.delete(id)); return id; }
    addChild(c) { this._children.push(c); if (this._loaded) c.load(); return c; }
    removeChild(c) { const i = this._children.indexOf(c); if (i >= 0) this._children.splice(i, 1); c.unload(); return c; }
    unload() { if (!this._loaded) return; this._loaded = false; while (this._children.length) this._children.pop().unload(); while (this._events.length) this._events.pop()(); this.onunload?.(); }
}
// A debounce whose pending call runs only when the test flushes it.
const pendingDebounces = new Set();
function debounce(fn) {
    let pending = false;
    const call = () => { pending = true; pendingDebounces.add(run); };
    const run = () => { if (pending) { pending = false; fn(); } };
    call.cancel = () => { pending = false; pendingDebounces.delete(run); };
    return call;
}
const flush = () => { for (const run of [...pendingDebounces]) { pendingDebounces.delete(run); run(); } };
const intervals = new Map();
let nextInterval = 0;

const load = async (path, imports) => {
    const { code } = await transform(await readFile(new URL(path, import.meta.url), 'utf8'), { loader: 'ts', format: 'cjs' });
    const module = { exports: {} };
    runInNewContext(code, {
        module, exports: module.exports, HTMLElement: class {},
        window: { setInterval: (fn) => { intervals.set(++nextInterval, fn); return nextInterval; } },
        require: (name) => imports[name] ?? {},
    });
    return module.exports;
};
const imports = { obsidian: { Component, debounce } };
imports['lib/component'] = await load('../src/lib/component.ts', imports);
const { releaseRenderedPages, registerOffscreenPageRelease, PDFPageReleaseManager } = await load('../src/page-release.ts', imports);

class EventBus {
    listeners = new Map();
    on(t, f) { if (!this.listeners.has(t)) this.listeners.set(t, new Set()); this.listeners.get(t).add(f); }
    off(t, f) { this.listeners.get(t)?.delete(f); }
    dispatch(t, data) { return Promise.all([...this.listeners.get(t) ?? []].map(f => f(data))); }
    count() { return [...this.listeners.values()].reduce((n, s) => n + s.size, 0); }
}

function viewerChild({ pages = 20, rendered = [], visible = [], spreadMode = 0, shown = true, selectionPages = [] } = {}) {
    const destroyed = [];
    const pageViews = Array.from({ length: pages }, (_, i) => ({
        id: i + 1,
        renderingState: rendered.includes(i + 1) ? 3 : 0,
        destroy() { destroyed.push(this.id); this.renderingState = 0; },
    }));
    const updates = [];
    const pageEl = (id) => ({ dataset: { pageNumber: String(id) } });
    const node = (id) => ({ instanceOf: () => true, closest: () => pageEl(id) });
    const child = {
        unloaded: false,
        containerEl: {
            isShown: () => child.shown,
            contains: () => true,
            win: {
                getSelection: () => selectionPages.length
                    ? { rangeCount: 1, getRangeAt: () => ({ startContainer: node(selectionPages[0]), endContainer: node(selectionPages.at(-1)) }) }
                    : { rangeCount: 0 },
            },
        },
        shown,
        pdfViewer: {
            eventBus: new EventBus(),
            pdfViewer: {
                _pages: pageViews, spreadMode,
                _getVisiblePages: () => ({ views: visible.map(id => ({ id, view: pageViews[id - 1], percent: 100 })) }),
                update: () => updates.push(1),
            },
        },
    };
    return { child, destroyed, pageViews, updates };
}

test('a shown viewer keeps the visible pages and one page on either side, releasing the rest', () => {
    const f = viewerChild({ rendered: [1, 2, 3, 4, 5, 6, 7, 8, 9, 12], visible: [5, 6] });
    assert.equal(releaseRenderedPages(f.child, 1), 6);
    assert.deepEqual(f.destroyed, [1, 2, 3, 8, 9, 12]);
});

test('spread modes keep the second page PDF.js pre-renders, so released pages are not re-rendered at once', () => {
    const f = viewerChild({ rendered: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], visible: [5, 6], spreadMode: 1 });
    releaseRenderedPages(f.child, 1);
    assert.deepEqual(f.destroyed, [1, 2, 9, 10]);
});

test('pages being rendered and pages holding the text selection are kept', () => {
    const f = viewerChild({ rendered: [1, 2, 10, 11], visible: [5], selectionPages: [10, 11] });
    f.pageViews[0].renderingState = 1; // still rendering
    releaseRenderedPages(f.child, 1);
    assert.deepEqual(f.destroyed, [2]);
});

test('without a visible page to go by, nothing is released; releasing a hidden viewer drops everything', () => {
    const f = viewerChild({ rendered: [1, 2, 3], visible: [] });
    assert.equal(releaseRenderedPages(f.child, 1), 0);
    assert.equal(releaseRenderedPages(f.child, null), 3);
    assert.deepEqual(f.destroyed, [1, 2, 3]);
});

test('off-screen release runs after rendering and scrolling settle, and its listeners leave with the PDF', async () => {
    const f = viewerChild({ rendered: [1, 2, 3, 4, 5, 6, 7, 8], visible: [7] });
    const plugin = { settings: { releaseOffscreenPDFPages: true, offscreenPDFPageMargin: 1 }, lib: {
        registerPDFEvent(name, bus, component, callback) { bus.on(name, callback); component.register(() => bus.off(name, callback)); },
    } };
    const component = new Component(); component.load();
    registerOffscreenPageRelease(plugin, f.child, component);
    const bus = f.child.pdfViewer.eventBus;
    assert.equal(bus.count(), 2);
    await bus.dispatch('pagerendered', {});
    await bus.dispatch('updateviewarea', {});
    assert.deepEqual(f.destroyed, [], 'nothing is released while scrolling');
    flush();
    assert.deepEqual(f.destroyed, [1, 2, 3, 4, 5]);

    // Disabled, or hidden (left to the manager): nothing happens.
    f.pageViews[0].renderingState = 3;
    plugin.settings.releaseOffscreenPDFPages = false;
    await bus.dispatch('pagerendered', {}); flush();
    plugin.settings.releaseOffscreenPDFPages = true;
    f.child.shown = false;
    await bus.dispatch('pagerendered', {}); flush();
    assert.deepEqual(f.destroyed, [1, 2, 3, 4, 5]);

    f.child.shown = true;
    await bus.dispatch('pagerendered', {});
    component.unload();
    flush();
    assert.equal(bus.count(), 0);
    assert.deepEqual(f.destroyed, [1, 2, 3, 4, 5], 'a pending release is cancelled with the PDF');
});

function manager(children, settings = {}) {
    const refs = [];
    const workspace = { on: (name, fn) => { const ref = { name, fn, off: () => refs.splice(refs.indexOf(ref), 1) }; refs.push(ref); return ref; } };
    const components = children.map(child => ({ child, then() { throw Error('then() queues callbacks on loading viewers'); } }));
    const plugin = {
        app: { workspace },
        settings: { releaseOffscreenPDFPages: true, releaseHiddenPDFPagesAfterSec: 60, ...settings },
        lib: { workspace: { iteratePDFViewerComponents: (cb) => components.forEach(c => cb(c)) } },
    };
    const m = new PDFPageReleaseManager(plugin);
    m.load();
    return { m, refs, components };
}

test('a hidden viewer is released after the delay, and re-rendered when it is shown again', () => {
    const hidden = viewerChild({ rendered: [3, 4, 5], visible: [4], shown: false });
    const shown = viewerChild({ rendered: [3, 4, 5], visible: [4] });
    const { m } = manager([hidden.child, shown.child]);
    m.check(0);
    m.check(59_000);
    assert.deepEqual(hidden.destroyed, [], 'released too early');
    m.check(60_000);
    assert.deepEqual(hidden.destroyed, [3, 4, 5]);
    assert.deepEqual(shown.destroyed, [], 'a shown viewer is left to the off-screen release');
    hidden.child.shown = true;
    m.check(61_000);
    m.check(62_000);
    assert.equal(hidden.updates.length, 1, 'shown again: rendered once, without waiting for a scroll');
    assert.equal(shown.updates.length, 0);
});

test('the manager skips loading viewers without queueing on them, and respects the settings', () => {
    const f = viewerChild({ rendered: [1], visible: [1], shown: false });
    const { m, components } = manager([f.child], { releaseHiddenPDFPagesAfterSec: 0 });
    components.push({ child: null, then() { throw Error('queued'); } });
    m.check(0); m.check(1_000_000);
    assert.deepEqual(f.destroyed, []);
    m.settings.releaseHiddenPDFPagesAfterSec = 60;
    m.settings.releaseOffscreenPDFPages = false;
    m.check(2_000_000); m.check(3_000_000);
    assert.deepEqual(f.destroyed, []);
});

test('the manager releases its workspace listeners and interval on unload', () => {
    const { m, refs } = manager([]);
    assert.equal(refs.length, 2);
    const before = intervals.size;
    m.unload();
    assert.equal(refs.length, 0);
    assert.equal(intervals.size, before - 1);
});
