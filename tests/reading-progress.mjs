import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
globalThis.crypto ??= webcrypto;
globalThis.window = globalThis;
const output = await build({ entryPoints: ['src/reading-progress.ts'], bundle: true, write: false, format: 'esm', platform: 'node', plugins: [{ name: 'obsidian-mock', setup(b) { b.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'mock' })); b.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({ contents: 'export class Component { register() {} } export class Notice {} export class TFile {}' })); } }] });
const { ReadingProgressSync, latest, validProgress } = await import('data:text/javascript;base64,' + Buffer.from(output.outputFiles[0].text).toString('base64'));
const base = {schema: 1, file: 'books/a.pdf', device: 'a', revision: 10, page: 30};
assert(validProgress(base));
for (const change of [{page: 0}, {page: NaN}, {revision: Infinity}, {zoom: -1}, {top: 'x'}, {schema: 2}]) assert(!validProgress({...base, ...change}));
assert.equal(latest([base, {...base, revision: 11, page: 5}]).page, 5, 'Latest read wins even after flipping backwards');
assert.equal(latest([base, {...base, device: 'z'}]).device, 'z', 'Stable tie break');
const storage = new Map();
const vault = {
 getFiles: () => [...storage.keys()].filter(p => p.endsWith('.json')).map(path => ({path, extension: 'json'})),
 read: async f => storage.get(f.path),
 getAbstractFileByPath: p => storage.has(p) ? {path:p} : null,
 createFolder: async p => storage.set(p, ''),
 create: async (p,s) => { storage.set(p,s); }, modify: async (f,s) => storage.set(f.path,s)
};
function device() {
 const events = new Map(), handlers = new Map();
 const doc = {hidden:false, addEventListener(){},removeEventListener(){}};
 const viewer = {pagesCount:100, currentPageNumber:1, currentScale:1, _location:{pageNumber:1,left:0,top:800}, container:{ownerDocument:doc, addEventListener:(e,h)=>handlers.set(e,h),removeEventListener(){}}, eventBus:{on:(e,h)=>events.set(e,h), off:e=>events.delete(e)}};
 const component = {then: cb=>cb({pdfViewer:{pdfViewer:viewer}}),register(){}};
 const plugin = {settings:{readingProgressSync:true},app:{vault,workspace:{activeLeaf:{view:{viewer:component}}}},lib:{isPDFView:()=>true,applyPDFViewStateToViewer:(v,p)=>{v.currentPageNumber=p.page;v._location={pageNumber:p.page,left:p.left,top:p.top};}}};
 return {sync:new ReadingProgressSync(plugin),component,viewer,events,handlers};
}
const a = device();
await a.sync.open(a.component, {path:base.file});
a.events.get('updateviewarea')();
await new Promise(r=>setTimeout(r,750));
assert.equal(storage.size,0,'Loading does not write progress');
a.handlers.get('wheel')();
a.viewer._location.pageNumber=30;
a.events.get('updateviewarea')();
await new Promise(r=>setTimeout(r,850));
await a.sync.queue;
assert.equal([...storage.keys()].filter(p=>p.endsWith('.json')).length,1);
const b=device();
await b.sync.open(b.component,{path:base.file});
assert.equal(b.viewer.currentPageNumber,30,'Second device restores synced progress');
b.handlers.get('wheel')();b.viewer._location.pageNumber=5;b.events.get('updateviewarea')();
await new Promise(r=>setTimeout(r,850));await b.sync.queue;
assert.equal([...storage.keys()].filter(p=>p.endsWith('.json')).length,2,'Devices have independent records');
const c=device();await c.sync.open(c.component,{path:base.file});assert.equal(c.viewer.currentPageNumber,5);
const explicit=device();await explicit.sync.open(explicit.component,{path:base.file},'#page=12');assert.equal(explicit.viewer.currentPageNumber,1,'Explicit destination left to native reader');
storage.set('PDF++ Reading Progress/broken.json','{');
const d=device();await d.sync.open(d.component,{path:base.file});assert.equal(d.viewer.currentPageNumber,5,'Corrupt sync record ignored');
console.log('Passed: validation, ordering, passive load, save, cross-device resume, backward reading, independent writers, explicit link, corrupt records.');
