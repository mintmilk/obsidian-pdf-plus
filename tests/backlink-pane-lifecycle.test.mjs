import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { transform } from 'esbuild';

class Component {
    _loaded = false; _events = []; _children = [];
    load() { this._loaded = true; return this.onload?.(); }
    register(callback) { this._events.push(callback); }
    registerDomEvent(el, type, callback) { el.addEventListener(type, callback); this.register(() => el.removeEventListener(type, callback)); }
    addChild(child) { this._children.push(child); if (this._loaded) child.load(); return child; }
    unload() {
        if (!this._loaded) return;
        this._loaded = false;
        while (this._children.length) this._children.pop().unload();
        while (this._events.length) this._events.pop()();
        this.onunload?.();
    }
}
class Element {
    listeners = new Map(); classes = new Set(); removed = false;
    addEventListener(type, callback) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(callback); }
    removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback); }
    dispatch(type) { for (const cb of [...this.listeners.get(type) ?? []]) cb({}); }
    addClass(name) { this.classes.add(name); } removeClass(name) { this.classes.delete(name); }
    toggleClass() {} remove() { this.removed = true; }
    count() { return [...this.listeners.values()].reduce((n, set) => n + set.size, 0); }
}
async function loadModule(path, imports) {
    const source = await readFile(new URL(path, import.meta.url), 'utf8');
    const { code } = await transform(source, { loader: 'ts', format: 'cjs' });
    const module = { exports: {} };
    runInNewContext(code, { module, exports: module.exports, require: name => imports[name] ?? {} });
    return module.exports;
}
const obsidian = { Component };
const component = await loadModule('../src/lib/component.ts', { obsidian });
const { PDFPlusLib } = await loadModule('../src/lib/index.ts', {});
const { BacklinkPanePDFPageTracker, BacklinkPanePDFManager } = await loadModule('../src/pdf-backlink.ts', {
    obsidian, 'lib/component': component,
    utils: { MutationObservingChild: class extends Component {}, isMouseEventExternal: () => true },
});
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function fixture() {
    const ready = deferred(), callbacks = [], listeners = new Set();
    const eventBus = { on: (_, cb) => listeners.add(cb), off: (_, cb) => listeners.delete(cb) };
    const leaf = { view: { viewer: { then: callback => callbacks.push(callback) } } };
    const plugin = { app: {}, settings: {}, lib: {
        workspace: { getExistingLeafForPDFFile: () => leaf, ensureViewLoaded: () => ready.promise }, isPDFView: () => true,
        registerPDFEvent: PDFPlusLib.prototype.registerPDFEvent,
    } };
    const renderer = { backlinkDom: { el: new Element() }, headerDom: { addNavButton: () => new Element() }, recomputeBacklink() {} };
    const child = { pdfViewer: { eventBus, pdfViewer: { currentPageNumber: 1 } } };
    return { ready, callbacks, listeners, plugin, renderer, child };
}

test('unload while a deferred PDF view loads prevents late filters, observers and subscriptions', async () => {
    const f = fixture(), tracker = new BacklinkPanePDFPageTracker(f.plugin, f.renderer, {});
    const loading = tracker.load(); tracker.unload(); f.ready.resolve(); await loading;
    for (const callback of f.callbacks) callback(f.child);
    assert.equal(f.renderer.backlinkDom.filter, undefined);
    assert.equal(f.listeners.size, 0);
    assert.equal(tracker._children.length, 0);
    assert.equal(tracker._events.length, 0);
});

test('unload between viewer.then registration and resolution cannot resurrect a page filter', async () => {
    const f = fixture(), tracker = new BacklinkPanePDFPageTracker(f.plugin, f.renderer, {});
    f.ready.resolve(); await tracker.load(); tracker.unload();
    for (const callback of f.callbacks) callback(f.child);
    assert.equal(f.renderer.backlinkDom.filter, undefined);
    assert.equal(f.listeners.size, 0);
    assert.equal(tracker._events.length, 0);
});

test('a previous filter generation cannot add duplicate listeners after reload', async () => {
    const f = fixture(), tracker = new BacklinkPanePDFPageTracker(f.plugin, f.renderer, {});
    f.ready.resolve(); await tracker.load(); tracker.unload(); await tracker.load();
    for (const callback of f.callbacks) callback(f.child);
    assert.equal(f.listeners.size, 1);
    assert.equal(tracker._children.length, 1);
    tracker.unload(); assert.equal(f.listeners.size, 0);
});

test('backlink hover cleanup releases all rectangles and ignores a viewer that becomes ready after mouseout', () => {
    const f = fixture(), callbacks = [], rectangles = [], link = new Element(), highlight = new Element();
    f.plugin.settings.highlightOnHoverBacklinkPane = true;
    f.plugin.lib.highlight = { viewer: { placeRectInPage: () => { const el = new Element(); rectangles.push(el); return el; } } };
    f.child.getPage = () => ({ annotationLayer: { annotationLayer: { getAnnotation: () => ({ data: { rect: [0, 0, 1, 1] } }) } } });
    const manager = new BacklinkPanePDFManager(f.plugin, f.renderer, {});
    manager.processBacklinkVisualizerDomForEvent = (_, callback) => callback(link, new Set([highlight]), {
        page: 1, annotation: { id: 'annot' }, FitR: { left: 0, bottom: 0, right: 1, top: 1 },
    }, { then: callback => callbacks.push(callback) });
    manager.load(); f.renderer.backlinkDom.el.dispatch('mouseover'); link.dispatch('mouseout');
    for (const callback of callbacks.splice(0)) callback(f.child);
    assert.equal(rectangles.length, 0, 'late viewer callback must not recreate a finished hover');
    f.renderer.backlinkDom.el.dispatch('mouseover');
    for (const callback of callbacks.splice(0)) callback(f.child);
    assert.equal(rectangles.length, 2);
    manager.unload();
    assert.ok(rectangles.every(el => el.removed));
    assert.equal(link.count(), 0);
    assert.equal(highlight.classes.size, 0);
});
