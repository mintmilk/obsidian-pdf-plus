import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { transform } from 'esbuild';

class Events {
    callbacks = new Set();
    on(_, callback) { this.callbacks.add(callback); return { owner: this, callback }; }
    offref(ref) { this.callbacks.delete(ref.callback); }
    trigger() { for (const callback of this.callbacks) callback(); }
}
class Component {
    _events = [];
    registerEvent(ref) { this._events.push(() => ref.owner.offref(ref)); }
    load() { this.onload?.(); }
    unload() { while (this._events.length) this._events.pop()(); this.onunload?.(); }
}
async function loadModule(path, imports = {}, suffix = '') {
    const source = process.env.PDF_PLUS_TEST_REV
        ? execFileSync('git', ['show', `${process.env.PDF_PLUS_TEST_REV}:${path.replace('../', '')}`], { cwd: new URL('..', import.meta.url), encoding: 'utf8' })
        : await readFile(new URL(path, import.meta.url), 'utf8');
    const { code } = await transform(source + suffix, { loader: 'ts', format: 'cjs' });
    const module = { exports: {} };
    runInNewContext(code, { module, exports: module.exports, require: name => imports[name] ?? {} });
    return module.exports;
}
const component = await loadModule('../src/lib/component.ts', { obsidian: { Component } });
const maps = await loadModule('../src/utils/maps.ts');
const indexModule = await loadModule('../src/lib/pdf-backlink-index.ts', { './component': component, obsidian: { Events }, utils: maps });
const { RectangleCache } = await loadModule('../src/backlink-visualizer.ts', { 'lib/component': component, 'lib/pdf-backlink-index': indexModule, utils: maps });

test('rectangle cache evicts deleted selection IDs while preserving unchanged cached geometry', () => {
    const events = new Events(), vaultEvents = new Events();
    const permanent = { page: 1, selection: { beginIndex: 0, beginOffset: 0, endIndex: 0, endOffset: 1 } };
    const backlinks = new Set([permanent]);
    const visualizer = { plugin: { app: { vault: vaultEvents } }, index: { backlinks, on: events.on.bind(events) } };
    const cache = new RectangleCache(visualizer); cache.load();
    cache.computeRectsForSelection = () => [[0, 0, 1, 1]];
    const permanentId = indexModule.PDFPageBacklinkIndex.selectionId(permanent.selection);
    const original = cache.getRectsForSelection(1, permanentId);
    for (let index = 1; index <= 30; index++) {
        const temporary = { page: 1, selection: { beginIndex: index, beginOffset: 0, endIndex: index, endOffset: 1 } };
        backlinks.add(temporary);
        cache.getRectsForSelection(1, indexModule.PDFPageBacklinkIndex.selectionId(temporary.selection));
        backlinks.delete(temporary); events.trigger();
        assert.equal(cache.pagewiseIdToRectsMap.get(1).size, 1);
        assert.equal(cache.getRectsForSelection(1, permanentId), original);
    }
    cache.unload();
    assert.equal(cache.pagewiseIdToRectsMap.size, 0);
    assert.equal(events.callbacks.size, 0);
});

test('font measurement uses its target document without retaining the first canvas globally', async () => {
    const fonts = await loadModule('../src/text-layer-fonts.ts', {}, '\nexport { measureText };');
    const document = width => ({ calls: 0, createElement() { this.calls++; return { getContext: () => ({ font: '', measureText: () => ({ width }) }) }; } });
    const first = document(10), second = document(20);
    assert.equal(fonts.measureText(first, '10px fixture', 'a'), 10);
    assert.equal(fonts.measureText(second, '10px fixture', 'a'), 20);
    assert.equal(fonts.measureText(first, '10px fixture', 'b'), 10);
    assert.equal(first.calls, 1); assert.equal(second.calls, 1);
});

test('font verdicts stay bounded as PDF.js assigns new font names across document loads', async () => {
    const fonts = await loadModule('../src/text-layer-fonts.ts');
    const doc = { createElement: () => ({ getContext: () => ({ font: '', measureText: () => ({ width: 1 }) }) }) };
    for (let index = 0; index < 1200; index++) {
        fonts.alignTextLayerNode({ doc, dataset: {}, style: { fontFamily: 'serif', fontSize: '10px' } }, {
            fontName: `g_d${index}_f1`, str: 'abcdefgh', width: 8, dir: 'ltr', transform: [1, 0, 0, 1, 0, 0],
            chars: [...'abcdefgh'].map((c, index) => ({ c, r: [index, 0, index + 1, 1] })),
        });
        assert.ok(fonts.fontVerdicts.size <= 512);
    }
    assert.ok(fonts.fontVerdicts.has('g_d1199_f1'));
});

const modeModule = await loadModule('../src/vim/mode.ts', { 'lib/component': component });
const hintnames = await loadModule('../src/vim/hintnames.ts');
const { VimHintMode } = await loadModule('../src/vim/hint.ts', { './mode': modeModule, './hintnames': hintnames });
test('Vim hint exit consumes cleanup callbacks instead of keeping all prior sessions', () => {
    const vim = { plugin: {}, vimScope: { unregisterAllKeymaps() {} } };
    const hints = new VimHintMode(vim);
    let calls = 0;
    for (let index = 0; index < 30; index++) {
        hints.onExit(() => calls++); hints.exit();
        assert.equal(hints.onExitCallbacks.length, 0);
    }
    assert.equal(calls, 30);
    hints.onExit(() => calls++); hints.unload();
    assert.equal(calls, 31);
});


test('Vim hint page redraw replaces old node cleanup callbacks within one mode session', () => {
    let page;
    const vim = { plugin: { settings: { vimHintChars: 'abc' } }, pdfViewer: { getPageView: () => page },
        vimScope: { unregisterAllKeymaps() {}, registerKeymaps() {} } };
    const hints = new VimHintMode(vim), oldNodes = [];
    for (let index = 0; index < 30; index++) {
        const target = { dataset: {}, matches: () => false };
        const div = { classes: new Set(), querySelectorAll: () => [target], addClass(cls) { this.classes.add(cls); }, removeClass(cls) { this.classes.delete(cls); } };
        page = { div }; hints.hintPage(1);
        assert.equal(target.dataset.pdfPlusVimHint, 'a');
        for (const [oldDiv, oldTarget] of oldNodes) {
            assert.equal(oldDiv.classes.size, 0);
            assert.equal(oldTarget.dataset.pdfPlusVimHint, undefined);
        }
        oldNodes.push([div, target]);
    }
    hints.exit();
    assert.ok(oldNodes.every(([div, target]) => div.classes.size === 0 && target.dataset.pdfPlusVimHint === undefined));
});
