import { SerialQueue } from './store.js';
import { chunks, stripPings } from './ui.js';

export class Inbox {
  constructor(store, archives, transport, config) {
    Object.assign(this, { store, archives, transport, config });
    this.queue = new SerialQueue(); this.lastMessage = new Map();
  }
  key(userId) { return this.store.active(userId)?.user_id || userId; }
  async eligibility(user, { ages = true } = {}) {
    if (this.config.dmMode === 'all') throw new Error('Modmail DMs are currently disabled.');
    if (this.store.blocked(user.id)) throw new Error('You cannot contact the moderators through this bot.');
    const member = await this.transport.member(user.id);
    if (!member) throw new Error('You must be a member of the server to contact its moderators.');
    if (this.store.blocks().some(b => b.kind === 'role' && member.roles?.cache.has(b.user_id))) throw new Error('Your role cannot contact moderators through this bot.');
    if (ages && Date.now() - user.createdTimestamp < this.config.minAccountAgeHours * 3600000) throw new Error(`Your account must be at least ${this.config.minAccountAgeHours} hours old to contact staff.`);
    if (ages && (!member.joinedTimestamp || Date.now() - member.joinedTimestamp < this.config.minMemberAgeHours * 3600000)) throw new Error(`You must have been in the server for at least ${this.config.minMemberAgeHours} hours before contacting staff.`);
    return member;
  }
  async ensure(user) {
    let ticket = this.store.active(user.id);
    if (ticket?.status === 'closing') throw new Error('Your previous conversation is closing. Please try again shortly.');
    if (!ticket) {
      if (this.config.dmMode !== 'enabled') throw new Error('New conversations are currently disabled.');
      if (!this.config.categoryId || !this.config.logChannelId) throw new Error('Staff must run setup before using modmail.');
      if (this.store.live().length >= this.config.maxOpenTickets) throw new Error('The moderator inbox is full. Please try again later.');
      ticket = this.store.createTicket(user.id);
    }
    if (ticket.status === 'opening') {
      const channel = await this.transport.open(ticket, user);
      ticket = this.store.updateTicket(ticket.id, { channel_id: channel.id, category_id: this.config.categoryId, status: 'open', last_error: null });
      await this.transport.notifyUser(user.id, this.config.welcomeMessage).catch(() => {});
      await this.transport.notifyOpening?.(ticket);
      this.store.event(ticket.id, user.id, 'opened');
      await this.plugins?.emit('threadOpen', { ticket });
    }
    return ticket;
  }
  contact(user, actor, ages = false) {
    return this.queue.run(this.key(user.id), async () => { await this.eligibility(user, { ages }); const ticket = await this.ensure(user); this.store.event(ticket.id, actor, 'staff contact'); return ticket; });
  }
  receive(source) {
    return this.queue.run(this.key(source.author.id), async () => {
      if (this.store.message(source.id)) return;
      await this.eligibility(source.author);
      if (Date.now() - (this.lastMessage.get(source.author.id) || 0) < this.config.messageCooldownSeconds * 1000) throw new Error('Please wait a moment before sending another message.');
      this.lastMessage.set(source.author.id, Date.now());
      if (this.lastMessage.size > 10000) for (const [id, time] of this.lastMessage) if (Date.now() - time > this.config.messageCooldownSeconds * 1000) this.lastMessage.delete(id);
      const isNew = !this.store.active(source.author.id);
      let ticket = await this.ensure(source.author);
      if (ticket.snoozed_at && this.config.snoozeMode === 'wake') ticket = await this.unsnoozeUnlocked(ticket);
      const row = await this.recordAndDeliver(ticket, source, 'member', source.content);
      if (isNew && !ticket.snoozed_at) await this.trigger(ticket, source);
      return row;
    });
  }
  async trigger(ticket, source) {
    const rule = Object.values(this.config.autotrigger).find(r => stripPings(source.content).toLowerCase().includes(r.keyword.toLowerCase()));
    if (!rule) return;
    const generated = { ...source, id: `auto:${source.id}`, channelId: ticket.channel_id, author: { id: this.transport.client?.user.id || 'system', username: 'Automatic response' }, attachments: new Map() };
    await this.recordAndDeliver(ticket, generated, 'staff', this.config.snippets[rule.snippet], { anonymous: true, plain: false });
    this.store.event(ticket.id, 'system', `autotrigger ${rule.snippet}`);
  }
  reply(ticket, source, content, note = false, options = { anonymous: true, plain: false }) {
    return this.queue.run(ticket.user_id, async () => {
      ticket = this.store.ticket(ticket.id);
      if (ticket.status !== 'open' || ticket.snoozed_at) throw new Error('Repair or unsnooze this conversation before replying.');
      if (!note && this.config.dmMode === 'all') throw new Error('Modmail DMs are currently disabled.');
      if (this.store.message(source.id)) return;
      return this.recordAndDeliver(ticket, source, note ? 'note' : 'staff', content, options);
    });
  }
  async recordAndDeliver(ticket, source, direction, content, options = { anonymous: true, plain: false }) {
    content = stripPings(content);
    if (!content && !source.attachments.size) throw new Error('Send text or attach a file. Stickers, polls, voice playback, and reactions are not relayed.');
    const attachments = await this.archives.saveAttachments(ticket.id, source.attachments, this.config.maxAttachmentBytes);
    const members = this.store.participants(ticket.id).map(p => p.user_id);
    const recipients = direction === 'note' ? ['staff'] : direction === 'staff' ? ['staff', ...members] : ['staff', ...members.filter(id => id !== source.author.id)];
    const row = this.store.addMessage(ticket, source, direction, content, attachments, options, recipients);
    if (direction === 'member' && (ticket.snoozed_at || ticket.status === 'broken')) {
      this.store.updateMessage(row.id, { delivery: 'queued' });
      await this.transport.notifyUser(source.author.id, 'Your message was saved. Staff will receive it when this conversation resumes.').catch(() => {});
      return row;
    }
    try { await this.deliver(ticket, row); }
    catch (error) {
      this.store.updateMessage(row.id, { delivery: 'failed' });
      await this.transport.alert(ticket, `Message ${source.id} was saved but delivery failed. Use ${this.config.prefix}retry ${source.id}. Successful recipients will not receive it twice.`).catch(() => {});
      throw new Error('Your message was saved, but delivery did not complete. Staff have been notified.', { cause: error });
    }
    if (direction === 'member') await this.notify(ticket);
    await this.plugins?.emit('message', { ticket, message: this.store.message(source.id) });
    return this.store.message(source.id);
  }
  async deliver(ticket, row) {
    if (this.config.dmMode === 'all' && row.direction !== 'note') throw new Error('Modmail DMs are currently disabled.');
    const targets = row.recipients.length ? row.recipients : [row.direction === 'staff' ? ticket.user_id : 'staff'];
    const active = new Set(this.store.participants(ticket.id).map(p => p.user_id));
    const parts = chunks(row.content);
    const errors = [];
    for (const target of targets) {
      if (target !== 'staff' && !active.has(target)) continue;
      for (let i = 0; i < parts.length; i++) {
        if (this.store.copies(row.id).some(c => c.destination === target && c.part === i)) continue;
        try {
          const message = await this.transport.send(ticket, row, i === 0 ? this.archives.files(row.attachments) : [], target, parts[i]);
          this.store.saveCopy(row.id, target, i, message);
          if (!row.target_id) this.store.updateMessage(row.id, { target_id: message.id, target_channel: message.channelId });
        } catch (error) { errors.push(error); break; }
      }
    }
    if (row.direction === 'member' && this.store.copies(row.id).filter(c => c.destination === 'staff').length === parts.length) {
      await this.transport.acknowledge?.(row).catch(error => this.transport.report(error, 'delivery reaction'));
    }
    if (errors.length) throw new AggregateError(errors, 'Some recipients could not be reached.');
    this.store.updateMessage(row.id, { delivery: row.direction === 'note' ? 'internal' : 'sent' });
    if (row.options.removeSource && !row.options.sourceRemoved && this.transport.deleteSource) {
      const options = { ...row.options, sourceRemoved: true };
      const origin = this.store.message(row.options.commandSourceId || row.source_id);
      this.store.updateMessage(row.id, { options: JSON.stringify(options) });
      if (origin && origin.id !== row.id) this.store.updateMessage(origin.id, { options: JSON.stringify({ ...origin.options, sourceRemoved: true }) });
      try { await this.transport.deleteSource(row); }
      catch (error) {
        this.store.updateMessage(row.id, { options: JSON.stringify({ ...options, sourceRemoved: false }) });
        if (origin && origin.id !== row.id) this.store.updateMessage(origin.id, { options: JSON.stringify(origin.options) });
        this.transport.report(error, 'reply command cleanup');
      }
    }
  }
  async notify(ticket) {
    for (const notification of this.store.notifications(ticket.id)) {
      const target = { id: notification.target_id, kind: notification.kind };
      try {
        if (!await this.transport.validNotification(target)) { this.store.unsubscribe(ticket.id, target, notification.recurring); continue; }
        await this.transport.alert(ticket, 'A new member message arrived.', [target]);
        if (!notification.recurring) this.store.unsubscribe(ticket.id, target, false);
      } catch (error) { this.transport.report(error, 'notification'); }
    }
  }
  retry(ticket, sourceId) {
    return this.queue.run(ticket.user_id, async () => {
      ticket = this.store.ticket(ticket.id);
      const row = this.store.findMessage(ticket.id, sourceId);
      if (ticket.status !== 'open' || ticket.snoozed_at || !row || row.deleted_at && row.delivery !== 'delete_failed' || !['failed','edit_failed','delete_failed'].includes(row.delivery)) throw new Error('Only failed messages in this open conversation can be retried.');
      if (row.delivery === 'failed') { await this.deliver(ticket,row); if (row.direction === 'member') await this.notify(ticket); }
      else await this.syncCopies(ticket,row);
    });
  }
  edit(source, content) {
    const found = this.store.message(source.id);
    if (!found) return;
    const ticket = this.store.ticket(found.ticket_id);
    return this.queue.run(ticket.user_id, async () => {
      const row = this.store.message(source.id);
      if (!['open','broken'].includes(this.store.ticket(ticket.id).status) || row.deleted_at) return;
      const attachments = await this.archives.saveAttachments(ticket.id, source.attachments, this.config.maxAttachmentBytes, row.attachments);
      content = stripPings(content);
      if (row.content === content && JSON.stringify(row.attachments) === JSON.stringify(attachments)) return;
      this.store.revise(row, content, attachments);
      await this.syncCopies(ticket,this.store.message(source.id));
    });
  }
  async syncCopies(ticket,row) {
    const copies = this.store.copies(row.id);
    const parts = chunks(row.content);
    try {
      const active = new Set(this.store.participants(ticket.id).map(p => p.user_id));
      for (const copy of copies) {
        if (!row.deleted_at && copy.destination !== 'staff' && !active.has(copy.destination)) continue;
        if (row.deleted_at || copy.part >= parts.length) {
          await this.transport.delete({ ...row, target_id: copy.target_id, target_channel: copy.channel_id });
          this.store.removeCopy(row.id,copy.destination,copy.part);
        } else await this.transport.edit({ ...row, target_id: copy.target_id, target_channel: copy.channel_id, destination: copy.destination }, parts[copy.part], copy.part === 0 ? this.archives.files(row.attachments) : []);
      }
      if (!row.deleted_at && !ticket.snoozed_at && ticket.status === 'open') await this.deliver(ticket,row);
      if (row.deleted_at) this.store.updateMessage(row.id, { delivery: 'deleted' });
    } catch (error) {
      this.store.updateMessage(row.id, { delivery: row.deleted_at ? 'delete_failed' : 'edit_failed' });
      await this.transport.alert(ticket, `Message ${row.source_id} could not be synchronized. Use ${this.config.prefix}retry ${row.source_id}.`).catch(() => {});
      throw error;
    }
  }
  delete(sourceId, force = false) {
    const found = this.store.message(sourceId);
    if (!found || !force && found.options.sourceRemoved) return;
    const ticket = this.store.ticket(found.ticket_id);
    return this.queue.run(ticket.user_id, async () => {
      const row = this.store.message(sourceId);
      if (!['open','broken'].includes(this.store.ticket(ticket.id).status) || row.deleted_at) return;
      this.store.updateMessage(row.id,{ deleted_at: Date.now() });
      await this.syncCopies(ticket,this.store.message(sourceId));
    });
  }
  commandEdit(ticket,id,content,actor) {
    const row = this.store.findMessage(ticket.id,id);
    if (!row || row.direction === 'member' || row.deleted_at) throw new Error('Choose a staff reply or note in this conversation.');
    return this.queue.run(ticket.user_id, async () => {
      const current = this.store.message(row.source_id);
      if (this.store.ticket(ticket.id).status !== 'open' || current.deleted_at) throw new Error('Conversation/message is not editable.');
      this.store.revise(current,stripPings(content),current.attachments);
      this.store.event(ticket.id,actor,`edited message ${row.source_id}`);
      await this.syncCopies(this.store.ticket(ticket.id),this.store.message(row.source_id));
    });
  }
  async commandDelete(ticket,id,actor) {
    const row = this.store.findMessage(ticket.id,id);
    if (!row || row.direction === 'member') throw new Error('Choose a staff reply or note in this conversation.');
    await this.delete(row.source_id, true);
    this.store.event(ticket.id,actor,`deleted message ${row.source_id}`);
    await this.transport.deleteSource?.(row).catch(() => {});
  }
  participants(ticket,user,actor,remove = false,anonymous = false) {
    return this.queue.run(ticket.user_id, async () => {
      ticket = this.store.ticket(ticket.id);
      if (ticket.status !== 'open' || ticket.snoozed_at) throw new Error('Repair or unsnooze the conversation first.');
      if (this.config.dmMode === 'all') throw new Error('Modmail DMs are disabled.');
      const ids = this.store.participants(ticket.id).map(p => p.user_id);
      if (remove) {
        if (user.id === ticket.user_id || !ids.includes(user.id)) throw new Error('Only an added participant can be removed. Close the ticket to remove its original member.');
        this.store.removeParticipant(ticket.id,user.id);
      } else {
        await this.eligibility(user);
        if (this.store.active(user.id)) throw new Error('That member already has an active conversation.');
        if (ids.length >= 10) throw new Error('A conversation can have at most 10 participants.');
        // Contact first: do not silently add someone whose DMs are unavailable.
        await this.transport.notifyUser(user.id, `You are joining a shared moderator conversation with member IDs ${ids.join(', ')}. Future messages and staff replies are shared with its participants. Previous messages are not replayed.`);
        this.store.addParticipant(ticket.id,user.id);
      }
      const announcement = `${anonymous ? 'Moderation team' : actor.name} ${remove ? 'removed' : 'added'} member ${user.id}.`;
      await this.transport.alert(ticket,announcement);
      for (const id of new Set([...ids,user.id])) await this.transport.notifyUser(id,announcement).catch(() => {});
      this.store.event(ticket.id,actor.id,`${remove ? 'removed' : 'added'} participant ${user.id}${anonymous ? ' anonymously' : ''}`);
    });
  }
  snooze(ticket,delay,actor) {
    return this.queue.run(ticket.user_id,async () => {
      ticket = this.store.ticket(ticket.id);
      if (ticket.status !== 'open') throw new Error('Only open tickets can be snoozed.');
      ticket = this.store.updateTicket(ticket.id,{ snoozed_at: Date.now(), snooze_until: delay ? Date.now()+delay : null });
      await this.transport.setSnoozed?.(ticket,true);
      this.store.event(ticket.id,actor,'snoozed'); return ticket;
    });
  }
  unsnooze(ticket) { return this.queue.run(ticket.user_id,() => this.unsnoozeUnlocked(this.store.ticket(ticket.id))); }
  async unsnoozeUnlocked(ticket) {
    if (ticket.status !== 'open') throw new Error('Repair the conversation before unsnoozing.');
    if (this.config.dmMode === 'all') throw new Error('Enable DMs before resuming queued messages.');
    await this.transport.setSnoozed?.(ticket,false);
    // An interrupted replay remains due so the scheduler resumes it after restart.
    ticket = this.store.updateTicket(ticket.id,{ snoozed_at: ticket.snoozed_at || Date.now(), snooze_until: Date.now() });
    for (const row of this.store.messages(ticket.id).filter(m => m.delivery === 'queued' && !m.deleted_at)) {
      try { await this.deliver(ticket,row); await this.notify(ticket); }
      catch (error) { this.store.updateMessage(row.id,{ delivery:'failed' }); await this.transport.alert(ticket,`Queued message ${row.source_id} failed. Use ${this.config.prefix}retry ${row.source_id}.`).catch(() => {}); }
    }
    ticket = this.store.updateTicket(ticket.id,{ snoozed_at: null, snooze_until: null });
    this.store.event(ticket.id,'system','unsnoozed'); return ticket;
  }
  repair(ticket) {
    return this.queue.run(ticket.user_id,async () => {
      ticket=this.store.ticket(ticket.id);
      if (!['open','broken','opening'].includes(ticket.status)) throw new Error('Closing/closed tickets cannot be repaired.');
      const channel=await this.transport.open(ticket,await this.transport.user(ticket.user_id));
      const replaced=channel.id !== ticket.channel_id;
      ticket=this.store.updateTicket(ticket.id,{channel_id:channel.id,status:'open',last_error:null});
      if (replaced) for (const row of this.store.messages(ticket.id)) {
        for (const c of this.store.copies(row.id).filter(c => c.destination==='staff')) this.store.removeCopy(row.id,c.destination,c.part);
        if (row.deleted_at || row.delivery==='queued') continue;
        // Restore staff context without resending old DMs or exposing prior messages to added participants.
        for (const [i,body] of chunks(row.content).entries()) {
          const copy=await this.transport.send(ticket,row,i===0?this.archives.files(row.attachments):[],'staff',body);
          this.store.saveCopy(row.id,'staff',i,copy);
        }
      }
      if (!ticket.snoozed_at) await this.unsnoozeUnlocked(ticket);
      this.store.event(ticket.id,'system','repaired'); return ticket;
    });
  }
  schedule(ticket,delay,reason,actor) { return this.queue.run(ticket.user_id,()=> { if (this.store.ticket(ticket.id).status !== 'open') throw new Error('Conversation is already closing.'); return this.store.updateTicket(ticket.id,{close_at:Date.now()+delay,close_reason:reason,closed_by:actor}); }); }
  cancel(ticket) { return this.queue.run(ticket.user_id,()=> { if (this.store.ticket(ticket.id).status !== 'open') throw new Error('Conversation is already closing.'); this.store.updateTicket(ticket.id,{close_at:null,close_reason:null,closed_by:null}); }); }
  async snapshot(ticket) { return this.queue.run(ticket.user_id,()=>this.archives.build(this.store.ticket(ticket.id),this.store.messages(ticket.id),this.store.revisions(ticket.id), { participants:this.store.participants(ticket.id,true), events:this.store.events(ticket.id) },true)); }
  close(ticket,reason,actor,scheduled=false) {
    return this.queue.run(ticket.user_id,async () => {
      ticket=this.store.ticket(ticket.id);
      if (ticket.status==='closed') return;
      if (scheduled && ticket.status!=='closing' && (!ticket.close_at || ticket.close_at>Date.now())) return;
      ticket=this.store.updateTicket(ticket.id,{status:'closing',close_reason:stripPings(reason || ticket.close_reason || 'Closed by staff'),closed_by:actor || ticket.closed_by || 'system'});
      try {
        if (!ticket.archive_path) ticket=this.store.updateTicket(ticket.id,{archive_path:await this.archives.build(ticket,this.store.messages(ticket.id),this.store.revisions(ticket.id),{participants:this.store.participants(ticket.id,true),events:this.store.events(ticket.id)})});
        if (!ticket.log_url) ticket=this.store.updateTicket(ticket.id,{log_url:await this.transport.publishArchive(ticket,ticket.archive_path,this.archives)});
        await this.transport.removeChannel(ticket);
        const participants=this.store.participants(ticket.id);
        this.store.finishTicket(ticket.id);
        if (this.config.dmMode!=='all') for (const p of participants) await this.transport.notifyUser(p.user_id,this.config.closeMessage).catch(()=>{});
        this.store.event(ticket.id,ticket.closed_by,'closed'); await this.plugins?.emit('threadClose',{ticket:this.store.ticket(ticket.id)});
      } catch(error) {this.store.updateTicket(ticket.id,{last_error:error.message});throw error;}
    });
  }
  async tick() {
    for (const ticket of this.store.live()) {
      try {
        if (ticket.status==='closing' || (ticket.close_at && ticket.close_at<=Date.now())) await this.close(ticket,null,null,true);
        else if (ticket.status==='open' && ticket.snoozed_at && ticket.snooze_until && ticket.snooze_until<=Date.now()) await this.unsnooze(ticket);
      } catch(error) {this.transport.report(error,`scheduled ticket #${ticket.id}; will retry`);}
    }
  }
}
