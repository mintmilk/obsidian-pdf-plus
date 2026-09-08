import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { transform } from 'esbuild';

class Component {
    _loaded = false;
    cleanups = [];

    load() {
        this._loaded = true;
    }

    register(callback) {
        this.cleanups.push(callback);
    }

    registerEvent(ref) {
        this.register(() => ref.e.offref(ref));
    }

    registerDomEvent(element, name, callback) {
        element.addEventListener(name, callback);
        this.register(() => element.removeEventListener(name, callback));
    }

    unload() {
        if (!this._loaded) return;
        this._loaded = false;
        while (this.cleanups.length) this.cleanups.pop()();
    }
}

class Events {
    listeners = new Map();

    on(name, callback) {
        if (!this.listeners.has(name)) this.listeners.set(name, new Set());
        const ref = { e: this, name, callback };
        this.listeners.get(name).add(ref);
        return ref;
    }

    offref(ref) {
        this.listeners.get(ref.name)?.delete(ref);
    }

    trigger(name) {
        for (const ref of [...this.listeners.get(name) ?? []]) ref.callback();
    }
}

// Load the actual class methods; the settings controls and Obsidian application
// are not constructed. Only imports needed by module-level defaults are stubbed.
const source = await readFile(new URL('../src/settings.ts', import.meta.url), 'utf8');
const { code } = await transform(source, { loader: 'ts', format: 'cjs' });
const module = { exports: {} };
runInNewContext(code, {
    module,
    exports: module.exports,
    require(name) {
        if (name === 'obsidian') return { Component, Events, PluginSettingTab: class {} };
        if (name === 'utils') return { getModifierNameInPlatform: () => 'Control' };
        if (name === 'pdfjs-enums') return {
            SidebarView: { THUMBS: 1 },
            ScrollMode: { VERTICAL: 0 },
            SpreadMode: { NONE: 0 },
        };
        return {};
    },
});
const { PDFPlusSettingTab } = module.exports;

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

function createTab(saveSettings) {
    const tab = Object.create(PDFPlusSettingTab.prototype);
    tab.component = new Component();
    tab.component.load();
    tab.events = new Events();
    tab.promises = [Promise.resolve()];
    tab.plugin = {
        settings: {
            colors: {},
            defaultColor: '',
            backlinkHoverColor: '',
            copyCommands: [],
            displayTextFormats: [],
            enablePDFEdit: false,
        },
        validateAutoFocusAndAutoPasteSettings() {},
        saveSettings,
        loadStyle() {},
    };
    return tab;
}

test('hide removes old clicks synchronously and cannot remove a redisplayed tab while saving', async () => {
    const save = deferred();
    const tab = createTab(() => save.promise);
    const oldHeader = new EventTarget();
    const newHeader = new EventTarget();
    let oldClicks = 0;
    let newClicks = 0;
    tab.component.registerDomEvent(oldHeader, 'click', () => oldClicks++);
    const pendingHide = tab.hide();

    try {
        oldHeader.dispatchEvent(new Event('click'));
        assert.equal(oldClicks, 0, 'old listeners must be removed before saveSettings settles');
        assert.equal(tab.component._loaded, false);
        assert.equal(tab.promises.length, 0);

        // Obsidian can render the same tab again without awaiting hide(). Keep
        // the same owner to detect a delayed unload of the new render's events.
        tab.component.load();
        tab.component.registerDomEvent(newHeader, 'click', () => newClicks++);
        const newPromises = [Promise.resolve('new render')];
        tab.promises = newPromises;
        save.resolve();
        await pendingHide;

        newHeader.dispatchEvent(new Event('click'));
        assert.equal(newClicks, 1);
        assert.equal(tab.component._loaded, true);
        assert.equal(tab.promises, newPromises);
    } finally {
        save.resolve();
        await pendingHide;
        tab.component.unload();
    }
});

test('a failed settings save does not leave hidden tab listeners registered', async () => {
    const save = deferred();
    const error = new Error('settings write failed');
    const tab = createTab(() => save.promise);
    const header = new EventTarget();
    let clicks = 0;
    tab.component.registerDomEvent(header, 'click', () => clicks++);
    const pendingHide = tab.hide();
    save.reject(error);
    await assert.rejects(pendingHide, (received) => received === error);

    header.dispatchEvent(new Event('click'));
    assert.equal(clicks, 0);
    assert.equal(tab.component._loaded, false);
    assert.equal(tab.component.cleanups.length, 0);
    assert.equal(tab.promises.length, 0);
});

test('conditional settings stop reacting when their display component unloads', () => {
    const tab = createTab(async () => {});
    let visible = true;
    let toggles = 0;
    let independentUpdates = 0;
    const element = {
        show() { toggles++; },
        hide() { toggles++; },
    };
    tab.events.on('update', () => independentUpdates++);
    tab.showConditionally({ settingEl: element }, () => visible);
    assert.equal(toggles, 1);

    visible = false;
    tab.events.trigger('update');
    assert.equal(toggles, 2);
    tab.component.unload();
    visible = true;
    tab.events.trigger('update');

    assert.equal(toggles, 2, 'hidden settings must no longer be retained by the update event');
    assert.equal(independentUpdates, 2, 'unrelated update subscribers must remain active');
});

test('redisplay restores the scroll position of the outer settings container', async () => {
    const tab = createTab(async () => {});
    let displays = 0;
    let updates = 0;
    tab.containerEl = {
        scrollTop: 840,
        scroll({ top }) { this.scrollTop = top; },
    };
    tab.contentEl = {
        scrollTop: 0,
        scroll() { assert.fail('the inner content is not the settings scroll container'); },
    };
    tab.display = () => {
        displays++;
        tab.containerEl.scrollTop = 0;
    };
    tab.events.on('update', () => updates++);

    await tab.redisplay();

    assert.equal(tab.containerEl.scrollTop, 840);
    assert.equal(displays, 1);
    assert.equal(updates, 1);
});
