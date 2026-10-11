import { PermissionFlagsBits as P } from 'discord.js';
import { commands, resolveCommandName } from './catalog.js';
export function staffRoles(config) { return [...new Set([...config.staffRoleIds, ...config.adminRoleIds, ...Object.keys(config.permissionRoles)])]; }
export function levelFor(member, config, guildOwnerId) {
  if (!member) return 0;
  const id = member.id || member.user?.id;
  if (id && (id === guildOwnerId || config.ownerUserIds.includes(id))) return 5;
  let level = 1;
  if (member.permissions?.has(P.Administrator) || config.adminRoleIds.some(r => member.roles.cache.has(r))) level = 4;
  if (config.staffRoleIds.some(r => member.roles.cache.has(r))) level = Math.max(level, 2);
  for (const [role, assigned] of Object.entries(config.permissionRoles)) if (member.roles.cache.has(role)) level = Math.max(level, assigned);
  return level;
}
export function requiredLevel(name, config, plugins) {
  const resolved = resolveCommandName(name);
  return Math.max(commands[resolved]?.level || commands[name]?.level || plugins?.command(resolved)?.level || plugins?.command(name)?.level || 5, config.commandLevels[resolved] || config.commandLevels[name] || 0);
}
export function authorize(name, level, config, plugins) { const required = requiredLevel(name,config,plugins); if (level < required) throw new Error(`This command requires permission level ${required}; yours is ${level}.`); }
