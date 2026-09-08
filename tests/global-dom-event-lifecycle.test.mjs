import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { setFlagsFromString } from 'node:v8';
import { transform } from 'esbuild';

setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc');
class Component {
    _loaded = true; _events = [];
    register(fn) { this._events.push(fn); }
    registerDomEvent(el, type, fn, options) { el.addEventListener(type, fn, options); this.register(() => el.removeEventListener(type, fn, options)); }
    registerEvent(ref) { this.register(() => ref.owner.offref(ref)); }
    unload() { if (!this._loaded) return; this._loaded = false; while (this._events.length) this._events.pop()(); }
}
class Document {
    listeners = new Set(); registrations = 0;
    addEventListener(type, fn, options) { this.registrations++; this.listeners.add(fn); this.options = options; }
    removeEventListener(type, fn, options) { assert.equal(options, this.options); this.listeners.delete(fn); }
    dispatch() { for (const fn of this.listeners) fn.call(this, {}); }
}
class Workspace {
    events = new Map(); ready = []; windows = [];
    onLayoutReady(fn) { this.ready.push(fn); }
    layoutReady() { for (const fn of this.ready.splice(0)) fn(); }
    iterateAllLeaves(fn) { for (const win of this.windows) fn({ getContainer: () => ({ win }) }); }
    on(name, fn) { if (!this.events.has(name)) this.events.set(name, new Set()); this.events.get(name).add(fn); return { owner: this, name, fn }; }
    offref(ref) { this.events.get(ref.name)?.delete(ref.fn); }
    trigger(name, win) { for (const fn of this.events.get(name) ?? []) fn({}, win); }
    count() { return [...this.events.values()].reduce((n, set) => n + set.size, 0); }
}
const source = await readFile(new URL('../src/lib/index.ts', import.meta.url), 'utf8');
const { code } = await transform(source, { loader: 'ts', format: 'cjs' });
function fixture() {
    const main = { document: new Document() }, workspace = new Workspace(), module = { exports: {} };
    runInNewContext(code, { module, exports: module.exports, window: main, document: main.document, require: () => ({}) });
    const lib = Object.assign(Object.create(module.exports.PDFPlusLib.prototype), { app: { workspace } });
    return { main, workspace, register: (owner, callback = () => {}) => lib.registerGlobalDomEvent(owner, 'click', callback, { capture: true }) };
}
test('twenty popout open/close cycles release document handlers without growing the owner', () => {
    const f = fixture(), owner = new Component(); let calls = 0;
    f.register(owner, () => calls++); f.workspace.layoutReady(); const baseline = owner._events.length;
    for (let i = 0; i < 20; i++) {
        const win = { document: new Document() }; f.workspace.trigger('window-open', win); win.document.dispatch();
        f.workspace.trigger('window-close', win); assert.equal(win.document.listeners.size, 0); assert.equal(owner._events.length, baseline);
    }
    assert.equal(calls, 20); owner.unload(); assert.equal(f.main.document.listeners.size, 0); assert.equal(f.workspace.count(), 0);
});
test('multiple leaves and duplicate open events register each existing window once', () => {
    const f = fixture(), owner = new Component(), popout = { document: new Document() };
    f.workspace.windows = [f.main, popout, popout]; f.register(owner); f.workspace.layoutReady();
    f.workspace.trigger('window-open', popout); f.workspace.trigger('window-open', f.main);
    assert.equal(popout.document.registrations, 1); assert.equal(f.main.document.registrations, 1);
    owner.unload(); assert.equal(popout.document.listeners.size, 0); assert.equal(f.main.document.listeners.size, 0);
});
test('unload before layout-ready detaches the pending owner capture and prevents late registrations', async () => {
    const f = fixture(), popout = { document: new Document() }; f.workspace.windows = [popout];
    const weak = (() => { const owner = new Component(); f.register(owner); owner.unload(); return new WeakRef(owner); })();
    await new Promise(resolve => setImmediate(resolve)); gc();
    assert.equal(weak.deref(), undefined, 'workspace layout callback still retains the unloaded owner');
    f.workspace.layoutReady(); assert.equal(popout.document.registrations, 0); assert.equal(f.workspace.count(), 0);
    assert.equal(f.main.document.listeners.size, 0);
});
