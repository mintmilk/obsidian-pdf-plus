import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { transform } from 'esbuild';
import ts from 'typescript';

async function loadModule(path, imports, globals = {}, captureJobs = false) {
    let source = await readFile(new URL(path, import.meta.url), 'utf8');
    if (captureJobs) {
        // Observe the real command's detached async job without changing its body
        // or boolean command-check return contract.
        const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
        const transformed = ts.transform(file, [context => root => {
            const visit = node => {
                if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
                    && ts.isParenthesizedExpression(node.expression.expression)
                    && ts.isArrowFunction(node.expression.expression.expression)
                    && node.expression.expression.expression.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword)) {
                    return ts.factory.updateExpressionStatement(node, ts.factory.createCallExpression(
                        ts.factory.createPropertyAccessExpression(ts.factory.createIdentifier('__jobs'), 'push'), undefined, [node.expression]));
                }
                return ts.visitEachChild(node, visit, context);
            };
            return ts.visitNode(root, visit);
        }]);
        source = ts.createPrinter().printFile(transformed.transformed[0]);
        transformed.dispose();
    }
    const { code } = await transform(source, { loader: 'ts', format: 'cjs' });
    const module = { exports: {} };
    runInNewContext(code, { module, exports: module.exports, require: name => imports[name] ?? {}, ...globals });
    return module.exports;
}

const submodule = await loadModule('../src/lib/submodule.ts', {});

for (const borrowed of [false, true]) for (const fails of [false, true]) {
    test(`extract highlighted text releases only its owned document (borrowed=${borrowed}, failure=${fails})`, async () => {
        const jobs = [], error = new Error('extraction failed');
        const { PDFPlusCommands } = await loadModule('../src/lib/commands.ts', {
            './submodule': submodule, obsidian: { Notice: class {} },
        }, { __jobs: jobs }, true);
        let destroyed = 0;
        const doc = { destroy: async () => { destroyed++; } };
        const child = { file: { path: 'fixture.pdf' } };
        const plugin = {
            app: {}, manifest: { name: 'test' }, settings: { copyCommands: [{ template: '' }], defaultColorPaletteActionIndex: 0 },
            lib: {
                getPDFViewerChild: () => child, getColorPaletteFromChild: () => null,
                getPDFDocument: () => borrowed ? doc : null, loadPDFDocument: async () => doc,
                highlight: { extract: { getAnnotatedTextsInDocument: async () => { if (fails) throw error; return new Map(); } } },
            },
        };
        const commands = Object.assign(Object.create(PDFPlusCommands.prototype), { plugin, app: plugin.app });
        assert.equal(commands.extractHighlightedText(false), true);
        assert.equal(jobs.length, 1);
        if (fails) await assert.rejects(jobs[0], received => received === error);
        else await jobs[0];
        assert.equal(destroyed, borrowed ? 0 : 1);
    });
}

for (const borrowed of [false, true]) for (const failure of [null, 'getPage', 'render', 'write']) {
    test(`rect image export releases its separate PDF on success and failure (borrowed=${borrowed}, failure=${failure})`, async () => {
        const jobs = [], win = {}, error = new Error('export failed');
        const { copyLinkLib } = await loadModule('../src/lib/copy-link.ts', { './submodule': submodule }, {
            __jobs: jobs, window: win, navigator: { clipboard: { writeText: async () => {} } },
        }, true);
        let destroyed = 0;
        const page = { destroyed: false };
        const doc = {
            getPage: async () => { if (failure === 'getPage') throw error; return page; },
            destroy: async () => { destroyed++; },
        };
        const child = { file: { path: 'fixture.pdf', basename: 'fixture' }, containerEl: { win: borrowed ? win : {} }, getPage: () => ({ pdfPage: page }) };
        const plugin = {
            app: { fileManager: { getAvailablePathForAttachment: async () => 'image.png' }, vault: {
                getConfig: () => false, createBinary: async () => { if (failure === 'write') throw error; return {}; },
            } },
            settings: { autoPaste: true, rectEmbedStaticImage: true, rectImageFormat: 'file', rectImageExtension: 'png' },
            lib: {
                getColorPaletteFromChild: () => null, generateMarkdownLink: () => '![[fixture.pdf]]', loadPDFDocument: async () => doc,
                getOptionalRenderParameters: () => ({}), pdfPageToImageArrayBuffer: async () => { if (failure === 'render') throw error; return new ArrayBuffer(0); },
            },
        };
        const copy = Object.assign(Object.create(copyLinkLib.prototype), {
            plugin, app: plugin.app, getDisplayText: () => '', onCopyFinish() {}, autoFocusOrAutoPaste: async () => {},
        });
        assert.equal(copy.copyEmbedLinkToRect(false, child, 1, [0, 0, 1, 1]), true);
        const expectsFailure = failure && (!borrowed || failure !== 'getPage');
        if (expectsFailure) await assert.rejects(jobs[0], received => received === error);
        else await jobs[0];
        assert.equal(destroyed, borrowed ? 0 : 1);
    });
}

test('pending historical rectangle export does not retain its original PDF child or page', async () => {
    const { setFlagsFromString } = await import('node:v8');
    setFlagsFromString('--expose_gc');
    const gc = runInNewContext('gc');
    const jobs = [], callbacks = [], win = {}; let reloaded = 0, destroyed = 0;
    const { copyLinkLib } = await loadModule('../src/lib/copy-link.ts', { './submodule': submodule }, {
        __jobs: jobs, window: win, navigator: { clipboard: { writeText: async () => {} } },
    }, true);
    const plugin = {
        app: { fileManager: { getAvailablePathForAttachment: async () => 'historical.png' }, vault: { getConfig: () => false, createBinary: async () => ({}) } },
        settings: { autoPaste: false, rectEmbedStaticImage: true, rectImageFormat: 'file', rectImageExtension: 'png' },
        lib: { getColorPaletteFromChild: () => null, generateMarkdownLink: () => '![[fixture.pdf]]', getOptionalRenderParameters: () => ({}),
            pdfPageToImageArrayBuffer: async () => new ArrayBuffer(0),
            loadPDFDocument: async () => { reloaded++; return { getPage: async () => ({}), destroy: async () => { destroyed++; } }; } },
    };
    const copy = Object.assign(Object.create(copyLinkLib.prototype), { plugin, app: plugin.app, getDisplayText: () => '',
        onCopyFinish(_, callback) { callbacks.push(callback); }, autoFocusOrAutoPaste: async () => {} });
    const refs = await (async () => {
        const page = { destroyed: false };
        const child = { file: { path: 'fixture.pdf', basename: 'fixture' }, containerEl: { win }, getPage: () => ({ pdfPage: page }) };
        copy.copyEmbedLinkToRect(false, child, 1, [0, 0, 1, 1]);
        await jobs.shift();
        return { child: new WeakRef(child), page: new WeakRef(page) };
    })();
    for (let i = 0; i < 8; i++) { await new Promise(setImmediate); gc(); }
    assert.equal(callbacks.length, 1);
    assert.equal(refs.child.deref(), undefined);
    assert.equal(refs.page.deref(), undefined);
    await callbacks[0]();
    assert.equal(reloaded, 1);
    assert.equal(destroyed, 1);
});
