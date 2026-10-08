import { fileURLToPath } from 'node:url';
import { log } from '../src/logging.js';
import { resolve } from 'node:path';
import { preparePterodactyl } from '../src/hosting.js';

process.umask(0o077);
try {
  log.setDirectory(resolve(process.cwd(),'data'));
  log.info('hosting','Preparing Pterodactyl configuration.');
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Select the Node.js 24 image in the panel.');
  if (!process.env.DISCORD_TOKEN?.trim() || process.env.DISCORD_TOKEN === 'replace_with_your_bot_token') {
    throw new Error('Set Discord Bot Token in the panel Startup tab.');
  }
  await preparePterodactyl(process.cwd(), fileURLToPath(new URL('../config.example.json', import.meta.url)));
  log.info('hosting','Pterodactyl configuration ready; persistent files are in config.json, data/, and plugins/.');
  await import('../src/main.js');
} catch (error) {
  // Do not dump API request objects, environment values, or tokens into the panel console.
  log.error('hosting startup',error);
  process.exitCode = 1;
}
