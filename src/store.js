import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { MongoClient } from 'mongodb';

export class SqliteStore {
  isMongo = false;
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
    columns('messages', { options: "TEXT NOT NULL DEFAULT '{}'", recipients: "TEXT NOT NULL DEFAULT '[]'" });
    columns('blocks', { kind: "TEXT NOT NULL DEFAULT 'user'" });
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS participants (ticket_id INTEGER NOT NULL REFERENCES tickets(id), user_id TEXT NOT NULL, joined_at INTEGER NOT NULL, removed_at INTEGER, PRIMARY KEY (ticket_id, user_id));
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_participant ON participants(user_id) WHERE removed_at IS NULL;
      CREATE TABLE IF NOT EXISTS copies (message_id INTEGER NOT NULL REFERENCES messages(id), destination TEXT NOT NULL, part INTEGER NOT NULL, channel_id TEXT NOT NULL, target_id TEXT NOT NULL, PRIMARY KEY (message_id, destination, part));
      CREATE TABLE IF NOT EXISTS notifications (ticket_id INTEGER NOT NULL REFERENCES tickets(id), target_id TEXT NOT NULL, kind TEXT NOT NULL, recurring INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (ticket_id, target_id, recurring));
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, ticket_id INTEGER REFERENCES tickets(id), actor TEXT NOT NULL, action TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS plugin_data (plugin TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (plugin, key));
      INSERT OR IGNORE INTO participants SELECT id, user_id, created_at, closed_at FROM tickets;
      INSERT OR IGNORE INTO copies SELECT m.id, CASE WHEN m.direction='member' THEN 'staff' ELSE t.user_id END, 0, m.target_channel,m.target_id FROM messages m JOIN tickets t ON t.id=m.ticket_id WHERE m.target_id IS NOT NULL AND m.deleted_at IS NULL;
    `);
  }
  connect() {}
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

export class MongoStore {
  isMongo = true;
  constructor(uri) {
    this.client = new MongoClient(uri || process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017');
    this.dbName = process.env.MONGODB_DB || 'aarons_support';
  }

  async connect() {
    await this.client.connect();
    this.db = this.client.db(this.dbName);
    
    await this.db.collection('tickets').createIndex({ user_id: 1 });
    await this.db.collection('tickets').createIndex({ channel_id: 1 }, { unique: true, sparse: true });
    await this.db.collection('messages').createIndex({ ticket_id: 1, id: 1 });
    await this.db.collection('messages').createIndex({ source_id: 1 }, { unique: true });
    await this.db.collection('participants').createIndex({ ticket_id: 1, user_id: 1 }, { unique: true });
    await this.db.collection('copies').createIndex({ message_id: 1, destination: 1, part: 1 }, { unique: true });
    await this.db.collection('notifications').createIndex({ ticket_id: 1, target_id: 1, kind: 1, recurring: 1 }, { unique: true });
    await this.db.collection('plugin_data').createIndex({ plugin: 1, key: 1 }, { unique: true });
  }

  async nextId(sequenceName) {
    const res = await this.db.collection('counters').findOneAndUpdate(
      { _id: sequenceName },
      { $inc: { seq: 1 } },
      { returnDocument: 'after', upsert: true }
    );
    return res.seq;
  }

  async createTicket(userId) {
    const id = await this.nextId('ticketId');
    const ticket = {
      id, user_id: userId, status: 'opening', created_at: Date.now(),
      closed_at: null, close_at: null, close_reason: null, closed_by: null,
      log_url: null, archive_path: null, last_error: null,
      title: null, category_id: null, snoozed_at: null, snooze_until: null, nsfw: 0
    };
    await this.db.collection('tickets').insertOne(ticket);
    await this.addParticipant(id, userId);
    return ticket;
  }

  async ticket(id) {
    return await this.db.collection('tickets').findOne({ id });
  }

  async active(userId) {
    const p = await this.db.collection('participants').findOne({ user_id: userId, removed_at: null });
    if (!p) return null;
    return await this.db.collection('tickets').findOne({ id: p.ticket_id, status: { $ne: 'closed' } });
  }

  async byChannel(id) {
    return await this.db.collection('tickets').findOne({ channel_id: id, status: { $ne: 'closed' } });
  }

  async live() {
    return await this.db.collection('tickets').find({ status: { $ne: 'closed' } }).toArray();
  }

  async history(userId, page = 0, query = '') {
    const participants = await this.db.collection('participants').find({ user_id: userId }).toArray();
    const ticketIds = participants.map(p => p.ticket_id);
    if (!ticketIds.length) return [];
    
    let filter = { id: { $in: ticketIds } };
    if (query) {
      const messages = await this.db.collection('messages').find({ ticket_id: { $in: ticketIds }, content: new RegExp(query, 'i') }).toArray();
      const matchIds = messages.map(m => m.ticket_id);
      filter.id = { $in: matchIds };
    }
    
    return await this.db.collection('tickets').find(filter).sort({ id: -1 }).skip(page * 10).limit(10).toArray();
  }

  async updateTicket(id, values) {
    await this.db.collection('tickets').updateOne({ id }, { $set: values });
    return await this.ticket(id);
  }

  async update(table, id, values) {
    await this.db.collection(table).updateOne({ id }, { $set: values });
  }

  async message(sourceId) {
    return await this.db.collection('messages').findOne({ source_id: sourceId });
  }

  async messages(ticketId) {
    return await this.db.collection('messages').find({ ticket_id: ticketId }).sort({ id: 1 }).toArray();
  }

  async addMessage(ticket, source, direction, content, attachments, options = {}, recipients = []) {
    const id = await this.nextId('messageId');
    const msg = {
      id, ticket_id: ticket.id, source_id: source.id, source_channel: source.channelId,
      direction, author_id: source.author.id,
      author_name: source.member?.displayName || source.author.tag || source.author.username,
      content, attachments, created_at: source.createdTimestamp || Date.now(),
      options, recipients, target_id: null, target_channel: null,
      edited_at: null, deleted_at: null, delivery: 'pending'
    };
    await this.db.collection('messages').insertOne(msg);
    return msg;
  }

  async updateMessage(id, values) {
    await this.db.collection('messages').updateOne({ id }, { $set: values });
  }

  async revise(row, content, attachments) {
    const revId = await this.nextId('revisionId');
    await this.db.collection('revisions').insertOne({
      id: revId, message_id: row.id, content: row.content, attachments: row.attachments, saved_at: Date.now()
    });
    await this.updateMessage(row.id, { content, attachments, edited_at: Date.now() });
  }

  async revisions(ticketId) {
    const msgs = await this.db.collection('messages').find({ ticket_id: ticketId }).toArray();
    const msgIds = msgs.map(m => m.id);
    return await this.db.collection('revisions').find({ message_id: { $in: msgIds } }).sort({ id: 1 }).toArray();
  }

  async settings() {
    const sets = await this.db.collection('settings').find({}).toArray();
    return Object.fromEntries(sets.map(s => [s._id, s.value]));
  }

  async setSetting(key, value) {
    await this.db.collection('settings').updateOne({ _id: key }, { $set: { value } }, { upsert: true });
  }

  async blocked(userId) {
    return await this.db.collection('blocks').findOne({ _id: userId });
  }

  async block(userId, reason, kind = 'user') {
    await this.db.collection('blocks').updateOne({ _id: userId }, { $set: { reason, kind } }, { upsert: true });
  }

  async unblock(userId) {
    await this.db.collection('blocks').deleteOne({ _id: userId });
  }

  async participants(ticketId, all = false) {
    const q = { ticket_id: ticketId };
    if (!all) q.removed_at = null;
    return await this.db.collection('participants').find(q).toArray();
  }

  async addParticipant(ticketId, userId) {
    await this.db.collection('participants').updateOne(
      { ticket_id: ticketId, user_id: userId },
      { $set: { removed_at: null }, $setOnInsert: { joined_at: Date.now() } },
      { upsert: true }
    );
  }

  async removeParticipant(ticketId, userId) {
    await this.db.collection('participants').updateOne(
      { ticket_id: ticketId, user_id: userId },
      { $set: { removed_at: Date.now() } }
    );
  }

  async finishTicket(ticketId) {
    await this.updateTicket(ticketId, { status: 'closed', closed_at: Date.now(), close_at: null, snoozed_at: null, snooze_until: null, last_error: null });
    await this.db.collection('participants').updateMany(
      { ticket_id: ticketId, removed_at: null },
      { $set: { removed_at: Date.now() } }
    );
  }

  async releaseParticipants(ticketId) {
    await this.db.collection('participants').updateMany(
      { ticket_id: ticketId, removed_at: null },
      { $set: { removed_at: Date.now() } }
    );
  }

  async copies(messageId) {
    return await this.db.collection('copies').find({ message_id: messageId }).sort({ destination: 1, part: 1 }).toArray();
  }

  async saveCopy(messageId, destination, part, message) {
    await this.db.collection('copies').updateOne(
      { message_id: messageId, destination, part },
      { $set: { channel_id: message.channelId, target_id: message.id } },
      { upsert: true }
    );
  }

  async removeCopy(messageId, destination, part) {
    await this.db.collection('copies').deleteOne({ message_id: messageId, destination, part });
  }

  async findMessage(ticketId, id) {
    const msg = await this.db.collection('messages').findOne({ ticket_id: ticketId, source_id: id });
    if (msg) return msg;
    const copies = await this.db.collection('copies').find({ target_id: id }).toArray();
    const msgIds = copies.map(c => c.message_id);
    return await this.db.collection('messages').findOne({ ticket_id: ticketId, id: { $in: msgIds } });
  }

  async notifications(ticketId) {
    return await this.db.collection('notifications').find({ ticket_id: ticketId }).toArray();
  }

  async subscribe(ticketId, target, recurring) {
    await this.db.collection('notifications').updateOne(
      { ticket_id: ticketId, target_id: target.id, kind: target.kind, recurring: Number(recurring) },
      { $set: { dummy: 1 } },
      { upsert: true }
    );
  }

  async unsubscribe(ticketId, target, recurring) {
    await this.db.collection('notifications').deleteOne({ ticket_id: ticketId, target_id: target.id, kind: target.kind, recurring: Number(recurring) });
  }

  async blocks() {
    return await this.db.collection('blocks').find({}).sort({ _id: 1 }).toArray();
  }

  async event(ticketId, actor, action) {
    const id = await this.nextId('eventId');
    await this.db.collection('events').insertOne({ id, ticket_id: ticketId, actor, action, created_at: Date.now() });
    await this.db.collection('events').deleteMany({ ticket_id: null, id: { $lt: id - 1000 } });
  }

  async events(ticketId) {
    if (ticketId === undefined) {
      return await this.db.collection('events').find({}).sort({ id: -1 }).limit(30).toArray();
    }
    return await this.db.collection('events').find({ ticket_id: ticketId }).sort({ id: 1 }).toArray();
  }

  async pluginGet(plugin, key) {
    const doc = await this.db.collection('plugin_data').findOne({ plugin, key });
    return doc ? doc.value : undefined;
  }

  async pluginSet(plugin, key, value) {
    await this.db.collection('plugin_data').updateOne(
      { plugin, key },
      { $set: { value } },
      { upsert: true }
    );
  }

  async recentTickets() {
    return await this.db.collection('tickets').find({}).sort({ id: -1 }).limit(100).toArray();
  }

  async close() {
    await this.client.close();
  }
}

export class Store {
  constructor(target) {
    const isMongo = (typeof target === 'string' && (target.startsWith('mongodb://') || target.startsWith('mongodb+srv://'))) || Boolean(process.env.MONGODB_URI);
    if (isMongo) {
      this.impl = new MongoStore(target && (target.startsWith('mongodb://') || target.startsWith('mongodb+srv://')) ? target : process.env.MONGODB_URI);
    } else {
      this.impl = new SqliteStore(target || process.env.DATA_DIR || './data');
    }
  }

  get isMongo() { return this.impl.isMongo; }
  get db() { return this.impl.db; }

  connect() { return this.impl.connect?.(); }
  createTicket(...args) { return this.impl.createTicket(...args); }
  ticket(...args) { return this.impl.ticket(...args); }
  active(...args) { return this.impl.active(...args); }
  byChannel(...args) { return this.impl.byChannel(...args); }
  live(...args) { return this.impl.live(...args); }
  history(...args) { return this.impl.history(...args); }
  updateTicket(...args) { return this.impl.updateTicket(...args); }
  update(...args) { return this.impl.update(...args); }
  message(...args) { return this.impl.message(...args); }
  messages(...args) { return this.impl.messages(...args); }
  addMessage(...args) { return this.impl.addMessage(...args); }
  updateMessage(...args) { return this.impl.updateMessage(...args); }
  revise(...args) { return this.impl.revise(...args); }
  revisions(...args) { return this.impl.revisions(...args); }
  settings(...args) { return this.impl.settings(...args); }
  setSetting(...args) { return this.impl.setSetting(...args); }
  blocked(...args) { return this.impl.blocked(...args); }
  block(...args) { return this.impl.block(...args); }
  unblock(...args) { return this.impl.unblock(...args); }
  participants(...args) { return this.impl.participants(...args); }
  addParticipant(...args) { return this.impl.addParticipant(...args); }
  removeParticipant(...args) { return this.impl.removeParticipant(...args); }
  finishTicket(...args) { return this.impl.finishTicket(...args); }
  releaseParticipants(...args) { return this.impl.releaseParticipants(...args); }
  copies(...args) { return this.impl.copies(...args); }
  saveCopy(...args) { return this.impl.saveCopy(...args); }
  removeCopy(...args) { return this.impl.removeCopy(...args); }
  findMessage(...args) { return this.impl.findMessage(...args); }
  notifications(...args) { return this.impl.notifications(...args); }
  subscribe(...args) { return this.impl.subscribe(...args); }
  unsubscribe(...args) { return this.impl.unsubscribe(...args); }
  blocks(...args) { return this.impl.blocks(...args); }
  event(...args) { return this.impl.event(...args); }
  events(...args) { return this.impl.events(...args); }
  pluginGet(...args) { return this.impl.pluginGet(...args); }
  pluginSet(...args) { return this.impl.pluginSet(...args); }
  recentTickets(...args) { return this.impl.recentTickets(...args); }
  close() { return this.impl.close(); }
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
