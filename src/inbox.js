import { SerialQueue } from './store.js';
import { chunks, stripPings } from './ui.js';

export class Inbox {
  constructor(store, archives, transport, config) {
    Object.assign(this, { store, archives, transport, config });
    this.queue = new SerialQueue(); this.lastMessage = new Map();
  }
  async key(userId) { const active = await this.store.active(userId); return active?.user_id || userId; }
  async eligibility(user, { ages = true } = {}) {
    if (this.config.dmMode === 'all') throw new Error('Modmail DMs are currently disabled.');
    if (await this.store.blocked(user.id)) throw new Error('You cannot contact the moderators through this bot.');
    const member = await this.transport.member(user.id);
    if (!member) throw new Error('You must be a member of the server to contact its moderators.');
    const blocks = await this.store.blocks();
    if (blocks.some(b => b.kind === 'role' && member.roles?.cache.has(b.user_id))) throw new Error('Your role cannot contact moderators through this bot.');
    if (ages && Date.now() - user.createdTimestamp < this.config.minAccountAgeHours * 3600000) throw new Error(`Your account must be at least ${this.config.minAccountAgeHours} hours old to contact staff.`);
    if (ages && (!member.joinedTimestamp || Date.now() - member.joinedTimestamp < this.config.minMemberAgeHours * 3600000)) throw new Error(`You must have been in the server for at least ${this.config.minMemberAgeHours} hours before contacting staff.`);
    return member;
  }
  async ensure(user) {
    let ticket = await this.store.active(user.id);
    if (ticket?.status === 'closing') throw new Error('Your previous conversation is closing. Please try again shortly.');
    if (!ticket) {
      if (this.config.dmMode !== 'enabled') throw new Error('New conversations are currently disabled.');
      if (!this.config.categoryId || !this.config.logChannelId) throw new Error('Staff must run setup before using modmail.');
      const live = await this.store.live();
      if (live.length >= this.config.maxOpenTickets) throw new Error('The moderator inbox is full. Please try again later.');
      ticket = await this.store.createTicket(user.id);
    }
    if (ticket.status === 'opening') {
      const channel = await this.transport.open(ticket, user);
      ticket = await this.store.updateTicket(ticket.id, { channel_id: channel.id, category_id: this.config.categoryId, status: 'open', last_error: null });
      await this.transport.notifyUser(user.id, this.config.welcomeMessage, { title: 'Ticket Created', color: this.config.colors.member }).catch(() => {});
      await this.transport.notifyOpening?.(ticket);
      await this.store.event(ticket.id, user.id, 'opened');
      await this.plugins?.emit('threadOpen', { ticket });
    }
    return ticket;
  }
  async contact(user, actor, ages = false) {
    const k = await this.key(user.id);
    return this.queue.run(k, async () => { await this.eligibility(user, { ages }); const ticket = await this.ensure(user); await this.store.event(ticket.id, actor, 'staff contact'); return ticket; });
  }
  async receive(source) {
    const k = await this.key(source.author.id);
    return this.queue.run(k, async () => {
      if (await this.store.message(source.id)) return;
      await this.eligibility(source.author);
      if (Date.now() - (this.lastMessage.get(source.author.id) || 0) < this.config.messageCooldownSeconds * 1000) throw new Error('Please wait a moment before sending another message.');
      this.lastMessage.set(source.author.id, Date.now());
      if (this.lastMessage.size > 10000) for (const [id, time] of this.lastMessage) if (Date.now() - time > this.config.messageCooldownSeconds * 1000) this.lastMessage.delete(id);
      const isNew = !(await this.store.active(source.author.id));
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
    await this.store.event(ticket.id, 'system', `autotrigger ${rule.snippet}`);
  }
  reply(ticket, source, content, note = false, options = { anonymous: true, plain: false }) {
    return this.queue.run(ticket.user_id, async () => {
      ticket = await this.store.ticket(ticket.id);
      if (ticket.status !== 'open' || ticket.snoozed_at) throw new Error('Repair or unsnooze this conversation before replying.');
      if (!note && this.config.dmMode === 'all') throw new Error('Modmail DMs are currently disabled.');
      if (await this.store.message(source.id)) return;
      return this.recordAndDeliver(ticket, source, note ? 'note' : 'staff', content, options);
    });
  }
  async recordAndDeliver(ticket, source, direction, content, options = { anonymous: true, plain: false }) {
    content = stripPings(content);
    if (!content && !source.attachments.size) throw new Error('Send text or attach a file. Stickers, polls, voice playback, and reactions are not relayed.');
    const attachments = await this.archives.saveAttachments(ticket.id, source.attachments, this.config.maxAttachmentBytes);
    const parts = await this.store.participants(ticket.id);
    const members = parts.map(p => p.user_id);
    const recipients = direction === 'note' ? ['staff'] : direction === 'staff' ? ['staff', ...members] : ['staff', ...members.filter(id => id !== source.author.id)];
    const row = await this.store.addMessage(ticket, source, direction, content, attachments, options, recipients);
    if (direction === 'member' && (ticket.snoozed_at || ticket.status === 'broken')) {
      await this.store.updateMessage(row.id, { delivery: 'queued' });
      await this.transport.notifyUser(source.author.id, 'Your message was saved. Staff will receive it when this conversation resumes.').catch(() => {});
      return row;
    }
    try { await this.deliver(ticket, row); }
    catch (error) {
      await this.store.updateMessage(row.id, { delivery: 'failed' });
      await this.transport.alert(ticket, `Message ${source.id} was saved but delivery failed. Use ${this.config.prefix}retry ${source.id}. Successful recipients will not receive it twice.`).catch(() => {});
      throw new Error('Your message was saved, but delivery did not complete. Staff have been notified.', { cause: error });
    }
    if (direction === 'member') await this.notify(ticket);
    await this.plugins?.emit('message', { ticket, message: await this.store.message(source.id) });
    return await this.store.message(source.id);
  }
  async deliver(ticket, row) {
    if (this.config.dmMode === 'all' && row.direction !== 'note') throw new Error('Modmail DMs are currently disabled.');
    const targets = row.recipients.length ? row.recipients : [row.direction === 'staff' ? ticket.user_id : 'staff'];
    const partsList = await this.store.participants(ticket.id);
    const active = new Set(partsList.map(p => p.user_id));
    const parts = chunks(row.content);
    const errors = [];
    for (const target of targets) {
      if (target !== 'staff' && !active.has(target)) continue;
      for (let i = 0; i < parts.length; i++) {
        if ((await this.store.copies(row.id)).some(c => c.destination === target && c.part === i)) continue;
        try {
          const message = await this.transport.send(ticket, row, i === 0 ? this.archives.files(row.attachments) : [], target, parts[i]);
          await this.store.saveCopy(row.id, target, i, message);
          if (!row.target_id) await this.store.updateMessage(row.id, { target_id: message.id, target_channel: message.channelId });
        } catch (error) { errors.push(error); break; }
      }
    }
    if (row.direction === 'member' && (await this.store.copies(row.id)).filter(c => c.destination === 'staff').length === parts.length) {
      await this.transport.acknowledge?.(row).catch(error => this.transport.report(error, 'delivery reaction'));
    }
    if (errors.length) throw new AggregateError(errors, 'Some recipients could not be reached.');
    await this.store.updateMessage(row.id, { delivery: row.direction === 'note' ? 'internal' : 'sent' });
    if (row.options.removeSource && !row.options.sourceRemoved && this.transport.deleteSource) {
      const options = { ...row.options, sourceRemoved: true };
      const origin = await this.store.message(row.options.commandSourceId || row.source_id);
      await this.store.updateMessage(row.id, { options: JSON.stringify(options) });
      if (origin && origin.id !== row.id) await this.store.updateMessage(origin.id, { options: JSON.stringify({ ...origin.options, sourceRemoved: true }) });
      try { await this.transport.deleteSource(row); }
      catch (error) {
        await this.store.updateMessage(row.id, { options: JSON.stringify({ ...options, sourceRemoved: false }) });
        if (origin && origin.id !== row.id) await this.store.updateMessage(origin.id, { options: JSON.stringify(origin.options) });
        this.transport.report(error, 'reply command cleanup');
      }
    }
  }
  async notify(ticket) {
    const notifications = await this.store.notifications(ticket.id);
    for (const notification of notifications) {
      const target = { id: notification.target_id, kind: notification.kind };
      try {
        if (!await this.transport.validNotification(target)) { await this.store.unsubscribe(ticket.id, target, notification.recurring); continue; }
        await this.transport.alert(ticket, 'A new member message arrived.', [target]);
        if (!notification.recurring) await this.store.unsubscribe(ticket.id, target, false);
      } catch (error) { this.transport.report(error, 'notification'); }
    }
  }
  async retry(ticket, sourceId) {
    const k = await this.key(ticket.user_id);
    return this.queue.run(k, async () => {
      ticket = await this.store.ticket(ticket.id);
      const row = await this.store.findMessage(ticket.id, sourceId);
      if (ticket.status !== 'open' || ticket.snoozed_at || !row || row.deleted_at && row.delivery !== 'delete_failed' || !['failed','edit_failed','delete_failed'].includes(row.delivery)) throw new Error('Only failed messages in this open conversation can be retried.');
      if (row.delivery === 'failed') { await this.deliver(ticket,row); if (row.direction === 'member') await this.notify(ticket); }
      else await this.syncCopies(ticket,row);
    });
  }
  async edit(source, content) {
    const found = await this.store.message(source.id);
    if (!found) return;
    const ticket = await this.store.ticket(found.ticket_id);
    const k = await this.key(ticket.user_id);
    return this.queue.run(k, async () => {
      const row = await this.store.message(source.id);
      const storeTicket = await this.store.ticket(ticket.id);
      if (!['open','broken'].includes(storeTicket.status) || row.deleted_at) return;
      const attachments = await this.archives.saveAttachments(ticket.id, source.attachments, this.config.maxAttachmentBytes, row.attachments);
      content = stripPings(content);
      if (row.content === content && JSON.stringify(row.attachments) === JSON.stringify(attachments)) return;
      await this.store.revise(row, content, attachments);
      await this.syncCopies(ticket,await this.store.message(source.id));
    });
  }
  async syncCopies(ticket,row) {
    const copies = await this.store.copies(row.id);
    const parts = chunks(row.content);
    try {
      const p = await this.store.participants(ticket.id);
      const active = new Set(p.map(x => x.user_id));
      for (const copy of copies) {
        if (!row.deleted_at && copy.destination !== 'staff' && !active.has(copy.destination)) continue;
        if (row.deleted_at || copy.part >= parts.length) {
          await this.transport.delete({ ...row, target_id: copy.target_id, target_channel: copy.channel_id });
          await this.store.removeCopy(row.id,copy.destination,copy.part);
        } else await this.transport.edit({ ...row, target_id: copy.target_id, target_channel: copy.channel_id, destination: copy.destination }, parts[copy.part], copy.part === 0 ? this.archives.files(row.attachments) : []);
      }
      if (!row.deleted_at && !ticket.snoozed_at && ticket.status === 'open') await this.deliver(ticket,row);
      if (row.deleted_at) await this.store.updateMessage(row.id, { delivery: 'deleted' });
    } catch (error) {
      await this.store.updateMessage(row.id, { delivery: row.deleted_at ? 'delete_failed' : 'edit_failed' });
      await this.transport.alert(ticket, `Message ${row.source_id} could not be synchronized. Use ${this.config.prefix}retry ${row.source_id}.`).catch(() => {});
      throw error;
    }
  }
  async delete(sourceId, force = false) {
    const found = await this.store.message(sourceId);
    if (!found || !force && found.options.sourceRemoved) return;
    const ticket = await this.store.ticket(found.ticket_id);
    const k = await this.key(ticket.user_id);
    return this.queue.run(k, async () => {
      const row = await this.store.message(sourceId);
      const storeTicket = await this.store.ticket(ticket.id);
      if (!['open','broken'].includes(storeTicket.status) || row.deleted_at) return;
      await this.store.updateMessage(row.id,{ deleted_at: Date.now() });
      await this.syncCopies(ticket,await this.store.message(sourceId));
    });
  }
  async commandEdit(ticket,id,content,actor) {
    const row = await this.store.findMessage(ticket.id,id);
    if (!row || row.direction === 'member' || row.deleted_at) throw new Error('Choose a staff reply or note in this conversation.');
    const k = await this.key(ticket.user_id);
    return this.queue.run(k, async () => {
      const current = await this.store.message(row.source_id);
      const storeTicket = await this.store.ticket(ticket.id);
      if (storeTicket.status !== 'open' || current.deleted_at) throw new Error('Conversation/message is not editable.');
      await this.store.revise(current,stripPings(content),current.attachments);
      await this.store.event(ticket.id,actor,`edited message ${row.source_id}`);
      await this.syncCopies(await this.store.ticket(ticket.id),await this.store.message(row.source_id));
    });
  }
  async commandDelete(ticket,id,actor) {
    const row = await this.store.findMessage(ticket.id,id);
    if (!row || row.direction === 'member') throw new Error('Choose a staff reply or note in this conversation.');
    await this.delete(row.source_id, true);
    await this.store.event(ticket.id,actor,`deleted message ${row.source_id}`);
    await this.transport.deleteSource?.(row).catch(() => {});
  }
  async participants(ticket,user,actor,remove = false,anonymous = false) {
    const k = await this.key(ticket.user_id);
    return this.queue.run(k, async () => {
      ticket = await this.store.ticket(ticket.id);
      if (ticket.status !== 'open' || ticket.snoozed_at) throw new Error('Repair or unsnooze the conversation first.');
      if (this.config.dmMode === 'all') throw new Error('Modmail DMs are disabled.');
      const parts = await this.store.participants(ticket.id);
      const ids = parts.map(p => p.user_id);
      if (remove) {
        if (user.id === ticket.user_id || !ids.includes(user.id)) throw new Error('Only an added participant can be removed. Close the ticket to remove its original member.');
        await this.store.removeParticipant(ticket.id,user.id);
      } else {
        await this.eligibility(user);
        if (await this.store.active(user.id)) throw new Error('That member already has an active conversation.');
        if (ids.length >= 10) throw new Error('A conversation can have at most 10 participants.');
        // Contact first: do not silently add someone whose DMs are unavailable.
        await this.transport.notifyUser(user.id, `You are joining a shared moderator conversation with member IDs ${ids.join(', ')}. Future messages and staff replies are shared with its participants. Previous messages are not replayed.`);
        await this.store.addParticipant(ticket.id,user.id);
      }
      const announcement = `${anonymous ? 'Moderation team' : actor.name} ${remove ? 'removed' : 'added'} member ${user.id}.`;
      await this.transport.alert(ticket,announcement);
      for (const id of new Set([...ids,user.id])) await this.transport.notifyUser(id,announcement).catch(() => {});
      await this.store.event(ticket.id,actor.id,`${remove ? 'removed' : 'added'} participant ${user.id}${anonymous ? ' anonymously' : ''}`);
    });
  }
  async snooze(ticket,delay,actor) {
    const k = await this.key(ticket.user_id);
    return this.queue.run(k,async () => {
      ticket = await this.store.ticket(ticket.id);
      if (ticket.status !== 'open') throw new Error('Only open tickets can be snoozed.');
      ticket = await this.store.updateTicket(ticket.id,{ snoozed_at: Date.now(), snooze_until: delay ? Date.now()+delay : null });
      await this.transport.setSnoozed?.(ticket,true);
      await this.store.event(ticket.id,actor,'snoozed'); return ticket;
    });
  }
  async unsnooze(ticket) { const k = await this.key(ticket.user_id); return this.queue.run(k,async () => this.unsnoozeUnlocked(await this.store.ticket(ticket.id))); }
  async unsnoozeUnlocked(ticket) {
    if (ticket.status !== 'open') throw new Error('Repair the conversation before unsnoozing.');
    if (this.config.dmMode === 'all') throw new Error('Enable DMs before resuming queued messages.');
    await this.transport.setSnoozed?.(ticket,false);
    // An interrupted replay remains due so the scheduler resumes it after restart.
    ticket = await this.store.updateTicket(ticket.id,{ snoozed_at: ticket.snoozed_at || Date.now(), snooze_until: Date.now() });
    const msgs = await this.store.messages(ticket.id);
    for (const row of msgs.filter(m => m.delivery === 'queued' && !m.deleted_at)) {
      try { await this.deliver(ticket,row); await this.notify(ticket); }
      catch (error) { await this.store.updateMessage(row.id,{ delivery:'failed' }); await this.transport.alert(ticket,`Queued message ${row.source_id} failed. Use ${this.config.prefix}retry ${row.source_id}.`).catch(() => {}); }
    }
    ticket = await this.store.updateTicket(ticket.id,{ snoozed_at: null, snooze_until: null });
    await this.store.event(ticket.id,'system','unsnoozed'); return ticket;
  }
  async repair(ticket) {
    const k = await this.key(ticket.user_id);
    return this.queue.run(k,async () => {
      ticket=await this.store.ticket(ticket.id);
      if (!['open','broken','opening'].includes(ticket.status)) throw new Error('Closing/closed tickets cannot be repaired.');
      const channel=await this.transport.open(ticket,await this.transport.user(ticket.user_id));
      const replaced=channel.id !== ticket.channel_id;
      ticket=await this.store.updateTicket(ticket.id,{channel_id:channel.id,status:'open',last_error:null});
      if (replaced) {
        const msgs = await this.store.messages(ticket.id);
        for (const row of msgs) {
          const rowCopies = await this.store.copies(row.id);
          for (const c of rowCopies.filter(c => c.destination==='staff')) await this.store.removeCopy(row.id,c.destination,c.part);
          if (row.deleted_at || row.delivery==='queued') continue;
          // Restore staff context without resending old DMs or exposing prior messages to added participants.
          for (const [i,body] of chunks(row.content).entries()) {
            const copy=await this.transport.send(ticket,row,i===0?this.archives.files(row.attachments):[],'staff',body);
            await this.store.saveCopy(row.id,'staff',i,copy);
          }
        }
      }
      if (!ticket.snoozed_at) await this.unsnoozeUnlocked(ticket);
      await this.store.event(ticket.id,'system','repaired'); return ticket;
    });
  }
  async schedule(ticket,delay,reason,actor) { const k = await this.key(ticket.user_id); return this.queue.run(k,async ()=> { const storeTicket = await this.store.ticket(ticket.id); if (storeTicket.status !== 'open') throw new Error('Conversation is already closing.'); return this.store.updateTicket(ticket.id,{close_at:Date.now()+delay,close_reason:reason,closed_by:actor}); }); }
  async cancel(ticket) { const k = await this.key(ticket.user_id); return this.queue.run(k,async ()=> { const storeTicket = await this.store.ticket(ticket.id); if (storeTicket.status !== 'open') throw new Error('Conversation is already closing.'); await this.store.updateTicket(ticket.id,{close_at:null,close_reason:null,closed_by:null}); }); }
  async snapshot(ticket) { const k = await this.key(ticket.user_id); return this.queue.run(k,async ()=>this.archives.build(await this.store.ticket(ticket.id),await this.store.messages(ticket.id),await this.store.revisions(ticket.id), { participants:await this.store.participants(ticket.id,true), events:await this.store.events(ticket.id) },true)); }
  async close(ticket,reason,actor,scheduled=false) {
    const k = await this.key(ticket.user_id);
    return this.queue.run(k,async () => {
      ticket=await this.store.ticket(ticket.id);
      if (ticket.status==='closed') return;
      if (scheduled && ticket.status!=='closing' && (!ticket.close_at || ticket.close_at>Date.now())) return;
      ticket=await this.store.updateTicket(ticket.id,{status:'closing',close_reason:stripPings(reason || ticket.close_reason || 'Closed by staff'),closed_by:actor || ticket.closed_by || 'system'});
      try {
        if (!ticket.archive_path) ticket=await this.store.updateTicket(ticket.id,{archive_path:await this.archives.build(ticket,await this.store.messages(ticket.id),await this.store.revisions(ticket.id),{participants:await this.store.participants(ticket.id,true),events:await this.store.events(ticket.id)})});
        if (!ticket.log_url) ticket=await this.store.updateTicket(ticket.id,{log_url:await this.transport.publishArchive(ticket,ticket.archive_path,this.archives)});
        await this.transport.removeChannel(ticket);
        const participants=await this.store.participants(ticket.id);
        await this.store.finishTicket(ticket.id);
        if (this.config.dmMode!=='all') for (const p of participants) await this.transport.notifyUser(p.user_id,this.config.closeMessage).catch(()=>{});
        await this.store.event(ticket.id,ticket.closed_by,'closed'); await this.plugins?.emit('threadClose',{ticket:await this.store.ticket(ticket.id)});
      } catch(error) {await this.store.updateTicket(ticket.id,{last_error:error.message});throw error;}
    });
  }
  async tick() {
    const liveTickets = await this.store.live();
    for (const ticket of liveTickets) {
      try {
        if (ticket.status==='closing' || (ticket.close_at && ticket.close_at<=Date.now())) await this.close(ticket,null,null,true);
        else if (ticket.status==='open' && ticket.snoozed_at && ticket.snooze_until && ticket.snooze_until<=Date.now()) await this.unsnooze(ticket);
      } catch(error) {this.transport.report(error,`scheduled ticket #${ticket.id}; will retry`);}
    }
  }
}
