import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { transform } from 'esbuild';

const source = await readFile(new URL('../src/lib/index.ts', import.meta.url), 'utf8');
const { code } = await transform(source, { loader: 'ts', format: 'cjs' });
function helpers({ pdfjs = {}, createEl, URL = {}, utils = {} } = {}) {
    const module = { exports: {} };
    runInNewContext(code, {
        module, exports: module.exports, createEl, URL, AbortController,
        window: { pdfjsLib: pdfjs, devicePixelRatio: 1 },
        require: name => name === 'utils' ? utils : name === 'obsidian' ? { Platform: { isDesktop: true } } : {},
    });
    const lib = Object.create(module.exports.PDFPlusLib.prototype);
    lib.plugin = { settings: { rectEmbedResolution: 100 } };
    return lib;
}
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((a, b) => { resolve = a; reject = b; });
    return { promise, resolve, reject };
};

test('a rejected PDF load destroys its loading task and preserves the load error', async () => {
    const error = Error('bad PDF');
    let destroyed = 0;
    const lib = helpers({ pdfjs: { getDocument: () => ({ promise: Promise.reject(error), destroy: async () => { destroyed++; } }) } });
    await assert.rejects(lib.loadPDFDocumentFromArrayBuffer(new ArrayBuffer(1)), value => value === error);
    assert.equal(destroyed, 1);
});

test('aborting a pending PDF load destroys the task exactly once', async () => {
    const pending = deferred();
    let destroyed = 0;
    const controller = new AbortController();
    const lib = helpers({ pdfjs: { getDocument: () => ({ promise: pending.promise, destroy: async () => { destroyed++; pending.reject(Error('worker destroyed')); } }) } });
    const result = lib.loadPDFDocumentFromArrayBuffer(new ArrayBuffer(1), controller.signal);
    controller.abort();
    // Resolve as well so old code cannot hang the regression test.
    pending.resolve({});
    await assert.rejects(result, error => error === controller.signal.reason);
    assert.equal(destroyed, 1);
});

test('an already aborted request never creates a loading task', async () => {
    const controller = new AbortController();
    controller.abort();
    let created = 0;
    const lib = helpers({ pdfjs: { getDocument: () => { created++; return { promise: Promise.resolve({}) }; } } });
    await assert.rejects(lib.loadPDFDocumentFromArrayBuffer(new ArrayBuffer(1), controller.signal));
    assert.equal(created, 0);
});

test('cancellation settles even if task destruction does not reject the loading promise', async () => {
    const pending = deferred();
    const controller = new AbortController();
    let destroyed = 0;
    let settled = false;
    const lib = helpers({ pdfjs: { getDocument: () => ({ promise: pending.promise, destroy: async () => { destroyed++; } }) } });
    const result = lib.loadPDFDocumentFromArrayBuffer(new ArrayBuffer(1), controller.signal);
    result.then(() => { settled = true; }, () => { settled = true; });
    controller.abort();
    await new Promise(resolve => setImmediate(resolve));
    const settledBeforeLoading = settled;
    pending.resolve({});
    await assert.rejects(result, error => error === controller.signal.reason);
    assert.equal(settledBeforeLoading, true);
    assert.equal(destroyed, 1);
});

for (const fail of [false, true]) {
    test(`externally fetched blob URL is revoked on ${fail ? 'loading failure' : 'document destruction'}`, async () => {
        const revoked = [];
        const lib = helpers({ URL: { revokeObjectURL: url => revoked.push(url) } });
        lib.getExternalPDFUrl = async () => 'blob:owned';
        lib.loadPDFDocumentFromArrayBufferOrUrl = async () => { if (fail) throw Error('bad PDF'); return { destroy: async () => {} }; };
        if (fail) await assert.rejects(lib.loadPDFDocument({}));
        else {
            const doc = await lib.loadPDFDocument({});
            assert.deepEqual(revoked, [], 'a live document may still need range requests');
            await doc.destroy();
        }
        assert.deepEqual(revoked, ['blob:owned']);
    });
}

test('resource URLs supplied by the vault are not revoked', async () => {
    const lib = helpers({ URL: { revokeObjectURL: () => assert.fail('not owned') } });
    lib.getExternalPDFUrl = async () => 'app://local.pdf';
    lib.loadPDFDocumentFromArrayBufferOrUrl = async () => ({});
    await lib.loadPDFDocument({});
});

