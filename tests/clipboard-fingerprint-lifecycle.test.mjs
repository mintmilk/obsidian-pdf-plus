import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, randomFillSync, webcrypto } from 'node:crypto';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { setFlagsFromString } from 'node:v8';
import { transform } from 'esbuild';

setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc');
const tick = () => new Promise(setImmediate);
class Component {
    _loaded = false; _children = []; _events = [];
    load() { this._loaded = true; }
    register(fn) { this._events.push(fn); }
    addChild(child) { this._children.push(child); if (this._loaded) child.load(); return child; }
    removeChild(child) { this._children = this._children.filter(c => c !== child); child.unload(); }
    unload() { if (!this._loaded) return; this._loaded = false; while (this._children.length) this._children.pop().unload(); while (this._events.length) this._events.pop()(); }
}
async function load(path, imports = {}, globals = {}) {
    const { code } = await transform(await readFile(new URL(path, import.meta.url), 'utf8'), { loader: 'ts', format: 'cjs' });
    const module = { exports: {} };
    runInNewContext(code, { module, exports: module.exports, require: name => imports[name] ?? {}, console, TextEncoder, ...globals });
    return module.exports;
}
const submodule = await load('../src/lib/submodule.ts');
async function fixture(mode = 'native') {
    const pending = [], digests = [], timers = [], nativeJobs = [];
    const MarkdownView = class { saves = 0; file = { extension: 'md' }; save() { this.saves++; } };
    const crypto = mode === 'missing' ? undefined : { subtle: { digest(algorithm, bytes) {
        digests.push(bytes.byteLength);
        if (mode === 'reject') return Promise.reject(new Error('WebCrypto unavailable'));
        if (mode === 'deferred') return new Promise(resolve => pending.push(() => resolve(webcrypto.subtle.digest(algorithm, bytes))));
        const job = webcrypto.subtle.digest(algorithm, bytes);
        nativeJobs.push(job);
        return job;
    } } };
    const { copyLinkLib } = await load('../src/lib/copy-link.ts', {
        './submodule': submodule, obsidian: { MarkdownView },
        '@noble/hashes/sha2.js': await import('@noble/hashes/sha2.js'),
    }, { crypto, setTimeout: callback => timers.push(callback) });
    const plugin = new Component(); plugin.load();
    const handlers = new Set();
    plugin.app = { workspace: {} };
    plugin.registerOneTimeEvent = (_, name, callback) => {
        const owner = plugin.addChild(new Component());
        const handler = (...args) => { plugin.removeChild(owner); return callback(...args); };
        handlers.add(handler); owner.register(() => handlers.delete(handler));
        return () => plugin.removeChild(owner);
    };
    const copy = new copyLinkLib(plugin);
    const paste = (text, info = { file: { extension: 'md' } }) => {
        const event = { clipboardData: { getData: () => text } };
        return Promise.all([...handlers].map(cb => cb(event, {}, info)));
    };
    return { copy, plugin, handlers, paste, pending, digests, timers, nativeJobs, MarkdownView };
}

test('immediate paste is observed while its copied-text fingerprint is still pending', async () => {
    const f = await fixture('deferred'); let calls = 0;
    f.copy.watchPaste('immediate', () => calls++);
    assert.equal(f.handlers.size, 1);
    const pasted = f.paste('immediate');
    assert.equal(f.handlers.size, 0);
    for (const complete of f.pending.splice(0)) complete();
    await pasted; assert.equal(calls, 1);
    assert.equal(f.plugin._children.length, 0);
});

test('fingerprints preserve CRLF normalization, unicode, mismatches and A/B/history-A actions', async () => {
    const f = await fixture(), calls = [];
    f.copy.watchPaste('A\r\n文😀', () => calls.push('A'));
    f.copy.watchPaste('B', () => calls.push('B'));
    await f.paste('A\n文😀'); assert.deepEqual(calls, ['A']);
    assert.equal(f.digests.length, 3, 'one copied digest per entry, one shared digest for this paste');
    f.copy.watchPaste('not-this', () => calls.push('wrong'));
    await f.paste('different'); assert.deepEqual(calls, ['A']);
});

for (const mode of ['reject', 'missing']) test(`WebCrypto ${mode} falls back to the same SHA-256 without retaining full text`, async () => {
    const f = await fixture(mode); let calls = 0;
    f.copy.watchPaste('fallback\r\n测试', () => calls++);
    await f.paste('fallback\n测试'); assert.equal(calls, 1);
    const { sha256 } = await import('@noble/hashes/sha2.js');
    const bytes = new TextEncoder().encode('abc');
    assert.equal(Buffer.from(sha256(bytes)).toString('hex'), createHash('sha256').update('abc').digest('hex'));
});

