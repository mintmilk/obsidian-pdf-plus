import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {EventEmitter} from 'node:events';
import test from 'node:test';
import {runInNewContext} from 'node:vm';
import {transform} from 'esbuild';

class Component {
    _loaded=true; _children=[]; _events=[];
    register(fn){this._events.push(fn);}
    addChild(c){this._children.push(c);return c;}
    removeChild(c){const i=this._children.indexOf(c);if(i>=0)this._children.splice(i,1);c.unload();}
    unload(){if(!this._loaded)return;this._loaded=false;while(this._children.length)this._children.pop().unload();while(this._events.length)this._events.pop()();this.onunload?.();}
}
class Menu extends Component {}
const source=await readFile(new URL('../src/context-menu.ts',import.meta.url),'utf8');
const {code}=await transform(source,{loader:'ts',format:'cjs'});
function fixture(){
    const timers=new Map();let timerId=0;const ipc=new EventEmitter();ipc.send=()=>{};
    const module={exports:{}};
    runInNewContext(code,{module,exports:module.exports,window:{electron:{ipcRenderer:ipc}},require:n=>({obsidian:{Component,Menu,Platform:{isDesktopApp:true}},'lib/component':{PDFPlusComponent:Component}}[n]??{})});
    const parent=new Component(), child={component:parent,unloaded:false,palette:{}};
    const evt={isTrusted:true,defaultPrevented:true,stopPropagation(){},stopImmediatePropagation(){},win:{setTimeout:fn=>{const id=++timerId;timers.set(id,fn);return id;},clearTimeout:id=>timers.delete(id)}};
    return {ipc,timers,module,parent,child,evt,request:()=>module.exports.onContextMenu({},child,evt)};
}
test('missing native context-menu replies release their IPC listener on every timeout',async()=>{
    const f=fixture();
    for(let i=0;i<20;i++){
        const pending=f.request();assert.equal(f.ipc.listenerCount('context-menu'),1);
        [...f.timers.values()].forEach(fn=>fn());await pending;
        assert.equal(f.ipc.listenerCount('context-menu'),0,'timed-out IPC request still holds its callback');
        assert.equal(f.timers.size,0);assert.equal(f.parent._children.length,0);assert.equal(f.parent._events.length,0);
    }
});
test('native replies remove both timeout and temporary owner',async()=>{
    const f=fixture(),pending=f.request();f.ipc.emit('context-menu',{},{});await pending;
    assert.equal(f.ipc.listenerCount('context-menu'),0);assert.equal(f.timers.size,0);assert.equal(f.parent._children.length,0);
});
test('closing a PDF cancels its waiting native menu handshake immediately',async()=>{
    const f=fixture(),pending=f.request();f.child.unloaded=true;f.parent.unload();
    assert.equal(f.ipc.listenerCount('context-menu'),0);assert.equal(f.timers.size,0);
    await pending;
});
test('a delayed context menu cannot reopen after its PDF closes',async()=>{
    const f=fixture();let complete;let shown=0,unloaded=0;
    const built=new Promise(resolve=>complete=resolve);
    f.module.exports.PDFPlusContextMenu.fromMouseEvent=()=>built;
    f.child.clearEphemeralUI=()=>{};f.child.pdfViewer={isEmbed:false};
    const pending=f.module.exports.showContextMenu({},f.child,f.evt);
    f.child.unloaded=true;f.parent.unload();
    complete({showAtMouseEvent:()=>shown++,unload:()=>unloaded++});await pending;
    assert.equal(shown,0,'a closed PDF spawned a late menu');assert.equal(unloaded,1);
});
