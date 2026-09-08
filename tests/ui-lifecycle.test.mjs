import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { transform } from 'esbuild';
import { around } from 'monkey-around';

class Component {
    _loaded = false; _events = []; _children = [];
    load() { if (!this._loaded) { this._loaded = true; this.onload?.(); } }
    register(callback) { this._events.push(callback); }
    registerDomEvent(el, type, callback, options) { el.addEventListener(type, callback, options); this.register(() => el.removeEventListener(type, callback, options)); }
    addChild(child) { this._children.push(child); if (this._loaded) child.load(); return child; }
    removeChild(child) { const i = this._children.indexOf(child); if (i >= 0) this._children.splice(i, 1); child.unload(); return child; }
    unload() { if (!this._loaded) return; this._loaded = false; while (this._children.length) this._children.pop().unload(); while (this._events.length) this._events.pop()(); this.onunload?.(); }
}
const timers = new Map(); let nextTimer = 0;
const win = { setTimeout: fn => { const id = ++nextTimer; timers.set(id, fn); return id; }, clearTimeout: id => timers.delete(id), getSelection: () => ({ empty() {} }) };
function flushTimers() { for (const [id, fn] of [...timers]) { timers.delete(id); fn(); } }
let doc;
class Element {
    listeners = new Map(); children = []; dataset = {}; classes = new Set(); value = ''; childNodes = []; style = {};
    constructor(classes = '') { this.doc = doc; this.win = win; for (const cls of classes.split(' ')) this.classes.add(cls); }
    addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); }
    removeEventListener(type, fn, options) { this.lastRemoval = { type, fn, options }; this.listeners.get(type)?.delete(fn); }
    count(type) { return type ? (this.listeners.get(type)?.size ?? 0) : [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0); }
    dispatch(type, properties = {}) { for (const fn of [...this.listeners.get(type) ?? []]) fn({ target: this, relatedTarget: null, preventDefault() {}, stopImmediatePropagation() {}, instanceOf: () => true, ...properties }); }
    addClass(cls) { this.classes.add(cls); } removeClass(cls) { this.classes.delete(cls); } hasClass(cls) { return this.classes.has(cls); }
    toggleClass(cls, on) { on ? this.addClass(cls) : this.removeClass(cls); }
    setText(text) { this.textContent = text; } appendText() {} getText() { return this.textContent; } setCssStyles() {} setCssProps() {} show() {} hide() {} focus() {} select() {}
    append(...children) { this.children.push(...children); children.forEach(el => { el.parent = this; }); }
    prepend(el) { this.append(el); } appendChild(el) { this.append(el); return el; } insertAfter(el) { this.append(el); }
    after(el) { this.parent?.append(el); } remove() { if (this.parent) this.parent.children = this.parent.children.filter(el => el !== this); this.removed = true; }
    removeChild(el) { el.remove(); } empty() { this.children = []; this.childNodes = []; }
    createDiv(options = '', callback) { const el = new Element(typeof options === 'string' ? options : options.cls ?? ''); this.append(el); callback?.(el); return el; }
    createEl() { return this.createDiv(); } createSpan(options) { return this.createDiv(options); }
    querySelectorAll() { return []; } querySelector() { return null; } closest() { return this.page ?? null; }
    getBoundingClientRect() { return { left: 0, top: 0 }; } contains() { return true; }
}
doc = new Element(); doc.doc = doc; doc.body = new Element();
class Modal {
    constructor(app) { this.app = app; this.modalEl = new Element(); this.contentEl = this.modalEl.createDiv(); this.titleEl = new Element(); this.containerEl = new Element(); this.scope = { register() {} }; }
    open() { return this.onOpen?.(); } close() { return this.onClose?.(); }
}
class Control {
    inputEl = new Element(); buttonEl = new Element(); extraSettingsEl = new Element(); selectEl = new Element();
    then(fn) { fn(this); return this; } setIcon() { return this; } setTooltip() { return this; } setValue() { return this; } setPlaceholder() { return this; }
    onChange() { return this; } onClick(fn) { this.click = fn; return this; } setButtonText() { return this; } setCta() { return this; } setWarning() { return this; }
}
class Setting {
    constructor(el) { this.settingEl = el.createDiv(); this.descEl = this.settingEl.createDiv(); }
    then(fn) { fn(this); return this; } setName() { return this; } setDesc() { return this; } setHeading() { return this; } setClass() { return this; }
    addButton(fn) { fn(new Control()); return this; } addText(fn) { fn(new Control()); return this; }
    addExtraButton(fn) { this.lastButton = new Control(); fn(this.lastButton); return this; }
}
class EventBus {
    events = new Map();
    on(type, fn) { if (!this.events.has(type)) this.events.set(type, new Set()); this.events.get(type).add(fn); }
    off(type, fn) { this.events.get(type)?.delete(fn); }
    dispatch(type, value) { this.events.get(type)?.forEach(fn => fn(value)); }
    count(type) { return this.events.get(type)?.size ?? 0; }
}
const created = [];
const create = (tag, options = '', callback) => { const el = new Element(typeof options === 'string' ? options : options.cls ?? ''); created.push(el); callback?.(el); return el; };
const imports = { obsidian: { Component, Modal, Setting, FuzzySuggestModal: class {}, setIcon() {}, setTooltip() {}, Platform: { isPhone: false }, Keymap: { isModifier: evt => !!evt.mod } } };
const globals = { HTMLElement: Element, Element, Node: Element, MouseEvent: class {}, HTMLInputElement: Element,
    setTimeout: win.setTimeout, clearTimeout: win.clearTimeout, activeWindow: win, document: doc, window: win,
    createEl: create, createDiv: (options, callback) => create('div', options, callback), createSpan: (options, callback) => create('span', options, callback),
    getComputedStyle: () => ({ borderTopWidth: '0', borderLeftWidth: '0', paddingTop: '0', paddingLeft: '0' }), createFragment: fn => { const el = new Element(); fn(el); return el; } };
