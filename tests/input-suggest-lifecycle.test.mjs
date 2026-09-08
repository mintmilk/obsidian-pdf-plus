import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { transform } from 'esbuild';

class DocumentEvents {
    listeners = [];

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
}

// Model the observed Obsidian 1.13.7 native capture mismatch. The plugin classes
// and settings ownership helper under test are loaded from their real sources.
class NativeInputSuggest {
    nativeCloseCalls = 0;
    isOpen = false;

    constructor(app, input) {
        this.app = app;
        this.input = input;
        this.autoReposition = () => {};
    }

    open() {
        this.isOpen = true;
        this.input.doc.addEventListener('scroll', this.autoReposition, { capture: true, passive: true });
    }

    close() {
        this.nativeCloseCalls++;
        this.isOpen = false;
        this.input.doc.removeEventListener('scroll', this.autoReposition);
        if (this.closeError) throw this.closeError;
    }
}

async function loadModule(relativePath, imports) {
    const source = await readFile(new URL(relativePath, import.meta.url), 'utf8');
    const { code } = await transform(source, { loader: 'ts', format: 'cjs' });
    const module = { exports: {} };
    runInNewContext(code, { module, exports: module.exports, require: name => imports[name] ?? {} });
    return module.exports;
}

const suggests = await loadModule('../src/utils/suggest.ts', {
    obsidian: { AbstractInputSuggest: NativeInputSuggest },
});
const { PDFPlusSettingTab } = await loadModule('../src/settings.ts', {
    obsidian: { PluginSettingTab: class {} },
    utils: { getModifierNameInPlatform: () => 'Control' },
    'pdfjs-enums': { SidebarView: { THUMBS: 1 }, ScrollMode: { VERTICAL: 0 }, SpreadMode: { NONE: 0 } },
});

function createSuggest(name, doc) {
    const input = { doc };
    const app = {};
    return name === 'CommandSuggest'
        ? new suggests[name]({ plugin: { app } }, input)
        : new suggests[name](app, input);
}

for (const name of ['FuzzyFileSuggest', 'FuzzyFolderSuggest', 'FuzzyMarkdownFileSuggest', 'CommandSuggest']) {
    test(`${name} closes native UI and removes capture listeners across repeated popups`, () => {
        const doc = new DocumentEvents();
        const independent = () => {};
        doc.addEventListener('scroll', independent, true);
        const suggest = createSuggest(name, doc);

        for (let i = 0; i < 10; i++) {
            suggest.open();
            assert.equal(doc.listeners.length, 2);
            suggest.close();
            assert.equal(doc.listeners.length, 1);
            assert.equal(suggest.isOpen, false);
        }

        assert.equal(suggest.nativeCloseCalls, 10);
        assert.equal(doc.listeners[0].callback, independent);
    });

    test(`${name} is closed when its settings display owner unloads`, () => {
        const doc = new DocumentEvents();
        const suggest = createSuggest(name, doc);
        const cleanups = [];
        const owner = { register: callback => cleanups.push(callback) };
        const registered = PDFPlusSettingTab.prototype.registerSuggest.call({ component: owner }, suggest);
        assert.equal(registered, suggest);
        suggest.open();
        assert.equal(doc.listeners.length, 1);

        while (cleanups.length) cleanups.pop()();

        assert.equal(doc.listeners.length, 0);
        assert.equal(suggest.isOpen, false);
        assert.equal(suggest.nativeCloseCalls, 1);
    });
}

test('close remains compatible if the native reposition callback is absent', () => {
    const suggest = createSuggest('FuzzyFileSuggest', new DocumentEvents());
    delete suggest.autoReposition;
    assert.doesNotThrow(() => suggest.close());
    assert.equal(suggest.nativeCloseCalls, 1);
});

test('capture cleanup still runs if the native close method throws', () => {
    const doc = new DocumentEvents();
    const suggest = createSuggest('FuzzyFileSuggest', doc);
    const error = new Error('native close failed');
    suggest.open();
    suggest.closeError = error;

    assert.throws(() => suggest.close(), received => received === error);
    assert.equal(doc.listeners.length, 0);
});
