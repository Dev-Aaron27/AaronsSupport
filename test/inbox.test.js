import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';
import { Store } from '../src/store.js';
import { Archives } from '../src/archive.js';
import { Inbox } from '../src/inbox.js';
import { validateConfig, parseCommand, parseDuration } from '../src/config.js';

const ids = { guildId: '100000000000000001', categoryId: '100000000000000002', logChannelId: '100000000000000003', staffRoleIds: ['100000000000000004'] };
const config = () => validateConfig({ ...ids, messageCooldownSeconds: 0 });
const user = { id: '100000000000000005', username: 'member', createdTimestamp: Date.now() - 365 * 86400000 };
let next = 0;
const source = (content = 'hello', who = user) => ({ id: String(++next), channelId: who === user ? 'dm' : 'staff', author: who, content, attachments: new Map(), createdTimestamp: Date.now() });
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'inbox-test-'));
  const store = new Store(dir);
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  const calls = [];
  const transport = {
    member: async () => ({ joinedTimestamp: Date.now() - 30 * 86400000 }),
    open: async ticket => { calls.push(['open', ticket.id]); return { id: `channel-${ticket.id}` }; },
    send: async (ticket, row, files, destination, body) => { calls.push(['send', row.direction, row.content, files, destination, body]); return { id: `mirror-${row.source_id}-${destination}-${calls.length}`, channelId: 'destination' }; },
    edit: async (row, content, files) => { calls.push(['edit', row.target_id, content, files]); },
    delete: async row => { calls.push(['delete', row.target_id]); },
    alert: async (_, text) => { calls.push(['alert', text]); },
    notifyUser: async (_, text) => { calls.push(['notify', text]); },
    publishArchive: async (ticket, path) => { assert.ok((await readFile(path)).length); calls.push(['archive', ticket.id]); return `https://discord.com/channels/server/log/${ticket.id}`; },
    removeChannel: async ticket => { calls.push(['remove', ticket.id]); },
    report: () => {},
    user: async id => ({...user,id}),
    validNotification: async () => true,
    setSnoozed: async () => {},
  };
  const archives = new Archives(dir);
  const inbox = new Inbox(store, archives, transport, config());
  return { dir, store, calls, transport, archives, inbox };
}

test('configuration rejects public roles, invalid aliases, unsafe limits; preserves multiline replies', () => {
  assert.throws(() => validateConfig({ ...ids, staffRoleIds: [ids.guildId] }));
  assert.throws(() => validateConfig({ ...ids, aliases: { reply: 'close' } }));
  assert.throws(() => validateConfig({ ...ids, aliases: { x: 'unknown' } }));
  assert.throws(() => validateConfig({ ...ids, maxAttachmentBytes: Infinity }));
  assert.throws(() => validateConfig({ ...ids, colors: { member: 'red' } }));
  assert.deepEqual(parseCommand('.r hello\n  world', { ...config(), aliases: { r: 'reply' } }), { name: 'reply', args: 'hello\n  world' });
  assert.equal(parseCommand('hello', config()), null);
  assert.equal(parseDuration('2h'), 7200000);
  assert.throws(() => parseDuration('31d'));
});

test('concurrent member DMs create one channel; staff replies and notes have distinct routing', async t => {
  const { inbox, store, calls } = await fixture(t);
  await Promise.all([inbox.receive(source('one')), inbox.receive(source('two'))]);
  assert.equal(calls.filter(c => c[0] === 'open').length, 1);
  const ticket = store.active(user.id);
  assert.equal(store.messages(ticket.id).length, 2);
  const moderator = { ...user, id: '100000000000000006', username: 'mod' };
  await inbox.reply(ticket, source('reply', moderator), 'reply');
  await inbox.reply(ticket, source('private', moderator), 'private', true);
  assert.equal(calls.filter(c => c[0] === 'send').length, 5);
  assert.equal(calls.filter(c => c[0] === 'send' && c[1] === 'note').length, 1);
  assert.equal(store.messages(ticket.id).at(-1).delivery, 'internal');
});

