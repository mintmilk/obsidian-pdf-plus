import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { transform } from 'esbuild';

// Match Obsidian's ownership behavior: offref removes the registration from the
// event bus, but the reference itself still holds its callback and context.
class Events {
    listeners = new Set();

    on(name, callback, ctx) {
        const ref = { e: this, name, callback, ctx };
        this.listeners.add(ref);
        return ref;
    }

    offref(ref) {
        this.listeners.delete(ref);
    }

    trigger(name, ...args) {
        for (const ref of [...this.listeners]) {
            if (ref.name === name) ref.callback.call(ref.ctx, ...args);
        }
    }
}

class Component {
    children = new Set();
    cleanups = [];

    register(callback) {
        this.cleanups.push(callback);
    }

    registerEvent(ref) {
        this.register(() => ref.e.offref(ref));
    }

    addChild(child) {
        this.children.add(child);
        return child;
    }

    removeChild(child) {
        if (this.children.delete(child)) child.unload();
    }

    unload() {
        for (const child of [...this.children]) this.removeChild(child);
        this.cleanups.splice(0).forEach(cleanup => cleanup());
    }
}

// Transpile the real helper; unrelated plugin services are never instantiated.
const source = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
const { code } = await transform(source, { loader: 'ts', format: 'cjs' });
const module = { exports: {} };
runInNewContext(code, {
    module, exports: module.exports,
    require: name => name === 'obsidian' ? { Component, Plugin: Component } : {},
});
const register = module.exports.default.prototype.registerOneTimeEvent;

test('completed callbacks leave no registrations or plugin cleanup owners', () => {
    const plugin = new Component();
    const bus = new Events();
    const context = { values: [] };
    const cancellations = [];
    for (let index = 0; index < 100; index++) {
        cancellations.push(register.call(plugin, bus, 'paste', function (value) {
            assert.equal(this, context);
            this.values.push(value);
            assert.equal(bus.listeners.size, 0);
            assert.equal(plugin.children.size, 0);
        }, context));
        assert.equal(plugin.children.size, 1);
        bus.trigger('paste', index);
    }
    cancellations.forEach(cancel => cancel());
    assert.equal(context.values.length, 100);
    assert.equal(bus.listeners.size, 0);
    assert.equal(plugin.children.size, 0);
    assert.equal(plugin.cleanups.length, 0);
});

test('pending callbacks remain independent until fired, cancelled, or unloaded', () => {
    const plugin = new Component();
    const bus = new Events();
    const calls = [];
    const cancelFirst = register.call(plugin, bus, 'first', () => calls.push('first'));
    register.call(plugin, bus, 'second', () => calls.push('second'));
    assert.equal(bus.listeners.size, 2);
    assert.equal(plugin.children.size, 2);
    cancelFirst();
    cancelFirst();
    bus.trigger('first');
    assert.equal(bus.listeners.size, 1);
    assert.equal(plugin.children.size, 1);
    bus.trigger('second');
    assert.deepEqual(calls, ['second']);
    assert.equal(plugin.children.size, 0);

    const cancelThird = register.call(plugin, bus, 'third', () => calls.push('third'));
    plugin.unload();
    cancelThird();
    bus.trigger('third');
    assert.equal(bus.listeners.size, 0);
    assert.equal(plugin.children.size, 0);
    assert.deepEqual(calls, ['second']);
});

test('reentrant dispatch invokes a once callback only once', () => {
    const plugin = new Component();
    const bus = new Events();
    let calls = 0;
    register.call(plugin, bus, 'change', () => {
        calls++;
        if (calls === 1) bus.trigger('change');
    });
    bus.trigger('change');
    assert.equal(calls, 1);
    assert.equal(bus.listeners.size, 0);
    assert.equal(plugin.children.size, 0);
});

test('throwing callbacks have already released their owner and registration', () => {
    const plugin = new Component();
    const bus = new Events();
    const failure = Error('expected callback failure');
    let calls = 0;
    register.call(plugin, bus, 'change', () => { calls++; throw failure; });
    assert.throws(() => bus.trigger('change'), error => error === failure);
    bus.trigger('change');
    assert.equal(calls, 1);
    assert.equal(bus.listeners.size, 0);
    assert.equal(plugin.children.size, 0);
});
