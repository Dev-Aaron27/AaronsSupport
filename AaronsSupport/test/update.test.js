import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { zipSync, strToU8 } from 'fflate';
import { AppUpdater, runtimeFiles } from '../src/update.js';

const revision = 'a'.repeat(40);
function archive(extra = {}) {
  const files = {
    'package.json': JSON.stringify({ name:'aarons-support',type:'module',version:'2.0.0' }),
    'package-lock.json': JSON.stringify({ name:'aarons-support',lockfileVersion:3 }),
    'config.example.json':'{}','src/main.js':'export const updated = true;',
    'src/update.js':'export const updater = true;','scripts/pterodactyl-start.js':'console.log("start");',
    '.env':'DO_NOT_INSTALL_THIS=secret','data/inbox.sqlite':'private','plugins/custom/index.js':'private',
    ...extra,
  };
  return zipSync(Object.fromEntries(Object.entries(files).map(([path,data])=>['repo-'+revision+'/'+path,strToU8(data)])));
}
async function fixture(t, options = {}) {
  const root=await mkdtemp(join(tmpdir(),'managed-update-'));t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(join(root,'app'));await writeFile(join(root,'app','.aarons-support-managed'),'');await writeFile(join(root,'app','original.txt'),'working app');
  for(const path of ['config.json','data/keep.txt','plugins/custom/keep.txt']) {await mkdir(join(root,join(path,'..')),{recursive:true});await writeFile(join(root,path),'keep '+path);}
  const urls=[],fetcher=async url=>{urls.push(url);return url.includes('api.github.com')?Response.json({sha:revision}):new Response(archive());};
  const updater=new AppUpdater(root,{fetcher,install:async directory=>{await mkdir(join(directory,'node_modules'));},...options});
  return {root,updater,urls};
}

test('managed updates install a pinned revision, preserve state and retain the working app for rollback',async t=>{
  const {root,updater,urls}=await fixture(t);
  const result=await updater.apply();assert.equal(result.changed,true);assert.equal(result.revision,revision);
  assert.ok(urls[1].endsWith('/zip/'+revision));assert.equal(await updater.current(),revision);
  assert.match(await readFile(join(root,'app','src/main.js'),'utf8'),/updated/);
  assert.equal(await readFile(join(root,'app.previous','original.txt'),'utf8'),'working app');
  for(const path of ['config.json','data/keep.txt','plugins/custom/keep.txt'])assert.equal(await readFile(join(root,path),'utf8'),'keep '+path);
  assert.ok(!(await readdir(join(root,'app'))).includes('.env'));
  await assert.rejects(updater.apply(),/Restart/);
  const restarted=new AppUpdater(root,{fetcher:async()=>Response.json({sha:revision}),install:async()=>{throw new Error('unnecessary install');}});
  assert.deepEqual(await restarted.apply(),{revision,changed:false});
});

test('failed syntax, download and dependency installation preserve the old app and remove staging',async t=>{
  for(const failure of ['syntax','download','dependencies']) {
    const {root,updater}=await fixture(t,{
      fetcher:async url=>url.includes('api.github.com')?Response.json({sha:revision}):failure==='download'?new Response('',{status:503}):new Response(archive(failure==='syntax'?{'src/main.js':'export = broken;'}:{})),
      install:async()=>{if(failure==='dependencies')throw new Error('npm unavailable');},
    });
    await assert.rejects(updater.apply());assert.equal(await readFile(join(root,'app','original.txt'),'utf8'),'working app');
    assert.ok(!(await readdir(root)).some(name=>name.startsWith('.aarons-update.')));
  }
});

test('updates reject unmarked apps, symlinked backups and overlapping installs',async t=>{
  const {root,updater}=await fixture(t);await rm(join(root,'app','.aarons-support-managed'));await assert.rejects(updater.apply());
  await writeFile(join(root,'app','.aarons-support-managed'),'');await symlink(join(root,'app'),join(root,'app.previous'));await assert.rejects(updater.apply(),/managed backup/);
  assert.equal(await readFile(join(root,'app','original.txt'),'utf8'),'working app');await rm(join(root,'app.previous'));
  let release,entered;const started=new Promise(resolve=>{entered=resolve;});
  updater.install=async()=>{entered();await new Promise(resolve=>{release=resolve;});};
  const installing=updater.apply();await started;await assert.rejects(updater.apply(),/already in progress/);release();await installing;
});

test('runtime update extraction requires complete source, excludes state and rejects traversal and oversized data',()=>{
  const files=runtimeFiles(archive());assert.ok(files.has('src/main.js'));assert.ok(!files.has('.env'));assert.ok(!files.has('data/inbox.sqlite'));assert.ok(!files.has('plugins/custom/index.js'));
  assert.throws(()=>runtimeFiles(zipSync({'repo/src/main.js':strToU8('')})),/missing/);
  assert.throws(()=>runtimeFiles(archive({'../outside.js':'unsafe'})),/Unsafe path/);
  assert.throws(()=>runtimeFiles(archive({'src/huge.js':'x'.repeat(17*1024*1024)})),/exceeds/);
});
