import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

const clean = value => String(value).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 1600);
const hints = {
  50013: 'Missing Discord permissions. Check the bot role and channel overrides.',
  50001: 'Missing access to the Discord channel or server.',
  50007: 'Cannot send DMs to this member. Their DMs may be closed.',
  10003: 'Discord channel no longer exists. Check the configured IDs or use repair.',
  10004: 'Configured server is unavailable. Check the server ID and bot membership.',
  10007: 'Member is no longer in the configured server.',
  10008: 'Discord message no longer exists.',
  50035: 'Discord rejected the message payload. Check message size and component limits.',
  4014: 'Discord rejected privileged intents. Enable Message Content Intent in the Developer Portal.',
  TokenInvalid: 'Bot token is invalid. Update Discord Bot Token in the panel or DISCORD_TOKEN on the host.',
  ENOENT: 'A required file or directory is missing. Check installation and configured paths.',
  EACCES: 'File access denied. Check ownership of app/, config.json, data/ and plugins/.',
  ENOSPC: 'The server has run out of disk space.',
  ECONNRESET: 'Network connection reset. Check outbound connectivity.',
  ETIMEDOUT: 'Network request timed out. Check outbound connectivity.',
};
export function safeError(error,depth=0) {
  if(depth>3)return 'Operation failed. Check configuration and Discord permissions.';
  if (error instanceof AggregateError && error.errors.length) return safeError(error.errors[0],depth+1);
  if(error?.cause)return safeError(error.cause,depth+1);
  const code = error?.code;
  if (Object.hasOwn(hints,code)) return `${code}: ${hints[code]}`;
  const message = error?.message || '';
  if (/disallowed intents/i.test(message)) return hints[4014];
  if (/^(This command requires permission level [1-5]; yours is [0-5]\.|Run this command inside an active inbox channel\.|Configured role \d+ does not exist\.|Channel \d+ is visible to non-staff role \d+\. Restrict access first\.|Channel \d+ has a non-staff member override\.)$/.test(message)) return message;
  if (/^(guildId|categoryId|logChannelId|staffRoleIds|adminRoleIds|ownerUserIds|permissionRoles|commandLevels|prefix|status|colors|Colors|Aliases|snippets|aliases|Permission)/.test(message)) return 'Invalid configuration. Check the saved configuration, Startup variables and permission settings.';
  if (/Bot is missing required permissions/.test(message)) return 'Bot is missing required permissions. Check Manage Channels, Manage Roles, Manage Messages, Add Reactions, View Channel, Send Messages, Embed Links and Attach Files.';
  if (/Configure a category and text log channel/.test(message)) return 'Category or log channel has the wrong type. Check the configured IDs.';
  if (/Set (DISCORD_TOKEN|Discord Bot Token)/.test(message)) return 'Set Discord Bot Token in Startup, or DISCORD_TOKEN in the host environment.';
  if (/Select the Node.js 24/.test(message)) return 'Select the Node.js 24 runtime image.';
  if (/config.json is not valid JSON/.test(message) || error instanceof SyntaxError) return 'Invalid JSON or syntax. Check config.json and the command arguments.';
  if (/Use a duration|Delay must be/.test(message)) return 'Invalid duration. Use 30m, 2h or 7d, between 1 second and 30 days.';
  if (/Unknown command/.test(message)) return 'Unknown command. Use help with the active prefix.';
  if (code !== undefined && /^(\d{1,6}|[A-Z_]{2,40})$/.test(String(code))) return `Operation failed (${code}).`;
  return 'Operation failed. Check the command response, configuration and Discord permissions.';
}
export function createLogger({ color = process.env.NO_COLOR === undefined && process.env.LOG_COLOR !== 'false', write = line => console.log(line), now = () => new Date(), maxBytes = 5 * 1024 * 1024 } = {}) {
  let file = null, fileWarning = false;
  const output = (level, scope, message) => {
    const line = `${now().toISOString().slice(0,19).replace('T',' ')} UTC ${clean(scope)} - ${level}: ${clean(message)}`;
    write(color ? `\x1b[35m${line}\x1b[0m` : line);
    if (!file) return;
    try {
      let size = 0; try { size = statSync(file).size; } catch(error) { if(error.code !== 'ENOENT') throw error; }
      if (size + Buffer.byteLength(line) + 1 > maxBytes) {
        rmSync(file+'.3',{force:true});
        for (let i=2;i>=0;i--) { try { renameSync(i?file+'.'+i:file,file+'.'+(i+1)); } catch(error) { if(error.code !== 'ENOENT') throw error; } }
      }
      appendFileSync(file,line+'\n',{mode:0o600});
    } catch {
      if (!fileWarning) { fileWarning=true; const warning='Logging - WARNING: Unable to write data/logs/modmail.log. Check permissions and disk space.';write(color?`\x1b[35m${warning}\x1b[0m`:warning); }
    }
  };
  return {
    get file() { return file; },
    setDirectory(directory) { const logs=join(directory,'logs');mkdirSync(logs,{recursive:true,mode:0o700});file=join(logs,'modmail.log'); },
    info: (scope,message) => output('INFO',scope,message),
    warn: (scope,message) => output('WARNING',scope,message),
    error: (scope,error) => output('ERROR',scope,safeError(error)),
    banner(version) { for(const line of ['========================================',"        AARON'S SUPPORT",`        Discord Modmail v${version}`,'========================================']) output('INFO','startup',line); },
  };
}
export const log = createLogger();
