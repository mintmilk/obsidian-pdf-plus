import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { transform } from 'esbuild';

class Component {
    _events = [];
    _children = [];
    load() { this.onload?.(); }
    register(callback) { this._events.push(callback); }
    registerDomEvent(el, type, callback, options) {
        el.addEventListener(type, callback, options);
        this.register(() => el.removeEventListener(type, callback, options));
    }
    addChild(child) { this._children.push(child); child.load(); return child; }
    removeChild(child) { this._children = this._children.filter(item => item !== child); child.unload(); return child; }
    unload() {
        this.onunload?.();
        while (this._children.length) this.removeChild(this._children[0]);
        while (this._events.length) this._events.pop()();
    }
}

class Element {
    listeners = [];
    dataset = {};
    addEventListener(type, callback, options = false) {
        const capture = typeof options === 'boolean' ? options : !!options.capture;
        if (!this.listeners.some(ref => ref.type === type && ref.callback === callback && ref.capture === capture)) {
            this.listeners.push({ type, callback, capture });
        }
    }
    removeEventListener(type, callback, options = false) {
        const capture = typeof options === 'boolean' ? options : !!options.capture;
        this.listeners = this.listeners.filter(ref => ref.type !== type || ref.callback !== callback || ref.capture !== capture);
    }
    dispatch(type) { for (const ref of [...this.listeners]) if (ref.type === type) ref.callback({}); }
    closest() { return true; }
    remove() { this.removed = true; }
    addClass() {}
    removeClass() {}
    setCssProps() {}
}

async function loadModule(relativePath, imports) {
    const source = await readFile(new URL(relativePath, import.meta.url), 'utf8');
    const { code } = await transform(source, { loader: 'ts', format: 'cjs' });
    const module = { exports: {} };
    runInNewContext(code, { module, exports: module.exports, require: name => imports[name] ?? {} });
    return module.exports;
}

const obsidian = { Component };
const maps = await loadModule('../src/utils/maps.ts', {});
const componentModule = await loadModule('../src/lib/component.ts', { obsidian });
const { BacklinkDomManager, PDFViewerBacklinkVisualizer } = await loadModule('../src/backlink-visualizer.ts', {
    obsidian,
    utils: maps,
    'lib/component': componentModule,
});
const { PDFPlusLib } = await loadModule('../src/lib/index.ts', {
    'lib/component': componentModule,
    'pdf-cropped-embed': { PDFCroppedEmbed: class {} },
});

function fixture() {
    const plugin = { app: { workspace: { trigger() {} } }, settings: {}, lib: {} };
    const visualizer = { plugin, file: { path: 'fixture.pdf' }, child: { getPage: () => ({ div: { querySelector: () => null } }) } };
    return new BacklinkDomManager(visualizer);
}

function cache(page, annotation = false) {
    return { page, annotation: annotation ? { id: 'annotation' } : undefined, refCache: {}, sourcePath: 'source.md', getColor: () => null };
}

function cleanupCount(manager) {
    return manager._events.length + [...manager.pagewiseOnClearDomCallbacksMap].reduce((total, [, callbacks]) => total + callbacks.size, 0);
}

for (const annotation of [false, true]) {
    test(`20 redraws release old backlink DOM and cleanup closures (annotation=${annotation})`, () => {
        const manager = fixture();
        for (let round = 0; round < 20; round++) {
            const el = new Element();
            manager.getCacheToDomsMap(1).addValue(cache(1, annotation), el);
            manager.postProcessPage(1);
            assert.ok(el.listeners.length > 0);
            manager.clearDomInPage(1);
            assert.equal(el.listeners.length, 0, `round ${round}: old DOM still has listeners`);
            assert.equal(cleanupCount(manager), 0, `round ${round}: old cleanup closures remain`);
        }
        manager.unload();
    });
}

