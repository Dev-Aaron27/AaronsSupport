import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
for(const entry of await readdir('.',{withFileTypes:true})) {
  if(!entry.isDirectory() || entry.name==='node_modules' || entry.name.startsWith('.'))continue;
  let pkg;
  try {pkg=JSON.parse(await readFile(`${entry.name}/package.json`,'utf8'));}
  catch(error) {if(error.code==='ENOENT' || error instanceof SyntaxError)continue;throw error;}
  if(pkg.name==='aarons-support')throw new Error(`Nested bot copy found in ${entry.name}/. Move the updated files to the repository root beside package.json, then delete the duplicate folder.`);
}
for(const dir of ['src','scripts','plugins/example'])for(const name of await readdir(dir)){if(!name.endsWith('.js'))continue;const result=spawnSync(process.execPath,['--check',`${dir}/${name}`],{stdio:'inherit'});if(result.status!==0)process.exit(result.status || 1);}
console.log('All source, build, and example plugin modules parse.');
