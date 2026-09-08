import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { transform } from 'esbuild';
import { around } from 'monkey-around';

class Component {
    _loaded = false; _events = []; _children = [];
    load() { if (this._loaded) return; this._loaded = true; this.onload?.(); for (const child of this._children) child.load(); }
    register(fn) { this._events.push(fn); }
    registerDomEvent(el, type, fn) { el.addEventListener(type, fn); this.register(() => el.removeEventListener(type, fn)); }
    addChild(child) { this._children.push(child); if (this._loaded) child.load(); return child; }
    removeChild(child) { const i = this._children.indexOf(child); if (i >= 0) this._children.splice(i, 1); child.unload(); return child; }
    unload() { if (!this._loaded) return; this._loaded = false; while (this._children.length) this._children.pop().unload(); while (this._events.length) this._events.pop()(); this.onunload?.(); }
}
class Element {
    listeners = new Map(); removed = false;
    addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); }
    removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
    toggleClass() {} remove() { this.removed = true; }
}
async function load(path, imports) {
    const { code } = await transform(await readFile(new URL(path, import.meta.url), 'utf8'), { loader: 'ts', format: 'cjs' });
    const module = { exports: {} }; runInNewContext(code, { module, exports: module.exports, console, require: name => imports[name] ?? {} }); return module.exports;
}
const obsidian = { Component };
const component = await load('../src/lib/component.ts', { obsidian });
const managers = await load('../src/pdf-backlink.ts', { obsidian, 'lib/component': component, utils: { MutationObservingChild: class extends Component {} } });
const { patchBacklink } = await load('../src/patchers/backlink.ts', { obsidian, 'monkey-around': { around }, 'pdf-backlink': managers });
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function backlinkFixture(t) {
    class SearchDom { el = new Element(); addResult() { return 'native-result'; } }
    class NativeBase extends Component { onLoadFile(file) { return this.loading?.(file); } onUnloadFile() { this.nativeUnloads = (this.nativeUnloads ?? 0) + 1; } }
    class BacklinkView extends NativeBase { getViewType() { return 'backlink'; } }
    const buttons = [], view = new BacklinkView(); view.load();
    view.backlink = { backlinkDom: new SearchDom(), headerDom: { addNavButton() { const el = new Element(); buttons.push(el); return el; } }, recomputeBacklink() {} };
    const plugin = Object.assign(new Component(), { app: { workspace: { getLeavesOfType: () => [{ view }] } }, settings: {}, patchStatus: {}, lib: { isBacklinkView: () => true, workspace: { iterateBacklinkViews() {} } } }); plugin.load();
    assert.equal(patchBacklink(plugin), true); t.after(() => { plugin.unload(); view.unload(); });
    const file = { extension: 'pdf', path: 'fixture.pdf' }; view.file = file;
    return { plugin, view, file, buttons, activeButtons: () => buttons.filter(el => !el.removed).length };
}

