import { Client, GatewayIntentBits, Partials, Events } from 'discord.js';
import { resolve } from 'node:path';
import { readConfig, validateConfig } from './config.js';
import { Store } from './store.js';
import { Archives } from './archive.js';
import { Inbox } from './inbox.js';
import { DiscordTransport, installHandlers } from './bot.js';
import { Plugins } from './plugins.js';
import { LogViewer } from './viewer.js';
import { panelOverrides } from './hosting.js';

process.umask(0o077);
const token = process.env.DISCORD_TOKEN;
if (!token || token === 'replace_with_your_bot_token') throw new Error('Set DISCORD_TOKEN in the environment or .env. See README.md for setup.');
const dir = resolve(process.env.DATA_DIR || './data');
const store = new Store(dir);
const hostingOverrides = panelOverrides();
const config = validateConfig({ ...readConfig(process.env.CONFIG_PATH || './config.json', hostingOverrides), ...store.settings(), ...hostingOverrides });
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.DirectMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel, Partials.Message],
  allowedMentions: { parse: [], repliedUser: false },
});
const transport = new DiscordTransport(client, config, store);
const inbox = new Inbox(store, new Archives(dir), transport, config);
const plugins = new Plugins(process.env.PLUGIN_DIR || './plugins', store, transport);
inbox.plugins = plugins;
const viewer = process.env.LOG_VIEWER_URL ? new LogViewer({ url: process.env.LOG_VIEWER_URL, clientId: process.env.DISCORD_CLIENT_ID, clientSecret: process.env.DISCORD_CLIENT_SECRET, port: Number(process.env.LOG_VIEWER_PORT || 8787), host: process.env.LOG_VIEWER_HOST || '127.0.0.1' }, store, inbox.archives, transport) : null;
const handlers = installHandlers(client, inbox, transport, store, plugins, viewer);
let timer;
let runningTick;
let stopping = false;
function tick() {
  if (runningTick || stopping) return runningTick || Promise.resolve();
  runningTick = inbox.tick().finally(() => { runningTick = null; });
  return runningTick;
}
client.once(Events.ClientReady, async () => {
  try {
    await transport.verify(store);
    // A send may have reached Discord just before a restart; staff must inspect before retrying.
    for (const ticket of store.live()) for (const row of store.messages(ticket.id)) {
      if (row.delivery === 'pending') {
        store.updateMessage(row.id, { delivery: 'failed' });
        await transport.alert(ticket, `Delivery of ${row.source_id} was interrupted. Check the recipient before using ${config.prefix}retry ${row.source_id}; delivery may already have occurred.`).catch(() => {});
      }
    }
    await plugins.start(config.enabledPlugins);
    if (viewer) { await viewer.start(); console.info('Private OAuth log viewer ready.'); }
    handlers.start();
    await tick();
    timer = setInterval(() => tick().catch(e => transport.report(e, 'scheduler')), 10000);
    console.info(`Ready: moderator inbox for server ${config.guildId}`);
  } catch (error) { transport.report(error, 'startup'); await shutdown(1); }
});
client.on(Events.Error, error => transport.report(error, 'Discord client'));
async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  await handlers.stop();
  await runningTick;
  await inbox.queue.drain();
  await plugins.stop();
  await viewer?.stop();
  client.destroy();
  store.close();
  process.exitCode = code;
}
process.once('SIGTERM', () => shutdown());
process.once('SIGINT', () => shutdown());
try { await client.login(token); }
catch (error) { transport.report(error, 'login'); await shutdown(1); }
