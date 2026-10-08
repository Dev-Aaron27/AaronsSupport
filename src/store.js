import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export class Store {
  constructor(dir) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(dir, 'inbox.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS tickets (
        id INTEGER PRIMARY KEY, user_id TEXT NOT NULL, channel_id TEXT UNIQUE,
        status TEXT NOT NULL DEFAULT 'opening', created_at INTEGER NOT NULL,
        closed_at INTEGER, close_at INTEGER, close_reason TEXT, closed_by TEXT,
        log_url TEXT, archive_path TEXT, last_error TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_live_ticket ON tickets(user_id) WHERE status != 'closed';
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY, ticket_id INTEGER NOT NULL REFERENCES tickets(id),
        source_id TEXT UNIQUE NOT NULL, source_channel TEXT NOT NULL,
        target_id TEXT, target_channel TEXT, direction TEXT NOT NULL,
        author_id TEXT NOT NULL, author_name TEXT NOT NULL, content TEXT NOT NULL,
        attachments TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL,
        edited_at INTEGER, deleted_at INTEGER, delivery TEXT NOT NULL DEFAULT 'pending'
      );
      CREATE INDEX IF NOT EXISTS ticket_messages ON messages(ticket_id, id);
      CREATE TABLE IF NOT EXISTS revisions (
        id INTEGER PRIMARY KEY, message_id INTEGER NOT NULL REFERENCES messages(id),
        content TEXT NOT NULL, attachments TEXT NOT NULL, saved_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS blocks (user_id TEXT PRIMARY KEY, reason TEXT NOT NULL);
    `);
    const columns = (table, specs) => { const existing = new Set(this.db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name)); for (const [name, spec] of Object.entries(specs)) if (!existing.has(name)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${spec}`); };
    columns('tickets', { title: 'TEXT', category_id: 'TEXT', snoozed_at: 'INTEGER', snooze_until: 'INTEGER', nsfw: 'INTEGER NOT NULL DEFAULT 0' });
    columns('messages', { options: "TEXT NOT NULL DEFAULT '{\"anonymous\":true,\"plain\":false}'", recipients: "TEXT NOT NULL DEFAULT '[]'" });
    columns('blocks', { kind: "TEXT NOT NULL DEFAULT 'user'" });
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS participants (ticket_id INTEGER REFERENCES tickets(id), user_id TEXT NOT NULL, joined_at INTEGER NOT NULL, removed_at INTEGER, PRIMARY KEY(ticket_id,user_id));
      CREATE UNIQUE INDEX IF NOT EXISTS one_participation ON participants(user_id) WHERE removed_at IS NULL;
      CREATE TABLE IF NOT EXISTS copies (message_id INTEGER REFERENCES messages(id), destination TEXT NOT NULL, part INTEGER NOT NULL, channel_id TEXT NOT NULL, target_id TEXT NOT NULL, PRIMARY KEY(message_id,destination,part));
      CREATE TABLE IF NOT EXISTS notifications (ticket_id INTEGER REFERENCES tickets(id), target_id TEXT NOT NULL, kind TEXT NOT NULL, recurring INTEGER NOT NULL, PRIMARY KEY(ticket_id,target_id,kind,recurring));
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, ticket_id INTEGER, actor TEXT, action TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS plugin_data (plugin TEXT, key TEXT, value TEXT NOT NULL, PRIMARY KEY(plugin,key));
      INSERT OR IGNORE INTO participants SELECT id,user_id,created_at,CASE WHEN status='closed' THEN coalesce(closed_at,created_at) ELSE NULL END FROM tickets;
      UPDATE participants SET removed_at=coalesce((SELECT closed_at FROM tickets WHERE id=participants.ticket_id),joined_at) WHERE removed_at IS NULL AND ticket_id IN (SELECT id FROM tickets WHERE status='closed');
      INSERT OR IGNORE INTO copies SELECT m.id, CASE WHEN m.direction='member' THEN 'staff' ELSE t.user_id END, 0, m.target_channel,m.target_id FROM messages m JOIN tickets t ON t.id=m.ticket_id WHERE m.target_id IS NOT NULL AND m.deleted_at IS NULL;
    `);
  }
  createTicket(userId) { this.db.exec('BEGIN'); try { const r=this.db.prepare('INSERT INTO tickets(user_id,created_at) VALUES (?,?)').run(userId,Date.now()); const ticket=this.ticket(Number(r.lastInsertRowid)); this.addParticipant(ticket.id,userId); this.db.exec('COMMIT'); return ticket; } catch(error) { this.db.exec('ROLLBACK'); throw error; } }
  ticket(id) { return this.db.prepare('SELECT * FROM tickets WHERE id=?').get(id); }
  active(userId) { return this.db.prepare("SELECT t.* FROM tickets t JOIN participants p ON p.ticket_id=t.id WHERE p.user_id=? AND p.removed_at IS NULL AND t.status!='closed'").get(userId); }
  byChannel(id) { return this.db.prepare("SELECT * FROM tickets WHERE channel_id=? AND status!='closed'").get(id); }
  live() { return this.db.prepare("SELECT * FROM tickets WHERE status!='closed'").all(); }
  history(userId, page = 0, query = '') { return this.db.prepare("SELECT DISTINCT t.* FROM tickets t JOIN participants p ON p.ticket_id=t.id WHERE p.user_id=? AND (?='' OR EXISTS(SELECT 1 FROM messages m WHERE m.ticket_id=t.id AND instr(lower(m.content),lower(?))>0)) ORDER BY t.id DESC LIMIT 10 OFFSET ?").all(userId, query, query, page * 10); }
  updateTicket(id, values) { this.update('tickets', id, values, ['channel_id','status','closed_at','close_at','close_reason','closed_by','log_url','archive_path','last_error','title','category_id','snoozed_at','snooze_until','nsfw']); return this.ticket(id); }
  update(table, id, values, allowed) {
    const entries = Object.entries(values);
    if (!entries.length || entries.some(([key]) => !allowed.includes(key))) throw new Error('Invalid database update');
    this.db.prepare(`UPDATE ${table} SET ${entries.map(([k]) => `${k}=?`).join(',')} WHERE id=?`).run(...entries.map(([,v]) => v), id);
  }
  message(sourceId) { return this.decode(this.db.prepare('SELECT * FROM messages WHERE source_id=?').get(sourceId)); }
  decode(row) { return row ? { ...row, attachments: JSON.parse(row.attachments), options: JSON.parse(row.options), recipients: JSON.parse(row.recipients) } : undefined; }
  messages(ticketId) { return this.db.prepare('SELECT * FROM messages WHERE ticket_id=? ORDER BY id').all(ticketId).map(r => this.decode(r)); }
  addMessage(ticket, source, direction, content, attachments, options = {}, recipients = []) {
    this.db.prepare(`INSERT INTO messages(ticket_id,source_id,source_channel,direction,author_id,author_name,content,attachments,created_at,options,recipients) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(ticket.id, source.id, source.channelId, direction, source.author.id, source.member?.displayName || source.author.tag || source.author.username, content, JSON.stringify(attachments), source.createdTimestamp || Date.now(), JSON.stringify(options), JSON.stringify(recipients));
    return this.message(source.id);
  }
  updateMessage(id, values) { this.update('messages', id, values, ['target_id','target_channel','content','attachments','edited_at','deleted_at','delivery','options','recipients']); }
  revise(row, content, attachments) {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('INSERT INTO revisions(message_id,content,attachments,saved_at) VALUES (?,?,?,?)').run(row.id, row.content, JSON.stringify(row.attachments), Date.now());
      this.updateMessage(row.id, { content, attachments: JSON.stringify(attachments), edited_at: Date.now() });
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  revisions(ticketId) { return this.db.prepare('SELECT r.* FROM revisions r JOIN messages m ON m.id=r.message_id WHERE m.ticket_id=? ORDER BY r.id').all(ticketId); }
  settings() { return Object.fromEntries(this.db.prepare('SELECT * FROM settings').all().map(r => [r.key, JSON.parse(r.value)])); }
  setSetting(key, value) { this.db.prepare('INSERT OR REPLACE INTO settings VALUES (?,?)').run(key, JSON.stringify(value)); }
  blocked(userId) { return this.db.prepare('SELECT * FROM blocks WHERE user_id=?').get(userId); }
  block(userId, reason, kind = 'user') { this.db.prepare('INSERT OR REPLACE INTO blocks(user_id,reason,kind) VALUES (?,?,?)').run(userId, reason, kind); }
  unblock(userId) { this.db.prepare('DELETE FROM blocks WHERE user_id=?').run(userId); }
  participants(ticketId, all = false) { return this.db.prepare(`SELECT * FROM participants WHERE ticket_id=? ${all ? '' : 'AND removed_at IS NULL'}`).all(ticketId); }
  addParticipant(ticketId, userId) { this.db.prepare('INSERT INTO participants VALUES (?,?,?,NULL) ON CONFLICT(ticket_id,user_id) DO UPDATE SET removed_at=NULL, joined_at=excluded.joined_at').run(ticketId,userId,Date.now()); }
  removeParticipant(ticketId,userId) { this.db.prepare('UPDATE participants SET removed_at=? WHERE ticket_id=? AND user_id=?').run(Date.now(),ticketId,userId); }
  finishTicket(ticketId) { this.db.exec('BEGIN'); try { this.updateTicket(ticketId,{status:'closed',closed_at:Date.now(),close_at:null,snoozed_at:null,snooze_until:null,last_error:null}); this.releaseParticipants(ticketId); this.db.exec('COMMIT'); } catch(error) { this.db.exec('ROLLBACK'); throw error; } }
  releaseParticipants(ticketId) { this.db.prepare('UPDATE participants SET removed_at=? WHERE ticket_id=? AND removed_at IS NULL').run(Date.now(),ticketId); }
  copies(messageId) { return this.db.prepare('SELECT * FROM copies WHERE message_id=? ORDER BY destination,part').all(messageId); }
  saveCopy(messageId,destination,part,message) { this.db.prepare('INSERT OR REPLACE INTO copies VALUES (?,?,?,?,?)').run(messageId,destination,part,message.channelId,message.id); }
  removeCopy(messageId,destination,part) { this.db.prepare('DELETE FROM copies WHERE message_id=? AND destination=? AND part=?').run(messageId,destination,part); }
  findMessage(ticketId,id) { return this.decode(this.db.prepare('SELECT m.* FROM messages m WHERE m.ticket_id=? AND (m.source_id=? OR EXISTS(SELECT 1 FROM copies c WHERE c.message_id=m.id AND c.target_id=?))').get(ticketId,id,id)); }
  notifications(ticketId) { return this.db.prepare('SELECT * FROM notifications WHERE ticket_id=?').all(ticketId); }
  subscribe(ticketId,target,recurring) { this.db.prepare('INSERT OR REPLACE INTO notifications VALUES (?,?,?,?)').run(ticketId,target.id,target.kind,Number(recurring)); }
  unsubscribe(ticketId,target,recurring) { this.db.prepare('DELETE FROM notifications WHERE ticket_id=? AND target_id=? AND kind=? AND recurring=?').run(ticketId,target.id,target.kind,Number(recurring)); }
  blocks() { return this.db.prepare('SELECT * FROM blocks ORDER BY user_id').all(); }
  event(ticketId,actor,action) { this.db.prepare('INSERT INTO events(ticket_id,actor,action,created_at) VALUES (?,?,?,?)').run(ticketId,actor,action,Date.now()); this.db.exec('DELETE FROM events WHERE ticket_id IS NULL AND id < (SELECT coalesce(max(id),0)-1000 FROM events)'); }
  events(ticketId) { return ticketId === undefined ? this.db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT 30').all() : this.db.prepare('SELECT * FROM events WHERE ticket_id=? ORDER BY id').all(ticketId); }
  pluginGet(plugin,key) { const row=this.db.prepare('SELECT value FROM plugin_data WHERE plugin=? AND key=?').get(plugin,key); return row ? JSON.parse(row.value) : undefined; }
  pluginSet(plugin,key,value) { this.db.prepare('INSERT OR REPLACE INTO plugin_data VALUES (?,?,?)').run(plugin,key,JSON.stringify(value)); }
  recentTickets() { return this.db.prepare('SELECT * FROM tickets ORDER BY id DESC LIMIT 100').all(); }
  close() { this.db.close(); }
}

export class SerialQueue {
  pending = new Map();
  run(key, fn) {
    const promise = (this.pending.get(key) || Promise.resolve()).catch(() => {}).then(fn);
    this.pending.set(key, promise);
    return promise.finally(() => { if (this.pending.get(key) === promise) this.pending.delete(key); });
  }
  async drain() { await Promise.allSettled([...this.pending.values()]); }
}