for (const mode of ['plugin', 'view', 'file']) test(`pending backlink load cannot install a manager after ${mode} unload`, async t => {
    const f = backlinkFixture(t), wait = deferred(); f.view.loading = () => wait.promise;
    const pending = f.view.onLoadFile(f.file);
    if (mode === 'plugin') f.plugin.unload(); else if (mode === 'view') f.view.unload(); else await f.view.onUnloadFile(f.file);
    wait.resolve(); await pending;
    assert.equal(f.view.pdfManager, undefined); assert.equal(f.activeButtons(), 0); assert.equal(f.plugin._children.length, 0);
});
for (const sameFile of [false, true]) test(`out-of-order backlink loads retain only the latest PDF manager (sameFile=${sameFile})`, async t => {
    const f = backlinkFixture(t), first = deferred(), second = deferred(), file2 = sameFile ? f.file : { extension: 'pdf', path: 'next.pdf' };
    let loads = 0; f.view.loading = () => ++loads === 1 ? first.promise : second.promise;
    const oldLoad = f.view.onLoadFile(f.file); f.view.file = file2; const newLoad = f.view.onLoadFile(file2);
    second.resolve(); await newLoad; const current = f.view.pdfManager;
    first.resolve(); await oldLoad;
    assert.equal(f.view.pdfManager, current); assert.equal(current.file, file2); assert.equal(f.activeButtons(), 1); assert.equal(f.plugin._children.length, 1);
});
test('twenty backlink reloads keep one manager and release both parents and the view property', async t => {
    const f = backlinkFixture(t);
    for (let i = 0; i < 20; i++) { await f.view.onLoadFile(f.file); assert.equal(f.activeButtons(), 1); assert.equal(f.plugin._children.length, 1); assert.equal(f.view._children.length, 1); }
    await f.view.onUnloadFile(f.file);
    assert.equal(f.view.pdfManager, undefined); assert.equal(f.activeButtons(), 0); assert.equal(f.plugin._children.length, 0); assert.equal(f.view._children.length, 0); assert.equal(f.view.nativeUnloads, 1);
});
test('switching to markdown drops the PDF manager, and plugin unload clears its replacement', async t => {
    const f = backlinkFixture(t); await f.view.onLoadFile(f.file);
    const markdown = { extension: 'md', path: 'fixture.md' }; f.view.file = markdown; await f.view.onLoadFile(markdown);
    assert.equal(f.view.pdfManager, undefined); assert.equal(f.activeButtons(), 0);
    f.view.file = f.file; await f.view.onLoadFile(f.file); f.plugin.unload();
    assert.equal(f.view.pdfManager, undefined); assert.equal(f.view._children.length, 0); assert.equal(f.activeButtons(), 0);
});

async function menuFixture(t) {
    class Menu {
        items = [{}]; hidden = false;
        setUseNativeMenu(value) { this.useNativeMenu = value; }
        showAtPosition(position) { if (position?.throw) throw new Error('native show failed'); if (!this.items.length) return this; this.hidden = false; if (position?.hide) this.hide(); return this; }
        hide() { this.hidden = true; return this; }
    }
    const originals = { show: Menu.prototype.showAtPosition, hide: Menu.prototype.hide };
    const { patchMenu } = await load('../src/patchers/menu.ts', { obsidian: { Menu }, 'monkey-around': { around } });
    const plugin = Object.assign(new Component(), { settings: { hoverableDropdownMenuInToolbar: true }, shownMenus: new Set() }); plugin.load(); patchMenu(plugin); t.after(() => plugin.unload());
    return { Menu, plugin, originals };
}
test('a failed or empty native menu does not remain in shownMenus', async t => {
    const f = await menuFixture(t);
    for (let i = 0; i < 20; i++) { assert.throws(() => new f.Menu().showAtPosition({ throw: true }), /native show failed/); const empty = new f.Menu(); empty.items = []; empty.showAtPosition({}); }
    assert.equal(f.plugin.shownMenus.size, 0);
});
test('plugin unload hides tracked menus, clears the set, and restores native methods', async t => {
    const f = await menuFixture(t), menus = [new f.Menu(), new f.Menu()];
    for (const menu of menus) assert.equal(menu.showAtPosition({}), menu);
    f.plugin.unload(); assert.ok(menus.every(menu => menu.hidden)); assert.equal(f.plugin.shownMenus.size, 0);
    assert.equal(f.Menu.prototype.showAtPosition, f.originals.show); assert.equal(f.Menu.prototype.hide, f.originals.hide);
});
test('toolbar hover keeps DOM menus and synchronous native hide cannot leave a tracked entry', async t => {
    const f = await menuFixture(t), menu = new f.Menu(); menu.parentEl = { closest: () => ({}) };
    menu.showAtPosition({}); assert.equal(menu.useNativeMenu, false); assert.equal(f.plugin.shownMenus.size, 1);
    assert.equal(menu.hide(), menu); assert.equal(f.plugin.shownMenus.size, 0);
    menu.showAtPosition({ hide: true }); assert.equal(f.plugin.shownMenus.size, 0);
});