test('membership, account age, join age, blocking, and rate limits gate new and existing tickets', async t => {
  const { inbox, store, transport } = await fixture(t);
  await assert.rejects(inbox.receive(source('hi', { ...user, createdTimestamp: Date.now() })), /account must/);
  transport.member = async () => null;
  await assert.rejects(inbox.receive(source()), /must be a member/);
  transport.member = async () => ({ joinedTimestamp: Date.now() });
  await assert.rejects(inbox.receive(source()), /been in the server/);
  assert.equal(store.live().length, 0);
  transport.member = async () => ({ joinedTimestamp: 1 });
  await inbox.receive(source());
  store.block(user.id, 'spam');
  await assert.rejects(inbox.receive(source()), /cannot contact/);
  store.unblock(user.id);
  inbox.config.messageCooldownSeconds = 60;
  await assert.rejects(inbox.receive(source()), /wait a moment/);
});

test('edits and deletes sync mapped copies, preserve audit, and do not loop from mirrored events', async t => {
  const { inbox, store, calls } = await fixture(t);
  const message = source('original');
  await inbox.receive(message);
  await inbox.edit({ ...message, content: 'edited' }, 'edited');
  assert.equal(store.message(message.id).content, 'edited');
  assert.equal(store.revisions(store.active(user.id).id)[0].content, 'original');
  await inbox.delete(`mirror-${message.id}`);
  assert.equal(calls.filter(c => c[0] === 'delete').length, 0);
  await inbox.delete(message.id);
  assert.ok(store.message(message.id).deleted_at);
  assert.equal(calls.filter(c => c[0] === 'delete').length, 1);
  await inbox.edit({ ...message, content: 'late edit' }, 'late edit');
  assert.equal(store.message(message.id).content, 'edited');
});

test('failed delivery is saved and can be retried without opening another channel', async t => {
  const { inbox, store, transport } = await fixture(t);
  const send = transport.send;
  transport.send = async () => { throw new Error('DMs closed'); };
  const message = source();
  await assert.rejects(inbox.receive(message), /saved/);
  assert.equal(store.message(message.id).delivery, 'failed');
  transport.send = send;
  await inbox.retry(store.active(user.id), message.id);
  assert.equal(store.message(message.id).delivery, 'sent');
  await assert.rejects(inbox.retry(store.active(user.id), message.id), /Only failed/);
});

test('closure uploads before deletion, keeps failed archives recoverable, and retries after restart', async t => {
  const { dir, inbox, store, transport, calls, archives } = await fixture(t);
  await inbox.receive(source());
  const ticket = store.active(user.id);
  const publish = transport.publishArchive;
  transport.publishArchive = async () => { throw new Error('upload failed'); };
  await assert.rejects(inbox.close(ticket, 'done', 'mod'), /upload failed/);
  assert.equal(store.ticket(ticket.id).status, 'closing');
  assert.ok(store.ticket(ticket.id).archive_path);
  assert.equal(calls.filter(c => c[0] === 'remove').length, 0);
  transport.publishArchive = publish;
  const reopened = new Store(dir);
  try {
    const restarted = new Inbox(reopened, archives, transport, inbox.config);
    await restarted.tick();
    assert.equal(reopened.ticket(ticket.id).status, 'closed');
    assert.ok(reopened.ticket(ticket.id).log_url);
    assert.ok(calls.findIndex(c => c[0] === 'archive') < calls.findIndex(c => c[0] === 'remove'));
    await restarted.receive(source('another conversation'));
    assert.notEqual(reopened.active(user.id).id, ticket.id);
    assert.equal(reopened.history(user.id).length, 2);
  } finally { reopened.close(); }
});