function canvas() {
    return { width: 0, height: 0, getContext: () => ({}), setCssStyles() {}, toDataURL: () => 'data:image/png;base64,AA==' };
}
test('a failed rendering releases canvas backing storage', async () => {
    const target = canvas();
    const error = Error('render failed');
    const lib = helpers({ createEl: () => target });
    const page = { getViewport: () => ({ width: 100, height: 200 }), render: () => ({ promise: Promise.reject(error) }) };
    await assert.rejects(lib.renderPDFPageToCanvas(page), value => value === error);
    assert.equal(target.width * target.height, 0);
});

test('an aborted rendering cancels the render task and releases its canvas', async () => {
    const target = canvas();
    const pending = deferred();
    let cancelled = 0;
    const controller = new AbortController();
    const lib = helpers({ createEl: () => target });
    const page = { getViewport: () => ({ width: 100, height: 200 }), render: () => ({ promise: pending.promise, cancel: () => { cancelled++; pending.reject(Error('render cancelled')); } }) };
    const result = lib.renderPDFPageToCanvas(page, 1, {}, controller.signal);
    controller.abort();
    pending.resolve();
    await assert.rejects(result, error => error === controller.signal.reason);
    assert.equal(cancelled, 1);
    assert.equal(target.width * target.height, 0);
});

for (const fail of [false, true]) {
    test(`encoding ${fail ? 'failure' : 'success'} releases the rendered canvas, and crops by rendering only the region`, async () => {
        const allocated = [];
        const make = () => { const result = canvas(); result.width = result.height = 100; allocated.push(result); return result; };
        const lib = helpers();
        const calls = [];
        lib.renderPDFPageToCanvas = async (...args) => {
            calls.push(args);
            const result = make();
            if (fail) result.toDataURL = () => { throw Error('encoding failed'); };
            return result;
        };
        const page = { view: [0, 0, 100, 100], rotate: 90 };
        if (fail) {
            await assert.rejects(lib.pdfPageToImageDataUrl(page, { cropRect: [1, 1, 2, 2] }));
        } else {
            assert.equal(await lib.pdfPageToImageDataUrl(page, { cropRect: [1, 1, 2, 2] }), 'data:image/png;base64,AA==');
        }
        assert.equal(allocated.length, 1, 'no intermediate full-page, rotated or cropped copies');
        assert.deepEqual(calls[0][4], [1, 1, 2, 2]);
        assert.equal(calls[0][1], 7, 'the default resolution is unchanged for exported images');
        assert.ok(allocated.every(item => item.width * item.height === 0));
    });
}

function regionPage(rendered) {
    // A 600x800 page rotated by 90 degrees: viewport is 800x600, and PDF (x, y) maps to viewport (y, x).
    return {
        getViewport: () => ({ width: 800, height: 600, convertToViewportRectangle: ([x1, y1, x2, y2]) => [y1, x1, y2, x2] }),
        render: (params) => { rendered.push(params); return { promise: Promise.resolve() }; },
    };
}

test('rendering a crop rectangle allocates only the rectangle and shifts it to the origin', async () => {
    const target = canvas();
    const rendered = [];
    const lib = helpers({ createEl: () => target });
    const result = await lib.renderPDFPageToCanvas(regionPage(rendered), 3, {}, undefined, [100, 200, 300, 250]);
    assert.equal(result, target);
    // Rotated: the rectangle is 50 wide and 200 tall in viewport units, at (200, 100).
    assert.equal(target.width, 150);
    assert.equal(target.height, 600);
    assert.deepEqual(Array.from(rendered[0].transform, v => v + 0), [3, 0, 0, 3, -600, -300]);
});

test('without a crop rectangle the whole page is rendered as before', async () => {
    const target = canvas();
    const rendered = [];
    const lib = helpers({ createEl: () => target });
    await lib.renderPDFPageToCanvas(regionPage(rendered), 2);
    assert.equal(target.width, 1600);
    assert.equal(target.height, 1200);
    assert.deepEqual(Array.from(rendered[0].transform, v => v + 0), [2, 0, 0, 2, 0, 0]);
});

for (const fail of [false, true]) {
    test(`blob encoding ${fail ? 'failure' : 'success'} releases the rendered canvas`, async () => {
        const target = canvas();
        target.width = target.height = 100;
        target.toBlob = (callback, type) => callback(fail ? null : { type });
        const lib = helpers();
        lib.renderPDFPageToCanvas = async () => target;
        if (fail) await assert.rejects(lib.pdfPageToImageBlob({}, { cropRect: [0, 0, 1, 1] }));
        else assert.deepEqual(await lib.pdfPageToImageBlob({}, { type: 'image/webp', cropRect: [0, 0, 1, 1] }), { type: 'image/webp' });
        assert.equal(target.width * target.height, 0);
    });
}