async function load(path) {
    const { code } = await transform(await readFile(new URL(path, import.meta.url), 'utf8'), { loader: 'ts', format: 'cjs' });
    const module = { exports: {} }; runInNewContext(code, { ...globals, module, exports: module.exports, require: name => imports[name] ?? {} }); return module.exports;
}
imports['lib/component'] = await load('../src/lib/component.ts');
imports.utils = await load('../src/utils/events.ts');
imports.modals = imports['./base-modal'] = await load('../src/modals/base-modal.ts');
const { PDFOutlineTitleModal } = await load('../src/modals/outline-modals.ts');
const { MarkdownModal } = await load('../src/modals/markdown-modal.ts');
const { PDFAnnotationEditModal } = await load('../src/modals/annotation-modals.ts');
const { PDFPageLabelEditModal } = await load('../src/modals/page-label-modals.ts');
const { PDFPlusToolbar } = await load('../src/toolbar.ts');
const { ColorPalette } = await load('../src/color-palette.ts');
const plugin = () => Object.assign(new Component(), { _loaded: true, app: { workspace: { trigger() {} } }, lib: { isEditable: () => true }, settings: {}, manifest: { name: 'Fixture PDF++' } });

test('outline title modal releases document keypress when cancelled and supports reopening', () => {
    const modal = new PDFOutlineTitleModal(plugin(), 'Title');
    modal.open(); assert.equal(doc.count('keypress'), 1); modal.close();
    assert.equal(doc.count('keypress'), 0);
    modal.open(); assert.equal(doc.count('keypress'), 1); modal.close(); assert.equal(doc.count('keypress'), 0);
});
test('Markdown modal loads its render owner and releases its registered resources on close', () => {
    imports.obsidian.MarkdownRenderer = { render(_app, _md, _el, _path, owner) { owner.registerDomEvent(doc, 'render-fixture', () => {}); return Promise.resolve(); } };
    const modal = new MarkdownModal(plugin()); modal.open(); assert.equal(doc.count('render-fixture'), 1); modal.close(); assert.equal(doc.count('render-fixture'), 0);
});
test('closing an annotation modal while data loads prevents late controls from being created', async () => {
    const modal = new PDFAnnotationEditModal({ contents: true }, plugin(), { path: 'fixture.pdf' }, 1, '1');
    let resolve; modal.readOldValues = () => new Promise(r => { resolve = r; });
    let controls = 0; modal.initContentsSetting = modal.addContentsSetting = modal.addButtons = () => controls++;
    const pending = modal.onOpen(); modal.close(); resolve(); await pending;
    assert.equal(controls, 0);
});
test('completed hover popups release child owners and their timers', () => {
    const owner = new Component(); owner.load(); const parent = new Element();
    imports.utils.showChildElOnParentElHover({ parentEl: parent, createChildEl: () => new Element(), removeChildEl() {}, component: owner });
    for (let i = 0; i < 30; i++) { parent.dispatch('mouseover'); parent.dispatch('mouseout'); flushTimers(); }
    assert.equal(owner._children.length, 0); owner.unload(); assert.equal(timers.size, 0);
});
test('moving repeatedly into one hover popup installs a single mouseout handler', () => {
    const owner = new Component(); owner.load(); const parent = new Element(), popup = new Element();
    imports.utils.showChildElOnParentElHover({ parentEl: parent, createChildEl: () => popup, removeChildEl() {}, component: owner });
    parent.dispatch('mouseover'); for (let i = 0; i < 30; i++) popup.dispatch('mouseover');
    assert.equal(popup.count('mouseout'), 1); owner.unload();
});
test('toolbar replacement releases the PDF scale listener and pending DOM insertion timers', () => {
    const p = plugin(); p.settings.zoomLevelInputBoxInToolbar = true;
    const bus = new EventBus(), left = new Element(), zoomOut = left.createDiv(); zoomOut.nextElementSibling = left.createDiv('pdf-toolbar-divider');
    const toolbar = { zoomOutEl: zoomOut, pdfViewer: { eventBus: bus, pdfViewer: { currentScale: 1 } } };
    const owner = new PDFPlusToolbar(p, toolbar, {}); owner._loaded = true;
    owner.addZoomLevelInputEl(); assert.equal(bus.count('scalechanging'), 1); owner.unload();
    assert.equal(bus.count('scalechanging'), 0); assert.equal(timers.size, 0);
});
test('repeated page label display drops obsolete preview-button listeners', () => {
    const modal = Object.create(PDFPageLabelEditModal.prototype); modal.component = new Component(); modal.component.load();
    modal.plugin = { ...plugin(), requireModKeyForLinkHover: () => false }; modal.app = modal.plugin.app; modal.file = { path: 'fixture.pdf' };
    modal.controlEl = new Element(); modal.doc = {}; modal.pageLabels = null;
    let first;
    for (let i = 0; i < 20; i++) { modal.display(); const setting = new Setting(modal.controlEl); modal.addPreviewButton(setting, 1); first ??= setting.lastButton.extraSettingsEl; }
    assert.equal(first.count('mouseover'), 0); assert.ok(modal.component._children.length <= 1); modal.component.unload();
});
test('repeated rectangle-selection activation and Escape do not retain session cleanup closures', () => {
    const p = plugin(), viewer = new Element(), child = { pdfViewer: { dom: { viewerEl: viewer } } };
    const palette = new ColorPalette(p, child, new Element()); palette._loaded = true; palette.cropButtonEl = new Element();
    for (let i = 0; i < 30; i++) { palette.startRectangularSelection(false); doc.dispatch('keydown', { key: 'Escape' }); }
    assert.equal(palette._events.length, 0); assert.equal(palette._children.length, 0); assert.equal(viewer.count('pointerdown'), 0); palette.unload();
});

