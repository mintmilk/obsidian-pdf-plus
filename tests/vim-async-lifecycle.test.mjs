import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { transform } from 'esbuild';

class Component {
    _loaded = false; _events = []; _children = [];
    register(cb) { this._events.push(cb); }
    registerEvent(ref) { this.register(() => ref.owner.off(ref.name, ref.cb)); }
    registerDomEvent(el, name, cb, options) { el.addEventListener(name, cb, options); this.register(() => el.removeEventListener(name, cb, options)); }
    load() { if (this._loaded) return; this._loaded = true; this.onload?.(); }
    addChild(child) { this._children.push(child); if (this._loaded) child.load(); return child; }
    removeChild(child) { this._children = this._children.filter(c => c !== child); child.unload(); return child; }
    unload() { if (!this._loaded) return; this._loaded = false; while (this._children.length) this._children.pop().unload(); while (this._events.length) this._events.pop()(); this.onunload?.(); }
}
class Events {
    callbacks = new Map();
    on(name, cb) { if (!this.callbacks.has(name)) this.callbacks.set(name, new Set()); this.callbacks.get(name).add(cb); return { owner: this, name, cb }; }
    off(name, cb) { this.callbacks.get(name)?.delete(cb); }
    trigger(name, data) { for (const cb of [...this.callbacks.get(name) ?? []]) cb(data); }
    count(name) { return this.callbacks.get(name)?.size ?? 0; }
}
class Element extends Events {
    value = ''; inputEl = this;
    addEventListener(name, cb, capture) { this.on(name + ':' + !!capture, cb); }
    removeEventListener(name, cb, capture) { this.off(name + ':' + !!capture, cb); }
    createDiv(_, cb) { const el = new Element(); cb?.(el); return el; }
    createEl(_, opts, cb) { const el = new Element(); cb?.(el); return el; }
    appendText() {} hide() {} remove() {} select() {}
}
class Suggest {
    closed = 0; scope = { keys: [] };
    onSelect() { return this; }
    close() { this.closed++; }
}
async function loadModule(path, imports = {}, globals = {}) {
    const { code } = await transform(await readFile(new URL(path, import.meta.url), 'utf8'), { loader: 'ts', format: 'cjs' });
    const module = { exports: {} };
    runInNewContext(code, { module, exports: module.exports, console, require: name => imports[name] ?? {}, ...globals });
    return module.exports;
}
const obsidian = { Component, normalizePath: p => p, debounce: fn => fn };
const component = await loadModule('../src/lib/component.ts', { obsidian });
const mode = await loadModule('../src/vim/mode.ts', { 'lib/component': component });
const { PDFPlusLib } = await loadModule('../src/lib/index.ts', { obsidian });
function deferred() { let resolve; const promise = new Promise(r => resolve = r); return { resolve, promise }; }
async function fixture() {
    const timers = new Map(); let nextTimer = 0;
    const clock = { setTimeout: cb => { timers.set(++nextTimer, cb); return nextTimer; }, clearTimeout: id => timers.delete(id) };
    const { VimCommandLineMode } = await loadModule('../src/vim/command-line.ts', { obsidian, './mode': mode, './ex-commands': { exCommands: () => [] }, utils: { FuzzyInputSuggest: Suggest } }, clock);
    const { VimOutlineMode } = await loadModule('../src/vim/outline.ts', { './mode': mode, 'pdfjs-enums': { SidebarView: { OUTLINE: 2 } } });
    const { VimSearch } = await loadModule('../src/vim/search.ts', { obsidian }, clock);
    const { PDFDocumentTextStructureParser } = await loadModule('../src/vim/text-structure-parser.ts', { 'lib/component': component, utils: { getTextLayerInfo: layer => layer } });
    const vim = new Component(); vim.load();
    const callbacks = [], events = new Events(), read = deferred(), input = new Element(), originalChange = () => {};
    const findBar = { eventBus: events, opened: false, searchSettings: {}, showSearch() { this.opened = true; },
        searchComponent: { inputEl: input, changeCallback: originalChange, onChange(cb) { this.changeCallback = cb; } } };
    const child = { pdfViewer: { eventBus: events, pdfViewer: { pagesCount: 0 } } };
    const plugin = { vimrc: null, settings: { vimrcPath: 'vimrc', vimIncsearch: false }, app: { vault: { on: events.on.bind(events), adapter: { read: () => read.promise } } },
        lib: { registerPDFEvent: PDFPlusLib.prototype.registerPDFEvent, updateSearchSettingsUI() {} } };
    Object.assign(vim, { plugin, lib: plugin.lib, settings: plugin.settings, obsidianViewer: { findBar },
        viewer: { containerEl: new Element(), then: cb => callbacks.push(cb) },
        vimScope: { registerKeymaps() {}, noremap() {} }, visualMode: { rememberSelection() {} } });
    return { VimCommandLineMode, VimOutlineMode, VimSearch, PDFDocumentTextStructureParser, vim, plugin, callbacks, child, events, read, timers, findBar, input, originalChange };
}

