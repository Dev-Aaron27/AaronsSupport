import { readdir, realpath, mkdir, writeFile } from 'node:fs/promises';
import { resolve, sep, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { commands } from './catalog.js';

export function parseGitHubPluginUrl(source) {
  let url = String(source || '').trim();
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  const parsed = new URL(url);
  const host = parsed.hostname.toLowerCase();
  if (host === 'raw.githubusercontent.com') {
    const parts = parsed.pathname.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
    if (parts.length < 3) throw new Error('Invalid raw GitHub URL.');
    const [owner, repo, branch, ...pathParts] = parts;
    return { owner, repo, branch, path: pathParts.join('/'), isRaw: true };
  }
  if (host === 'github.com') {
    const parts = parsed.pathname.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
    if (parts.length < 2) throw new Error('Invalid GitHub repository URL.');
    const owner = parts[0];
    const repo = parts[1].replace(/\.git$/i, '');
    const rest = parts.slice(2);
    let branch = null;
    let path = '';
    if (rest.length > 0) {
      if (rest[0] === 'tree' || rest[0] === 'blob') {
        branch = rest[1] || 'main';
        path = rest.slice(2).join('/');
      } else {
        path = rest.join('/');
      }
    }
    return { owner, repo, branch, path, isRaw: path.endsWith('.js') };
  }
  throw new Error('Only GitHub URLs (github.com or raw.githubusercontent.com) are supported.');
}

export async function fetchPluginFromGitHub(source) {
  const info = parseGitHubPluginUrl(source);
  const userAgent = 'AaronsSupport-PluginInstaller';
  const headers = { 'User-Agent': userAgent, 'Accept': 'application/vnd.github.v3+json' };
  const files = [];

  async function fetchRaw(url) {
    const res = await fetch(url, { headers: { 'User-Agent': userAgent } });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return await res.text();
  }

  if (info.isRaw) {
    const rawUrl = source.startsWith('https://raw.githubusercontent.com')
      ? source
      : `https://raw.githubusercontent.com/${info.owner}/${info.repo}/${info.branch || 'main'}/${info.path}`;
    const content = await fetchRaw(rawUrl);
    const fileName = basename(info.path) || 'index.js';
    files.push({ name: fileName, content });
  } else {
    let apiSuccess = false;
    try {
      const apiPath = info.path ? `/${info.path.replace(/^\/+|\/+$/g, '')}` : '';
      const refQuery = info.branch ? `?ref=${encodeURIComponent(info.branch)}` : '';
      const apiUrl = `https://api.github.com/repos/${info.owner}/${info.repo}/contents${apiPath}${refQuery}`;
      const res = await fetch(apiUrl, { headers });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) {
          for (const item of data) {
            if (item.type === 'file' && (item.name.endsWith('.js') || item.name.endsWith('.json') || item.name.endsWith('.md'))) {
              if (item.size && item.size > 2 * 1024 * 1024) continue;
              const downloadUrl = item.download_url || `https://raw.githubusercontent.com/${info.owner}/${info.repo}/${info.branch || 'main'}/${item.path}`;
              const content = await fetchRaw(downloadUrl);
              files.push({ name: item.name, content });
            }
          }
          apiSuccess = files.length > 0;
        } else if (data && data.type === 'file') {
          const content = await fetchRaw(data.download_url);
          files.push({ name: data.name || 'index.js', content });
          apiSuccess = true;
        }
      }
    } catch {
      apiSuccess = false;
    }

    if (!apiSuccess || files.length === 0) {
      const branchesToTry = info.branch ? [info.branch] : ['main', 'master'];
      let fetched = null;
      let lastErr = null;
      for (const br of branchesToTry) {
        const candidateUrl = `https://raw.githubusercontent.com/${info.owner}/${info.repo}/${br}/${info.path ? info.path.replace(/^\/+|\/+$/g, '') + '/' : ''}index.js`;
        try {
          fetched = await fetchRaw(candidateUrl);
          break;
        } catch (err) {
          lastErr = err;
        }
      }
      if (!fetched) {
        throw new Error(`Could not find plugin index.js at GitHub repository (${lastErr?.message || 'not found'}).`);
      }
      files.push({ name: 'index.js', content: fetched });
    }
  }

  const indexFile = files.find(f => f.name === 'index.js');
  if (!indexFile) throw new Error('Plugin does not contain an index.js file.');

  const nameMatch = indexFile.content.match(/\bname\s*:\s*['"]([a-z][a-z0-9_-]{0,40})['"]/i);
  let pluginName = nameMatch?.[1]?.toLowerCase();

  if (!pluginName) {
    const pathParts = (info.path || '').split('/').filter(Boolean);
    const candidate = pathParts.length > 0 ? pathParts[pathParts.length - 1].replace(/\.js$/i, '') : info.repo;
    const sanitized = candidate.toLowerCase().replace(/[^a-z0-9_-]/g, '');
    if (/^[a-z][a-z0-9_-]{0,40}$/.test(sanitized)) pluginName = sanitized;
  }

  if (!pluginName || !/^[a-z][a-z0-9_-]{0,40}$/.test(pluginName)) {
    throw new Error('Plugin name must be 1–41 lowercase alphanumeric characters, starting with a letter.');
  }

  return { name: pluginName, files };
}

export class Plugins {
  constructor(root,store,transport) {Object.assign(this,{root:resolve(root),store,transport});this.loaded=new Map();this.registry=new Map();}
  async available() {try{return (await readdir(this.root,{withFileTypes:true})).filter(e=>e.isDirectory() && /^[a-z][a-z0-9_-]{0,40}$/.test(e.name)).map(e=>e.name);}catch(e){if(e.code==='ENOENT')return [];throw e;}}
  command(name) {return this.registry.get(name);}
  async install(source) {
    const { name, files } = await fetchPluginFromGitHub(source);
    await mkdir(this.root, { recursive: true });
    const rootPath = await realpath(this.root);
    const targetDir = resolve(rootPath, name);
    if (!targetDir.startsWith(rootPath + sep)) {
      throw new Error('Target plugin directory must be inside the plugins root.');
    }
    await mkdir(targetDir, { recursive: true });
    for (const file of files) {
      const fileName = basename(file.name);
      if (!fileName || fileName.startsWith('.')) continue;
      await writeFile(resolve(targetDir, fileName), file.content, 'utf8');
    }
    this.transport.info?.('plugins', `Installed plugin ${name} from GitHub into ${targetDir}.`);
    return { name, files: files.map(f => f.name) };
  }
  async load(name) {
    if(!/^[a-z][a-z0-9_-]{0,40}$/.test(name))throw new Error('Invalid plugin name.');
    if(this.loaded.has(name))throw new Error('Plugin is already loaded.');
    const root=await realpath(this.root),entry=await realpath(resolve(root,name,'index.js'));
    if(!entry.startsWith(root+sep))throw new Error('Plugin entry must be inside the plugin directory.');
    const plugin=(await import(`${pathToFileURL(entry).href}?reload=${Date.now()}`)).default;
    if(!plugin || plugin.apiVersion!==1 || plugin.name!==name)throw new Error('Plugin must export apiVersion: 1 and a matching name.');
    const registered=[];
    const api=Object.freeze({
      get:key=>this.store.pluginGet(name,key), set:(key,value)=>this.store.pluginSet(name,key,value),
      log:action=>this.store.event(null,`plugin:${name}`,String(action).slice(0,200)),
      registerCommand:(command,spec)=>{
        if(!/^[a-z][a-z0-9_-]{0,31}$/.test(command) || Object.hasOwn(commands,command) || this.registry.has(command) || Object.hasOwn(this.transport.config.aliases,command))throw new Error('Plugin command name conflicts or is invalid.');
        if(!Number.isInteger(spec.level) || spec.level<2 || spec.level>5 || typeof spec.execute!=='function' || typeof spec.description!=='string')throw new Error('Plugin commands require level 2–5, description, and execute(context).');
        this.registry.set(command,{...spec,plugin:name});registered.push(command);
      },
    });
    try {await plugin.start?.(api);this.loaded.set(name,{plugin,api,registered});this.transport.info?.('plugins',`Loaded plugin: ${name}.`);}
    catch(error){for(const cmd of registered)this.registry.delete(cmd);try{await plugin.stop?.();}catch{}throw error;}
  }
  async unload(name) {const entry=this.loaded.get(name);if(!entry)throw new Error('Plugin is not loaded.');try{await entry.plugin.stop?.();}finally{for(const command of entry.registered)this.registry.delete(command);this.loaded.delete(name);this.transport.info?.('plugins',`Unloaded plugin: ${name}.`);}}
  async emit(event,context) {for(const [name,{plugin,api}] of this.loaded){try{await plugin.hooks?.[event]?.(structuredClone(context),api);}catch(error){this.transport.report(error,`plugin ${name} ${event}`);}}}
  async start(names) {for(const name of names){try{await this.load(name);}catch(error){this.transport.report(error,`plugin ${name} load`);}}}
  async stop() {for(const name of [...this.loaded.keys()]){try{await this.unload(name);}catch(error){this.transport.report(error,`plugin ${name} stop`);}}}
}
