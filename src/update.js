import { mkdtemp, mkdir, readFile, writeFile, rm, lstat } from 'node:fs/promises';
import { renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { unzipSync } from 'fflate';

const run = promisify(execFile);
const repository = 'Dev-Aaron27/AaronsSupport';
const required = ['package.json','package-lock.json','config.example.json','scripts/pterodactyl-start.js','src/main.js','src/update.js'];
const allowed = path => required.includes(path) || /^(src|plugins\/example)\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*\.js$/.test(path);
const limit = 16 * 1024 * 1024;
async function bytes(response) {
  if (!response.ok) throw new Error('Unable to download the GitHub update. Publish the bot files on main and check outbound internet access.');
  let size = 0; const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) throw new Error('Update download exceeds 16 MiB.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
export function runtimeFiles(archive) {
  let size = 0;
  const entries = unzipSync(archive, { filter(entry) {
    const parts = entry.name.split('/'), path = parts.slice(1).join('/');
    if (!parts[0] || parts.some(part => part === '..' || part === '.') || entry.name.includes('\\')) throw new Error('Unsafe path in update archive.');
    if (!allowed(path)) return false;
    size += entry.originalSize;
    if (size > limit) throw new Error('Unpacked runtime exceeds 16 MiB.');
    return true;
  } });
  const files = new Map(); let prefix;
  for (const [name, data] of Object.entries(entries)) {
    const [root, ...parts] = name.split('/');
    if (prefix && prefix !== root) throw new Error('Update archive has multiple source roots.');
    prefix = root; const path = parts.join('/');
    if (files.has(path)) throw new Error('Duplicate file in update archive.');
    files.set(path, data);
  }
  for (const path of required) if (!files.has(path)) throw new Error(`GitHub main is missing ${path}. Upload the updated bot source before using .update.`);
  const pkg = JSON.parse(Buffer.from(files.get('package.json')).toString());
  const lock = JSON.parse(Buffer.from(files.get('package-lock.json')).toString());
  if (pkg.name !== 'aarons-support' || pkg.type !== 'module' || lock.name !== pkg.name || lock.lockfileVersion < 2) throw new Error('GitHub archive is not an Aarons Support runtime.');
  return files;
}
export class AppUpdater {
  constructor(root, { fetcher = fetch, install = directory => run('npm',['ci','--omit=dev','--ignore-scripts','--no-audit','--no-fund'],{cwd:directory,timeout:180000,maxBuffer:1024*1024}) } = {}) {
    Object.assign(this,{root,fetcher,install}); this.busy = false; this.pending = false;
  }
  async latest() {
    const response = await this.fetcher(`https://api.github.com/repos/${repository}/commits/main`,{headers:{Accept:'application/vnd.github+json'},signal:AbortSignal.timeout(15000)});
    if (!response.ok) throw new Error('Unable to read GitHub main. The repository must be public and contain the bot source.');
    const data = await response.json();
    if (!/^[a-f0-9]{40}$/.test(data.sha || '')) throw new Error('GitHub returned an invalid revision.');
    return data.sha;
  }
  async current() {
    try { return (await readFile(join(this.root,'app','.aarons-support-revision'),'utf8')).trim(); }
    catch(error) { if(error.code !== 'ENOENT') throw error; return null; }
  }
  async apply() {
    if (this.busy) throw new Error('An update is already in progress.');
    if (this.pending) throw new Error('Restart the server in the panel to activate the installed update.');
    this.busy = true; let staging;
    const app = join(this.root,'app'), previous = join(this.root,'app.previous');
    try {
      const stat = await lstat(app);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Updates require the managed Pterodactyl app directory.');
      await readFile(join(app,'.aarons-support-managed'));
      const revision = await this.latest();
      if (revision === await this.current()) return {revision,changed:false};
      const response = await this.fetcher(`https://codeload.github.com/${repository}/zip/${revision}`,{signal:AbortSignal.timeout(60000)});
      const files = runtimeFiles(await bytes(response));
      staging = await mkdtemp(join(this.root,'.aarons-update.'));
      for (const [path, data] of files) {
        const target = join(staging,path); await mkdir(dirname(target),{recursive:true}); await writeFile(target,data,{mode:0o600});
      }
      // Syntax and dependency checks finish before replacing the working application.
      for (const path of files.keys()) if(path.endsWith('.js')) await run(process.execPath,['--check',join(staging,path)],{timeout:15000});
      await this.install(staging);
      await writeFile(join(staging,'.aarons-support-managed'),'');
      await writeFile(join(staging,'.aarons-support-revision'),revision+'\n');
      try {
        const old = await lstat(previous);
        if (!old.isDirectory() || old.isSymbolicLink()) throw new Error('app.previous is not a managed backup.');
        await readFile(join(previous,'.aarons-support-managed'));
        await rm(previous,{recursive:true});
      } catch(error) { if(error.code !== 'ENOENT') throw error; }
      renameSync(app,previous);
      try { renameSync(staging,app); staging = null; }
      catch(error) { renameSync(previous,app); throw error; }
      this.pending = true;
      return {revision,changed:true};
    } finally { if(staging) await rm(staging,{recursive:true,force:true}); this.busy = false; }
  }
}
