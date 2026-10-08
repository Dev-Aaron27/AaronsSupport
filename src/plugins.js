import { readdir, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { commands } from './catalog.js';

export class Plugins {
  constructor(root,store,transport) {Object.assign(this,{root:resolve(root),store,transport});this.loaded=new Map();this.registry=new Map();}
  async available() {try{return (await readdir(this.root,{withFileTypes:true})).filter(e=>e.isDirectory() && /^[a-z][a-z0-9_-]{0,40}$/.test(e.name)).map(e=>e.name);}catch(e){if(e.code==='ENOENT')return [];throw e;}}
  command(name) {return this.registry.get(name);}
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
    try {await plugin.start?.(api);this.loaded.set(name,{plugin,api,registered});}
    catch(error){for(const cmd of registered)this.registry.delete(cmd);try{await plugin.stop?.();}catch{}throw error;}
  }
  async unload(name) {const entry=this.loaded.get(name);if(!entry)throw new Error('Plugin is not loaded.');try{await entry.plugin.stop?.();}finally{for(const command of entry.registered)this.registry.delete(command);this.loaded.delete(name);}}
  async emit(event,context) {for(const [name,{plugin,api}] of this.loaded){try{await plugin.hooks?.[event]?.(structuredClone(context),api);}catch(error){this.transport.report(error,`plugin ${name} ${event}`);}}}
  async start(names) {for(const name of names){try{await this.load(name);}catch(error){this.transport.report(error,`plugin ${name} load`);}}}
  async stop() {for(const name of [...this.loaded.keys()]){try{await this.unload(name);}catch(error){this.transport.report(error,`plugin ${name} stop`);}}}
}
