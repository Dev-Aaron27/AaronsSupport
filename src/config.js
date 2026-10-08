import { readFileSync } from 'node:fs';

const snowflake = /^\d{17,20}$/;
import { commands } from './catalog.js';
export const defaults = {
  adminRoleIds: [], ownerUserIds: [], permissionRoles: {}, commandLevels: {}, prefix: '.', status: 'DM me to contact the moderators', statusType: 'Watching',
  colors: { member: '#5865F2', staff: '#57F287', system: '#FEE75C' },
  minAccountAgeHours: 168, minMemberAgeHours: 24, messageCooldownSeconds: 2,
  maxAttachmentBytes: 8 * 1024 * 1024, maxOpenTickets: 100,
  snippets: {}, aliases: {}, autotrigger: {}, enabledPlugins: [], dmMode: 'enabled', snoozeMode: 'queue', snoozedCategoryId: null, presenceStatus: 'online', mention: null, alwaysAnonymous: false,
  welcomeMessage: 'Your message has reached the moderation team. Replies will arrive here.',
  closeMessage: 'This conversation has been closed. Send another message if you need more help.',
};

export function validateConfig(input) {
  const c = { ...defaults, ...input, colors: { ...defaults.colors, ...input.colors } };
  for (const key of ['guildId', 'categoryId', 'logChannelId']) {
    if (key !== 'guildId' && c[key] === null) continue;
    if (typeof c[key] !== 'string' || !snowflake.test(c[key])) throw new Error(`${key} must be a Discord ID (enable Developer Mode to copy it).`);
  }
  for (const key of ['staffRoleIds', 'adminRoleIds']) {
    if (!Array.isArray(c[key]) || c[key].some(id => typeof id !== 'string' || !snowflake.test(id) || id === c.guildId)) throw new Error(`${key} must contain role IDs, excluding @everyone.`);
  }
  if (!c.staffRoleIds.length) throw new Error('At least one staff role is required.');
  if (typeof c.prefix !== 'string' || !/^\S{1,10}$/.test(c.prefix)) throw new Error('prefix must be 1–10 non-space characters.');
  if (typeof c.status !== 'string' || c.status.length > 128) throw new Error('status must be at most 128 characters.');
  if (!['Playing', 'Listening', 'Watching', 'Competing'].includes(c.statusType)) throw new Error('Unsupported statusType.');
  for (const color of Object.values(c.colors)) if (typeof color !== 'string' || !/^#[\da-f]{6}$/i.test(color)) throw new Error('Colors must be #RRGGBB.');
  for (const key of ['minAccountAgeHours', 'minMemberAgeHours', 'messageCooldownSeconds', 'maxAttachmentBytes', 'maxOpenTickets']) {
    if (!Number.isFinite(c[key]) || c[key] < 0) throw new Error(`${key} must be a nonnegative number.`);
  }
  if (!Number.isInteger(c.maxOpenTickets) || c.maxOpenTickets < 1 || c.maxOpenTickets > 400) throw new Error('maxOpenTickets must be an integer from 1 to 400.');
  if (!Number.isInteger(c.maxAttachmentBytes) || c.maxAttachmentBytes < 1 || c.maxAttachmentBytes > 8 * 1024 * 1024) throw new Error('maxAttachmentBytes must be 1–8388608 (total per message).');
  for (const key of ['welcomeMessage', 'closeMessage']) if (typeof c[key] !== 'string' || !c[key].length || c[key].length > 2000) throw new Error(`${key} must contain 1–2000 characters.`);
  for (const key of ['snippets', 'aliases']) {
    if (!c[key] || typeof c[key] !== 'object' || Array.isArray(c[key]) || Object.entries(c[key]).some(([k, v]) => !/^[a-z][a-z0-9_-]{0,31}$/.test(k) || typeof v !== 'string' || !v || v.length > 4000)) throw new Error(`${key} must map short lowercase names to nonempty text (max 4000).`);
  }
  for (const [alias, target] of Object.entries(c.aliases)) if (Object.hasOwn(commands, alias) || !Object.hasOwn(commands, target.split(/\s+/)[0])) throw new Error('Aliases must use a new name and target a built-in command (with optional preset arguments).');
  if (!Array.isArray(c.ownerUserIds) || c.ownerUserIds.some(id => typeof id !== 'string' || !snowflake.test(id))) throw new Error('ownerUserIds must contain user IDs.');
  for (const key of ['permissionRoles', 'commandLevels']) {
    if (!c[key] || typeof c[key] !== 'object' || Array.isArray(c[key])) throw new Error(`${key} must be an object.`);
    for (const [id, level] of Object.entries(c[key])) {
      if (!Number.isInteger(level) || level < 2 || level > 5) throw new Error('Permission levels must be 2–5.');
      if (key === 'permissionRoles' && (!snowflake.test(id) || id === c.guildId)) throw new Error('Permission role must be a role ID, excluding everyone.');
      if (key === 'commandLevels' && (!Object.hasOwn(commands, id) || level < commands[id].level)) throw new Error('Command overrides may only raise the default permission level.');
    }
  }
  if (!['enabled', 'new', 'all'].includes(c.dmMode) || !['queue', 'wake'].includes(c.snoozeMode)) throw new Error('Invalid DM or snooze mode.');
  if (!['online','idle','dnd','invisible'].includes(c.presenceStatus)) throw new Error('Invalid presenceStatus.');
  if (typeof c.alwaysAnonymous !== 'boolean') throw new Error('alwaysAnonymous must be true or false.');
  if (c.snoozedCategoryId !== null && !snowflake.test(c.snoozedCategoryId)) throw new Error('Invalid snoozedCategoryId.');
  if (c.mention !== null && (!['role','user'].includes(c.mention.kind) || !snowflake.test(c.mention.id))) throw new Error('mention must be null or {kind: user/role, id}.');
  if (!Array.isArray(c.enabledPlugins) || c.enabledPlugins.some(n => !/^[a-z][a-z0-9_-]{0,40}$/.test(n))) throw new Error('Invalid enabledPlugins.');
  if (!c.autotrigger || typeof c.autotrigger !== 'object' || Array.isArray(c.autotrigger) || Object.keys(c.autotrigger).length > 50) throw new Error('autotrigger must contain at most 50 named rules.');
  for (const [name, rule] of Object.entries(c.autotrigger)) if (!/^[a-z][a-z0-9_-]{0,31}$/.test(name) || !rule || typeof rule.keyword !== 'string' || !rule.keyword.trim() || rule.keyword.length > 100 || typeof rule.snippet !== 'string' || !Object.hasOwn(c.snippets, rule.snippet)) throw new Error('Autotrigger rules need a keyword and an existing snippet.');
  return c;
}

export function readConfig(path, overrides = {}) { return validateConfig({ ...JSON.parse(readFileSync(path, 'utf8')), ...overrides }); }
export const runtimeKeys = new Set(['prefix', 'status', 'statusType', 'colors', 'minAccountAgeHours', 'minMemberAgeHours', 'messageCooldownSeconds', 'snippets', 'aliases', 'welcomeMessage', 'closeMessage', 'snoozeMode', 'presenceStatus', 'alwaysAnonymous']);

export function parseCommand(content, config) {
  if (!content.startsWith(config.prefix)) return null;
  const match = /^(\S+)(?:\s([\s\S]*))?$/.exec(content.slice(config.prefix.length).trim());
  const name = (match?.[1] || '').toLowerCase();
  const args = match?.[2] || '';
  if (Object.hasOwn(config.aliases, name)) {
    const [target, ...preset] = config.aliases[name].split(/\s+/);
    return { name: target, args: [preset.join(' '), args].filter(Boolean).join(' ') };
  }
  return { name, args };
}

export function parseDuration(value) {
  const match = /^(\d+)(s|m|h|d)$/.exec(value);
  if (!match) throw new Error('Use a duration such as 30m, 2h, or 7d.');
  const ms = Number(match[1]) * { s: 1000, m: 60000, h: 3600000, d: 86400000 }[match[2]];
  if (ms < 1000 || ms > 30 * 86400000) throw new Error('Delay must be between 1 second and 30 days.');
  return ms;
}
