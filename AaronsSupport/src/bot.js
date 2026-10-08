import { ActivityType, ChannelType, PermissionFlagsBits as P } from 'discord.js';
import { panel, sendPanels, button, stripPings } from './ui.js';
import { levelFor, staffRoles } from './permissions.js';
export { installHandlers } from './handlers.js';

export class DiscordTransport {
  constructor(client, config, store) { Object.assign(this,{client,config,store}); }
  async guild() { return this.client.guilds.fetch(this.config.guildId); }
  user(id) { return this.client.users.fetch(id); }
  async member(id) {
    try { return await (await this.guild()).members.fetch({user:id,force:true}); }
    catch(error) { if(error.code===10007) return null; throw error; }
  }
  level(member) { return levelFor(member,this.config,this.client.guilds?.cache.get(this.config.guildId)?.ownerId); }
  isStaff(member) { return this.level(member)>=2; }
  isAdmin(member) { return this.level(member)>=4; }
  overwrites(guild) {
    return [{id:guild.id,deny:[P.ViewChannel]},
      {id:this.client.user.id,allow:[P.ViewChannel,P.SendMessages,P.ReadMessageHistory,P.AttachFiles,P.EmbedLinks,P.ManageChannels,P.ManageRoles,P.ManageMessages,P.AddReactions]},
      ...staffRoles(this.config).map(id=>({id,allow:[P.ViewChannel,P.SendMessages,P.ReadMessageHistory,P.AttachFiles,P.EmbedLinks]})),
      ...this.config.ownerUserIds.map(id=>({id,type:1,allow:[P.ViewChannel,P.SendMessages,P.ReadMessageHistory,P.AttachFiles,P.EmbedLinks]}))];
  }
  async assertPrivate(channel) {
    const guild=await this.guild();
    if(!channel || channel.guildId!==guild.id) throw new Error('Configured channel must belong to the configured server.');
    const allowed=new Set(staffRoles(this.config));
    await guild.roles.fetch();
    for(const role of guild.roles.cache.values()) {
      if(role.id===guild.members.me?.roles.botRole?.id || allowed.has(role.id) || role.permissions.has(P.Administrator)) continue;
      if(channel.permissionsFor(role)?.has(P.ViewChannel)) throw new Error(`Channel ${channel.id} is visible to non-staff role ${role.id}. Restrict access first.`);
    }
    for(const overwrite of channel.permissionOverwrites.cache.values()) {
      if(overwrite.type!==1 || !overwrite.allow.has(P.ViewChannel) || overwrite.id===this.client.user.id) continue;
      if(!this.isStaff(await this.member(overwrite.id))) throw new Error(`Channel ${channel.id} has a non-staff member override.`);
    }
  }
  async verify(store) {
    const guild=await this.guild(); await guild.members.fetchMe(); await guild.roles.fetch();
    for(const id of staffRoles(this.config)) if(!guild.roles.cache.has(id)) throw new Error(`Configured role ${id} does not exist.`);
    if(!this.config.categoryId || !this.config.logChannelId) { this.presence(); return; }
    const category=await guild.channels.fetch(this.config.categoryId), log=await guild.channels.fetch(this.config.logChannelId);
    if(category?.type!==ChannelType.GuildCategory || log?.type!==ChannelType.GuildText) throw new Error('Configure a category and text log channel.');
    await this.assertPrivate(category); await this.assertPrivate(log);
    const required=[P.ViewChannel,P.SendMessages,P.ReadMessageHistory,P.AttachFiles,P.EmbedLinks,P.ManageChannels,P.ManageRoles,P.ManageMessages,P.AddReactions];
    if(!guild.members.me.permissions.has(P.ManageChannels) || !category.permissionsFor(guild.members.me).has(required) || !log.permissionsFor(guild.members.me).has(required.slice(0,5))) throw new Error('Bot is missing required permissions. See the setup guide.');
    for(const ticket of store.live()) {
      if(!ticket.channel_id) continue;
      const channel=await this.channel(ticket.channel_id);
      if(channel) await channel.permissionOverwrites.set(this.overwrites(guild),'Apply modmail staff permissions');
      else if(ticket.status==='open') store.updateTicket(ticket.id,{status:'broken',last_error:'Staff channel missing; use repair'});
    }
    this.presence();
  }
  async setup(store) {
    const guild=await this.guild();
    if(!this.config.categoryId) {
      const category=await guild.channels.create({name:'Modmail',type:ChannelType.GuildCategory,permissionOverwrites:this.overwrites(guild)});
      this.config.categoryId=category.id; store.setSetting('categoryId',category.id);
    }
    const category=await guild.channels.fetch(this.config.categoryId);
    if(category?.type!==ChannelType.GuildCategory) throw new Error('categoryId does not point to a category.');
    await this.assertPrivate(category);
    if(!this.config.logChannelId) {
      const channel=await guild.channels.create({name:'modmail-logs',type:ChannelType.GuildText,parent:category.id,permissionOverwrites:this.overwrites(guild)});
      this.config.logChannelId=channel.id; store.setSetting('logChannelId',channel.id);
    }
    await this.verify(store);
  }
  presence() { this.client.user.setPresence({status:this.config.presenceStatus,activities:this.config.status?[{name:this.config.status,type:ActivityType[this.config.statusType]}]:[]}); }
  async channel(id) { if(!id) return null; try { return await this.client.channels.fetch(id); } catch(e) { if(e.code===10003) return null; throw e; } }
  async open(ticket,user) {
    const guild=await this.guild(), channels=await guild.channels.fetch();
    let channel=channels.get(ticket.channel_id) || channels.find(c=>c?.type===ChannelType.GuildText && c.topic===`modmail:${ticket.id}:${ticket.user_id}`);
    if(channel) { await channel.permissionOverwrites.set(this.overwrites(guild)); return channel; }
    const category=await guild.channels.fetch(ticket.category_id || this.config.categoryId); await this.assertPrivate(category);
    channel=await guild.channels.create({name:ticket.title || `inbox-${ticket.id}`,type:ChannelType.GuildText,parent:category.id,nsfw:Boolean(ticket.nsfw),topic:`modmail:${ticket.id}:${ticket.user_id}`,permissionOverwrites:this.overwrites(guild),reason:`Modmail #${ticket.id}`});
    const member = await this.member(user.id);
    const date = timestamp => Number.isFinite(timestamp) ? `<t:${Math.floor(timestamp / 1000)}:F>` : 'Unavailable';
    await sendPanels(channel,`**Member:** ${user.tag || user.username}\n**User ID:** ${user.id}\n**Account created:** ${date(user.createdTimestamp)}\n**Joined server:** ${date(member?.joinedTimestamp)}\n\nUse ${this.config.prefix}reply (${this.config.prefix}r) for a named reply or ${this.config.prefix}areply (${this.config.prefix}ar) for an anonymous reply. Only reply commands and snippets send messages to the member. Normal messages stay in this channel; ${this.config.prefix}note saves an internal note in the log.\n\nReplies are copied here and to the member’s DMs. Edits and deletions are retained in the private audit log.`,{title:`Conversation #${ticket.id}`,color:this.config.colors.system,controls:[button('Close',`ticket:close:${ticket.id}`),button('Snooze',`ticket:snooze:${ticket.id}`),button('History',`ticket:logs:${ticket.id}`)]});
    return channel;
  }
  async notifyOpening(ticket) {
    if(this.config.mention && await this.validNotification(this.config.mention)) await this.alert(ticket,'New conversation opened.',[this.config.mention]);
  }
  async validNotification(target) {
    if(target.kind==='user') return this.isStaff(await this.member(target.id));
    const role=await (await this.guild()).roles.fetch(target.id);
    return Boolean(role && target.id!==this.config.guildId && (staffRoles(this.config).includes(target.id) || role.permissions.has(P.Administrator)));
  }
  title(row) { return row.direction==='member'?`Member · ${row.author_name}`:row.direction==='note'?`Staff note · ${row.author_name}`:row.options.anonymous?'Moderation team':`Moderator · ${row.author_name}`; }
  payload(row,body,files) {
    const name=this.title(row);
    return panel(row.options.plain ? `${name}\n${body}` : body,{title:name,plain:Boolean(row.options.plain),color:row.direction==='member'?this.config.colors.member:row.direction==='note'?this.config.colors.system:this.config.colors.staff,files});
  }
  async send(ticket,row,files,destination=row.direction==='member'?'staff':ticket.user_id,body=row.content) {
    let channel;
    if(destination==='staff') {channel=await this.channel(ticket.channel_id);await this.assertPrivate(channel);}
    else channel=await (await this.user(destination)).createDM();
    return channel.send(this.payload(row,body,files));
  }
  async edit(row,content,files) {
    const channel=await this.channel(row.target_channel);
    if(row.destination==='staff' || row.direction==='member' && channel?.guildId) await this.assertPrivate(channel);
    const payload=this.payload(row,content,files);
    // Clears old legacy embeds when editing a message originally sent by version 1.
    await channel.messages.edit(row.target_id,{...payload,content:null,embeds:[],attachments:[]});
  }
  async delete(row) { try { await (await this.channel(row.target_channel))?.messages.delete(row.target_id); } catch(error) { if(error.code!==10008) throw error; } }
  async deleteSource(row) { const id = row.options.commandSourceId || row.source_id; if(!/^\d+$/.test(id)) return; try { await (await this.channel(row.source_channel))?.messages.delete(id); } catch(error) { if(error.code!==10008) throw error; } }
  async acknowledge(row) { const channel = await this.channel(row.source_channel); const message = await channel.messages.fetch(row.source_id); await message.react('✅'); }
  async notifyUser(id,content) {return sendPanels(await (await this.user(id)).createDM(),content,{color:this.config.colors.system});}
  async alert(ticket,content,mentions=[]) {const channel=await this.channel(ticket.channel_id);await this.assertPrivate(channel);return sendPanels(channel,content,{color:this.config.colors.system,mentions});}
  async publishArchive(ticket,path,archives) {
    const channel=await this.channel(this.config.logChannelId); await this.assertPrivate(channel);
    const text=`Member ID: ${ticket.user_id}\nClosed by: ${ticket.closed_by}\nReason: ${stripPings(ticket.close_reason || 'No reason provided').slice(0,1800)}\nArchive follows. Extract the ZIP and open transcript.html. Join numbered parts first (see documentation).`;
    const [header]=await sendPanels(channel,text,{title:`Conversation #${ticket.id} closed`});
    for await(const part of archives.parts(path)) await channel.send(panel(`Archive for conversation #${ticket.id}`,{files:[part]}));
    await header.edit(panel(`${text}\n**Archive upload complete.**`,{title:`Conversation #${ticket.id} closed`}));
    return header.url;
  }
  async removeChannel(ticket) {await (await this.channel(ticket.channel_id))?.delete('Modmail archived');}
  async setSnoozed(ticket,snoozed) {
    const channel=await this.channel(ticket.channel_id); if(!channel) throw new Error('Channel missing. Use repair first.');
    const categoryId=snoozed?this.config.snoozedCategoryId:ticket.category_id;
    if(categoryId) {const category=await this.channel(categoryId);await this.assertPrivate(category);await channel.setParent(categoryId,{lockPermissions:false});}
    await channel.setName(`${snoozed?'snoozed-':''}${ticket.title || `inbox-${ticket.id}`}`.slice(0,100));
  }
  async move(ticket,categoryId) {const category=await this.channel(categoryId);if(category?.type!==ChannelType.GuildCategory) throw new Error('Provide a category ID.');await this.assertPrivate(category);await (await this.channel(ticket.channel_id)).setParent(categoryId,{lockPermissions:false});}
  async setTitle(ticket,title) {if(!title || title.length>90) throw new Error('Title must have 1–90 characters.');return (await this.channel(ticket.channel_id)).setName(title);}
  async setNsfw(ticket,value) {return (await this.channel(ticket.channel_id)).setNSFW(value);}
  report(error,context) {
    // Diagnostic command reads only these sanitized categories/codes, never exception bodies.
    const summary=`${context}: ${error.name || 'Error'}${error.code ? ` (${error.code})` : ''}`;
    console.error(summary);
    this.store?.event(null,'system',summary.slice(0,300));
  }
}
