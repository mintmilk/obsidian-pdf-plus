import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { transform } from 'esbuild';
import { around } from 'monkey-around';

// Export the private patch installer only in the in-memory test module. Exercise
// its real prototype wrapper, rather than reproducing the annotation logic.
const source = await readFile(new URL('../src/patchers/pdf-internals.ts', import.meta.url), 'utf8');
const { code } = await transform(`${source}\nexport { patchPDFViewerChild };`, { loader: 'ts', format: 'cjs' });
const module = { exports: {} };
runInNewContext(code, {
    module,
    exports: module.exports,
    require(name) {
        if (name === 'monkey-around') return { around };
        if (name === 'obsidian') return { Platform: { isPhone: false }, setIcon() {}, setTooltip() {} };
        return {};
    },
});
const { patchPDFViewerChild } = module.exports;

class Element {
    constructor(classes = '') {
        this.classes = classes;
        this.children = [];
    }

    createDiv(classes, callback) {
        const element = new Element(classes);
        this.children.push(element);
        callback?.(element);
        return element;
    }

    querySelector() { return null; }
    addEventListener() {}

    hasDescendant(className) {
        return this.children.some(child => child.classes.split(' ').includes(className) || child.hasDescendant(className));
    }
}

for (const [firstEditable, currentEditable] of [[false, true], [true, false]]) {
    test(`annotation delete permission uses the current PDF (first=${firstEditable}, current=${currentEditable})`, () => {
        class ViewerChild {
            constructor(path, editable) {
                this.file = { path };
                this.editable = editable;
                this.popupMeta = new Element();
                this.activeAnnotationPopupEl = { querySelector: () => this.popupMeta };
            }

            renderAnnotationPopup() { return 'native-rendered'; }
        }

        const first = new ViewerChild('first.pdf', firstEditable);
        const current = new ViewerChild('current.pdf', currentEditable);
        const checkedChildren = [];
        const cleanups = [];
        const plugin = {
            app: {},
            settings: {
                renderMarkdownInStickyNote: false,
                enableAnnotationContentEdit: false,
                enableAnnotationDeletion: true,
                annotationPopupDrag: false,
            },
            lib: {
                isEditable(child) { checkedChildren.push(child); return child.editable; },
                getAnnotationInfoFromAnnotationElement() { return { page: 1, id: 'annotation-1' }; },
            },
            register(cleanup) { cleanups.push(cleanup); },
        };

        patchPDFViewerChild(plugin, first);
        try {
            assert.equal(current.renderAnnotationPopup({ data: { subtype: 'Highlight' } }), 'native-rendered');
            assert.equal(current.popupMeta.hasDescendant('pdf-plus-delete-annotation'), currentEditable);
            assert.ok(checkedChildren.length > 0);
            assert.ok(checkedChildren.every(child => child === current), 'prototype wrappers must not read the first viewer instance');
            assert.equal(plugin.lastAnnotationPopupChild, current);
        } finally {
            while (cleanups.length) cleanups.pop()();
        }
    });
}
