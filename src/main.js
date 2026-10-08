import { Client, GatewayIntentBits, Partials, Events, version as discordVersion } from 'discord.js';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { readConfig, validateConfig } from './config.js';
import { Store } from './store.js';
import { Archives } from './archive.js';
import { Inbox } from './inbox.js';
import { DiscordTransport, installHandlers } from './bot.js';
import { Plugins } from './plugins.js';
import { LogViewer } from './viewer.js';
import { panelOverrides } from './hosting.js';
import { log } from './logging.js';

process.umask(0o077);
let client,store,transport,inbox,plugins,viewer,handlers,timer,runningTick,readyTask;
let stopping=false;
const started=Date.now();
function tick() {
  if(runningTick || stopping)return runningTick || Promise.resolve();
  runningTick=inbox.tick().finally(()=>{runningTick=null;});
  return runningTick;
}
async function shutdown(code=0) {
  if(stopping)return;
  stopping=true;
  log.info('shutdown','Stopping intake and waiting for pending deliveries.');
  clearInterval(timer);
  try {
    await readyTask?.catch(()=>{});
    clearInterval(timer);
    await handlers?.stop();
    await runningTick;
    await inbox?.queue.drain();
    await plugins?.stop();
    await viewer?.stop();
  } catch(error) { log.error('shutdown',error);code=1; }
  await client?.destroy();
  store?.close();
  log.info('shutdown',`Stopped with exit code ${code}.`);
  process.exitCode=code;
}
async function boot() {
  const dir=resolve(process.env.DATA_DIR || './data');
  log.setDirectory(dir);
  const version=JSON.parse(readFileSync(new URL('../package.json',import.meta.url))).version;
  log.banner(version);
  log.info('startup',`Node.js ${process.version}; discord.js ${discordVersion}.`);
  log.info('startup','Logging level: INFO. Timestamps use UTC.');
  log.info('startup',`Log file: ${log.file}`);
  log.info('startup',`Hosting: ${process.env.MODMAIL_HOSTING==='pterodactyl'?'Pterodactyl':'Node / Docker'}.`);
  const token=process.env.DISCORD_TOKEN;
  if(!token || token==='replace_with_your_bot_token')throw new Error('Set DISCORD_TOKEN in the environment or .env.');
  store=new Store(dir);
  log.info('startup','SQLite opened. Loading configuration and saved settings.');
  const hostingOverrides=panelOverrides();
  const config=validateConfig({...readConfig(process.env.CONFIG_PATH || './config.json',hostingOverrides),...store.settings(),...hostingOverrides});
  log.info('startup',`Configured server ID: ${config.guildId}; prefix: ${config.prefix}`);
  client=new Client({
    intents:[GatewayIntentBits.Guilds,GatewayIntentBits.GuildMessages,GatewayIntentBits.DirectMessages,GatewayIntentBits.MessageContent],
    partials:[Partials.Channel,Partials.Message],allowedMentions:{parse:[],repliedUser:false},
  });
  transport=new DiscordTransport(client,config,store);
  inbox=new Inbox(store,new Archives(dir),transport,config);
  plugins=new Plugins(process.env.PLUGIN_DIR || './plugins',store,transport);
  inbox.plugins=plugins;
  viewer=process.env.LOG_VIEWER_URL?new LogViewer({url:process.env.LOG_VIEWER_URL,clientId:process.env.DISCORD_CLIENT_ID,clientSecret:process.env.DISCORD_CLIENT_SECRET,port:Number(process.env.LOG_VIEWER_PORT || 8787),host:process.env.LOG_VIEWER_HOST || '127.0.0.1'},store,inbox.archives,transport):null;
  handlers=installHandlers(client,inbox,transport,store,plugins,viewer);
  client.once(Events.ClientReady,()=>{
    if(stopping)return;
    readyTask=(async()=>{
      log.info('gateway',`Logged in as ${client.user.tag || client.user.username}; bot ID: ${client.user.id}.`);
      log.info('startup','Checking server membership, roles and private channel permissions.');
      await transport.verify(store);
      const guild=await transport.guild();
      log.info('startup',`Server: ${guild.name}; ID: ${guild.id}.`);
      log.info('startup',`Owner IDs: ${[...new Set([guild.ownerId,...config.ownerUserIds].filter(Boolean))].join(', ')}.`);
      log.info('startup',`Staff role IDs: ${config.staffRoleIds.join(', ')}. Admin role IDs: ${config.adminRoleIds.join(', ') || 'none'}.`);
      log.info('startup',`Extra role levels: ${Object.entries(config.permissionRoles).map(([id,level])=>`${id}=${level}`).join(', ') || 'none'}.`);
      log.info('startup',`Category: ${config.categoryId || 'not configured'}; log channel: ${config.logChannelId || 'not configured'}.`);
      if(!config.categoryId || !config.logChannelId)log.warn('startup',`Inbox setup is incomplete. Run ${config.prefix}setup in the configured server as its owner.`);
      log.info('startup',`Prefix: ${config.prefix}; presence: ${config.presenceStatus}; activity: ${config.statusType} ${config.status || '(none)'}.`);
      log.info('startup','Management commands work in private staff channels. Reply commands require an active ticket.');
      for(const ticket of store.live())for(const row of store.messages(ticket.id)) {
        if(row.delivery==='pending') {
          store.updateMessage(row.id,{delivery:'failed'});
          await transport.alert(ticket,`Delivery of ${row.source_id} was interrupted. Check the recipient before using ${config.prefix}retry ${row.source_id}; delivery may already have occurred.`).catch(error=>transport.report(error,'startup delivery notice'));
        }
      }
      log.info('plugins',`Loading ${config.enabledPlugins.length} configured plugin(s).`);
      await plugins.start(config.enabledPlugins);
      log.info('plugins',`Loaded ${plugins.loaded.size} plugin(s).`);
      if(viewer) { await viewer.start();log.info('logviewer','Private OAuth log viewer started.'); }
      else log.info('logviewer','Private OAuth log viewer is disabled.');
      if(stopping)return;
      handlers.start();
      await tick();
      const live=store.live();
      log.info('startup',`Active conversations: ${live.length}; scheduled closures: ${live.filter(t=>t.close_at).length}; snoozed: ${live.filter(t=>t.snoozed_at).length}.`);
      log.info('startup',`Updates are manual. Use ${config.prefix}update check to check GitHub.`);
      timer=setInterval(()=>tick().catch(error=>transport.report(error,'scheduler')),10000);
      log.info('startup',`Startup completed in ${((Date.now()-started)/1000).toFixed(1)} seconds.`);
      log.info('startup',`Ready: moderator inbox for server ${config.guildId}`);
    })();
    readyTask.catch(error=>{transport.report(error,'startup');void shutdown(1);});
  });
  client.on(Events.Error,error=>transport.report(error,'gateway'));
  client.on(Events.ShardReady,id=>log.info('gateway',`Shard ${id} connected.`));
  client.on(Events.ShardReconnecting,id=>log.warn('gateway',`Shard ${id} is reconnecting.`));
  client.on(Events.ShardResume,id=>log.info('gateway',`Shard ${id} resumed.`));
  client.on(Events.ShardDisconnect,(event,id)=>{log.warn('gateway',`Shard ${id} disconnected (code ${event.code}).`);if(event.code===4014)log.error('gateway',{code:4014});});
  log.info('gateway','Logging in to Discord. Message Content Intent is requested; enable it in the Developer Portal.');
  await client.login(token);
}
process.once('SIGTERM',()=>shutdown());
process.once('SIGINT',()=>shutdown());
try { await boot(); }
catch(error) { log.error('startup',error);await shutdown(1); }
