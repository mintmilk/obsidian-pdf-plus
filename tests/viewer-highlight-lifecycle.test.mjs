import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { transform } from 'esbuild';

class Component {
    children = new Set();
    cleanups = [];
    loaded = false;
    load() { this.loaded = true; }
    register(fn) { this.cleanups.push(fn); }
    addChild(child) { this.children.add(child); if (this.loaded) child.load(); return child; }
    removeChild(child) { if (this.children.delete(child)) child.unload(); }
    unload() {
        if (!this.loaded) return;
        this.loaded = false;
        for (const child of [...this.children]) this.removeChild(child);
        this.cleanups.splice(0).forEach(fn => fn());
    }
}
class Submodule { constructor(plugin) { this.plugin = plugin; } get lib() { return this.plugin.lib; } get settings() { return this.plugin.settings; } }
const source = await readFile(new URL('../src/lib/highlights/viewer.ts', import.meta.url), 'utf8');
const { code } = await transform(source, { loader: 'ts', format: 'cjs' });
function fixture(type, ready = false) {
    const timers = new Map();
    let nextTimer = 0;
    const timerWindow = { setTimeout: fn => { timers.set(++nextTimer, fn); return nextTimer; }, clearTimeout: id => timers.delete(id) };
    const module = { exports: {} };
    runInNewContext(code, {
        module, exports: module.exports, activeWindow: timerWindow,
        setTimeout: timerWindow.setTimeout, clearTimeout: timerWindow.clearTimeout,
        require: name => name === 'obsidian' ? { Component } : name === 'lib/submodule' ? { PDFPlusLibSubmodule: Submodule } : {},
    });
    const listeners = new Set();
    const registerReady = (viewer, component, fn) => {
        // Match the real helpers: existing pages are visited BEFORE registration.
        if (ready) fn(1);
        listeners.add(fn);
        component.register(() => listeners.delete(fn));
    };
    const parent = new Component(); parent.load();
    const calls = [];
    const child = {
        component: parent, unloaded: false, pdfViewer: {},
        subpathHighlight: { type, page: 1, range: {}, id: 'annotation', rect: [0, 0, 1, 1] },
        getPage: () => ({ div: { dataset: { loaded: true } } }),
        highlightText: () => calls.push('highlight'), highlightAnnotation: () => calls.push('highlight'),
        clearTextHighlight: () => calls.push('clear'), clearAnnotationHighlight: () => calls.push('clear'),
    };
    const plugin = { settings: {}, lib: { onTextLayerReady: registerReady, onAnnotationLayerReady: registerReady, onPageReady: registerReady } };
    const viewer = new module.exports.ViewerHighlightLib(plugin);
    viewer.highlightRect = () => calls.push('highlight');
    viewer.clearRectHighlight = () => calls.push('clear');
    return { viewer, child, parent, calls, timers, listeners,
        ready() { for (const fn of [...listeners]) fn(1); },
        close() { child.unloaded = true; child.component = undefined; parent.unload(); },
    };
}

for (const type of ['text', 'annotation', 'rect']) {
    test(`${type}: closing before the target page is ready removes its listener`, () => {
        const f = fixture(type);
        f.viewer.highlightSubpath(f.child, 5);
        f.close(); f.ready();
        assert.equal(f.listeners.size, 0);
        assert.equal(f.timers.size, 0);
        assert.deepEqual(f.calls, []);
    });
    test(`${type}: an already rendered page leaves no once listener or component`, () => {
        const f = fixture(type, true);
        f.viewer.highlightSubpath(f.child, 0);
        assert.deepEqual(f.calls, ['highlight']);
        assert.equal(f.listeners.size, 0);
        assert.equal(f.parent.children.size, 0);
    });
    test(`${type}: replacement is bounded and viewer close cancels the highlight timer`, () => {
        const f = fixture(type);
        for (let i = 0; i < 20; i++) f.viewer.highlightSubpath(f.child, 5);
        assert.equal(f.listeners.size, 1);
        f.ready();
        assert.equal(f.listeners.size, 0);
        assert.equal(f.timers.size, 1);
        f.close();
        assert.equal(f.timers.size, 0);
        assert.equal(f.parent.children.size, 0);
    });
}