test('modifier-key hover waits are removed on owner unload and leave no completed child owners', () => {
    const owner = new Component(); owner.load(); const target = new Element(); let calls = 0;
    const baseline = doc.count();
    for (let i = 0; i < 20; i++) {
        imports.utils.onModKeyPress({ doc }, target, () => calls++, owner);
        doc.dispatch('keydown', { mod: true });
    }
    assert.equal(calls, 20); assert.equal(owner._children.length, 0); assert.equal(owner._events.length, 0);
    imports.utils.onModKeyPress({ doc }, target, () => calls++, owner); owner.unload();
    assert.equal(doc.count(), baseline); doc.dispatch('keydown', { mod: true }); assert.equal(calls, 20);
});
test('closing and reopening modal owners is bounded, and plugin unload closes the active modal', () => {
    const p = plugin(), modal = new PDFOutlineTitleModal(p, 'Title');
    for (let i = 0; i < 20; i++) { modal.open(); assert.equal(p._children.length, 1); modal.close(); assert.equal(p._children.length, 0); }
    modal.open(); p.unload(); assert.equal(doc.count('keypress'), 0); assert.equal(modal.component._loaded, false); assert.equal(p._children.length, 0);
});
test('rectangle drag completion and cancellation remove page handlers and the selection box', () => {
    const p = plugin(), viewer = new Element(), page = new Element(); page.dataset.pageNumber = '1'; page.page = page;
    let copied = 0; p.lib.copyLink = { copyEmbedLinkToRect() { copied++; } };
    win.pdfjsLib = { Util: { normalizeRect: value => value } };
    const child = { pdfViewer: { dom: { viewerEl: viewer } }, getPage: () => ({ id: 1, getPagePoint: (x, y) => [x, y] }) };
    const palette = new ColorPalette(p, child, new Element()); palette._loaded = true; palette.cropButtonEl = new Element();
    for (let i = 0; i < 12; i++) {
        palette.startRectangularSelection(false); viewer.dispatch('pointerdown', { target: page, clientX: 1, clientY: 1 });
        page.dispatch('pointermove', { clientX: 25, clientY: 25 }); page.dispatch('pointerup');
        assert.equal(page.count(), 0); assert.equal(page.children.length, 0); assert.equal(palette._children.length, 0);
    }
    assert.equal(copied, 12);
    palette.startRectangularSelection(false); viewer.dispatch('pointerdown', { target: page, clientX: 1, clientY: 1 });
    palette.unload(); assert.equal(page.count(), 0); assert.equal(page.children.length, 0); assert.equal(viewer.count(), 0);
});
test('annotation preview renderers are replaced and discarded when returning to the editor', async () => {
    const modal = new PDFAnnotationEditModal({}, plugin(), { path: 'fixture.pdf' }, 1, '1');
    modal.readOldValues = async () => {}; modal.addButtons = () => {}; await modal.open();
    modal.editorEl = new Element(); modal.previewEl = new Element();
    imports.obsidian.MarkdownRenderer = { render(_app, _text, _el, _path, owner) { owner.registerDomEvent(doc, 'preview-fixture', () => {}); return Promise.resolve(); } };
    for (let i = 0; i < 20; i++) { await modal.showPreview(); assert.equal(doc.count('preview-fixture'), 1); }
    await modal.showEditor(); assert.equal(doc.count('preview-fixture'), 0); assert.equal(modal.component._children.length, 0); modal.close();
});
test('dummy-file form redraws close suggestions belonging to replaced inputs', async () => {
    const suggestions = [];
    imports.obsidian.AbstractInputSuggest = class {
        constructor() { this.closed = false; suggestions.push(this); }
        onSelect() { return this; } close() { this.closed = true; }
    };
    const suggest = await load('../src/utils/suggest.ts');
    imports.utils.FuzzyFolderSuggest = suggest.FuzzyFolderSuggest;
    const { DummyFileModal } = await load('../src/modals/dummy-file-modals.ts');
    const modal = new DummyFileModal(plugin()); imports.modals.PDFPlusModal.prototype.onOpen.call(modal);
    modal.displayDesktop = modal.displayMobile = () => modal.addFolderSetting();
    for (let i = 0; i < 20; i++) modal.display();
    assert.ok(suggestions.slice(0, -1).every(s => s.closed)); assert.equal(suggestions.at(-1).closed, false);
    modal.close(); assert.ok(suggestions.every(s => s.closed));
});
test('auto-copy context menu remains available after mode toggles and ends with the plugin', async () => {
    let menus = 0;
    imports.obsidian.Menu = class { constructor() { menus++; } addItem() {} onHide() {} showAtMouseEvent() {} };
    const { AutoCopyMode } = await load('../src/auto-copy.ts');
    const p = plugin(), icon = new Element(); p.settings.autoCopyToggleRibbonIcon = true; p.addRibbonIcon = () => icon; p.saveSettings = () => {};
    const mode = new AutoCopyMode(p); mode.enable(); mode.disable(); mode.enable(); icon.dispatch('contextmenu');
    assert.equal(menus, 1); p.unload(); assert.equal(icon.count('contextmenu'), 0); mode.unload();
});

