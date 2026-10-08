import { ChannelType, Events, MessageFlags } from 'discord.js';
import { SerialQueue } from './store.js';
import { parseCommand } from './config.js';
import { commands, replyCommands } from './catalog.js';
import { CommandRouter } from './commands.js';
import { panel, chunks, sendPanels, formatVariables, stripPings } from './ui.js';
import { safeError } from './logging.js';
import { authorize } from './permissions.js';

const publicCommands=new Set(['help','about','changelog','sponsors','selfcontact']);
export function installHandlers(client,inbox,transport,store,plugins,viewer) {
  let accepting=false;
  const events=new SerialQueue(),config=inbox.config,router=new CommandRouter(inbox,transport,store,plugins,viewer);
  const on=(event,key,handler)=>client.on(event,(...args)=>{if(accepting)events.run(key(...args),()=>handler(...args)).catch(e=>transport.report(e,event));});
  async function context(message,respond) {
    const member=await transport.member(message.author.id),level=transport.level(member);
    return {message,member,level,ticket:store.byChannel(message.channelId),respond:respond || ((text,options)=>sendPanels(message.channel,text,{color:config.colors.system,...options}))};
  }
  on(Events.MessageCreate,m=>m.channelId,async message=>{
    if(message.author.bot || message.webhookId)return;
    let ctx,commandLabel='member message';
    const respond = (text) => sendPanels(message.channel,text,{color:config.colors.system});
    try {
      const cmd=parseCommand(message.content,config);
      const known = step => Object.hasOwn(commands,step.name) || plugins?.command(step.name);
      if(cmd) {
        commandLabel=(cmd.steps || [cmd]).map(step=>known(step)?step.name:'unknown').join(' + ');
        transport.info?.('commands',`Received ${commandLabel}; user ${message.author.id}; channel ${message.channelId}.`);
      }
      if(!message.guildId) {
        if(message.channel.type!==ChannelType.DM)return;
        if(cmd && publicCommands.has(cmd.name)) {
          ctx=await context(message);ctx.level=Math.min(ctx.level,1);
          await router.dispatch(ctx,cmd);
          transport.info?.('commands',`Completed ${commandLabel} in DMs.`);
        } else await inbox.receive(message);
        return;
      }
      if(!cmd)return; // Staff conversation is local; only commands can relay replies.
      if(message.guildId!==config.guildId) {
        transport.info?.('commands',`Rejected ${commandLabel}: command came from a different server.`);
        return await respond('This bot is configured for another server. Check Discord Server ID in the hosting settings.');
      }
      ctx=await context(message);
      if(!(cmd.steps || [cmd]).every(known))throw new Error(`Unknown command. Use ${config.prefix}help.`);
      for(const step of cmd.steps || [cmd])authorize(step.name,ctx.level,config,plugins);
      // Check the entire alias, so a public first step cannot bypass the channel rule.
      const needsPrivate=(cmd.steps || [cmd]).some(step=>!publicCommands.has(step.name) && step.name!=='setup');
      if(needsPrivate) {
        try { await transport.assertPrivate(message.channel); }
        catch(error) {
          transport.report(error,`commands ${commandLabel}: privacy check`);
          return await respond(`Use this command in a private staff channel, an inbox ticket, or the modmail log channel. Only configured staff may have access. Use ${config.prefix}setup first if the inbox has not been configured.`);
        }
      }
      await router.dispatch(ctx,cmd);
      transport.info?.('commands',`Completed ${commandLabel}; user ${message.author.id}; channel ${message.channelId}.`);
    } catch(error) {
      transport.report(error,`commands ${commandLabel}`);
      const text=error.code?safeError(error):error.message;
      try { await respond(text); }
      catch(replyError) { transport.report(replyError,`commands ${commandLabel}: could not send the error response`); }
    }
  });
  on(Events.MessageUpdate,(_old,m)=>m.channelId,async(_old,partial)=>{
    const row=store.message(partial.id);if(!row)return;
    const message=partial.partial?await partial.fetch():partial;
    if(message.author.bot)return;
    let content=message.content;
    if(message.guildId){
      if(message.guildId!==config.guildId)return;
      const ctx=await context(message);if(ctx.level<2)return;
      await transport.assertPrivate(message.channel);
      authorize(row.direction==='note'?'note':row.options.sourceCommand || 'areply',ctx.level,config,plugins);
      const cmd=parseCommand(content,config);
      if(cmd && (replyCommands.has(cmd.name) || cmd.name==='note'))content=cmd.args;
      else if(cmd?.name==='snippet' && Object.hasOwn(config.snippets,cmd.args))content=config.snippets[cmd.args];
      else if(cmd)return ctx.respond('This edit was not relayed. Edit the reply text or use the edit command.');
      if(row.options.formatted)content=formatVariables(content,{ticket:store.ticket(row.ticket_id),user:await transport.user(store.ticket(row.ticket_id).user_id),moderator:row.options.anonymous?{displayName:'Moderation team'}:ctx.member,guild:await transport.guild()});
    }
    await inbox.edit(message,content);
  });
  on(Events.MessageDelete,m=>m.channelId,m=>inbox.delete(m.id));
  on(Events.MessageBulkDelete,messages=>messages.first()?.channelId,async messages=>{for(const id of messages.keys())await inbox.delete(id);});
  on(Events.ChannelDelete,channel=>channel.id,async channel=>{
    const ticket=store.byChannel(channel.id);
    if(ticket?.status==='open') {
      await inbox.queue.run(ticket.user_id,()=>{if(store.ticket(ticket.id).status==='open')store.updateTicket(ticket.id,{status:'broken',last_error:'Staff channel removed; use repair'});});
      const logs=await transport.channel(config.logChannelId);
      if(logs){await transport.assertPrivate(logs);await sendPanels(logs,`Conversation #${ticket.id} lost its staff channel. Incoming DMs will be saved. Use ${config.prefix}repair ${ticket.id} to restore it.`);}
    }
  });
  on(Events.InteractionCreate,i=>i.channelId,async interaction=>{
    if(!interaction.isButton() || interaction.user.bot || interaction.guildId!==config.guildId)return;
    const recognized=/^(help:|ticket:|confirm:)/.test(interaction.customId);
    if(!recognized)return;
    await interaction.deferReply({flags:MessageFlags.Ephemeral});
    let replied=false;
    const respond=async(text,options={})=>{
      for(const [index,body] of chunks(stripPings(text)).entries()){
        const payload=panel(body,{...options,files:index===0?options.files:[],color:config.colors.system});
        if(!replied){await interaction.editReply(payload);replied=true;}else await interaction.followUp({...payload,flags:MessageFlags.IsComponentsV2|MessageFlags.Ephemeral});
      }
    };
    try {
      const message={id:interaction.id,channelId:interaction.channelId,channel:interaction.channel,guildId:interaction.guildId,author:interaction.user,attachments:new Map(),content:''};
      const ctx=await context(message,respond),[type,action,value]=interaction.customId.split(':');
      if(type==='help'){
        if(action!==interaction.user.id)throw new Error('Open your own help menu to use these buttons.');
        const privateChannel=ctx.ticket || interaction.channelId===config.logChannelId;
        if(privateChannel)await transport.assertPrivate(interaction.channel);
        return router.execute(ctx,'help',value);
      }
      if(!ctx.ticket && interaction.channelId!==config.logChannelId)throw new Error('Use controls inside a private modmail channel.');
      await transport.assertPrivate(interaction.channel);
      if(type==='confirm')return await router.confirm(ctx,action);
      if(type==='ticket'){
        const ticket=store.ticket(Number(value));
        if(!ticket || ticket.channel_id!==interaction.channelId || ticket.status!=='open')throw new Error('These controls are no longer active.');
        ctx.ticket=ticket;
        if(!['close','snooze','logs'].includes(action))throw new Error('Unknown control.');
        authorize(action,ctx.level,config,plugins);
        if(action==='close')return router.confirmation(ctx,'close',[ticket.id],`Close and archive conversation #${ticket.id}?`);
        return router.execute(ctx,action,'');
      }
    } catch(error){transport.report(error,'interaction');await respond(error.code?'Discord could not complete that action.':error.message).catch(()=>{});}
  });
  return {router,start(){accepting=true;},async stop(){accepting=false;await events.drain();}};
}
