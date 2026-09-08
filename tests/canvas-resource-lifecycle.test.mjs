import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { transform } from 'esbuild';

const source = await readFile(new URL('../src/utils/html-canvas.ts', import.meta.url), 'utf8');
const { code } = await transform(source, { loader: 'ts', format: 'cjs' });
for (const operation of ['crop', 'rotate']) {
    test(`${operation} clears the newly allocated canvas if drawing fails`, () => {
        const error = Error('drawing failed');
        const allocated = [];
        const module = { exports: {} };
        runInNewContext(code, { module, exports: module.exports, createEl: () => {
            const result = { width: 0, height: 0, getContext: () => ({ translate() {}, rotate() {}, drawImage() { throw error; } }) };
            allocated.push(result);
            return result;
        } });
        const original = { width: 100, height: 200 };
        assert.throws(() => operation === 'crop'
            ? module.exports.cropCanvas(original, { left: 0, top: 0, width: 50, height: 50 })
            : module.exports.rotateCanvas(original, 90), received => received === error);
        assert.equal(allocated.length, 1);
        assert.equal(allocated[0].width * allocated[0].height, 0);
        assert.equal(original.width * original.height, 20000, 'borrowed input remains owned by caller');
    });
}
