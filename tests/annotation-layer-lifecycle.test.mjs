import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { transform } from 'esbuild';
import ts from 'typescript';
import { around } from 'monkey-around';

class Component {
    _loaded = false;
    _events = [];
    _children = [];
    load() { this._loaded = true; this.onload?.(); }
    register(callback) { this._events.push(callback); }
    registerDomEvent(el, type, callback) {
        el.addEventListener(type, callback);
        this.register(() => el.removeEventListener(type, callback));
    }
    addChild(child) { this._children.push(child); if (this._loaded) child.load(); return child; }
    removeChild(child) { const i = this._children.indexOf(child); if (i >= 0) this._children.splice(i, 1); child.unload(); return child; }
    unload() {
        if (!this._loaded) return;
        this._loaded = false;
        for (const child of this._children.splice(0)) child.unload();
        for (const callback of this._events.splice(0)) callback();
    }
}
class Element {
    dataset = {};
    listeners = new Map();
    addEventListener(type, callback) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(callback); }
    removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback); }
    querySelectorAll() { return []; }
    count() { return [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0); }
    dispatch(type) {
        const event = { target: this, relatedTarget: null, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {} };
        return Promise.all([...this.listeners.get(type) ?? []].map(callback => callback(event)));
    }
}

const imports = { obsidian: { Component, Keymap: { isModEvent: () => 'tab' } }, 'monkey-around': { around } };
async function loadSource(path, suffix = '') {
    const source = await readFile(new URL(path, import.meta.url), 'utf8');
    const { code } = await transform(source + suffix, { loader: 'ts', format: 'cjs' });
    const module = { exports: {} };
    runInNewContext(code, { module, exports: module.exports, setTimeout, clearTimeout, require: name => imports[name] ?? {} });
    return module.exports;
}
imports.utils = await loadSource('../src/utils/events.ts');
imports['lib/component'] = await loadSource('../src/lib/component.ts');
const processors = await loadSource('../src/post-process/pdf-link-like.ts');
const { PDFExternalLinkPostProcessor } = await loadSource('../src/post-process/external-link.ts');

