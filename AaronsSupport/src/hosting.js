import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { validateConfig } from './config.js';

// These values are configuration only. The Discord/OAuth secrets stay in the environment.
export function panelOverrides(env = process.env) {
  if (env.MODMAIL_HOSTING !== 'pterodactyl') return {};
  const overrides = {};
  const strings = {
    MODMAIL_GUILD_ID: 'guildId', MODMAIL_CATEGORY_ID: 'categoryId',
    MODMAIL_LOG_CHANNEL_ID: 'logChannelId', MODMAIL_PREFIX: 'prefix',
  };
  for (const [variable, key] of Object.entries(strings)) {
    if (env[variable]?.trim()) overrides[key] = env[variable].trim();
  }
  const lists = {
    MODMAIL_STAFF_ROLE_IDS: 'staffRoleIds', MODMAIL_ADMIN_ROLE_IDS: 'adminRoleIds',
    MODMAIL_OWNER_USER_IDS: 'ownerUserIds',
  };
  for (const [variable, key] of Object.entries(lists)) {
    const value = env[variable]?.trim();
    if (value) overrides[key] = value === 'none' ? [] : value.split(/[\s,]+/).filter(Boolean);
  }
  return overrides;
}

export async function preparePterodactyl(root, templatePath, env = process.env) {
  root = resolve(root);
  env.MODMAIL_HOSTING = 'pterodactyl';
  env.CONFIG_PATH = join(root, 'config.json');
  env.DATA_DIR = join(root, 'data');
  env.PLUGIN_DIR = join(root, 'plugins');
  for (const path of [env.DATA_DIR, env.PLUGIN_DIR]) await mkdir(path, { recursive: true, mode: 0o700 });

  let config;
  try { config = JSON.parse(await readFile(env.CONFIG_PATH, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw new Error('config.json is not valid JSON. Correct it in the file manager; it has not been replaced.');
    const template = JSON.parse(await readFile(templatePath, 'utf8'));
    config = validateConfig({ ...template, ...panelOverrides(env) });
    // Never replace an existing config or write tokens into a file.
    await writeFile(env.CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  }
  validateConfig({ ...config, ...panelOverrides(env) });

  if (env.LOG_VIEWER_URL?.trim()) {
    env.LOG_VIEWER_URL = env.LOG_VIEWER_URL.trim();
    if (!env.DISCORD_CLIENT_ID?.trim() || !env.DISCORD_CLIENT_SECRET?.trim()) {
      throw new Error('Set both OAuth client variables before enabling the private log viewer.');
    }
    const port = Number(env.SERVER_PORT);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('The log viewer requires a valid primary SERVER_PORT allocation.');
    env.LOG_VIEWER_HOST = '0.0.0.0';
    env.LOG_VIEWER_PORT = String(port);
  } else {
    delete env.LOG_VIEWER_URL;
  }
  return { configPath: env.CONFIG_PATH, dataDir: env.DATA_DIR, pluginDir: env.PLUGIN_DIR };
}
