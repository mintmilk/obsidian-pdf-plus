import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { transform } from 'esbuild';

class Component {
    _loaded = false; _events = []; _children = [];
    load() { if (!this._loaded) { this._loaded = true; this.onload?.(); } }
    register(fn) { this._events.push(fn); }
    registerDomEvent(el, type, fn, options) { el.addEventListener(type, fn, options); this.register(() => el.removeEventListener(type, fn, options)); }
    addChild(c) { if (!this._children.includes(c)) this._children.push(c); if (this._loaded) c.load(); return c; }
    removeChild(c) { const i=this._children.indexOf(c); if(i>=0)this._children.splice(i,1); c.unload(); return c; }
    unload() { if (!this._loaded) return; this._loaded=false; while(this._children.length)this._children.pop().unload(); while(this._events.length)this._events.pop()(); this.onunload?.(); }
}
class Element extends EventTarget {
    dataset={}; listeners=new Map();
    addEventListener(t,f,o){super.addEventListener(t,f,o);if(!this.listeners.has(t))this.listeners.set(t,new Set());this.listeners.get(t).add(f);}
    removeEventListener(t,f,o){super.removeEventListener(t,f,o);this.listeners.get(t)?.delete(f);}
    count(){return [...this.listeners.values()].reduce((a,s)=>a+s.size,0);}
}
class Embed extends Component { containerEl = new Element(); viewer={}; }
class Cropped extends Embed { static documentsClosed=0; static closeUnusedDocuments(){Cropped.documentsClosed++;} onload(){this.renderPending=true;} onunload(){this.renderPending=false;} }
let loadPdfJs = async () => {};
const {code}=await transform(await readFile(new URL('../src/main.ts',import.meta.url),'utf8'),{loader:'ts',format:'cjs'});
const module={exports:{}};
runInNewContext(code,{module,exports:module.exports,require:n=>({obsidian:{Plugin:Component,Component,loadPdfJs:()=>loadPdfJs(),Keymap:{isModEvent:()=>false}},'pdf-cropped-embed':{PDFCroppedEmbed:Cropped},utils:{subpathToParams:s=>new URLSearchParams(s.replace(/^#/,'')),isTargetHTMLElement:()=>false}}[n]??{})});
const proto=module.exports.default.prototype;
function fixture(){
    const p=new Component();p.load();
    p.settings={embedUnscrollable:true};p.classes={};p.patchStatus={pdfInternals:true};
    const original=()=>new Embed();
    p.app={embedRegistry:{embedByExtension:{pdf:original},unregisterExtension(ext){delete this.embedByExtension[ext];},registerExtension(ext,f){this.embedByExtension[ext]=f;}}};
    proto.registerPDFEmbedCreator.call(p);
    const create=subpath=>p.app.embedRegistry.embedByExtension.pdf({}, {path:'sample.pdf'},subpath);
    return {p,create,original};
}
for(const subpath of ['#page=1','#page=1&rect=0,0,100,100'])test(`removed ${subpath} embeds release their listeners without growing plugin cleanup`,()=>{
    const f=fixture(), baseline=f.p._events.length;
    for(let i=0;i<40;i++){
        const embed=f.create(subpath);embed.load();
        assert.ok(embed.containerEl.count()>=3);
        embed.unload();
        assert.equal(embed.containerEl.count(),0,'removed embed retains plugin-owned listeners');
        assert.equal(f.p._events.length,baseline,'plugin cleanup closures accumulate per embed');
        assert.equal(f.p._children.length,0,'completed embed owner remains attached');
    }
    f.p.unload();
});
test('disabling the plugin releases embed handlers and unlinks its owners from still-open embeds',()=>{
    const f=fixture(), embeds=Array.from({length:3},()=>f.create('#page=2'));
    embeds.forEach(e=>e.load());f.p.unload();
    assert.equal(f.p.app.embedRegistry.embedByExtension.pdf,f.original);
    for(const embed of embeds){assert.equal(embed.containerEl.count(),0);assert.equal(embed._children.length,0);assert.equal(embed._loaded,true);embed.unload();}
});
test('layout-ready work cannot install patches after the plugin unloads',()=>{
    const p=new Component();p.load();const pending=[];let calls=0;
    p.app={workspace:{onLayoutReady:fn=>pending.push(fn)}};
    p.registerOnLayoutReady=proto.registerOnLayoutReady;
    proto.tryPatchUntilSuccess.call(p,()=>{calls++;return true;});
    p.unload();pending.forEach(fn=>fn());
    assert.equal(calls,0,'late layout callback ran a patcher after unload');
    assert.equal(p._children.length,0);
});
test('plugin unload stops still-open cropped embed rendering without unloading native embeds',()=>{
    const f=fixture(),crop=f.create('#page=1&rect=0,0,100,100'),native=f.create('#page=1');crop.load();native.load();
    const closed=Cropped.documentsClosed;
    assert.equal(crop.renderPending,true);f.p.unload();assert.equal(crop.renderPending,false);assert.equal(native._loaded,true);native.unload();
    assert.equal(Cropped.documentsClosed,closed+1,'shared cropped-embed documents are not closed on unload');
});
test('pending plugin initialization cannot resume registering resources after unload',async()=>{
    let resolve;loadPdfJs=()=>new Promise(r=>resolve=r);
    const p=new Component();p.load();p.loadGeneration=0;p.checkVersion=()=>{};p.addIcons=()=>{};
    let settingsReads=0;p.loadSettings=async()=>{settingsReads++;};p.cleanUpResources=async()=>{};
    const pending=proto.onload.call(p);await proto.onunload.call(p);resolve();await pending;
    assert.equal(settingsReads,0);loadPdfJs=async()=>{};
});