test('scheduled closure persists; canceling queued timer prevents closure; overdue timer runs', async t => {
  const { inbox, store } = await fixture(t);
  await inbox.receive(source());
  const ticket = store.active(user.id);
  await inbox.schedule(ticket, 100000, 'later', 'mod');
  await inbox.tick();
  assert.equal(store.ticket(ticket.id).status, 'open');
  store.updateTicket(ticket.id, { close_at: Date.now() - 1000 });
  await Promise.all([inbox.cancel(ticket), inbox.close(ticket, null, null, true)]);
  assert.equal(store.ticket(ticket.id).status, 'open');
  assert.equal(store.ticket(ticket.id).close_at, null);
  store.updateTicket(ticket.id, { close_at: Date.now() - 1000 });
  await inbox.tick();
  assert.equal(store.ticket(ticket.id).status, 'closed');
});

test('files are copied, removed attachments retained, HTML escaped, multipart archive is reconstructable', async t => {
  const { inbox, store, archives } = await fixture(t);
  archives.fetcher = async () => new Response(Buffer.from('image contents'));
  const message = source('<script>alert(1)</script>');
  message.attachments.set('123', { id: '123', name: 'photo.png', size: 14, url: 'https://cdn.discordapp.com/attachments/a/photo.png' });
  await inbox.receive(message);
  const ticket = store.active(user.id);
  await inbox.edit({ ...message, attachments: new Map() }, 'new text');
  await inbox.close(ticket, 'resolved', 'mod');
  const parts = [];
  for await (const part of archives.parts(store.ticket(ticket.id).archive_path, 128)) parts.push(part.attachment);
  assert.ok(parts.length > 1);
  const entries = unzipSync(Buffer.concat(parts));
  assert.equal(strFromU8(entries[`attachments/${ticket.id}/123-photo.png`]), 'image contents');
  assert.ok(strFromU8(entries['audit.json']).includes('<script>'));
  assert.ok(!strFromU8(entries['transcript.html']).includes('<script>'));
  assert.ok(archives.html(ticket, [{ ...store.message(message.id), content: '<script>' }]).includes('&lt;script&gt;'));
});

test('attachment downloader rejects non-Discord hosts, redirects, and actual bytes over the limit', async t => {
  const { archives } = await fixture(t);
  let fetched = false;
  archives.fetcher = async (_, options) => { fetched = true; assert.equal(options.redirect, 'error'); return new Response('too large'); };
  const attachment = { id: '1', name: 'a', size: 1, url: 'https://localhost/secret' };
  await assert.rejects(archives.saveAttachments(1, new Map([['1', attachment]]), 4), /Only Discord/);
  assert.equal(fetched, false);
  attachment.url = 'https://cdn.discordapp.com/attachments/a';
  await assert.rejects(archives.saveAttachments(1, new Map([['1', attachment]]), 4), /limit exceeded/);
});

test('multi-user replies fan out, retry only failed recipients, and removal prevents new delivery', async t => {
  const { inbox, store, transport, calls } = await fixture(t);
  await inbox.receive(source());
  const ticket=store.active(user.id),other={...user,id:'100000000000000007',username:'other'},actor={id:'100000000000000006',name:'Moderator'};
  await inbox.participants(ticket,other,actor);
  assert.equal(store.active(other.id).id,ticket.id);
  const send=transport.send;
  let fail=true;
  transport.send=async (...args)=>{if(args[3]===other.id && fail)throw new Error('DM failed');return send(...args);};
  const message=source('shared reply',{...user,id:actor.id});
  await assert.rejects(inbox.reply(ticket,message,'shared reply'),/saved/);
  assert.equal(store.copies(store.message(message.id).id).length,2);
  fail=false;await inbox.retry(ticket,message.id);
  assert.equal(calls.filter(c=>c[0]==='send' && c[2]==='shared reply' && c[4]===user.id).length,1);
  assert.equal(store.copies(store.message(message.id).id).length,3);
  await inbox.participants(ticket,other,actor,true,true);
  assert.equal(store.active(other.id),undefined);
  await inbox.reply(ticket,source('after removal',{...user,id:actor.id}),'after removal');
  assert.equal(calls.filter(c=>c[0]==='send' && c[2]==='after removal' && c[4]===other.id).length,0);
  assert.equal(store.history(other.id)[0].id,ticket.id);
  await assert.rejects(inbox.participants(ticket,user,actor,true),/Only an added/);
});

