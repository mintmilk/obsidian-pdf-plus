import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { transform } from 'esbuild';

const source = await readFile(new URL('../src/post-process/pdf-link-like.ts', import.meta.url), 'utf8');
const { code } = await transform(source, { loader: 'ts', format: 'cjs' });
const module = { exports: {} };
runInNewContext(code, {
    module,
    exports: module.exports,
    require: (name) => name === 'obsidian' ? { Keymap: { isModEvent: () => 'tab' } } : {},
});
const { PDFOutlineItemPostProcessor } = module.exports;

function createViewer() {
    const listeners = new Map();
    const cleanups = [];
    const target = {};
    const opened = [];
    const hovered = [];
    const component = {
        registerDomEvent(element, name, callback) {
            assert.equal(element, target);
            if (!listeners.has(name)) listeners.set(name, new Set());
            listeners.get(name).add(callback);
            cleanups.push(() => listeners.get(name).delete(callback));
        },
        unload() {
            cleanups.splice(0).forEach((cleanup) => cleanup());
        },
    };
    const child = { component, unloaded: false, file: { path: 'example.pdf' }, opts: { isEmbed: false } };
    const plugin = {
        app: { workspace: {
            openLinkText: (...args) => opened.push(args),
            trigger: (...args) => hovered.push(args),
        } },
        lib: { workspace: { iteratePDFViews() {} } },
        settings: {
            clickOutlineItemWithModifierKey: true,
            popoverPreviewOnOutlineHover: true,
            recordHistoryOnOutlineClick: true,
        },
        registerDomEvent() {
            assert.fail('PDF DOM listeners must not be owned by the global plugin');
        },
    };
    const processor = PDFOutlineItemPostProcessor.registerEvents(plugin, child, { selfEl: target });
    processor.getLinkText = async () => 'example.pdf#page=2';
    return {
        processor, opened, hovered,
        count: () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0),
        dispatch(name) {
            const event = { defaultPrevented: false, preventDefault() {}, stopPropagation() {} };
            return Promise.all([...listeners.get(name) ?? []].map((callback) => callback(event)));
        },
        close() {
            child.component = undefined;
            child.unloaded = true;
            component.unload();
        },
    };
}

test('all three outline DOM handlers belong to the viewer and stop on close', async () => {
    const viewer = createViewer();
    assert.equal(viewer.count(), 3);

    await viewer.dispatch('click');
    await viewer.dispatch('mouseover');
    assert.equal(viewer.opened.length, 1);
    assert.equal(viewer.hovered.length, 1);

    viewer.close();
    await viewer.dispatch('click');
    await viewer.dispatch('mouseover');
    assert.equal(viewer.count(), 0);
    assert.equal(viewer.opened.length, 1);
    assert.equal(viewer.hovered.length, 1);
});

for (const eventName of ['click', 'mouseover']) {
    test(`a pending ${eventName} destination cannot open a tab or hover after close`, async () => {
        const viewer = createViewer();
        let resolveDestination;
        let enteredDestination;
        const destination = new Promise((resolve) => { resolveDestination = resolve; });
        const entered = new Promise((resolve) => { enteredDestination = resolve; });
        viewer.processor.getLinkText = () => {
            enteredDestination();
            return destination;
        };

        const pending = viewer.dispatch(eventName);
        await entered;
        viewer.close();
        resolveDestination('example.pdf#page=2');
        await pending;

        assert.equal(viewer.opened.length, 0);
        assert.equal(viewer.hovered.length, 0);
        assert.equal(viewer.count(), 0);
    });
}
