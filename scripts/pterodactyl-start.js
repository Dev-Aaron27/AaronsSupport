import { fileURLToPath } from 'node:url';
import { preparePterodactyl } from '../src/hosting.js';

process.umask(0o077);
try {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Select the Node.js 24 image in the panel.');
  if (!process.env.DISCORD_TOKEN?.trim() || process.env.DISCORD_TOKEN === 'replace_with_your_bot_token') {
    throw new Error('Set Discord Bot Token in the panel Startup tab.');
  }
  await preparePterodactyl(process.cwd(), fileURLToPath(new URL('../config.example.json', import.meta.url)));
  console.info('Pterodactyl configuration ready; persistent files are in config.json, data/, and plugins/.');
  await import('../src/main.js');
} catch (error) {
  // Do not dump API request objects, environment values, or tokens into the panel console.
  console.error(`Startup failed: ${error.code ? 'Check file permissions and the selected runtime image.' : error.message}`);
  process.exitCode = 1;
}
