import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { transform } from 'esbuild';

class Component {
    _loaded = false; _events = []; _children = [];
    register(cb) { this._events.push(cb); }
    registerEvent(ref) { this.register(() => ref.owner.offref(ref)); }
    load() { if (this._loaded) return; this._loaded = true; this.onload?.(); }
    addChild(child) { this._children.push(child); if (this._loaded) child.load(); return child; }
    removeChild(child) { this._children = this._children.filter(c => c !== child); child.unload(); return child; }
    unload() { if (!this._loaded) return; this._loaded = false; while (this._children.length) this._children.pop().unload(); while (this._events.length) this._events.pop()(); this.onunload?.(); }
}
class Events {
    callbacks = new Map();
    on(name, cb) { if (!this.callbacks.has(name)) this.callbacks.set(name, new Set()); this.callbacks.get(name).add(cb); return { owner: this, name, cb }; }
    offref(ref) { this.callbacks.get(ref.name)?.delete(ref.cb); }
    trigger(name, ...args) { return Promise.all([...this.callbacks.get(name) ?? []].map(cb => cb(...args))); }
    count(name) { return this.callbacks.get(name)?.size ?? 0; }
}
function deferred() { let resolve; const promise = new Promise(r => resolve = r); return { resolve, promise }; }
async function loadModule(path, imports = {}, globals = {}) {
    const { code } = await transform(await readFile(new URL(path, import.meta.url), 'utf8'), { loader: 'ts', format: 'cjs' });
    const module = { exports: {} };
    runInNewContext(code, { module, exports: module.exports, console, TextEncoder, crypto: webcrypto, require: name => imports[name] ?? {}, ...globals });
    return module.exports;
}
const submodule = await loadModule('../src/lib/submodule.ts');
const obsidian = { Component, MarkdownView: class {} };
const { withFilesWithInlineFields } = await loadModule('../src/lib/dataview.ts', { obsidian, modals: { PDFPlusModal: class {} } });
const { copyLinkLib } = await loadModule('../src/lib/copy-link.ts', { obsidian, './submodule': submodule });
const timers = new Map(); let timerId = 0;
const { PDFPlusCommands } = await loadModule('../src/lib/commands.ts', { obsidian, './submodule': submodule }, {
    setTimeout: cb => { timers.set(++timerId, cb); return timerId; }, clearTimeout: id => timers.delete(id),
});
function fixture() {
    const plugin = new Component(); plugin.load();
    const workspace = new Events(), metadataCache = new Events(), layouts = [], query = deferred();
    let queries = 0;
    plugin.app = { workspace, metadataCache, plugins: { plugins: { dataview: { index: { initialized: false }, api: { query: () => { queries++; return query.promise; } } } } } };
    workspace.onLayoutReady = cb => layouts.push(cb);
    plugin.settings = { proxyMDProperty: 'pdf' };
    plugin.registerOneTimeEvent = (emitter, name, cb) => {
        const ref = emitter.on(name, (...args) => { emitter.offref(ref); return cb(...args); });
        plugin.register(() => emitter.offref(ref)); return () => emitter.offref(ref);
    };
    return { plugin, workspace, metadataCache, layouts, query, queries: () => queries };
}

test('Dataview layout callback cannot add a subscription after plugin unload', () => {
    const f = fixture(); withFilesWithInlineFields(f.plugin, () => assert.fail('late callback'));
    f.plugin.unload(); f.layouts[0]();
    assert.equal(f.metadataCache.count('dataview:index-ready'), 0);
    assert.equal(f.plugin._events.length, 0);
});

test('Dataview query completed after unload cannot open its result UI', async () => {
    const f = fixture(); let callbacks = 0;
    f.plugin.app.plugins.plugins.dataview.index.initialized = true;
    withFilesWithInlineFields(f.plugin, () => callbacks++); f.layouts[0]();
    assert.equal(f.queries(), 1);
    f.plugin.unload(); f.query.resolve({ successful: false }); await new Promise(setImmediate);
    assert.equal(callbacks, 0);
});

test('clipboard-history paste still triggers its earlier deferred action and unload releases waits', async () => {
    const f = fixture(), copy = Object.assign(Object.create(copyLinkLib.prototype), { plugin: f.plugin, app: f.plugin.app });
    const called = [];
    for (let index = 0; index < 30; index++) copy.watchPaste(`text-${index}`, () => called.push(index));
    assert.equal(f.workspace.count('editor-paste'), 30);
    await f.workspace.trigger('editor-paste', { clipboardData: { getData: () => 'text-0' } }, {}, { file: { extension: 'md' } });
    assert.deepEqual(called, [0]);
    assert.equal(f.workspace.count('editor-paste'), 0);
    assert.equal(f.plugin._children.length, 0);
    copy.watchPaste('last'); f.plugin.unload();
    assert.equal(f.workspace.count('editor-paste'), 0);
});

for (const resolved of [false, true]) test(`new-note hover editor wait is cancelled on unload (resolved=${resolved})`, async () => {
    const f = fixture(), file = {}, commands = Object.assign(Object.create(PDFPlusCommands.prototype), { plugin: f.plugin, app: f.plugin.app });
    f.workspace.getActiveFile = () => null;
    f.plugin.settings.howToOpenAutoFocusTargetIfNotOpened = 'hover-editor';
    f.plugin.app.fileManager = { getNewFileParent: () => '', createNewMarkdownFile: async () => file };
    await commands.createNewNote();
    if (resolved) f.metadataCache.trigger('resolve', file);
    f.plugin.unload();
    assert.equal(f.metadataCache.count('resolve'), 0);
    assert.equal(timers.size, 0);
});