test('redaction covers create, native edit, command edit, and audit; longer replies split without data loss', async t => {
  const {inbox,store,calls}=await fixture(t);
  const message=source('@everyone 67 <@123456789012345678> @SomeUser');
  await inbox.receive(message);
  assert.equal(store.message(message.id).content,'[REMOVED_PING] 67 [REMOVED_PING] [REMOVED_PING]');
  await inbox.edit({...message,content:'@here edited'},'@here edited');
  assert.equal(store.message(message.id).content,'[REMOVED_PING] edited');
  const ticket=store.active(user.id),reply=source('reply',{...user,id:'100000000000000006'});
  await inbox.reply(ticket,reply,'x'.repeat(4000),false,{anonymous:false,plain:true});
  const row=store.message(reply.id);
  assert.equal(store.copies(row.id).length,4);
  assert.equal(calls.filter(c=>c[0]==='send' && c[2]==='x'.repeat(4000) && c[4]===user.id).map(c=>c[5]).join(''),'x'.repeat(4000));
  await inbox.commandEdit(ticket,reply.id,'@everyone changed','owner');
  assert.equal(store.message(reply.id).content,'[REMOVED_PING] changed');
  assert.equal(store.message(reply.id).options.anonymous,false);
  assert.equal(store.copies(row.id).length,2);
  assert.ok(!JSON.stringify(store.revisions(ticket.id)).includes('@everyone'));
});

test('snooze queues edits/deletes durably, then replays exactly once and wakes on schedule', async t => {
  const {inbox,store,dir,archives,transport,calls}=await fixture(t);
  await inbox.receive(source());const ticket=store.active(user.id);
  await inbox.snooze(ticket,null,'owner');
  const queued=source('queued'),deleted=source('remove me');
  await inbox.receive(queued);await inbox.receive(deleted);await inbox.delete(deleted.id);
  await inbox.edit({...queued,content:'updated'},'updated');
  assert.equal(store.message(queued.id).delivery,'queued');
  const reopened=new Store(dir);
  try {const restarted=new Inbox(reopened,archives,transport,inbox.config);await restarted.unsnooze(reopened.ticket(ticket.id));await restarted.unsnooze(reopened.ticket(ticket.id));}
  finally {reopened.close();}
  assert.equal(calls.filter(c=>c[0]==='send' && c[2]==='updated').length,1);
  assert.equal(calls.filter(c=>c[0]==='send' && c[2]==='remove me').length,0);
  await inbox.snooze(ticket,1000,'owner');store.updateTicket(ticket.id,{snooze_until:Date.now()-1});await inbox.tick();
  assert.equal(store.ticket(ticket.id).snoozed_at,null);
});

test('role blocks, disabled DM modes, and auto-trigger responses persist with safe routing', async t => {
  const {inbox,store,transport}=await fixture(t);
  transport.member=async()=>({joinedTimestamp:1,roles:{cache:new Map([['role',{}]])}});
  store.block('role','spam','role');await assert.rejects(inbox.receive(source()),/role cannot/);store.unblock('role');
  inbox.config.dmMode='new';await assert.rejects(inbox.receive(source()),/New conversations/);
  inbox.config.dmMode='enabled';inbox.config.snippets={welcome:'Hello @everyone'};inbox.config.autotrigger={greeting:{keyword:'help',snippet:'welcome'}};
  await inbox.receive(source('need help'));const ticket=store.active(user.id);
  assert.equal(store.messages(ticket.id)[1].content,'Hello [REMOVED_PING]');
  assert.equal(store.messages(ticket.id)[1].options.anonymous,true);
  inbox.config.dmMode='new';await inbox.receive(source('existing allowed'));
  inbox.config.dmMode='all';await assert.rejects(inbox.receive(source()),/disabled/);await assert.rejects(inbox.reply(ticket,source(),'reply'),/disabled/);
});