test('settings wait for the actual markdown render and reject an obsolete description target', async () => {
    imports.obsidian.PluginSettingTab = class { constructor(app) { this.app = app; this.containerEl = new Element(); } };
    imports.obsidian.Events = class { trigger() {} };
    imports.utils.getModifierNameInPlatform = () => 'Control';
    imports['pdfjs-enums'] = { SidebarView: {}, ScrollMode: {}, SpreadMode: {} };
    const { PDFPlusSettingTab } = await load('../src/settings.ts');
    const tab = new PDFPlusSettingTab(plugin()); tab.component.load();
    let resolve, calls = 0, finished = false;
    imports.obsidian.MarkdownRenderer = { render() { calls++; return new Promise(r => { resolve = r; }); } };
    const el = new Element(), pending = tab.renderMarkdown('First description', el).then(() => { finished = true; });
    await Promise.resolve(); await Promise.resolve(); assert.equal(finished, false);
    resolve(); await pending;
    tab.component.unload(); tab.component = new Component(); tab.component.load();
    const second = tab.renderMarkdown('Old callback, second description', el); await Promise.resolve();
    assert.equal(calls, 1); await second;
    let displays = 0; tab.display = () => displays++; tab.component.unload(); tab.redisplay(); assert.equal(displays, 0);
});

