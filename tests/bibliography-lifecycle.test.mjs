import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { transform } from 'esbuild';

class Component {
    _loaded = false; _events = []; _children = [];
    load() { this._loaded = true; this.onload?.(); }
    register(callback) { this._events.push(callback); }
    addChild(child) { this._children.push(child); if (this._loaded) child.load(); return child; }
    removeChild(child) { this._children = this._children.filter(item => item !== child); child.unload(); return child; }
    unload() {
        if (!this._loaded) return;
        this._loaded = false;
        while (this._children.length) this.removeChild(this._children[0]);
        while (this._events.length) this._events.pop()();
        this.onunload?.();
    }
}
class Events { on() {} trigger() {} }
class FileSystemAdapter {
    static async mkdir() {}
    files = new Set(); writes = 0;
    getFullPath(path) { return path; }
    async write(path) { this.writes++; this.files.add(path); }
    async remove(path) { this.files.delete(path); }
}
async function loadModule(path, imports, globals = {}) {
    const source = await readFile(new URL(path, import.meta.url), 'utf8');
    const { code } = await transform(source, { loader: 'ts', format: 'cjs' });
    const module = { exports: {} };
    runInNewContext(code, { module, exports: module.exports, console, require: name => imports[name] ?? {}, ...globals });
    return module.exports;
}
const obsidian = { Component, Events, FileSystemAdapter, Platform: { isDesktopApp: true }, Notice: class {} };
const component = await loadModule('../src/lib/component.ts', { obsidian });
const { PDFPlusLib } = await loadModule('../src/lib/index.ts', { obsidian });
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
const tick = () => new Promise(resolve => setImmediate(resolve));

test('document-ready ownership removes a queued callback on unload', () => {
    const owner = new Component(); owner.load();
    const viewer = {}, lib = Object.create(PDFPlusLib.prototype);
    let calls = 0;
    lib.onDocumentReady(viewer, () => calls++, owner);
    assert.equal(viewer.pdfPlusCallbacksOnDocumentLoaded.length, 1);
    owner.unload();
    assert.equal(viewer.pdfPlusCallbacksOnDocumentLoaded.length, 0);
    assert.equal(calls, 0);
});

test('cancelled document-loading continuations do not retain a callable owner callback', () => {
    let ready;
    const owner = new Component(); owner.load();
    const viewer = { pdfLoadingTask: { promise: { then(callback) { ready = callback; } } } };
    let calls = 0;
    PDFPlusLib.prototype.onDocumentReady.call({}, viewer, () => calls++, owner);
    owner.unload(); ready({});
    assert.equal(calls, 0);
});

test('document-ready rejection reports the error and releases its task owner', () => {
    let reject;
    const owner = new Component(); owner.load();
    const viewer = { pdfLoadingTask: { promise: { then(_, callback) { reject = callback; } } } };
    const errors = [], error = new Error('loading failed');
    PDFPlusLib.prototype.onDocumentReady.call({}, viewer, () => {}, owner, error => errors.push(error));
    reject?.(error);
    assert.deepEqual(errors, [error]);
    assert.equal(owner._children.length, 0);
});

test('completing a document queue does not skip the next owned callback', () => {
    const owner = new Component(); owner.load();
    const viewer = {}, calls = [];
    PDFPlusLib.prototype.onDocumentReady.call({}, viewer, () => calls.push(1), owner);
    PDFPlusLib.prototype.onDocumentReady.call({}, viewer, () => calls.push(2), owner);
    viewer.pdfPlusCallbacksOnDocumentLoaded.forEach(callback => callback({}));
    assert.deepEqual(calls, [1, 2]);
    assert.equal(owner._children.length, 0);
});

