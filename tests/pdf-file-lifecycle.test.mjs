import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {runInNewContext} from 'node:vm';
import {transform} from 'esbuild';
import {around} from 'monkey-around';
class Component {
    _loaded=false;_children=[];_events=[];
    load(){if(!this._loaded){this._loaded=true;this.onload?.();}}
    register(fn){this._events.push(fn);}
    registerDomEvent(el,t,f,o){el.addEventListener(t,f,o);this.register(()=>el.removeEventListener(t,f,o));}
    addChild(c){this._children.push(c);if(this._loaded)c.load();return c;}
    removeChild(c){const i=this._children.indexOf(c);if(i>=0)this._children.splice(i,1);c.unload();return c;}
    unload(){if(!this._loaded)return;this._loaded=false;while(this._children.length)this._children.pop().unload();while(this._events.length)this._events.pop()();this.onunload?.();}
}
class EventBus {
    listeners=new Map();
    on(t,f){if(!this.listeners.has(t))this.listeners.set(t,new Set());this.listeners.get(t).add(f);}
    off(t,f){this.listeners.get(t)?.delete(f);}
    dispatch(t,data){return Promise.all([...this.listeners.get(t)??[]].map(f=>f(data)));}
    count(){return [...this.listeners.values()].reduce((n,s)=>n+s.size,0);}
}
async function source(path,imports,suffix=''){
    const {code}=await transform(await readFile(new URL(path,import.meta.url),'utf8')+suffix,{loader:'ts',format:'cjs'});const module={exports:{}};
    runInNewContext(code,{module,exports:module.exports,URL:{revokeObjectURL:url=>imports.revoked.push(url)},require:n=>imports[n]??{}});return module.exports;
}
async function fixture(){
    const rendered=[];
    const imports={obsidian:{Component,Platform:{},MarkdownRenderer:{render:async(_a,_m,_el,_s,owner)=>{rendered.push(owner);owner.addChild(new Component());}}},'monkey-around':{around},utils:{isEmbed:()=>false,isNonEmbedLike:()=>false,hookInternalLinkMouseEventHandlers(){}},revoked:[]};
    imports['lib/component']=await source('../src/lib/component.ts',imports);
    imports.bib={BibliographyManager:class extends Component{}};
    imports['vim/vim']={VimBindings:{register(){}}};
    const lib=await source('../src/lib/index.ts',imports);
    const patchers=await source('../src/patchers/pdf-internals.ts',imports,'\nexport {patchPDFViewerChild, patchPDFViewerComponent};');
    const {patchPDFViewerChild}=patchers;
    class Child {
        async loadFile(file){this.file=file;} unload(){this.unloaded=true;}
        renderAnnotationPopup(){const content={textContent:'',addClass(){}};this.activeAnnotationPopupEl={querySelector:q=>q==='.popupContent'?content:null};}
        destroyAnnotationPopup(){this.activeAnnotationPopupEl=null;}
    }
    const plugin=new Component();plugin.load();plugin.app={vault:{getResourcePath:f=>f.path}};plugin.settings={};plugin.pdfViewerChildren=new Map();
    plugin.lib={registerPDFEvent:lib.PDFPlusLib.prototype.registerPDFEvent,getExternalPDFUrl:async f=>'blob:'+f.path,getAnnotationInfoFromAnnotationElement:()=>({page:1,id:'a'}),highlight:{writeFile:{getAnnotationContents:async()=> 'A note with an embed'}}};
    const child=new Child();child.component=plugin.addChild(new Component());child.unloaded=false;child.pdfViewer={eventBus:new EventBus()};child.containerEl={querySelector:()=>null};
    patchPDFViewerChild(plugin,child);
    return {plugin,child,bus:child.pdfViewer.eventBus,imports,rendered,patchers};
}
test('reloading files in one viewer replaces PDF event owners instead of accumulating subscriptions',async()=>{
    const f=await fixture();let baseline;
    try{for(let i=0;i<25;i++){
        await f.child.loadFile({path:`file-${i}.pdf`,stat:{size:1000}});
        baseline??=f.bus.count();assert.equal(f.bus.count(),baseline,'file reload accumulated PDF.js listeners');
        assert.equal(f.bus.listeners.get('annotationlayerrendered').size,1);
    }}finally{f.child.unload();f.plugin.unload();}
    assert.equal(f.bus.count(),0);
});
test('reloading a viewer does not accumulate PageUp and PageDown key handlers',async()=>{
    const f=await fixture();f.plugin.settings.usePageUpAndPageDown=true;
    class Viewer {
        scope={keys:[],register(_mods,key,fn){const binding={key,fn};this.keys.push(binding);return binding;},unregister(binding){this.keys.splice(this.keys.indexOf(binding),1);}};
        async onload(){this.child={component:new Component(),pdfViewer:{pdfViewer:{}}};this.child.component.load();}
    }
    const viewer=new Viewer();f.patchers.patchPDFViewerComponent(f.plugin,viewer);
    try{for(let i=0;i<20;i++){
        await viewer.onload();assert.equal(viewer.scope.keys.length,2);viewer.child.component.unload();
        assert.equal(viewer.scope.keys.length,0,'closed viewer retained PageUp/PageDown callbacks');
    }}finally{f.child.unload();f.plugin.unload();}
});
test('unloading a PDF cancels its pending page-sync debounce',async()=>{
    const f=await fixture();let pending;
    f.imports.utils.isNonEmbedLike=()=>true;
    f.imports.obsidian.debounce=callback=>{const fn=data=>{pending=()=>callback(data);};fn.cancel=()=>{pending=undefined;};return fn;};
    f.plugin.lib.workspace={getActivePDFView:()=>null};
    try{
        await f.child.loadFile({path:'sample.pdf',stat:{size:1000}});
        await f.bus.dispatch('pagechanging',{pageNumber:2});assert.equal(typeof pending,'function');
        f.child.unload();assert.equal(pending,undefined,'debounce still captures the closed PDF');
    }finally{f.plugin.unload();}
});
test('closing a viewer cancels queued PDF patch initialization and settles its promise',async()=>{
    const f=await fixture();f.plugin.patchStatus={pdfInternals:false};
    class Viewer extends Component {next=[];then(fn){this.next.push(fn);}onunload(){this.next=[];}}
    const viewer=new Viewer();viewer.load();
    const pending=f.patchers.patchPDFInternals(f.plugin,viewer);viewer.unload();
    const result=await Promise.race([pending,new Promise(resolve=>setImmediate(()=>resolve('pending')))]);
    assert.equal(result,false,'patch promise retained its loading viewer after close');
    f.child.unload();f.plugin.unload();
});
test('unloading the plugin removes a queued PDF-ready patch callback',async()=>{
    const f=await fixture();f.plugin.patchStatus={pdfInternals:false};
    class Viewer extends Component {next=[];then(fn){this.next.push(fn);}}
    const viewer=new Viewer();viewer.load();f.patchers.patchPDFInternals(f.plugin,viewer);
    assert.equal(viewer.next.length,1);f.plugin.unload();assert.equal(viewer.next.length,0,'viewer still captures unloaded plugin through its ready callback');
    viewer.unload();
});
test('closing annotation popups releases their Markdown render children while the PDF stays open',async()=>{
    const f=await fixture();await f.child.loadFile({path:'sample.pdf',stat:{size:1000}});f.plugin.settings.renderMarkdownInStickyNote=true;
    const baseline=f.child.component._children.length;
    try{for(let i=0;i<20;i++){
        f.child.renderAnnotationPopup({data:{subtype:'Text'}});await new Promise(setImmediate);
        f.child.destroyAnnotationPopup();
        assert.equal(f.rendered.at(-1)._loaded,false,'Markdown render owner survives closing its popup');
        assert.equal(f.child.component._children.length,baseline);
    }}finally{f.child.unload();f.plugin.unload();}
});
test('late Markdown annotation contents cannot create children in a closed popup',async()=>{
    const f=await fixture();await f.child.loadFile({path:'sample.pdf',stat:{size:1000}});f.plugin.settings.renderMarkdownInStickyNote=true;
    let resolve;f.plugin.lib.highlight.writeFile.getAnnotationContents=()=>new Promise(r=>resolve=r);
    try{
        f.child.renderAnnotationPopup({data:{subtype:'Text'}});f.child.destroyAnnotationPopup();resolve('Late note');await new Promise(setImmediate);
        assert.equal(f.rendered.length,0,'late annotation read attached a renderer after the popup closed');
    }finally{f.child.unload();f.plugin.unload();}
});
test('reloading external PDFs revokes each obsolete blob before the viewer closes',async()=>{
    const f=await fixture();
    try{for(let i=0;i<8;i++){
        await f.child.loadFile({path:`remote-${i}.pdf`,stat:{size:100}});
        assert.equal(f.imports.revoked.length,i,'old external document URL survived a file reload');
    }}finally{f.child.unload();f.plugin.unload();}
    assert.equal(f.imports.revoked.length,8);
});