test('Vim outline ignores a viewer that arrives after mode unload', async () => {
    const f = await fixture(), mode = f.vim.addChild(new f.VimOutlineMode(f.vim));
    mode.unload(); f.callbacks.forEach(cb => cb(f.child));
    assert.equal(f.events.count('sidebarviewchanged'), 0);
    assert.equal(mode._events.length, 0);
});

test('Vim command line closes its suggest and ignores late viewer initialization', async () => {
    const f = await fixture(), mode = f.vim.addChild(new f.VimCommandLineMode(f.vim));
    mode.unload(); f.callbacks.forEach(cb => cb(f.child));
    assert.equal(f.events.count('pagesloaded'), 0);
    assert.equal(mode.suggest.closed, 1);
});

test('Vimrc readiness runs once and unloading cancels its pending timer', async () => {
    const f = await fixture(), mode = f.vim.addChild(new f.VimCommandLineMode(f.vim));
    f.callbacks.forEach(cb => cb(f.child)); f.events.trigger('pagesloaded');
    assert.equal(f.events.count('pagesloaded'), 0);
    assert.equal(f.timers.size, 1);
    mode.unload(); assert.equal(f.timers.size, 0);
});

test('Vimrc reading completed after unload cannot run commands', async () => {
    const f = await fixture(), mode = f.vim.addChild(new f.VimCommandLineMode(f.vim)); let scripts = 0;
    mode.runScript = () => scripts++;
    f.callbacks.forEach(cb => cb(f.child)); f.events.trigger('pagesloaded');
    const jobs = [...f.timers.values()]; f.timers.clear(); jobs.forEach(cb => cb());
    mode.unload(); f.read.resolve('set ignorecase'); await new Promise(setImmediate);
    assert.equal(scripts, 0);
});

test('Vim search unload releases capture listener and restores the native change callback', async () => {
    const f = await fixture(), search = new f.VimSearch(f.vim);
    search.start(true); assert.equal(f.input.count('keypress:true'), 1);
    f.vim.unload();
    assert.equal(f.input.count('keypress:true'), 0);
    assert.equal(f.events.count('findbarclose'), 0);
    assert.equal(f.findBar.searchComponent.changeCallback, f.originalChange);
});

test('Vim search closing each session leaves no child owners or per-session cleanup callbacks', async () => {
    const f = await fixture(), search = new f.VimSearch(f.vim);
    for (let i = 0; i < 30; i++) { search.start(true); f.findBar.opened = false; f.events.trigger('findbarclose'); }
    assert.equal(f.vim._children.length, 0);
    assert.ok(f.vim._events.length <= 1);
    assert.equal(f.input.count('keypress:true'), 0);
});

test('Vim search delayed selection actions are cancelled on unload', async () => {
    const f = await fixture(), search = new f.VimSearch(f.vim);
    search.restoreSelectionAndExtendToMatch(); search.findAndSelectNextMatch();
    assert.equal(f.timers.size, 2); f.vim.unload(); assert.equal(f.timers.size, 0);
});

test('Vim text parser replaces stale text-layer nodes and clears page data on unload', async () => {
    const f = await fixture();
    const page = { textLayer: { textContentItems: [], textDivs: [{}] } };
    const parser = new f.PDFDocumentTextStructureParser(f.plugin, { getPageView: () => page }, {}); parser.load();
    const first = parser.getPageParser(1);
    page.textLayer = { textContentItems: [], textDivs: [{}] };
    const next = parser.getPageParser(1); assert.notEqual(first, next);
    assert.equal(next.divs, page.textLayer.textDivs);
    page.textLayer = null; assert.equal(parser.getPageParser(1), undefined);
    assert.equal(parser.pages.size, 0);
    parser.pages.set(1, next); parser.unload(); assert.equal(parser.pages.size, 0);
});