test('late annotation popup text cannot install drag handlers after its popup owner closes', async () => {
    imports['monkey-around'] = { around };
    const { registerAnnotationPopupDrag } = await load('../src/drag.ts');
    const p = plugin(); let registered = 0, resolve;
    p.app.dragManager = { handleDrag() { registered++; } };
    const viewerOwner = new Component(); viewerOwner.load(); const popupOwner = new Component(); popupOwner.load();
    const file = { path: 'fixture.pdf' }, child = { component: viewerOwner, file, unloaded: false, getPage: () => ({}), getAnnotatedText: () => new Promise(r => { resolve = r; }) };
    const pending = registerAnnotationPopupDrag(p, new Element(), child, file, 1, '1', popupOwner);
    popupOwner.unload(); resolve('Annotated text'); await pending; await Promise.resolve();
    assert.equal(registered, 0);
});
test('thumbnail drag handlers belong to the current file owner and retain native capture options', async () => {
    const { registerThumbnailDrag } = await load('../src/drag.ts');
    const p = plugin(), owner = new Component(), viewerOwner = new Component(), target = new Element(); owner.load(); viewerOwner.load(); target.dataset.pageNumber = '1';
    const options = { capture: true }; const original = target.addEventListener;
    p.app.dragManager = { handleDrag(el, callback) { el.addEventListener('dragstart', callback, options); } };
    const file = { path: 'fixture.pdf' }, child = { component: viewerOwner, pdfPlusFileComponent: owner, file, unloaded: false,
        pdfViewer: { pdfThumbnailViewer: { container: { querySelectorAll: () => [target] } }, pagesCount: 1 }, getPage: () => ({ pageLabel: null }) };
    registerThumbnailDrag(p, child, file); assert.equal(target.addEventListener, original); assert.equal(target.count('dragstart'), 1);
    owner.unload(); assert.equal(target.count('dragstart'), 0); assert.equal(target.lastRemoval.options, options);
});
test('outline destinations resolving after file-owner unload cannot attach new drag handlers', async () => {
    const { registerOutlineDrag } = await load('../src/drag.ts');
    const p = plugin(), owner = new Component(), viewerOwner = new Component(); owner.load(); viewerOwner.load();
    let resolve, attached = 0; p.lib.copyLink = { getTextToCopyForOutlineItemDynamic: () => new Promise(r => { resolve = r; }) }; p.lib.toSingleLine = x => x;
    p.app.dragManager = { handleDrag() { attached++; }, handleDrop() { attached++; } };
    const file = { path: 'fixture.pdf' }, child = { component: viewerOwner, pdfPlusFileComponent: owner, file, unloaded: false };
    const pending = registerOutlineDrag(p, { allItems: [{ item: { title: 'Section' }, selfEl: new Element() }] }, child, file);
    owner.unload(); resolve(() => 'Link'); await pending; assert.equal(attached, 0);
});

test('palette unload hides an already-open native menu so it cannot retain the palette', () => {
    const menus = [];
    imports.obsidian.Menu = class {
        constructor() { menus.push(this); }
        onHide(fn) { this.onHidden = fn; }
        hide() { this.hidden = true; this.onHidden?.(); }
    };
    imports.utils.showMenuUnderParentEl = menu => { menu.hidden = false; };
    const palette = new ColorPalette(plugin(), {}, new Element()); palette._loaded = true;
    const button = palette.addDropdown(new Element(), [], 'actionIndex', '');
    button.dispatch('click'); assert.equal(menus[0].hidden, false); palette.unload(); assert.equal(menus[0].hidden, true);
});

test('a pending layout-ready installer notice cannot open a modal after plugin unload', async () => {
    imports.utils.getInstallerVersion = () => '1.0.0'; imports.utils.isVersionOlderThan = () => true;
    const { InstallerVersionModal } = await load('../src/modals/installer-version-modal.ts');
    let ready, opened = 0; const p = plugin(); p.app.workspace.onLayoutReady = callback => { ready = callback; };
    InstallerVersionModal.prototype.open = () => opened++;
    InstallerVersionModal.openIfNecessary(p); p.unload(); ready(); assert.equal(opened, 0);
});
