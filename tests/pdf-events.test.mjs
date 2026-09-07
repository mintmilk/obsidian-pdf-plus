import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { transform } from 'esbuild';

// Exercise the actual TypeScript helper without starting Obsidian or constructing
// its unrelated PDF services. registerPDFEvent only uses the two supplied owners.
const source = await readFile(new URL('../src/lib/index.ts', import.meta.url), 'utf8');
const { code } = await transform(source, { loader: 'ts', format: 'cjs' });
const module = { exports: {} };
runInNewContext(code, { module, exports: module.exports, require: () => ({}) });
const registerPDFEvent = module.exports.PDFPlusLib.prototype.registerPDFEvent;

class EventBus {
    listeners = new Map();

    on(name, callback) {
        if (!this.listeners.has(name)) this.listeners.set(name, new Set());
        this.listeners.get(name).add(callback);
    }

    off(name, callback) {
        this.listeners.get(name)?.delete(callback);
    }

    // PDF.js invokes listeners synchronously. Expose their promises to the test
    // so rejected and pending async callbacks are also observed.
    dispatch(name, data) {
        return Promise.all([...this.listeners.get(name) ?? []].map((callback) => callback(data)));
    }

    count(name) {
        return this.listeners.get(name)?.size ?? 0;
    }
}

class Component {
    cleanups = [];

    register(callback) {
        this.cleanups.push(callback);
    }

    unload() {
        this.cleanups.splice(0).forEach((callback) => callback());
    }
}

test('persistent listeners receive events until their viewer unloads', async () => {
    const bus = new EventBus();
    const component = new Component();
    const received = [];
    registerPDFEvent('textlayerrendered', bus, component, (data) => received.push(data.pageNumber));

    await bus.dispatch('textlayerrendered', { pageNumber: 1 });
    await bus.dispatch('textlayerrendered', { pageNumber: 2 });
    component.unload();
    await bus.dispatch('textlayerrendered', { pageNumber: 3 });

    assert.deepEqual(received, [1, 2]);
    assert.equal(bus.count('textlayerrendered'), 0);
});

test('an unfired once listener is removed when its viewer unloads', async () => {
    const bus = new EventBus();
    const component = new Component();
    let calls = 0;
    registerPDFEvent('outlineloaded', bus, component, () => calls++, { once: true });

    component.unload();
    await bus.dispatch('outlineloaded', {});

    assert.equal(calls, 0);
    assert.equal(bus.count('outlineloaded'), 0);
});

for (const withOwner of [true, false]) {
    test(`once is respected during async and reentrant dispatch (${withOwner ? 'viewer-owned' : 'legacy null owner'})`, async () => {
        const bus = new EventBus();
        const component = withOwner ? new Component() : null;
        let release;
        const gate = new Promise((resolve) => { release = resolve; });
        let calls = 0;
        let reentrant;
        registerPDFEvent('outlineloaded', bus, component, async () => {
            calls++;
            if (calls === 1) reentrant = bus.dispatch('outlineloaded', {});
            await gate;
        }, withOwner ? { once: true } : undefined);

        const first = bus.dispatch('outlineloaded', {});
        const repeated = bus.dispatch('outlineloaded', {});
        try {
            assert.equal(calls, 1);
            assert.equal(bus.count('outlineloaded'), 0);
        } finally {
            release();
            await Promise.all([first, repeated, reentrant]);
            component?.unload();
        }
    });
}

test('a rejecting once callback is not invoked again', async () => {
    const bus = new EventBus();
    const component = new Component();
    const error = new Error('outline unavailable');
    let calls = 0;
    registerPDFEvent('outlineloaded', bus, component, async () => {
        calls++;
        throw error;
    }, { once: true });

    await assert.rejects(bus.dispatch('outlineloaded', {}), (received) => received === error);
    await bus.dispatch('outlineloaded', {});
    component.unload();

    assert.equal(calls, 1);
    assert.equal(bus.count('outlineloaded'), 0);
});

test('closing one viewer does not remove another viewer listener on the same bus', async () => {
    const bus = new EventBus();
    const first = new Component();
    const second = new Component();
    const received = [];
    registerPDFEvent('pagerendered', bus, first, () => received.push('first'), { once: true });
    registerPDFEvent('pagerendered', bus, second, () => received.push('second'), { once: true });

    first.unload();
    await bus.dispatch('pagerendered', {});
    second.unload();

    assert.deepEqual(received, ['second']);
    assert.equal(bus.count('pagerendered'), 0);
});