test('page cleanup matches capture options and leaves unrelated listeners intact', () => {
    const manager = fixture();
    const el = new Element();
    const callback = () => {};
    el.addEventListener('click', callback, false);
    manager.registerDomEventForCache(cache(1, true), el, 'click', callback, { capture: true, passive: true });
    manager.clearDomInPage(1);
    assert.equal(el.listeners.length, 1);
    assert.equal(el.listeners[0].capture, false);
    assert.equal(cleanupCount(manager), 0);
});

test('clearing one page preserves the other and view unload releases every page', () => {
    const manager = fixture();
    const elements = [new Element(), new Element()];
    for (let index = 0; index < elements.length; index++) {
        manager.getCacheToDomsMap(index + 1).addValue(cache(index + 1, true), elements[index]);
        manager.postProcessPage(index + 1);
    }
    const secondCount = elements[1].listeners.length;
    manager.clearDomInPage(1);
    assert.equal(elements[0].listeners.length, 0);
    assert.equal(elements[1].listeners.length, secondCount);
    manager.unload();
    assert.equal(elements[1].listeners.length, 0);
    assert.equal(cleanupCount(manager), 0);
    assert.equal(manager.pagewiseCacheToDomsMap.size, 0);
    assert.equal(manager.pagewiseStatus.size, 0);
});

test('repeated post-processing does not duplicate handlers and can rebind a surviving annotation after clear', () => {
    const manager = fixture();
    const el = new Element();
    const backlink = cache(1, true);
    manager.getCacheToDomsMap(1).addValue(backlink, el);
    manager.postProcessPage(1);
    const listenerCount = el.listeners.length;
    const registeredCount = cleanupCount(manager);
    for (let index = 0; index < 20; index++) manager.postProcessPage(1);
    assert.equal(el.listeners.length, listenerCount);
    assert.equal(cleanupCount(manager), registeredCount);
    manager.clearDomInPage(1);
    manager.getCacheToDomsMap(1).addValue(backlink, el);
    manager.postProcessPage(1);
    assert.equal(el.listeners.length, listenerCount);
    manager.unload();
});

test('page clear callbacks are consumed once, including callback-only pages on unload', () => {
    const manager = fixture();
    let calls = 0;
    manager.onClearDomInPage(1, () => calls++);
    manager.clearDomInPage(1);
    manager.clearDomInPage(1);
    assert.equal(calls, 1);
    manager.onClearDomInPage(2, () => calls++);
    manager.unload();
    assert.equal(calls, 2);
    assert.equal(cleanupCount(manager), 0);
});

test('hover exit releases its temporary cleanup and page clear removes a pending hover exit', () => {
    const manager = fixture();
    const el = new Element();
    const backlink = cache(1);
    manager.getCacheToDomsMap(1).addValue(backlink, el);
    manager.postProcessPage(1);
    const registeredCount = cleanupCount(manager);
    for (let index = 0; index < 20; index++) {
        el.dispatch('mouseover');
        el.dispatch('mouseout');
        assert.equal(cleanupCount(manager), registeredCount);
    }
    el.dispatch('mouseover');
    manager.clearDomInPage(1);
    assert.equal(el.listeners.length, 0);
    assert.equal(cleanupCount(manager), 0);
});

test('repeated real visualize calls replace PDF render event ownership', () => {
    const listeners = new Map();
    const eventBus = {
        on(name, callback) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(callback); },
        off(name, callback) { listeners.get(name)?.delete(callback); },
    };
    const lib = Object.create(PDFPlusLib.prototype);
    const plugin = { lib, app: {}, settings: {} };
    const child = { pdfViewer: { pdfViewer: { _pages: [] }, eventBus } };
    const visualizer = new PDFViewerBacklinkVisualizer(plugin, { path: 'fixture.pdf' }, child);
    for (let index = 0; index < 20; index++) {
        visualizer.visualize();
        assert.equal(listeners.get('pagerendered').size, 1);
        assert.equal(listeners.get('textlayerrendered').size, 1);
        assert.equal(listeners.get('annotationlayerrendered').size, 1);
    }
    visualizer.unload();
    assert.ok([...listeners.values()].every(callbacks => callbacks.size === 0));
    assert.equal(visualizer._events.length, 0);
    assert.equal(visualizer._children.length, 0);
});