async function fixture(enabled = false) {
    const adapter = new FileSystemAdapter(), processes = [];
    const { BibliographyManager } = await loadModule('../src/bib.ts', {
        obsidian, 'lib/component': component,
        utils: { isNonEmbedLike: () => true, genId: () => 'fixture' },
        child_process: { spawn() {
            const process = new EventEmitter(); process.stdout = new EventEmitter(); process.kills = 0;
            process.kill = () => { process.kills++; };
            processes.push(process); return process;
        } },
    });
    const plugin = {
        app: { vault: { adapter } }, settings: { actionOnCitationHover: enabled ? 'pdf-plus-bib-popover' : 'none', anystylePath: '/mock/anystyle' },
        manifest: { name: 'test' }, getAnyStyleInputDir: () => '/mock/inputs',
        lib: { onDocumentReady: PDFPlusLib.prototype.onDocumentReady },
    };
    const child = { pdfViewer: {} };
    const manager = new BibliographyManager(plugin, child); manager.load();
    return { manager, adapter, processes, child };
}

test('unloaded bibliography does not begin extraction when the PDF eventually becomes ready', async () => {
    const f = await fixture(true);
    const callbacks = [...f.child.pdfViewer.pdfPlusCallbacksOnDocumentLoaded];
    let reads = 0;
    f.manager.unload();
    for (const callback of callbacks) callback({ getDestinations: async () => { reads++; return {}; } });
    await tick();
    assert.equal(reads, 0);
    assert.equal(f.processes.length, 0);
});

for (const stage of ['mkdir', 'write']) test(`unload during bibliography ${stage} prevents late process creation and removes temporary input`, async () => {
    const f = await fixture(), pending = deferred(), mkdir = FileSystemAdapter.mkdir;
    if (stage === 'mkdir') FileSystemAdapter.mkdir = () => pending.promise;
    else f.adapter.write = async path => { f.adapter.files.add(path); await pending.promise; };
    try {
        const result = f.manager.parseBibliographyText('citation');
        await tick(); f.manager.unload(); pending.resolve(); await tick();
        assert.equal(f.processes.length, 0);
        assert.equal(f.adapter.files.size, 0);
        assert.equal(await result, null);
    } finally { FileSystemAdapter.mkdir = mkdir; pending.resolve(); f.manager.unload(); }
});

test('unload kills an unfinished bibliography process, settles its task and removes listeners/input', async () => {
    const f = await fixture();
    const result = f.manager.parseBibliographyText('citation'); await tick();
    const process = f.processes[0]; f.manager.unload(); await tick();
    assert.equal(process.kills, 1);
    assert.equal(await result, null);
    assert.equal(process.stdout.listenerCount('data'), 0);
    process.emit('close', -1);
    assert.equal(process.listenerCount('close'), 0);
    assert.equal(f.adapter.files.size, 0);
});

for (const outcome of ['success', 'invalid-json', 'error']) test(`bibliography process ${outcome} settles and releases resources immediately`, async () => {
    const f = await fixture();
    const result = f.manager.parseBibliographyText('citation'); await tick();
    const process = f.processes[0];
    try {
        if (outcome === 'error') process.emit('error', Object.assign(new Error('denied'), { code: 'EACCES' }));
        else {
            process.stdout.emit('data', Buffer.from(outcome === 'success' ? '[{"date":["2024"]}]' : 'invalid'));
            assert.doesNotThrow(() => process.emit('close', 0));
        }
        await tick();
        assert.equal(f.adapter.files.size, 0);
        const value = await result;
        if (outcome === 'success') assert.equal(value[0].year, '2024');
        else assert.equal(value, null);
        assert.equal(f.manager._children.length, 0);
        assert.equal(process.stdout.listenerCount('data'), 0);
        assert.equal(process.listenerCount('close'), 0);
    } finally { f.manager.unload(); }
});


test('an error arriving after bibliography cancellation is still handled until process close', async () => {
    const f = await fixture();
    const result = f.manager.parseBibliographyText('citation'); await tick();
    const process = f.processes[0]; f.manager.unload();
    assert.doesNotThrow(() => process.emit('error', Object.assign(new Error('not found'), { code: 'ENOENT' })));
    process.emit('close', -1); await result;
    assert.equal(process.listenerCount('error'), 0);
    assert.equal(process.listenerCount('close'), 0);
});