test('notifications are consumed only after success and invalid staff subscriptions are removed', async t => {
  const {inbox,store,transport,calls}=await fixture(t);
  await inbox.receive(source());const ticket=store.active(user.id);
  const once={kind:'user',id:'100000000000000006'},recurring={kind:'role',id:'100000000000000004'};
  store.subscribe(ticket.id,once,false);store.subscribe(ticket.id,recurring,true);
  await inbox.receive(source('notify me'));
  assert.equal(store.notifications(ticket.id).length,1);
  assert.equal(calls.filter(c=>c[0]==='alert' && c[1]==='A new member message arrived.').length,2);
  transport.validNotification=async()=>false;await inbox.receive(source('no unauthorized ping'));
  assert.equal(store.notifications(ticket.id).length,0);
});

test('deleted message copies are not resurrected when the database is reopened', async t => {
  const {inbox,store,dir}=await fixture(t);const message=source();await inbox.receive(message);await inbox.delete(message.id);
  const reopened=new Store(dir);try{assert.equal(reopened.copies(store.message(message.id).id).length,0);}finally{reopened.close();}
});

test('editing a legacy internal note never sends it to the member',async t=>{
  const {inbox,store,calls}=await fixture(t);await inbox.receive(source());const ticket=store.active(user.id);
  const note=source('private legacy note',{...user,id:'moderator'});store.addMessage(ticket,note,'note','private legacy note',[]);
  store.updateMessage(store.message(note.id).id,{delivery:'internal'});
  await inbox.commandEdit(ticket,note.id,'still private','owner');
  const copies=calls.filter(c=>c[0]==='send' && c[2]==='still private');assert.equal(copies.length,1);assert.equal(copies[0][4],'staff');
});

test('removed participants receive no future reply edits',async t=>{
  const {inbox,store,transport}=await fixture(t);await inbox.receive(source());const ticket=store.active(user.id),other={...user,id:'100000000000000007'},actor={id:'mod',name:'Moderator'};
  await inbox.participants(ticket,other,actor);const reply=source('original',{...user,id:'mod'});await inbox.reply(ticket,reply,'original');
  const removedCopy=store.copies(store.message(reply.id).id).find(c=>c.destination===other.id);await inbox.participants(ticket,other,actor,true);
  const edited=[];transport.edit=async row=>{edited.push(row.target_id);};await inbox.commandEdit(ticket,reply.id,'private follow-up','mod');
  assert.ok(!edited.includes(removedCopy.target_id));assert.equal(edited.length,2);
});

test('interrupted unsnooze remains scheduled and resumes after restart',async t=>{
  const {inbox,store,transport,archives,dir}=await fixture(t);await inbox.receive(source());const ticket=store.active(user.id);await inbox.snooze(ticket,null,'owner');const queued=source('queued');await inbox.receive(queued);
  const messages=store.messages.bind(store);store.messages=()=>{throw new Error('interrupted before replay');};await assert.rejects(inbox.unsnooze(ticket),/interrupted/);store.messages=messages;
  assert.ok(store.ticket(ticket.id).snoozed_at);assert.ok(store.ticket(ticket.id).snooze_until<=Date.now());
  const reopened=new Store(dir);try{await new Inbox(reopened,archives,transport,inbox.config).tick();assert.equal(reopened.message(queued.id).delivery,'sent');assert.equal(reopened.ticket(ticket.id).snoozed_at,null);}finally{reopened.close();}
});


