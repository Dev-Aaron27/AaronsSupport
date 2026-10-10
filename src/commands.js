import { AppUpdater } from './update.js';
import { randomBytes } from 'node:crypto';
import { commands, replyCommands, replyOptions } from './catalog.js';
import { authorize, requiredLevel } from './permissions.js';
import { validateConfig, runtimeKeys, parseDuration } from './config.js';
import { button, selectMenu, sendPanels, formatVariables, stripPings } from './ui.js';

export const idFrom = value => /^(?:<@!?|<#)?(\d{17,20})>?$/.exec(value || '')?.[1];
export const firstArg = args => {const match=/^(\S+)(?:\s+([\s\S]*))?$/.exec(args.trim());return [match?.[1] || '',match?.[2] || ''];};
const pageNumber = value => {const page=Number(value || 1);if(!Number.isSafeInteger(page) || page<1 || page>1000000)throw new Error('Page must be a positive integer.');return page;};
const requireTicket = ticket => {if(!ticket)throw new Error('Run this command inside an active inbox channel.');return ticket;};

export class CommandRouter {
  constructor(inbox,transport,store,plugins,viewer) {Object.assign(this,{inbox,transport,store,plugins,viewer});this.config=inbox.config;this.confirmations=new Map();this.updater=process.env.MODMAIL_HOSTING==='pterodactyl'?new AppUpdater(process.cwd()):null;}
  set(key,value) {const validated=validateConfig({...this.config,[key]:value});this.store.setSetting(key,validated[key]);this.config[key]=validated[key];return validated[key];}
  async target(value,actorId) {
    const role=/^<@&(\d{17,20})>$/.exec(value);
    const target={kind:role?'role':'user',id:role?.[1] || idFrom(value) || (!value?actorId:null)};
    if(!target.id || !await this.transport.validNotification(target))throw new Error('Choose a current staff user or role that has access to modmail.');
    return target;
  }
  ticketFor(ctx,value) {const ticket=value?this.store.ticket(Number(value)):ctx.ticket;if(!ticket || ticket.status==='closed')throw new Error('Provide an active ticket number.');return ticket;}
  confirmation(ctx,action,ids,text) {
    for(const [key,value] of this.confirmations)if(value.expires<Date.now())this.confirmations.delete(key);
    const token=randomBytes(12).toString('hex');
    this.confirmations.set(token,{actor:ctx.message.author.id,channel:ctx.message.channelId,expires:Date.now()+60000,action,ids});
    return ctx.respond(text,{controls:[button('Confirm',`confirm:${token}`,4)]});
  }
  async confirm(ctx,token) {
    const pending=this.confirmations.get(token);
    if(!pending || pending.expires<Date.now() || pending.actor!==ctx.message.author.id || pending.channel!==ctx.message.channelId)throw new Error('This confirmation expired or belongs to someone else. Run the command again.');
    authorize(pending.action,ctx.level,this.config,this.plugins);
    this.confirmations.delete(token);
    if(pending.action==='clearsnoozed') {
      let count=0;
      for(const id of pending.ids) {const ticket=this.store.ticket(id);if(ticket?.status==='open' && ticket.snoozed_at){await this.inbox.unsnooze(ticket);count++;}}
      return ctx.respond(`Unsnoozed ${count} conversations.`);
    }
    const ticket=this.ticketFor(ctx,String(pending.ids[0]));
    await ctx.respond('Archiving conversation…');await this.inbox.close(ticket,'Closed from staff controls',ctx.message.author.id);
  }
  async help(ctx,args) {
    if(args==='r')args='reply';if(args==='ar')args='areply';
    const item=commands[args] || this.plugins?.command(args);
    if(item) {return ctx.respond(`${item.description}\nUsage: ${this.config.prefix}${args}${item.usage?' '+item.usage:''}\nPermission level: ${requiredLevel(args,this.config,this.plugins)}${replyCommands.has(args)?'\nVariables: {user.name}, {user.id}, {moderator.name}, {server.name}, {ticket.id}.':''}`,{title:args});}
    const available=[...Object.values(commands),...[...(this.plugins?.registry || [])].map(([name,spec])=>({name,...spec}))];
    const pages=Math.max(1,Math.ceil(available.length/10)), page=Math.min(pageNumber(args),pages);
    const controls=[];
    const options = available.slice((page-1)*10,page*10).map(c=>({label: c.name, value: `help:${ctx.message.author.id}:${c.name}`, description: c.description.slice(0,100)}));
    if(options.length)controls.push(selectMenu(`help:${ctx.message.author.id}:_menu`, options, `Select a command...`));
    if(page>1)controls.push(button('Previous',`help:${ctx.message.author.id}:${page-1}`));
    if(page<pages)controls.push(button('Next',`help:${ctx.message.author.id}:${page+1}`));
    return ctx.respond(available.slice((page-1)*10,page*10).map(c=>`**[${requiredLevel(c.name,this.config,this.plugins)}] ${this.config.prefix}${c.name}**: ${c.description}`).join('\n')+`\n\nPage ${page} of ${pages} · ${this.config.prefix}help command for details.\nNumbers in brackets show the permission level required to run each command.`,{title:'Modmail commands',controls});
  }
  async dispatch(ctx, command) {
    const steps = command.steps || [command];
    // Check every command before the first side effect; recheck each during execution.
    for (const step of steps) {
      authorize(step.name,ctx.level,this.config,this.plugins);
      if (['snippet','alias'].includes(step.name) && ['add','set','delete'].includes(firstArg(step.args)[0]) && ctx.level < 3) throw new Error('Editing canned replies and aliases requires permission level 3.');
      if (step.name === 'close') {
        requireTicket(ctx.ticket);
        const [delay] = firstArg(step.args);
        if (delay && delay !== 'now') parseDuration(delay);
      }
    }
    for (const [index, step] of steps.entries()) {
      const message = index ? { id: `${ctx.message.id}:${index}`, channelId: ctx.message.channelId, author: ctx.message.author, member: ctx.message.member, attachments: new Map(), createdTimestamp: ctx.message.createdTimestamp } : ctx.message;
      const stepCtx = { ...ctx, message, commandSourceId: ctx.message.id };
      await this.execute(stepCtx,step.name,step.args);
    }
  }
  async sendReply(ctx, ticket, text, options) {
    return this.inbox.reply(ticket,ctx.message,text,false,{...options,removeSource:true,commandSourceId:ctx.commandSourceId || ctx.message.id});
  }
  async execute(ctx,name,args='') {
    authorize(name,ctx.level,this.config,this.plugins);
    const {message,ticket,respond}=ctx, actor=message.author.id;
    const [first,rest]=firstArg(args);
    if(replyCommands.has(name)) {
      requireTicket(ticket);
      const options={...replyOptions(name,this.config),sourceCommand:name};
      const text=options.formatted?formatVariables(args,{ticket,user:await this.transport.user(ticket.user_id),moderator:options.anonymous?{displayName:'Moderation team'}:ctx.member,guild:await this.transport.guild()}):args;
      await this.sendReply(ctx,ticket,text,options);return;
    }
    switch(name) {
      case 'help':return this.help(ctx,args);
      case 'about':return respond('Aaron’s Support 2.0 · Self-hosted private moderator inbox. Discord.js + SQLite, Components V2, private archives, and trusted local plugins.');
      case 'changelog':return respond('2.0: Components V2 and mention redaction; permission levels; named/anonymous/formatted/plain replies; participants; snoozing; subscriptions; durable delivery tracking; plugins; OAuth log viewer; GitHub Pages docs.\n1.0: private inbox, relays, archives, history, safety gates, and scheduled closure.');
      case 'sponsors':return respond('No sponsors are currently configured for this project. Repository: https://github.com/Dev-Aaron27/AaronsSupport');
      case 'selfcontact': {const created=await this.inbox.contact(message.author,actor,true);return respond(ctx.level>=2?`Conversation #${created.id} is ready.`:'Your conversation is ready. Check your DMs.');}
      case 'contact': {
        const userId=idFrom(first);if(!userId)throw new Error('Provide a member ID or mention.');
        const user=await this.transport.user(userId);if(user.bot)throw new Error('Cannot contact a bot.');
        const created=await this.inbox.contact(user,actor);
        if(rest)await this.sendReply(ctx,created,rest,{anonymous:this.config.alwaysAnonymous,plain:false});
        return respond(`Conversation #${created.id}: https://discord.com/channels/${this.config.guildId}/${created.channel_id}`);
      }
      case 'note':requireTicket(ticket);return this.inbox.reply(ticket,message,args,true,{anonymous:false,plain:false});
      case 'edit':requireTicket(ticket);if(!rest)throw new Error('Provide a message ID and new text.');await this.inbox.commandEdit(ticket,first,rest,actor);return respond('Updated the delivered copies and audit log.');
      case 'delete':requireTicket(ticket);await this.inbox.commandDelete(ticket,first,actor);return respond('Deleted the delivered copies. Content remains in the private audit log.');
      case 'retry':requireTicket(ticket);await this.inbox.retry(ticket,first);return respond('Synchronization completed.');
      case 'close': {
        requireTicket(ticket);
        if(!first || first==='now'){await respond('Archiving conversation…');return this.inbox.close(ticket,rest || 'Closed by staff',actor);}
        const updated=await this.inbox.schedule(ticket,parseDuration(first),rest || 'Scheduled closure',actor);
        return respond(`Scheduled to close <t:${Math.floor(updated.close_at/1000)}:F>. Replies do not cancel the timer. Use ${this.config.prefix}cancelclose.`);
      }
      case 'cancelclose':requireTicket(ticket);await this.inbox.cancel(ticket);return respond('Scheduled closure canceled.');
      case 'adduser':case 'anonadduser':case 'removeuser':case 'anonremoveuser': {
        requireTicket(ticket);const id=idFrom(first);if(!id)throw new Error('Provide a member ID or mention.');const user=await this.transport.user(id);if(user.bot)throw new Error('Bots cannot participate.');
        await this.inbox.participants(ticket,user,{id:actor,name:ctx.member.displayName || message.author.username},name.includes('remove'),name.startsWith('anon') || this.config.alwaysAnonymous);return;
      }
      case 'logs':case 'history': {
        const userId=idFrom(first) || (!first?ticket?.user_id:null);if(!userId)throw new Error('Provide a user ID or mention.');
        const [p,query]=firstArg(rest),page=pageNumber(p);const rows=this.store.history(userId,page-1,query);
        return respond(rows.map(t=>`#${t.id} · ${t.status}${t.snoozed_at?' (snoozed)':''} · <t:${Math.floor(t.created_at/1000)}:d> · ${t.log_url?`[Log](${t.log_url})`:t.channel_id?`[Channel](https://discord.com/channels/${this.config.guildId}/${t.channel_id})`:'opening'}`).join('\n') || 'No conversations found.',{title:`History for ${userId} · page ${page}`});
      }
      case 'log': {
        const archived=this.store.ticket(Number(first));if(!archived || archived.status!=='closed' || !archived.archive_path)throw new Error('Provide a closed conversation number.');
        for await(const part of this.inbox.archives.parts(archived.archive_path))await respond(`Conversation #${archived.id}`,{files:[part]});return;
      }
      case 'loglink': {
        requireTicket(ticket);if(this.viewer?.url)return respond(`Private live log: ${this.viewer.url}/tickets/${ticket.id}`);
        const archive=await this.inbox.snapshot(ticket);const channel=await this.transport.channel(this.config.logChannelId);await this.transport.assertPrivate(channel);
        const [header]=await sendPanels(channel,`Snapshot of open conversation #${ticket.id}. Archive follows.`,{title:'Conversation snapshot'});
        for await(const part of this.inbox.archives.parts(archive))await sendPanels(channel,`Snapshot #${ticket.id}`,{files:[part]});
        return respond(`Current snapshot: ${header.url}`);
      }
      case 'msglink': {
        requireTicket(ticket);const row=this.store.findMessage(ticket.id,first);if(!row)throw new Error('No matching message in this conversation.');
        const copy=this.store.copies(row.id).find(c=>c.destination==='staff');
        const channel=copy?.channel_id || (row.direction!=='member'?row.source_channel:null),id=copy?.target_id || row.source_id;
        if(!channel)throw new Error('No staff copy exists yet.');return respond(`https://discord.com/channels/${this.config.guildId}/${channel}/${id}`);
      }
      case 'notify':case 'unnotify':case 'subscribe':case 'unsubscribe': {
        requireTicket(ticket);const target=await this.target(first,actor),recurring=name.includes('subscribe');
        if(name.startsWith('un'))this.store.unsubscribe(ticket.id,target,recurring);else this.store.subscribe(ticket.id,target,recurring);
        return respond(`${name.startsWith('un')?'Removed':'Saved'} ${recurring?'recurring':'one-time'} notification for ${target.kind} ${target.id}.`);
      }
      case 'snooze':requireTicket(ticket);await this.inbox.snooze(ticket,first?parseDuration(first):null,actor);return respond(`Conversation snoozed. Incoming messages will ${this.config.snoozeMode==='wake'?'wake it automatically':'be saved until unsnoozed'}.`);
      case 'unsnooze': {const current=this.ticketFor(ctx,first);await this.inbox.unsnooze(current);return respond(`Conversation #${current.id} resumed.`);}
      case 'snoozed': {
        const page=pageNumber(first),rows=this.store.live().filter(t=>t.snoozed_at).slice((page-1)*15,page*15);
        return respond(rows.map(t=>`#${t.id} · member ${t.user_id}${t.snooze_until?` · wakes <t:${Math.floor(t.snooze_until/1000)}:F>`:''}`).join('\n') || 'No snoozed conversations on this page.');
      }
      case 'clearsnoozed': {const rows=this.store.live().filter(t=>t.snoozed_at);if(!rows.length)return respond('No snoozed conversations.');return this.confirmation(ctx,'clearsnoozed',rows.map(t=>t.id),`Unsnooze all ${rows.length} conversations?\n${rows.map(t=>`#${t.id} (member ${t.user_id})`).join(', ')}\nConfirmation expires in 60 seconds.`);}
      case 'repair': {const current=this.ticketFor(ctx,first);const repaired=await this.inbox.repair(current);return respond(`Repaired #${current.id}: https://discord.com/channels/${this.config.guildId}/${repaired.channel_id}`);}
      case 'title':requireTicket(ticket);await this.transport.setTitle(ticket,stripPings(args));this.store.updateTicket(ticket.id,{title:stripPings(args)});return respond('Title updated.');
      case 'nsfw':case 'sfw':requireTicket(ticket);await this.transport.setNsfw(ticket,name==='nsfw');this.store.updateTicket(ticket.id,{nsfw:Number(name==='nsfw')});return respond(`Channel marked ${name.toUpperCase()}.`);
      case 'move': {requireTicket(ticket);const id=idFrom(first);if(!id)throw new Error('Provide a category ID.');await this.transport.move(ticket,id);this.store.updateTicket(ticket.id,{category_id:id});return respond('Conversation moved with its private overwrites preserved.');}
      case 'snippet':case 'snippets':case 'alias':case 'aliases': {
        const key=name.startsWith('snippet')?'snippets':'aliases';
        if(name===key || !first || first==='list')return respond(Object.entries(this.config[key]).map(([n,v])=>`${n}: ${v}`).join('\n') || `No ${key} configured.`);
        if(first==='add' || first==='set' || first==='delete') {
          if(ctx.level<3)throw new Error('Editing canned replies and aliases requires permission level 3.');
          const [keyName,value]=firstArg(rest);if(!keyName || first!=='delete' && !value)throw new Error('Provide a name and value.');
          if(key==='aliases' && this.plugins?.command(keyName))throw new Error('Alias conflicts with a plugin command.');
          const updated={...this.config[key]};if(first==='delete')delete updated[keyName];else Object.defineProperty(updated,keyName,{value,enumerable:true,configurable:true,writable:true});
          this.set(key,updated);return respond(`${key} updated.`);
        }
        if(key==='aliases')throw new Error('Use alias add, set, delete, or list.');
        requireTicket(ticket);if(!Object.hasOwn(this.config.snippets,first))throw new Error('Unknown snippet.');return this.sendReply(ctx,ticket,this.config.snippets[first],{anonymous:true,plain:false,sourceCommand:'snippet'});
      }
      case 'block':case 'unblock': {
        const role=/^<@&(\d{17,20})>$/.exec(first),id=role?.[1] || idFrom(first);if(!id)throw new Error('Provide a user ID or role mention.');
        if(name==='block')this.store.block(id,stripPings(rest || 'Blocked by staff'),role?'role':'user');else this.store.unblock(id);return respond(`${role?'Role':'User'} ${id} ${name==='block'?'blocked':'unblocked'}.`);
      }
      case 'blocked': {const page=pageNumber(first);return respond(this.store.blocks().slice((page-1)*15,page*15).map(b=>`${b.kind} ${b.user_id}: ${b.reason}`).join('\n') || 'No blocks on this page.');}
      case 'disable':if(!['new','all'].includes(first))throw new Error('Use disable new or disable all.');this.set('dmMode',first);return respond(`DM mode: disabled ${first==='new'?'for new conversations':'for incoming and outgoing messages'}.`);
      case 'enable':this.set('dmMode','enabled');return respond('All DM functions enabled.');
      case 'isenable':return respond(`DM mode: ${this.config.dmMode}.`);
      case 'prefix':this.set('prefix',args);return respond(`Prefix is now ${this.config.prefix}`);
      case 'status':this.set('presenceStatus',first);this.transport.presence();return respond('Presence updated.');
      case 'activity': {const validated=validateConfig({...this.config,statusType:first,status:rest});this.set('statusType',validated.statusType);this.set('status',validated.status);this.transport.presence();return respond('Activity updated.');}
      case 'mention':this.set('mention',first==='off'?null:await this.target(first,actor));return respond('Opening notification updated.');
      case 'ping':return respond(`Gateway latency: ${Math.round(this.transport.client.ws.ping)} ms.`);
      case 'config': {
        const [subCommand, subArgs] = firstArg(args);
        const action = subCommand ? subCommand.toLowerCase() : 'help';
        if (action === 'help') {
          if (!subArgs) {
            return respond(`.[config|configuration]\nModify changeable configuration variables for this bot.\n\nType \`${this.config.prefix}config options\` to view a list\nof valid configuration variables.\n\nType \`${this.config.prefix}config help config-name\` for info\non a config.\n\nTo set a configuration variable:\n\`${this.config.prefix}config set config-name value here\`\n\nTo remove a configuration variable:\n\`${this.config.prefix}config remove config-name\`\nPermission Level\nADMINISTRATOR [4]\nSub Command(s)\n├─ get - Show the configuration variables that are currently set.\n├─ help - Show information on a specified configuration.\n├─ options - Return a list of valid configuration names you can change.\n├─ remove - Delete a set configuration variable.\n└─ set - Set a configuration variable and its value.`);
          }
          if (runtimeKeys.has(subArgs)) return respond(`**${subArgs}**\nThis is a valid configuration variable. Type \`${this.config.prefix}config get\` to see its current value.`);
          return respond(`Unknown configuration variable: ${subArgs}`);
        }
        if (action === 'get') {
          const current = {};
          for (const key of runtimeKeys) if (this.config[key] !== undefined) current[key] = this.config[key];
          return respond(`Currently set variables:\n\`\`\`json\n${JSON.stringify(current, null, 2)}\n\`\`\``);
        }
        if (action === 'remove') {
          if (!subArgs) throw new Error('Provide a configuration variable to remove.');
          const [key] = firstArg(subArgs);
          if (!runtimeKeys.has(key)) throw new Error('Unknown configuration variable.');
          this.set(key, null); this.transport.presence();
          return respond(`Removed configuration variable: ${key}`);
        }
        if (action === 'set') {
          const [key, val] = firstArg(subArgs);
          if (!key || !val) throw new Error('Provide a configuration variable and its JSON value.');
          if (!runtimeKeys.has(key)) throw new Error('Unknown configuration variable.');
          this.set(key, JSON.parse(val)); this.transport.presence();
          return respond(`${key} updated.`);
        }
        if (action === 'options') {
          const keys = [...runtimeKeys].sort();
          const pages = Math.max(1, Math.ceil(keys.length / 15)), page = Math.min(pageNumber(subArgs), pages);
          const controls = [];
          if(page > 1) controls.push(button('Previous', `config:${actor}:${page-1}`));
          if(page < pages) controls.push(button('Next', `config:${actor}:${page+1}`));
          return respond(`**Available configuration keys:**\n${keys.slice((page-1)*15, page*15).join('\n')}\n\nPage ${page} of ${pages}`, {controls});
        }
        throw new Error('Unknown subcommand. Use get, help, options, remove, or set.');
      }
      case 'permissions': {
        if(!first)return respond(`Your level: ${ctx.level}\nRole levels: ${JSON.stringify(this.config.permissionRoles)}\nCommand overrides: ${JSON.stringify(this.config.commandLevels)}\nLevels: 1 member, 2 staff, 3 senior staff, 4 administrator, 5 owner. Overrides can raise command requirements.`);
        if(ctx.level<5)throw new Error('Permission changes require level 5.');
        const [target,value]=firstArg(rest);
        if(first==='command'){this.set('commandLevels',{...this.config.commandLevels,[target]:Number(value)});return respond('Command requirement updated.');}
        if(first==='reset'){const updated={...this.config.commandLevels};delete updated[target];this.set('commandLevels',updated);return respond('Command requirement reset.');}
        if(first!=='role')throw new Error('Use permissions command, role, or reset.');
        const id=idFrom(target);if(!id || !(await this.transport.guild()).roles.cache.has(id))throw new Error('Provide an existing role ID.');
        const previous=this.config.permissionRoles,next={...previous};if(value==='remove')delete next[id];else next[id]=Number(value);
        const validated=validateConfig({...this.config,permissionRoles:next});this.config.permissionRoles=validated.permissionRoles;
        try {await this.reconcileAccess();this.store.setSetting('permissionRoles',validated.permissionRoles);}
        catch(error){this.config.permissionRoles=previous;await this.reconcileAccess().catch(e=>this.transport.report(e,'permission rollback'));throw error;}
        return respond('Role permissions updated for configured modmail channels.');
      }
      case 'setup':await this.transport.setup(this.store);return respond('Private category and log channel are ready. Configuration is saved in SQLite.');
      case 'autotrigger': {
        if(!first || first==='list')return respond(JSON.stringify(this.config.autotrigger,null,2));
        const [ruleName,remaining]=firstArg(rest),updated={...this.config.autotrigger};
        if(first==='delete')delete updated[ruleName];
        else if(first==='set'){const [keyword,snippet]=firstArg(remaining);Object.defineProperty(updated,ruleName,{value:{keyword,snippet},enumerable:true,configurable:true,writable:true});}
        else throw new Error('Use autotrigger list, set <name> <keyword> <snippet>, or delete <name>.');
        this.set('autotrigger',updated);return respond('Autotrigger rules updated. Only the first matching rule runs; it can send a snippet.');
      }
      case 'debug':return respond(this.store.events().map(e=>`${new Date(e.created_at).toISOString()} · ${e.actor} · ${e.action}`).join('\n') || 'No operational events yet.');
      case 'oauth': {
        if(first==='logoutall'){this.viewer?.revoke();return respond('All log-viewer sessions revoked.');}
        return respond(this.viewer?.url?`OAuth log viewer: ${this.viewer.url}/login\nAccess requires current staff membership in the configured server.`:'OAuth viewer is disabled. Configure LOG_VIEWER_URL, DISCORD_CLIENT_ID, and DISCORD_CLIENT_SECRET on the host; see the OAuth deployment docs.');
      }
      case 'plugins': {
        if(!this.plugins)throw new Error('Plugin manager is unavailable.');
        if(first==='guide')return respond(`**Plugins Guide**\nPlugins are local JavaScript modules placed in the \`plugins/\` directory.\nThey can add new commands (like \`.ticketstats\`) and listen to hooks like \`threadOpen\` or \`message\`.\n\nUse \`${this.config.prefix}plugins list\` to see available plugins, and \`${this.config.prefix}plugins load <name>\` to enable one.\nChanges to plugin entry files reload when you use \`${this.config.prefix}plugins reload <name>\`, but dependency changes require a restart.\nRead \`docs/plugins.md\` in the source repository for the full API documentation.`);
        if(!first || first==='list')return respond(`Available: ${(await this.plugins.available()).join(', ') || '(none)'}\nLoaded: ${[...this.plugins.loaded.keys()].join(', ') || '(none)'}\nPlugins are trusted local JavaScript with full process privileges. Install reviewed source on the host, then load its folder name.`);
        if(!['load','unload','reload'].includes(first))throw new Error('Use plugins list, load, unload, reload <name>, or guide.');
        try {
          if(first==='unload' || first==='reload')await this.plugins.unload(rest);
          if(first==='load' || first==='reload')await this.plugins.load(rest);
        } finally { this.set('enabledPlugins',[...this.plugins.loaded.keys()]); }
        return respond(`Plugin ${rest}: ${first} complete.`);
      }
      case 'update': {
        if(first && first!=='check')throw new Error('Use update or update check.');
        const updater=this.updater || new AppUpdater(process.cwd());
        if(first==='check') {
          const revision=await updater.latest(),current=this.updater?await updater.current():null;
          return respond(`GitHub main: ${revision.slice(0,12)}\nInstalled: ${current?.slice(0,12) || 'bundled/local source'}\n${this.updater?'Use '+this.config.prefix+'update to install, then restart from the panel.':'Update your checkout and rebuild the Docker image or restart your Node process.'}`);
        }
        if(!this.updater)throw new Error('Automatic installation is available on managed Pterodactyl servers. For Docker, update your checkout and run docker compose up -d --build.');
        await respond('Downloading and checking the update. The current bot keeps running until you restart.');
        try {
          const result=await this.updater.apply();
          return respond(result.changed?`Installed GitHub revision ${result.revision.slice(0,12)}. Restart the server from the panel to activate it. Configuration, data and plugins were preserved; the previous app is in app.previous/.`:'The latest GitHub revision is already installed.');
        } catch(error) { this.transport.report(error,'update');throw new Error(error.code?'Update failed. Check disk space and file permissions in the panel.':error.message); }
      }
      default: {
        const plugin=this.plugins?.command(name);if(!plugin)throw new Error(`Unknown command. Use ${this.config.prefix}help.`);
        return plugin.execute(Object.freeze({args,actorId:actor,level:ctx.level,ticket:ticket?structuredClone(ticket):null,respond:(text)=>respond(String(text)),reply:(text)=>{requireTicket(ticket);return this.sendReply(ctx,ticket,String(text),{anonymous:true,plain:false});}}));
      }
    }
  }
  async reconcileAccess() {const guild=await this.transport.guild();for(const id of new Set([this.config.categoryId,this.config.logChannelId,this.config.snoozedCategoryId,...this.store.live().map(t=>t.channel_id)].filter(Boolean))){const channel=await this.transport.channel(id);if(channel)await channel.permissionOverwrites.set(this.transport.overwrites(guild));}}
}
