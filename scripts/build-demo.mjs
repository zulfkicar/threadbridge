import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const root=resolve(import.meta.dirname,'..');
const files=['index.html','demo.css','demo.js','worker.js','engine.js','sql-wasm.wasm'];
const sources=['src/events.ts','src/planner.ts','src/journal.ts','src/adapters.ts','src/auth.ts','src/worker.ts','test/bridge.test.ts','test/wire-payload.test.ts','test/browser-demo.test.ts'];
await mkdir(resolve(root,'public/demo'),{recursive:true});
await build({entryPoints:[resolve(root,'public/demo/engine-entry.js')],outfile:resolve(root,'public/demo/engine.js'),bundle:true,format:'esm',platform:'browser',target:'es2022',minify:true,external:['node:fs','node:path','node:crypto'],legalComments:'eof'});
await copyFile(resolve(root,'node_modules/sql.js/dist/sql-wasm.wasm'),resolve(root,'public/demo/sql-wasm.wasm'));
const dest=process.argv[2];
if(dest){await mkdir(resolve(dest),{recursive:true});for(const file of files)await copyFile(resolve(root,'public/demo',file),resolve(dest,file));}
for(const dir of [resolve(root,'public/demo/source'),...(dest?[resolve(dest,'source')]:[])]){
  await mkdir(dir,{recursive:true});for(const source of sources)await copyFile(resolve(root,source),resolve(dir,source.replaceAll('/','-')+'.txt'));
}
console.log('Built Threadbridge browser walkthrough with the production journal and SQLite WASM.');