test('reply cards reach staff and member before source cleanup; cleanup event does not retract cards', async t => {
  const {inbox,store,transport,calls}=await fixture(t);
  await inbox.receive(source()); const ticket=store.active(user.id);
  const message=source('.ar hello',{...user,id:'100000000000000006'});
  transport.deleteSource=async row=>{assert.equal(store.message(row.source_id).options.sourceRemoved,true);calls.push(['source-delete',row.source_id]);};
  await inbox.reply(ticket,message,'@everyone hello',false,{anonymous:true,removeSource:true});
  const row=store.message(message.id),copies=store.copies(row.id);
  assert.deepEqual(new Set(copies.map(c=>c.destination)),new Set(['staff',user.id]));
  assert.ok(calls.findIndex(c=>c[0]==='source-delete') > calls.findLastIndex(c=>c[0]==='send'));
  await inbox.delete(message.id); assert.equal(store.message(message.id).deleted_at,null); assert.equal(store.copies(row.id).length,2);
  await inbox.commandEdit(ticket,copies[0].target_id,'corrected','mod');assert.equal(store.message(message.id).content,'corrected');
  await inbox.commandDelete(ticket,copies[0].target_id,'mod');assert.ok(store.message(message.id).deleted_at);assert.equal(store.copies(row.id).length,0);
});

test('failed reply keeps its command, retries missing copies then removes it; cleanup failures preserve delivered cards', async t => {
  const {inbox,store,transport}=await fixture(t); await inbox.receive(source());const ticket=store.active(user.id);
  const message=source('.ar hello',{...user,id:'mod'}),send=transport.send;let failed=true,deleted=0;
  transport.send=async(...args)=>{if(args[3]===user.id && failed)throw new Error('DM unavailable');return send(...args);};
  transport.deleteSource=async()=>{deleted++;};
  await assert.rejects(inbox.reply(ticket,message,'hello',false,{anonymous:true,removeSource:true}),/saved/);
  assert.equal(deleted,0);assert.equal(store.copies(store.message(message.id).id).length,1);
  failed=false;await inbox.retry(ticket,message.id);assert.equal(deleted,1);assert.equal(store.copies(store.message(message.id).id).length,2);
  transport.deleteSource=async()=>{throw new Error('Missing Manage Messages');};
  const another=source('.ar another',{...user,id:'mod'});await inbox.reply(ticket,another,'another',false,{anonymous:true,removeSource:true});
  assert.equal(store.message(another.id).delivery,'sent');assert.equal(store.message(another.id).options.sourceRemoved,false);
});

test('member delivery acknowledgements wait for all staff parts and queued messages acknowledge after replay', async t => {
  const {inbox,store,transport}=await fixture(t);const ack=[];transport.acknowledge=async row=>{ack.push(row.source_id);};
  const first=source();await inbox.receive(first);assert.deepEqual(ack,[first.id]);const ticket=store.active(user.id);
  await inbox.snooze(ticket,null,'mod');const queued=source('queued');await inbox.receive(queued);assert.ok(!ack.includes(queued.id));
  await inbox.unsnooze(ticket);assert.ok(ack.includes(queued.id));
  const send=transport.send;let failed=true;
  transport.send=async(...args)=>{if(failed && args[4].startsWith('y'))throw new Error('staff unavailable');return send(...args);};
  const split=source('x'.repeat(3400)+'y'.repeat(100));await assert.rejects(inbox.receive(split),/saved/);assert.ok(!ack.includes(split.id));
  failed=false;await inbox.retry(ticket,split.id);assert.ok(ack.includes(split.id));
  transport.acknowledge=async()=>{throw new Error('Cannot react');};const noReaction=source('still delivered');await inbox.receive(noReaction);assert.equal(store.message(noReaction.id).delivery,'sent');
});


test('alias command cleanup preserves an earlier note sharing the original command source',async t=>{
  const {inbox,store,transport}=await fixture(t);await inbox.receive(source());const ticket=store.active(user.id),original=source('.combo',{...user,id:'mod'});
  await inbox.reply(ticket,original,'internal note',true,{anonymous:false});
  transport.deleteSource=async()=>{};
  await inbox.reply(ticket,{...original,id:original.id+':1'},'reply',false,{anonymous:true,removeSource:true,commandSourceId:original.id});
  await inbox.delete(original.id);assert.equal(store.message(original.id).deleted_at,null);assert.equal(store.message(original.id).options.sourceRemoved,true);
});
