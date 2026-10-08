import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile, rename, stat } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { once } from 'node:events';
import { finished } from 'node:stream/promises';
import { Zip, ZipPassThrough } from 'fflate';
import { stripPings } from './ui.js';

export const escapeHtml = value => String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const safeName = name => basename(name).replace(/[^a-zA-Z0-9._-]/g, '_').slice(-120) || 'attachment';

export class Archives {
  constructor(dir, fetcher = fetch) { this.dir = dir; this.fetcher = fetcher; }
  async saveAttachments(ticketId, attachments, maxBytes, previous = []) {
    const list = [...attachments.values()];
    if (list.length > 10 || list.reduce((n, a) => n + a.size, 0) > maxBytes) throw new Error(`Attachments must total at most ${Math.floor(maxBytes / 1024 / 1024)} MiB per message (10 files maximum).`);
    const dir = join(this.dir, 'attachments', String(ticketId));
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const saved = [];
    let total = 0;
    for (const a of list) {
      const cached = previous.find(p => p.id === a.id);
      if (cached) { total += cached.size; if (total > maxBytes) throw new Error('Attachment limit exceeded.'); saved.push(cached); continue; }
      const url = new URL(a.url);
      if (url.protocol !== 'https:' || !['cdn.discordapp.com', 'media.discordapp.net'].includes(url.hostname)) throw new Error('Only Discord-hosted attachments are supported.');
      const response = await this.fetcher(url, { signal: AbortSignal.timeout(30000), redirect: 'error' });
      if (!response.ok || !response.body) throw new Error('Unable to download attachment; please resend it.');
      const chunks = [];
      for await (const chunk of response.body) {
        total += chunk.length;
        if (total > maxBytes) { await response.body.cancel?.().catch(() => {}); throw new Error('Attachment limit exceeded.'); }
        chunks.push(chunk);
      }
      const name = `${a.id}-${safeName(a.name)}`;
      const bytes = Buffer.concat(chunks);
      await writeFile(join(dir, name), bytes, { mode: 0o600 });
      saved.push({ id: a.id, name: stripPings(a.name), size: bytes.length, path: `attachments/${ticketId}/${name}` });
    }
    return saved;
  }
  files(attachments) { return attachments.map(a => ({ attachment: join(this.dir, a.path), name: safeName(a.name) })); }
  html(ticket, messages) {
    const rows = messages.map(m => `<article><header>${escapeHtml(m.direction === 'staff' ? 'Moderator' : m.direction === 'note' ? 'Staff note' : 'Member')} · ${escapeHtml(m.author_name)} (${escapeHtml(m.author_id)}) · ${new Date(m.created_at).toISOString()}${m.edited_at ? ' · EDITED' : ''}${m.deleted_at ? ' · DELETED (retained for audit)' : ''} · ${escapeHtml(m.delivery)}</header><pre>${escapeHtml(m.content)}</pre>${m.attachments.map(a => `<p><a href="${escapeHtml(a.path)}" download>${escapeHtml(a.name)}</a> (${a.size} bytes)</p>`).join('')}</article>`).join('\n');
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>Conversation #${ticket.id}</title><style>body{font:16px system-ui;max-width:900px;margin:40px auto;padding:0 20px;background:#111827;color:#eee}article{border-top:1px solid #4b5563;padding:16px 0}header{color:#a5b4fc}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}a{color:#93c5fd}</style></head><body><h1>Conversation #${ticket.id}</h1><p>User ${escapeHtml(ticket.user_id)} · Opened ${new Date(ticket.created_at).toISOString()}</p><p>Closed by ${escapeHtml(ticket.closed_by || '—')}: ${escapeHtml(ticket.close_reason || '—')}</p><p>Private moderator record. Edited and deleted content is retained in audit.json. Extract the archive before opening attachments.</p>${rows}</body></html>`;
  }
  async build(ticket, messages, revisions, extra = {}, snapshot = false) {
    const dir = join(this.dir, 'archives');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, `ticket-${ticket.id}${snapshot ? "-snapshot" : ""}.zip`);
    const temp = `${path}.tmp`;
    const output = createWriteStream(temp, { mode: 0o600 });
    const done = finished(output);
    // Attach an immediate rejection handler while streaming inputs.
    done.catch(() => {});
    const zip = new Zip((error, data, final) => {
      if (error) output.destroy(error);
      else { output.write(data); if (final) output.end(); }
    });
    const add = async (name, iterable) => {
      const file = new ZipPassThrough(name);
      zip.add(file);
      for await (const chunk of iterable) { file.push(chunk); if (output.writableNeedDrain) await once(output, 'drain'); }
      file.push(new Uint8Array(), true);
    };
    try {
      await add('transcript.html', [Buffer.from(this.html(ticket, messages))]);
      await add('audit.json', [Buffer.from(JSON.stringify({ ticket, messages, ...extra, revisions: revisions.map(r => ({ ...r, attachments: JSON.parse(r.attachments) })) }, null, 2))]);
      const paths = new Set([...messages.flatMap(m => m.attachments), ...revisions.flatMap(r => JSON.parse(r.attachments))].map(a => a.path));
      for (const file of paths) await add(file, createReadStream(join(this.dir, file)));
      zip.end();
      await done;
      await rename(temp, path);
      return path;
    } catch (error) { output.destroy(); throw error; }
  }
  async *parts(path, maxBytes = 8 * 1024 * 1024) {
    const size = (await stat(path)).size;
    let index = 0;
    for await (const chunk of createReadStream(path, { highWaterMark: maxBytes })) {
      index++;
      yield { attachment: chunk, name: size <= maxBytes ? basename(path) : `${basename(path)}.${String(index).padStart(3, '0')}` };
    }
  }
}