// Execute the installed PDF.js dependency's actual builder and page cancellation
// method. The wrapper below is not a reimplementation of keepAnnotationLayer.
const nativeSource = await readFile(new URL('../node_modules/pdfjs-dist/web/pdf_viewer.mjs', import.meta.url), 'utf8');
const ast = ts.createSourceFile('pdf_viewer.mjs', nativeSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const nativeClass = name => ast.statements.find(node => ts.isClassDeclaration(node) && node.name.text === name);
const NativeBuilder = runInNewContext(`(${nativeClass('AnnotationLayerBuilder').getText(ast)})`);
const cancelSource = nativeClass('PDFPageView').members.find(node => node.name?.getText(ast) === 'cancelRendering').getText(ast);
const NativePage = runInNewContext(`(class extends Base { ${cancelSource} })`, { Base: class { cancelRendering() {} } });

function fixture() {
    const component = new Component(); component.load();
    const opened = [], hovered = [];
    const child = { component, unloaded: false, opts: { isEmbed: false }, file: { path: 'sample.pdf' } };
    const plugin = {
        app: { plugins: { enabledPlugins: new Set(['surfing']) }, workspace: { openLinkText: (...args) => opened.push(args), trigger: (...args) => hovered.push(args) } },
        lib: { workspace: { iteratePDFViews() {} }, isCitationId: () => false },
        settings: { clickPDFInternalLinkWithModifierKey: true, enableHoverPDFInternalLink: true, recordPDFInternalLinkHistory: true, popoverPreviewOnExternalLinkHover: true },
    };
    function layer() {
        const builder = new NativeBuilder({ linkService: { eventBus: {} } }); builder.div = new Element();
        const page = new NativePage(); page.annotationLayer = builder;
        // The fallback runs the pre-fix source through its existing viewer owner,
        // so the regression fails on retained handlers, rather than a missing API.
        const owner = processors.getAnnotationLayerComponent?.(child, builder) ?? component;
        const internal = new Element(), external = new Element(), popup = new Element();
        const processor = processors.PDFInternalLinkPostProcessor.registerEvents(plugin, child, { container: internal, data: { subtype: 'Link', dest: 'section-1' } }, owner);
        processor.getLinkText = async () => 'sample.pdf#page=2';
        PDFExternalLinkPostProcessor.registerEvents(plugin, child, { container: external, data: { subtype: 'Link', url: 'https://example.com/' } }, owner);
        let popups = 0, removed = 0;
        imports.utils.showChildElOnParentElHover({ parentEl: popup, component: owner, createChildEl: () => { popups++; return new Element(); }, removeChildEl: () => removed++ });
        return { builder, page, owner, internal, external, popup, processor, popups: () => popups, removed: () => removed };
    }
    return { component, child, plugin, opened, hovered, layer, close() { child.unloaded = true; component.unload(); child.component = undefined; } };
}

test('native annotation cancellation releases internal/external/popup handlers while the PDF stays open', async () => {
    const f = fixture(), layer = f.layer();
    try {
        await layer.internal.dispatch('click'); await layer.internal.dispatch('mouseover'); await layer.external.dispatch('mouseover'); await layer.popup.dispatch('mouseover');
        assert.equal(f.opened.length, 1); assert.equal(f.hovered.length, 2); assert.equal(layer.popups(), 1);
        layer.page.cancelRendering();
        assert.equal(layer.page.annotationLayer, null, 'native PDF.js discarded this annotation builder');
        assert.equal(layer.builder._cancelled, true);
        assert.equal(layer.internal.count(), 0, 'discarded annotation must not retain internal-link handlers');
        assert.equal(layer.external.count(), 0); assert.equal(layer.popup.count(), 0);
        assert.equal(layer.removed(), 1, 'an open annotation popup is removed with its layer');
        assert.equal(f.component._children.length, 0, 'postprocessor and popup components leave the still-live viewer');
        await layer.internal.dispatch('click'); await layer.external.dispatch('mouseover'); await layer.popup.dispatch('mouseover');
        assert.equal(f.opened.length, 1); assert.equal(f.hovered.length, 2); assert.equal(layer.popups(), 1);
    } finally { f.close(); }
});

test('native keepAnnotationLayer preserves one owner and working handlers until actual cancellation', async () => {
    const f = fixture(), layer = f.layer();
    try {
        layer.page.cancelRendering({ keepAnnotationLayer: true });
        assert.equal(layer.page.annotationLayer, layer.builder); assert.equal(layer.builder._cancelled, false);
        const retained = processors.getAnnotationLayerComponent?.(f.child, layer.builder) ?? f.component;
        assert.equal(retained, layer.owner);
        await layer.internal.dispatch('click'); await layer.external.dispatch('mouseover');
        assert.equal(f.opened.length, 1); assert.equal(f.hovered.length, 1);
        layer.page.cancelRendering();
        assert.equal(layer.internal.count(), 0);
    } finally { f.close(); }
});

for (const event of ['click', 'mouseover']) test(`pending internal ${event} cannot open anything after its annotation layer is replaced`, async () => {
    const f = fixture(), layer = f.layer();
    let resolve, entered;
    const destination = new Promise(r => { resolve = r; });
    const started = new Promise(r => { entered = r; });
    layer.processor.getLinkText = () => { entered(); return destination; };
    const pending = layer.internal.dispatch(event);
    try {
        await started; layer.page.cancelRendering(); resolve('sample.pdf#page=3'); await pending;
        assert.equal(f.opened.length, 0); assert.equal(f.hovered.length, 0);
    } finally { resolve(null); await pending; f.close(); }
});

test('forty native layer rebuilds do not accumulate viewer callbacks or children', () => {
    const f = fixture(), baseline = f.component._events.length;
    try {
        for (let i = 0; i < 40; i++) {
            const layer = f.layer(); layer.page.cancelRendering();
            assert.equal(f.component._children.length, 0, `retained children after layer ${i}`);
            assert.equal(f.component._events.length, baseline, `retained cleanup callbacks after layer ${i}`);
            assert.equal(processors.getAnnotationLayerComponent?.(f.child, layer.builder), undefined, 'a cancelled layer cannot get a fresh owner');
        }
    } finally { f.close(); }
});

test('viewer unload restores the native cancel method and cannot create a new layer owner', () => {
    const f = fixture(), layer = f.layer();
    f.close();
    assert.equal(layer.builder.cancel, NativeBuilder.prototype.cancel);
    assert.equal(layer.internal.count(), 0); assert.equal(layer.external.count(), 0); assert.equal(layer.popup.count(), 0);
    assert.equal(processors.getAnnotationLayerComponent?.(f.child, layer.builder), undefined);
});

test('the actual annotationlayerrendered installer assigns all postprocessors to the native layer', async () => {
    imports['post-process'] = { ...processors, PDFExternalLinkPostProcessor };
    imports.bib = { BibliographyManager: class extends Component {} };
    imports.utils.isEmbed = () => false;
    imports.utils.isNonEmbedLike = () => false;
    imports.obsidian.Platform = { isPhone: false };
    const { PDFPlusLib } = await loadSource('../src/lib/index.ts');
    const { patchPDFViewerChild } = await loadSource('../src/patchers/pdf-internals.ts', '\nexport { patchPDFViewerChild };');
    class ViewerChild { async loadFile(file) { this.file = file; } }
    class EventBus {
        callbacks = new Map();
        on(type, callback) { if (!this.callbacks.has(type)) this.callbacks.set(type, new Set()); this.callbacks.get(type).add(callback); }
        off(type, callback) { this.callbacks.get(type)?.delete(callback); }
        dispatch(type, data) { return Promise.all([...this.callbacks.get(type) ?? []].map(callback => callback(data))); }
    }
    const f = fixture(), patchCleanups = [];
    Object.setPrototypeOf(f.child, ViewerChild.prototype);
    const bus = new EventBus();
    f.child.pdfViewer = { eventBus: bus, pdfViewer: { pdfDocument: {} } };
    f.child.containerEl = { querySelector: () => null };
    f.plugin.register = callback => patchCleanups.push(callback);
    f.plugin.lib.registerPDFEvent = PDFPlusLib.prototype.registerPDFEvent;
    f.plugin.lib.destIdToSubpath = async () => '#page=2';
    f.plugin.settings.showAnnotationPopupOnHover = true;
    patchPDFViewerChild(f.plugin, f.child);
    try {
        await f.child.loadFile({ path: 'sample.pdf', stat: { size: 1000 } });
        const baselineChildren = f.component._children.length, baselineEvents = f.component._events.length;
        const builder = new NativeBuilder({ linkService: { eventBus: bus } });
        const internal = new Element(), external = new Element(), popup = new Element();
        internal.dataset = { annotationId: 'internal', internalLink: '' };
        external.dataset = { annotationId: 'external' }; popup.dataset = { annotationId: 'popup' };
        const annotations = new Map([
            ['internal', { container: internal, data: { subtype: 'Link', dest: 'section-1' } }],
            ['external', { container: external, data: { subtype: 'Link', url: 'https://example.com/' } }],
            ['popup', { container: popup, data: { subtype: 'Text', contentsObj: { str: 'Fixture annotation' } } }],
        ]);
        builder.div = { querySelectorAll: () => [internal, external, popup] };
        builder.annotationLayer = { getAnnotation: id => annotations.get(id) };
        const page = new NativePage(); page.annotationLayer = builder;
        await bus.dispatch('annotationlayerrendered', { source: page, pageNumber: 1 });
        await bus.dispatch('annotationlayerrendered', { source: page, pageNumber: 1 });
        assert.equal(internal.count(), 3); assert.equal(external.count(), 1); assert.equal(popup.count(), 1);
        assert.equal(f.component._children.length, baselineChildren + 1, 'one shared layer owner despite repeated render events');
        await internal.dispatch('click'); await external.dispatch('mouseover');
        assert.equal(f.opened.length, 1); assert.equal(f.hovered.length, 1);
        page.cancelRendering();
        assert.equal(internal.count(), 0); assert.equal(external.count(), 0); assert.equal(popup.count(), 0);
        assert.equal(f.component._children.length, baselineChildren);
        assert.equal(f.component._events.length, baselineEvents);
        assert.equal(internal.dataset.pdfPlusIsAnnotationPostProcessed, undefined);
        await bus.dispatch('annotationlayerrendered', { source: page, pageNumber: 1 });
        assert.equal(f.component._children.length, baselineChildren, 'late events on a cancelled page cannot recreate processors');
    } finally {
        f.close();
        patchCleanups.reverse().forEach(cleanup => cleanup());
    }
});
