import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { transform } from 'esbuild';

class Component {
    _loaded = true; _events = []; _children = [];
    register(callback) { this._events.push(callback); }
    registerEvent(ref) { this.register(() => ref.owner.offref(ref)); }
    load() { this._loaded = true; }
    addChild(child) { this._children.push(child); if (this._loaded) child.load(); return child; }
    removeChild(child) { this._children = this._children.filter(item => item !== child); child.unload(); return child; }
    unload() { if (!this._loaded) return; this._loaded = false; while (this._children.length) this.removeChild(this._children[0]); while (this._events.length) this._events.pop()(); }
}
class Events {
    callbacks = new Map();
    on(name, callback) { if (!this.callbacks.has(name)) this.callbacks.set(name, new Set()); this.callbacks.get(name).add(callback); return { owner: this, name, callback }; }
    offref(ref) { this.callbacks.get(ref.name)?.delete(ref.callback); }
    trigger(name, value) { for (const callback of [...this.callbacks.get(name) ?? []]) callback(value); }
    count(name) { return this.callbacks.get(name)?.size ?? 0; }
}
async function loadModule(path, imports, globals = {}) {
    const source = await readFile(new URL(path, import.meta.url), 'utf8');
    const { code } = await transform(source, { loader: 'ts', format: 'cjs' });
    const module = { exports: {} };
    runInNewContext(code, { module, exports: module.exports, require: name => imports[name] ?? {}, ...globals });
    return module.exports;
}
const submodule = await loadModule('../src/lib/submodule.ts', {});
async function fixture() {
    const timers = new Map(); let timerId = 0;
    const clock = { setTimeout: callback => { timers.set(++timerId, callback); return timerId; }, clearTimeout: id => timers.delete(id) };
    const obsidian = { Component, Notice: class { noticeEl = { appendText() {}, createEl() {} }; } };
    const { WorkspaceLib } = await loadModule('../src/lib/workspace-lib.ts', { obsidian, './submodule': submodule }, { window: clock });
    const { copyLinkLib } = await loadModule('../src/lib/copy-link.ts', { obsidian, './submodule': submodule }, { activeWindow: clock });
    const plugin = new Component(), events = new Events(), sidebar = { collapse() {} };
    plugin.manifest = { name: 'fixture' };
    plugin.settings = { closeHoverEditorWhenLostFocus: true, executeCommandWhenTargetNotIdentified: true, autoPasteTargetDialogTimeoutSec: 120 };
    plugin.app = { workspace: Object.assign(events, { leftSplit: sidebar }), plugins: { plugins: { 'obsidian-hover-editor': { settings: {} } } },
        commands: { findCommand: () => ({ id: 'new-note' }), executeCommandById() {} } };
    plugin.registerOneTimeEvent = (emitter, name, callback) => {
        const ref = emitter.on(name, value => { emitter.offref(ref); callback(value); });
        plugin.register(() => emitter.offref(ref)); return () => emitter.offref(ref);
    };
    const workspace = new WorkspaceLib(plugin); plugin.lib = { workspace };
    const leaf = { getRoot: () => sidebar, containerEl: { closest: () => ({}) } };
    const popover = { hoverEl: { hasClass: () => false }, hide() {} };
    workspace.hoverEditor.getHoverEditorForLeaf = () => popover;
    const copy = Object.assign(Object.create(copyLinkLib.prototype), { plugin, app: plugin.app, getAutoFocusOrAutoPasteTarget: () => null, pasteTextToFile: async () => {} });
    return { plugin, events, timers, workspace, sidebar, leaf, copy };
}

test('repeated sidebar auto-hide registrations have one owner and unload removes the waiting listener', async () => {
    const f = await fixture();
    for (let index = 0; index < 30; index++) f.workspace.registerHideSidebar(f.leaf);
    assert.equal(f.events.count('active-leaf-change'), 1);
    f.plugin.unload(); assert.equal(f.events.count('active-leaf-change'), 0);
});

test('repeated hover-editor postprocessing has one loss-of-focus listener', async () => {
    const f = await fixture();
    for (let index = 0; index < 30; index++) f.workspace.hoverEditor.postProcessHoverEditorLeaf(f.leaf);
    assert.equal(f.events.count('active-leaf-change'), 1);
    f.events.trigger('active-leaf-change', {});
    assert.equal(f.events.count('active-leaf-change'), 0);
    assert.equal(f.plugin._children.length, 0);
});

for (const cancel of [false, true]) test(`hover-editor creation releases its timeout and wait listener (unload=${cancel})`, async () => {
    const f = await fixture();
    const pending = f.workspace.hoverEditor.createNewHoverEditorLeaf({}, null, 'fixture.md', '');
    if (cancel) f.plugin.unload(); else f.events.trigger('active-leaf-change', f.leaf);
    assert.equal(f.events.count('active-leaf-change'), 0);
    assert.equal(f.timers.size, 0);
    assert.equal(await pending, cancel ? null : f.leaf);
});

test('auto-paste waiting for a note is cancelled on plugin unload', async () => {
    const f = await fixture(); const pending = f.copy.autoPaste('fixture');
    f.plugin.unload();
    assert.equal(f.events.count('file-open'), 0);
    assert.equal(f.timers.size, 0);
    assert.equal(await pending, false);
});

test('successful auto-paste clears its timeout immediately', async () => {
    const f = await fixture(); const pending = f.copy.autoPaste('fixture');
    f.events.trigger('file-open', { extension: 'md' });
    assert.equal(await pending, true);
    assert.equal(f.events.count('file-open'), 0);
    assert.equal(f.timers.size, 0);
    f.plugin.unload();
});


for (const failure of ['timeout', 'command-error']) test(`auto-paste ${failure} also cancels its hover-editor activation wait`, async () => {
    const f = await fixture();
    if (failure === 'command-error') f.plugin.app.commands.executeCommandById = () => { throw new Error('command error'); };
    const pending = f.copy.autoPaste('fixture');
    if (failure === 'timeout') {
        const callbacks = [...f.timers.values()]; f.timers.clear(); callbacks.forEach(cb => cb());
        assert.equal(await pending, false);
    } else await assert.rejects(pending, /command error/);
    assert.equal(f.events.count('file-open'), 0);
    assert.equal(f.events.count('active-leaf-change'), 0);
    assert.equal(f.timers.size, 0);
});

test('successful auto-paste retains the following one-time hover-editor activation', async () => {
    const f = await fixture(); let calls = 0;
    f.workspace.hoverEditor.isHoverEditorLeaf = () => true;
    f.workspace.hoverEditor.postProcessHoverEditorLeaf = () => calls++;
    const pending = f.copy.autoPaste('fixture');
    f.events.trigger('file-open', { extension: 'md' }); assert.equal(await pending, true);
    f.events.trigger('active-leaf-change', f.leaf); f.events.trigger('active-leaf-change', f.leaf);
    assert.equal(calls, 1);
    assert.equal(f.events.count('active-leaf-change'), 0);
});
