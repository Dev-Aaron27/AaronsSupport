import { MongoClient } from 'mongodb';

export class Store {
  constructor(uri) {
    this.client = new MongoClient(uri || process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017');
    this.dbName = process.env.MONGODB_DB || 'aarons_support';
  }

  async connect() {
    await this.client.connect();
    this.db = this.client.db(this.dbName);
    
    // Create indexes
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

export class SerialQueue {
  pending = new Map();
  run(key, fn) {
    const promise = (this.pending.get(key) || Promise.resolve()).catch(() => {}).then(fn);
    this.pending.set(key, promise);
    return promise.finally(() => { if (this.pending.get(key) === promise) this.pending.delete(key); });
  }
  async drain() { await Promise.allSettled([...this.pending.values()]); }
}
