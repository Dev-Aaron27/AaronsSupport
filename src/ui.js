import { MessageFlags } from 'discord.js';

export const noMentions = { parse: [], users: [], roles: [], repliedUser: false };
// Strip both real Discord mentions and human-written @handles, even inside markdown.
export function stripPings(text) {
  return String(text ?? '').replace(/<@(?:!|&)?\d+>/g, '[REMOVED_PING]').replace(/@(everyone|here)\b/gi, '[REMOVED_PING]').replace(/@[\p{L}\p{N}_][\p{L}\p{N}_.-]*/gu, '[REMOVED_PING]');
}
export function chunks(text, size = 3400) {
  const points = Array.from(String(text || '(attachment)'));
  const result = [];
  let chunk = '';
  for (const point of points) { if (chunk.length + point.length > size) { result.push(chunk); chunk = ''; } chunk += point; }
  if (chunk) result.push(chunk);
  return result;
}
const cleanFilename = value => stripPings(value).replace(/[^a-zA-Z0-9._-]/g, '_').slice(-110) || 'file';
export function panel(text, { title, color = '#5865F2', plain = false, files = [], controls = [], mentions } = {}) {
  const components = [];
  if (title && !plain) {
    components.push({ type: 10, content: `## ${stripPings(title).slice(0, 180)}\n***` });
  }
  const body = stripPings(text || '(attachment)');
  if (body.length > 3600) throw new Error('UI text exceeds one card; split it with chunks().');
  components.push({ type: 10, content: body });
  const attachments = files.map((f, i) => ({ ...f, name: `${i}-${cleanFilename(f.name)}` }));
  const images = attachments.filter(f => /\.(png|jpe?g|gif|webp)$/i.test(f.name));
  if (images.length) components.push({ type: 12, items: images.map(f => ({ media: { url: `attachment://${f.name}` } })) });
  for (const file of attachments.filter(f => !images.includes(f))) components.push({ type: 13, file: { url: `attachment://${file.name}` } });
  const selects = controls.filter(c => c.type === 3 || c.type === 5 || c.type === 6 || c.type === 7 || c.type === 8);
  const buttons = controls.filter(c => c.type === 2);
  for (const s of selects) components.push({ type: 1, components: [s] });
  if (buttons.length) components.push({ type: 1, components: buttons.slice(0, 5) });
  const result = { flags: MessageFlags.IsComponentsV2, components: plain ? components : [{ type: 17, accent_color: Number.parseInt(color.slice(1), 16), components }], allowedMentions: noMentions, files: attachments };
  if (mentions?.length) {
    // Only explicitly validated staff notification targets bypass redaction.
    result.components.push({ type: 10, content: mentions.map(m => m.kind === 'role' ? `<@&${m.id}>` : `<@${m.id}>`).join(' ') });
    result.allowedMentions = { parse: [], repliedUser: false, roles: mentions.filter(m => m.kind === 'role').map(m => m.id), users: mentions.filter(m => m.kind === 'user').map(m => m.id) };
  }
  return result;
}
export async function sendPanels(channel, text, options = {}) {
  const sent = [];
  const parts = chunks(stripPings(text));
  for (let i = 0; i < parts.length; i++) sent.push(await channel.send(panel(parts[i], { ...options, files: i === 0 ? options.files : [], controls: i === parts.length - 1 ? options.controls : [], mentions: i === 0 ? options.mentions : [] })));
  return sent;
}
export const button = (label, id, style = 2) => ({ type: 2, style, label, custom_id: id });
export const selectMenu = (id, options, placeholder) => ({ type: 3, custom_id: id, options: options.slice(0, 25), placeholder });
export function formatVariables(text, { ticket, user, moderator, guild }) {
  const values = { 'user.name': user?.displayName || user?.username || ticket.user_id, 'user.id': ticket.user_id, 'moderator.name': moderator?.displayName || moderator?.user?.username || 'Moderation team', 'server.name': guild?.name || 'Server', 'ticket.id': String(ticket.id) };
  return String(text).replace(/\{([a-z.]+)\}/g, (match, key) => Object.hasOwn(values, key) ? values[key] : match);
}