test('plugin unload cancels unobserved waits but completes an already committed paste action', async () => {
    const f = await fixture('deferred'); let calls = 0;
    f.copy.watchPaste('before', () => calls++);
    f.plugin.unload(); assert.equal(f.handlers.size, 0);
    for (const complete of f.pending.splice(0)) complete(); await tick();
    assert.equal(calls, 0);
    f.plugin.load(); f.copy.watchPaste('during', () => calls++);
    const pasted = f.paste('during'); f.plugin.unload();
    for (const complete of f.pending.splice(0)) complete(); await pasted;
    assert.equal(calls, 1);
    assert.equal(f.plugin.lastPasteFile, undefined);
});

test('twelve pending base64 copies release their large strings after fingerprinting', async () => {
    const f = await fixture();
    const collect = async () => { for (let i = 0; i < 6; i++) { await tick(); gc(); } };
    const memory = () => { const usage = process.memoryUsage(); return usage.heapUsed + usage.external; };
    await collect(); const before = memory();
    await (async () => {
        for (let index = 0; index < 12; index++) {
            const base64 = randomFillSync(Buffer.allocUnsafe(3 * 1024 * 1024)).toString('base64');
            f.copy.watchPaste(`![](data:image/png;base64,${base64})\n\n[[fixture.pdf]]`);
        }
    })();
    // Let native digest jobs finish before measuring retained memory, not transient encodings.
    await Promise.all(f.nativeJobs); await collect();
    const retainedBytes = memory() - before;
    console.log(JSON.stringify({ scenario: '12x4MiB-base64-no-paste', payloadBytes: 48 * 1024 * 1024, retainedBytes, listeners: f.handlers.size }));
    assert.equal(f.handlers.size, 12);
    assert.ok(retainedBytes < 4 * 1024 * 1024, `pending copied text still retains ${retainedBytes} bytes`);
    f.plugin.unload(); await collect(); assert.equal(f.handlers.size, 0);
});


test('native note saving remains scheduled before delayed clipboard fingerprints resolve', async () => {
    const f = await fixture('deferred'), info = new f.MarkdownView();
    f.copy.watchPaste('save'); const pasted = f.paste('save', info);
    assert.equal(f.timers.length, 1);
    f.timers.shift()(); assert.equal(info.saves, 1);
    for (const complete of f.pending.splice(0)) complete(); await pasted;
    assert.equal(info.saves, 1);
});

test('out-of-order digests preserve newest paste target while completing both historical file actions', async () => {
    const f = await fixture('deferred'), first = { file: { extension: 'md', path: 'one.md' } }, second = { file: { extension: 'md', path: 'two.md' } }, calls = [];
    f.copy.watchPaste('A', () => calls.push('A')); const pastedA = f.paste('A', first);
    f.copy.watchPaste('B', () => calls.push('B')); const pastedB = f.paste('B', second);
    f.pending[2](); f.pending[3](); await pastedB;
    assert.equal(f.plugin.lastPasteFile, second.file);
    f.pending[0](); f.pending[1](); await pastedA;
    assert.equal(f.plugin.lastPasteFile, second.file);
    assert.deepEqual(calls, ['B', 'A']);
});


test('a newer nonmatching paste does not suppress the most recent matching target', async () => {
    const f = await fixture('deferred'), first = { file: { extension: 'md', path: 'one.md' } }, second = { file: { extension: 'md', path: 'two.md' } };
    f.copy.watchPaste('A'); const pastedA = f.paste('A', first);
    f.copy.watchPaste('B'); const pastedB = f.paste('unrelated', second);
    f.pending[2](); f.pending[3](); await pastedB;
    f.pending[0](); f.pending[1](); await pastedA;
    assert.equal(f.plugin.lastPasteFile, first.file);
});


test('paste target is the event-time file even if the Markdown view switches before its digest completes', async () => {
    const f = await fixture('deferred'), originalFile = { extension: 'md', path: 'original.md' }, info = { file: originalFile };
    f.copy.watchPaste('switch'); const pasted = f.paste('switch', info);
    info.file = { extension: 'md', path: 'later.md' };
    for (const complete of f.pending.splice(0)) complete(); await pasted;
    assert.equal(f.plugin.lastPasteFile, originalFile);
});
